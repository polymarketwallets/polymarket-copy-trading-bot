import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
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
export function addRawConfigSecrets(raw: string, env: NodeJS.ProcessEnv = process.env): void {
  // valid YAML that fails only the bot's own checks: the parser sees every form a key can take (quoted names,
  // block scalars, flow maps); the line scan below is for text the parser cannot read at all
  // placeholders are filled in first, as loadConfig does: `{apiSecret: ${X}}` only parses once `${X}` is gone
  const filled = raw.replace(/\$\{(\w+)\}/g, (m, n: string) => env[n] ?? m);
  try {
    const doc = parseDocument(filled, { schema: 'failsafe', uniqueKeys: false });
    walk(doc.contents, false, env, doc);
  } catch { /* not YAML: the scan must do */ }
  for (const m of raw.matchAll(/^\s*[\w-]*(?:key|secret|pass|token|private)[\w-]*\s*:\s*(.+)$/gim)) {
    const v = m[1]!.replace(/\s+#.*$/, '').trim();
    // a placeholder names the variable holding the key, whatever that variable is called
    for (const p of v.matchAll(/\$\{(\w+)\}/g)) addSecret(env[p[1]!]);
    if (/^\$\{\w+\}$/.test(v)) continue;
    addSecret(v.replace(/^['"]|['"]$/g, ''));
    // a line that does not parse may carry junk after the key: the first scalar on it is the likeliest key
    const first = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#,\]}]+))/.exec(v);
    addSecret(first?.[1] ?? first?.[2] ?? first?.[3]);
  }
  for (const m of raw.matchAll(/pmw_[A-Za-z0-9]+_[A-Za-z0-9]+|(?:0x)?[0-9a-fA-F]{64}/g)) addSecret(m[0]);
}

const CREDENTIAL_NAME = /key|secret|pass|token|private/i;

/**
 * Every scalar under a credential-named key, read off the syntax tree rather than a parsed object: an object keeps
 * only the last of a key given twice, and a config that fails for that very reason is when this scan matters.
 */
function walk(node: unknown, credential: boolean, env: NodeJS.ProcessEnv, doc: Document, depth = 0): void {
  if (depth > 50) return; // aliases can point back up the tree
  if (isAlias(node)) {
    // `apiSecret: *a` holds whatever `&a` marks, wherever that stands
    if (credential) walk(node.resolve(doc), true, env, doc, depth + 1);
  } else if (isScalar(node)) {
    if (!credential) return;
    const v = String(node.value ?? '');
    for (const p of v.matchAll(/\$\{(\w+)\}/g)) addSecret(env[p[1]!]);
    if (!/^\$\{\w+\}$/.test(v.trim())) addSecret(v.trim());
  } else if (isMap(node)) {
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value ?? '') : '';
      walk(pair.value, credential || CREDENTIAL_NAME.test(k), env, doc, depth + 1);
    }
  } else if (isSeq(node)) {
    for (const v of node.items) walk(v, credential, env, doc, depth + 1);
  }
}

/**
 * `s` with every known credential, any PMWallets key by its shape (one rotated away since it was written is known
 * to no one here), and any user:password in a URL, replaced
 */
export function redactText(s: string): string {
  let t = s;
  for (const v of ordered) if (t.includes(v)) t = t.split(v).join(REDACTED);
  return t.replace(/pmw_[A-Za-z0-9]+_[A-Za-z0-9]+/g, REDACTED).replace(/\/\/[^/@\s"]*:[^/@\s"]*@/g, '//***@');
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
