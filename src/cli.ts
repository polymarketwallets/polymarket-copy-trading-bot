#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { consoleLogger } from './log.js';
import { run } from './run.js';
import { BotState } from './state.js';
import { fromMicro } from './units.js';

const HELP = `pmwallets-copytrade — copy the Polymarket wallets you follow on PMWallets

  pmwallets-copytrade init [config.yaml]        write an example config
  pmwallets-copytrade run [--config config.yaml] [--json]
  pmwallets-copytrade status [--config config.yaml]

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
    return;
  }
  console.log(HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

main().catch((e: unknown) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
