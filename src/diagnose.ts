import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULTS, loadConfig, type Config } from './config.js';
import { tailOf } from './files.js';
import { addConfigSecrets, addRawConfigSecrets, redact, redactText } from './secrets.js';
import { VERSION } from './version.js';

/** how much of each log a bundle carries: the newest part, where the trouble usually is */
const TAIL_BYTES = 5 * 1024 * 1024;
const REDACTED = '<redacted>';

/**
 * Everything support needs to see what the bot did, in one file a user can send: versions, the `check` result,
 * the config without its keys, the state files, and the newest logs and decisions of both modes.
 * Keys are removed twice: from the config by field, then by value from every string in the bundle — so a key that
 * turned up anywhere else (an error message, a log line) does not leave the machine either.
 */
export async function diagnose(
  configPath: string,
  check: (path: string, out: (line: string) => void) => Promise<number>,
  { env = process.env, now = new Date(), outDir = '.' }: { env?: NodeJS.ProcessEnv; now?: Date; outDir?: string } = {},
): Promise<string> {
  let rawConfig = '';
  try { rawConfig = readFileSync(configPath, 'utf8'); } catch { /* no file: loadConfig says so */ }
  addRawConfigSecrets(rawConfig);
  let cfg: Config | null = null;
  let configError: string | undefined;
  // a parser error quotes the line it failed on — cut short, so no value match can catch it: keep the first line
  try { cfg = loadConfig(configPath, env); } catch (e) { configError = firstLine(e); }
  addConfigSecrets(cfg, env);

  const lines: string[] = [];
  let checkExit: number | null = null;
  try { checkExit = await check(configPath, (l) => lines.push(l)); } catch (e) { lines.push(`check failed: ${firstLine(e)}`); }

  // a config that does not load still says where the data is; guessing the default would bundle the wrong files
  const rawDataDir = /^dataDir:\s*(.+?)\s*(?:#.*)?$/m.exec(rawConfig)?.[1]?.replace(/^['"]|['"]$/g, '');
  const dataDir = cfg?.dataDir ?? rawDataDir ?? DEFAULTS.dataDir;
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
    dataDir: cfg ? dataDir : `${dataDir} (${rawDataDir ? 'read from the config text' : 'the default'}: the config did not load)`,
    files,
  };
  // strings first, then the text once more: the second pass is only a backstop
  const text = redactText(JSON.stringify(redact(bundle), (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  const out = join(outDir, `pmw-diagnose-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json.gz`);
  writeFileSync(out, gzipSync(text));
  return out;
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0];

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
