import type { Config } from './config.js';

/**
 * Every credential this process knows, so that nothing it writes to a file — the run log, a support bundle — can
 * carry one: the config's keys, credential-named environment variables, and the CLOB API credentials the gateway
 * derives at run time. Values are removed from each string before it is serialized, so JSON escaping cannot hide
 * a match.
 */
const known = new Set<string>();
let ordered: string[] = [];
const REDACTED = '<redacted>';
/** environment variables whose values are credentials, whatever the config says */
const SECRET_NAME = /KEY|SECRET|PASS|TOKEN|PRIVATE/i;

export function addSecret(v: string | undefined | null): void {
  // short values would blank out ordinary text; no real credential is this short
  if (!v || v.length < 8) return;
  const bare = v.replace(/^0x/i, '');
  for (const b of [bare, bare.toLowerCase(), bare.toUpperCase()]) { known.add(b); known.add(`0x${b}`); known.add(`0X${b}`); }
  known.add(v);
  ordered = [...known].sort((a, b) => b.length - a.length);
}

export function addConfigSecrets(cfg: Config | null, env: NodeJS.ProcessEnv): void {
  for (const v of [cfg?.pmwallets.apiKey, cfg?.polymarket.privateKey, cfg?.polymarket.apiKey, cfg?.polymarket.apiSecret, cfg?.polymarket.apiPassphrase]) addSecret(v);
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k)) addSecret(v);
}

/**
 * Credential-looking values in a config file's raw text, for when it does not load: the value of every key named
 * like a credential, and any PMWallets key or 32-byte hex (a private key; a config holds no transaction hash).
 */
export function addRawConfigSecrets(raw: string): void {
  for (const m of raw.matchAll(/^\s*[\w-]*(?:key|secret|pass|token|private)[\w-]*\s*:\s*(.+)$/gim)) {
    const v = m[1]!.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!/^\$\{\w+\}$/.test(v)) addSecret(v);
  }
  for (const m of raw.matchAll(/pmw_[A-Za-z0-9]+_[A-Za-z0-9]+|(?:0x)?[0-9a-fA-F]{64}/g)) addSecret(m[0]);
}

/** `s` with every known credential, and any user:password in a URL, replaced */
export function redactText(s: string): string {
  let t = s;
  for (const v of ordered) if (t.includes(v)) t = t.split(v).join(REDACTED);
  return t.replace(/\/\/[^/@\s"]*:[^/@\s"]*@/g, '//***@');
}

/** `value` with `redactText` applied to every string in it, keys included */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactText(k), redact(v)])) as T;
  }
  return value;
}

/** for tests */
export function clearSecrets(): void { known.clear(); ordered = []; }
