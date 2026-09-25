#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTradingConfig, loadConfig } from './config.js';
import { PmwClient } from 'pmwallets';
import { applyProxyFromEnv } from './proxy.js';
import { consoleLogger, teeLogger } from './log.js';
import { RotatingFile } from './files.js';
import { VERSION } from './version.js';
import { diagnose } from './diagnose.js';
import { funderMismatch, run } from './run.js';
import { checkFunder } from './wallets.js';
import { checkGeo, describeGeo } from './geo.js';
import { BotState, InstanceLock } from './state.js';
import { CopyEngine } from './engine.js';
import { PolymarketGateway } from './polymarket.js';
import { fmtUsd, fromMicro, toMicro } from './units.js';

const HELP = `pmwallets-copytrade — copy the Polymarket wallets you follow on PMWallets

  pmwallets-copytrade init [config.yaml]        write an example config
  pmwallets-copytrade run [--config config.yaml] [--json]
  pmwallets-copytrade check [--config config.yaml]    verify the trading setup (read-only; places no order)
  pmwallets-copytrade status [--config config.yaml]
  pmwallets-copytrade reconcile [<key> --none | <key> --filled <shares> --usdc <usdc>] [--config config.yaml]
      settle an order the bot could not verify by itself (see \`status\`); run it with the bot stopped
  pmwallets-copytrade diagnose [--config config.yaml]
      write pmw-diagnose-<time>.json.gz for support@pmwallets.com: logs, decisions, state and \`check\`, no keys
  pmwallets-copytrade --version

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
  if (cmd === '--version' || cmd === 'version') {
    console.log(VERSION);
    return;
  }
  if (cmd === 'run') {
    const cfg = loadConfig(arg('--config', 'config.yaml'));
    const log = teeLogger(consoleLogger(process.argv.includes('--json')), new RotatingFile(join(cfg.dataDir, `bot.${cfg.mode}.log`), 10 * 1024 * 1024, 5));
    log.info(`pmwallets-copytrade ${VERSION}`, { node: process.version, platform: process.platform, arch: process.arch });
    try {
      await run(cfg, log);
    } catch (e) {
      // what stopped the bot belongs in the file too: the terminal that showed it may be long gone
      log.error('stopped by an error', { error: (e as Error).message, stack: (e as Error).stack });
      throw e;
    }
    return;
  }
  if (cmd === 'check') {
    process.exitCode = await check(arg('--config', 'config.yaml'));
    return;
  }
  if (cmd === 'diagnose') {
    const file = await diagnose(arg('--config', 'config.yaml'), (path, out) => check(path, out));
    console.log(`wrote ${file}\nSend it to support@pmwallets.com with a line about what went wrong. It holds no private key or API key,\nbut it does show your wallet addresses, the traders you copy, your trades and this machine's IP.`);
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

const ACCOUNT_TYPES = ['0 · plain wallet (EOA)', '1 · Proxy Wallet (older email/Google account)', '2 · Safe Wallet (older browser-wallet account)', '3 · Deposit Wallet (polymarket.com account since 2026-05-04)'];

/**
 * Everything live trading depends on, checked without trading: the config, the PMWallets key and its
 * subscriptions, the Polymarket credentials, and whether the account the orders would come from is the
 * one holding the money. Exit 0 only when all of it is in order.
 */
async function check(path: string, out: (line: string) => void = console.log): Promise<number> {
  const ok = (m: string) => out(`  ✓ ${m}`);
  const bad = (m: string) => out(`  ✗ ${m}`);
  let problems = 0;
  const cfg = loadConfig(path);
  const { proxy } = applyProxyFromEnv();
  if (proxy) ok(`proxy ${proxy}`);

  out('PMWallets');
  try {
    const subs = await new PmwClient({ apiKey: cfg.pmwallets.apiKey, baseUrl: cfg.pmwallets.baseUrl }).subscriptions();
    const active = subs.filter((s) => s.status === 'active');
    ok(`API key accepted; ${active.length} active subscription(s)${subs.length > active.length ? `, ${subs.length - active.length} paused` : ''}`);
    if (!active.length) { bad('nothing to copy yet: subscribe to a trader on pmwallets.com'); problems++; }
  } catch (e) { bad(`API key: ${(e as Error).message}`); problems++; }

  out('Polymarket');
  try { checkTradingConfig(cfg); } catch (e) { bad((e as Error).message); return problems + 1; }
  const type = cfg.polymarket.signatureType!;
  ok(`account type ${ACCOUNT_TYPES[type]}`);
  const gw = new PolymarketGateway(cfg.polymarket, { info() {}, warn() {}, error: (m: string) => out(m) });
  try { await gw.connect(); } catch (e) { bad(`could not derive the trading credentials: ${(e as Error).message}`); return problems + 1; }
  ok(`signer ${gw.signerAddress}`);
  const fc = checkFunder(gw.signerAddress as `0x${string}`, cfg.polymarket.funderAddress, type);
  if (fc.ok) ok(`funds held by ${cfg.polymarket.funderAddress ?? gw.signerAddress} — this key's ${ACCOUNT_TYPES[type]!.split(' (')[0]}`);
  else { bad(funderMismatch(cfg.polymarket.funderAddress, type, fc)); problems++; }
  try {
    const { balance: usdc, allowances } = await gw.collateral();
    const spenders = Object.entries(allowances);
    const zero = spenders.filter(([, v]) => v === 0n).map(([k]) => k);
    if (!spenders.length) {
      // no approval data at all is not "approved": it cannot be confirmed, so it does not pass
      bad('Polymarket returned no exchange approvals for this account, so they cannot be confirmed');
      problems++;
    } else if (zero.length === spenders.length) {
      bad(type === 0
        ? 'no exchange contract may spend this wallet\'s USDC yet: approve them before the first trade (see the README)'
        : 'no exchange contract may spend this account\'s USDC: finish setting up trading on polymarket.com (make one trade or deposit there) first');
      problems++;
    } else if (zero.length) out(`  ! no approval yet for ${zero.join(', ')} — orders routed through it will fail`);
    else ok('exchange approvals in place');
    if (usdc > 0n) ok(`balance ${fmtUsd(usdc)} available to trade`);
    else {
      bad('balance $0.00 — if polymarket.com shows money in this account, signatureType or funderAddress is wrong');
      problems++;
    }
    if (usdc > 0n && usdc < toMicro(cfg.copy.orderSizeUsdc)) { bad(`balance is below one order (copy.orderSizeUsdc = $${cfg.copy.orderSizeUsdc})`); problems++; }
  } catch (e) {
    const msg = (e as Error).message;
    // Polymarket's answer when the funder is not a Deposit Wallet owned by this key
    if (/no deposit wallet found/i.test(msg)) {
      bad(fc.ok
        ? `this key's Deposit Wallet ${cfg.polymarket.funderAddress} is not deployed yet: sign up on polymarket.com with this wallet and make a deposit first`
        : `Polymarket finds no account wallet at ${cfg.polymarket.funderAddress} owned by this key — funderAddress, privateKey or signatureType is wrong`);
    }
    else bad(`balance lookup failed: ${msg}`);
    problems++;
  }
  try {
    const g = await checkGeo();
    if (g.api === 'ok') ok(describeGeo(g));
    else { bad(describeGeo(g)); problems++; }
  } catch (e) { bad(`region lookup failed: ${(e as Error).message}`); problems++; }
  try {
    if (await gw.closedOnly()) { bad('Polymarket lets this account only close positions (region or account restriction): BUYs will be rejected'); problems++; }
    else ok('account may open positions');
  } catch (e) { bad(`restriction lookup failed: ${(e as Error).message}`); problems++; }

  out(problems ? `\n${problems} problem(s): fix them before mode: live` : `\nready for mode: live (the bot is in ${cfg.mode} mode now)`);
  return problems ? 1 : 0;
}

main().catch((e: unknown) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
