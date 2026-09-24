#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { consoleLogger } from './log.js';
import { run } from './run.js';
import { BotState, InstanceLock } from './state.js';
import { CopyEngine } from './engine.js';
import { PolymarketGateway } from './polymarket.js';
import { toMicro } from './units.js';
import { fromMicro } from './units.js';

const HELP = `pmwallets-copytrade — copy the Polymarket wallets you follow on PMWallets

  pmwallets-copytrade init [config.yaml]        write an example config
  pmwallets-copytrade run [--config config.yaml] [--json]
  pmwallets-copytrade status [--config config.yaml]
  pmwallets-copytrade reconcile [<key> --none | <key> --filled <shares> --usdc <usdc>] [--config config.yaml]
      settle an order the bot could not verify by itself (see \`status\`); run it with the bot stopped

Starts in dry-run: nothing is traded until you set \`mode: live\`.
Docs: https://pmwallets.com/copy-trading`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    const dest = process.argv[3] ?? 'config.yaml';
    if (existsSync(dest)) throw new Error(`${dest} already exists`);
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.example.yaml'), dest);
    console.log(`wrote ${dest} — fill in PMW_API_KEY (and the Polymarket keys for live mode), then: pmwallets-copytrade run`);
    return;
  }
  if (cmd === 'run') {
    const cfg = loadConfig(arg('--config', 'config.yaml'));
    await run(cfg, consoleLogger(process.argv.includes('--json')));
    return;
  }
  if (cmd === 'status') {
    const cfg = loadConfig(arg('--config', 'config.yaml'));
    const st = new BotState(cfg.dataDir, cfg.mode);
    const ps = st.positions();
    console.log(`${cfg.mode}: ${ps.length} open position(s), spent today $${fromMicro(st.spentToday()).toFixed(2)}`);
    for (const p of ps) console.log(`  ${p.target.slice(0, 10)}…  ${(p.question ?? p.conditionId).slice(0, 60)}  [${p.outcome ?? '?'}]  ${fromMicro(BigInt(p.shares)).toFixed(2)} sh  cost $${fromMicro(BigInt(p.costUsdc)).toFixed(2)}  buys ${p.buyCount}`);
    const po = st.pendingOrders();
    if (po.length) console.log(`${po.length} order(s) not yet confirmed:`);
    for (const p of po) console.log(`  ${p.needsReconcile ? 'NEEDS RECONCILE' : 'checking'}  ${p.side}  ${(p.question ?? p.conditionId).slice(0, 50)}  sent ${new Date(p.sentAt).toISOString()}  order ${p.orderId ?? '(no id)'}  key ${p.key}${p.needsReconcile ? `\n      ${p.needsReconcile}` : ''}`);
    if (st.pendingExits().length) console.log(`${st.pendingExits().length} exit(s) being retried`);
    return;
  }
  if (cmd === 'reconcile') {
    const cfg = loadConfig(arg('--config', 'config.yaml'));
    const lock = new InstanceLock(cfg.dataDir, cfg.mode);
    lock.acquire(); // the bot must not be running while its books are edited
    try {
      const st = new BotState(cfg.dataDir, cfg.mode);
      const key = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
      if (!key) {
        const open = st.pendingOrders().filter((p) => p.needsReconcile);
        if (!open.length) { console.log('nothing to reconcile'); return; }
        for (const p of open) console.log(`${p.key}\n  ${p.side} ${p.question ?? p.conditionId} [${p.outcome ?? '?'}] sent ${new Date(p.sentAt).toISOString()} order ${p.orderId ?? '(no id)'}\n  ${p.needsReconcile}`);
        console.log('\nCheck your trade history on polymarket.com, then: reconcile <key> --none  |  reconcile <key> --filled <shares> --usdc <usdc>');
        return;
      }
      let result: { shares: bigint; usdc: bigint } | null;
      if (process.argv.includes('--none')) result = null;
      else if (process.argv.includes('--filled') && process.argv.includes('--usdc')) result = { shares: toMicro(arg('--filled', '')), usdc: toMicro(arg('--usdc', '')) };
      else throw new Error('say what happened: --none, or --filled <shares> --usdc <usdc>');
      const engine = new CopyEngine({ cfg, exchange: new PolymarketGateway({ ...cfg.polymarket, privateKey: undefined }, consoleLogger()), state: st, log: consoleLogger(), targets: null });
      await engine.reconcile(key, result);
      console.log('reconciled');
    } finally { lock.release(); }
    return;
  }
  console.log(HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

main().catch((e: unknown) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
