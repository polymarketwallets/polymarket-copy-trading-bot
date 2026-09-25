import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULTS, loadConfig, type Config } from './config.js';
import { tailOf } from './files.js';
import { VERSION } from './version.js';

/** how much of each log a bundle carries: the newest part, where the trouble usually is */
const TAIL_BYTES = 5 * 1024 * 1024;
const REDACTED = '<redacted>';
/** environment variables whose values are credentials, whatever the config says */
const SECRET_ENV = /KEY|SECRET|PASS|TOKEN|PRIVATE/i;

/**
 * Everything support needs to see what the bot did, in one file a user can send: versions, the `check` result,
 * the config without its keys, the state files, and the newest logs and decisions of both modes.
 * Keys are removed twice: from the config by field, then by value from the whole bundle — so a key that turned up
 * anywhere else (an error message, a log line) does not leave the machine either.
 */
export async function diagnose(
  configPath: string,
  check: (path: string, out: (line: string) => void) => Promise<number>,
  { env = process.env, now = new Date(), outDir = '.' }: { env?: NodeJS.ProcessEnv; now?: Date; outDir?: string } = {},
): Promise<string> {
  let cfg: Config | null = null;
  let configError: string | undefined;
  let rawConfig = '';
  try { rawConfig = readFileSync(configPath, 'utf8'); } catch { /* no file: loadConfig says so */ }
  // a parser error quotes the line it failed on, key and all: keep its first line only, and scrub what the raw
  // file holds, because a config that does not load gives no field to read the key from
  try { cfg = loadConfig(configPath, env); } catch (e) { configError = (e as Error).message.split('\n')[0]; }

  const lines: string[] = [];
  let checkExit: number | null = null;
  try { checkExit = await check(configPath, (l) => lines.push(l)); } catch (e) { lines.push(`check failed: ${(e as Error).message.split('\n')[0]}`); }

  const dataDir = cfg?.dataDir ?? DEFAULTS.dataDir;
  const files: Record<string, string> = {};
  for (const mode of ['live', 'dry-run']) {
    for (const name of [`state.${mode}.json`, `stream.${mode}.json`]) {
      const p = join(dataDir, name);
      if (existsSync(p)) files[name] = readFileSync(p, 'utf8');
    }
    for (const name of [`bot.${mode}.log`, `decisions.${mode}.jsonl`]) {
      const t = tailOf(join(dataDir, name), TAIL_BYTES);
      if (t) files[name] = t;
    }
  }

  const bundle = {
    format: 1,
    createdAt: now.toISOString(),
    version: VERSION,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    config: cfg ? redactConfig(cfg) : { error: configError },
    check: { exitCode: checkExit, output: lines },
    dataDir,
    files,
  };
  const text = scrub(JSON.stringify(bundle, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1), [...secretsOf(cfg, env), ...secretsInRaw(rawConfig)].sort((a, b) => b.length - a.length));
  const out = join(outDir, `pmw-diagnose-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json.gz`);
  writeFileSync(out, gzipSync(text));
  return out;
}

function redactConfig(cfg: Config): unknown {
  const hide = (v: string | undefined) => (v ? REDACTED : undefined);
  return {
    ...cfg,
    pmwallets: { ...cfg.pmwallets, apiKey: hide(cfg.pmwallets.apiKey) },
    polymarket: {
      ...cfg.polymarket,
      privateKey: hide(cfg.polymarket.privateKey),
      apiKey: hide(cfg.polymarket.apiKey),
      apiSecret: hide(cfg.polymarket.apiSecret),
      apiPassphrase: hide(cfg.polymarket.apiPassphrase),
    },
  };
}

/** every credential value we know of: the config's, and those of environment variables named like one */
export function secretsOf(cfg: Config | null, env: NodeJS.ProcessEnv): string[] {
  const vals = [
    cfg?.pmwallets.apiKey, cfg?.polymarket.privateKey, cfg?.polymarket.apiKey, cfg?.polymarket.apiSecret, cfg?.polymarket.apiPassphrase,
    ...Object.entries(env).filter(([k]) => SECRET_ENV.test(k)).map(([, v]) => v),
  ];
  const out = new Set<string>();
  for (const v of vals) {
    // short values would blank out ordinary text; no real credential is this short
    if (!v || v.length < 8) continue;
    const bare = v.replace(/^0x/i, '');
    for (const x of [v, bare, bare.toLowerCase(), bare.toUpperCase()]) out.add(x);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Credential-looking values in a config file's raw text: the value of every key named like a credential, and any
 * PMWallets key or 32-byte hex (a private key; a config holds no transaction hashes) wherever it stands.
 */
export function secretsInRaw(raw: string): string[] {
  const vals: string[] = [];
  for (const m of raw.matchAll(/^\s*[\w-]*(?:key|secret|pass|token|private)[\w-]*\s*:\s*(.+)$/gim)) {
    const v = m[1]!.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!/^\$\{\w+\}$/.test(v)) vals.push(v);
  }
  for (const m of raw.matchAll(/pmw_[A-Za-z0-9]+_[A-Za-z0-9]+|(?:0x)?[0-9a-fA-F]{64}/g)) vals.push(m[0]);
  const out = new Set<string>();
  for (const v of vals) {
    if (v.length < 8) continue;
    const bare = v.replace(/^0x/i, '');
    for (const x of [v, bare, bare.toLowerCase(), bare.toUpperCase()]) out.add(x);
  }
  return [...out];
}

/** `text` with every secret value, and any user:password in a URL, replaced */
export function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) t = t.split(s).join(REDACTED);
  return t.replace(/\/\/[^/@\s"]*:[^/@\s"]*@/g, '//***@');
}
