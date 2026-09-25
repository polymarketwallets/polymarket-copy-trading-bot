import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { addConfigSecrets, addSecret, clearSecrets, redact, redactText } from '../src/secrets.js';
import { RotatingFile } from '../src/files.js';
import { consoleLogger, teeLogger } from '../src/log.js';
import { VERSION } from '../src/version.js';
import { loadConfig } from '../src/config.js';

const KEY = '0x' + 'ab12'.repeat(16);
const PMW = 'pmw_abcd1234_secretsecretsecret';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pmw-diag-'));
  const data = join(dir, 'data');
  mkdirSync(data);
  writeFileSync(join(dir, 'config.yaml'), [
    'mode: live',
    'pmwallets:', '  apiKey: ${PMW_API_KEY}',
    'polymarket:', '  signatureType: 3', '  privateKey: ${POLY_PRIVATE_KEY}', '  funderAddress: "0x' + '1'.repeat(40) + '"',
    `dataDir: ${data}`,
  ].join('\n'));
  writeFileSync(join(data, 'state.live.json'), '{"positions":{}}');
  writeFileSync(join(data, 'bot.live.log'), `{"msg":"started"}\n{"msg":"oops, key was ${KEY.slice(2).toUpperCase()}"}\n`);
  writeFileSync(join(data, 'decisions.live.jsonl'), '{"decision":"bought"}\n');
  return { dir, env: { PMW_API_KEY: PMW, POLY_PRIVATE_KEY: KEY, HTTPS_PROXY: 'http://user:hunter22@proxy:8080' } };
}

describe('diagnose', () => {
  beforeEach(() => clearSecrets());
  it('bundles what support needs and not a single key', async () => {
    const { dir, env } = setup();
    const check = async (_: string, out: (l: string) => void) => { out(`  ✓ signer ok (${PMW})`); out('  ✗ region'); return 1; };
    const file = await diagnose(join(dir, 'config.yaml'), check, { env, now: new Date('2026-09-25T06:30:00.123Z'), outDir: dir });
    expect(file).toBe(join(dir, 'pmw-diagnose-20260925T063000Z.json.gz'));
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    for (const s of [KEY, KEY.slice(2), KEY.slice(2).toUpperCase(), PMW, 'hunter22']) expect(text).not.toContain(s);
    const b = JSON.parse(text);
    expect(b).toMatchObject({ format: 1, version: VERSION, check: { exitCode: 1 } });
    expect(b.config.polymarket).toMatchObject({ privateKey: '<redacted>', funderAddress: '0x' + '1'.repeat(40), signatureType: 3 });
    expect(b.config.pmwallets.apiKey).toBe('<redacted>');
    expect(b.check.output).toEqual(['  ✓ signer ok (<redacted>)', '  ✗ region']);
    expect(Object.keys(b.files).sort()).toEqual(['bot.live.log', 'decisions.live.jsonl', 'state.live.json']);
    expect(b.files['bot.live.log']).toContain('oops, key was <redacted>');
  });

  it('still writes a bundle when the config does not load', async () => {
    const { dir, env } = setup();
    writeFileSync(join(dir, 'bad.yaml'), 'mode: live\nnonsense: 1\n');
    const file = await diagnose(join(dir, 'bad.yaml'), async () => { throw new Error('no config'); }, { env, outDir: dir });
    const b = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    expect(b.config.error).toMatch(/nonsense/);
    expect(b.check.output).toEqual(['check failed: no config']);
  });

  it.each([
    ['an unterminated quote', `mode: live\npmwallets:\n  apiKey: "${PMW}\npolymarket:\n  privateKey: ${KEY}\n`],
    ['a key where a group belongs', `mode: live\npmwallets: ${PMW}\n`],
    ['a bad indent', `mode: live\npmwallets:\n  apiKey: ${PMW}\n    privateKey: '${KEY}'\n  apiSecret: c2VjcmV0c2VjcmV0c2VjcmV0\n`],
  ])('keeps literal keys out of the bundle when the config does not parse (%s)', async (_, yaml) => {
    const { dir } = setup();
    writeFileSync(join(dir, 'broken.yaml'), yaml);
    // the real check reads the config first, and its error is the parser's — excerpt and all
    const file = await diagnose(join(dir, 'broken.yaml'), async (p) => { loadConfig(p, {}); return 0; }, { env: {}, outDir: dir });
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    // the parser's excerpt cuts a long line short, so a prefix of the key must not be there either
    for (const s of [PMW, KEY.slice(0, 40), KEY.slice(2, 40), 'c2VjcmV0c2VjcmV0c2VjcmV0']) expect(text).not.toContain(s);
    expect(JSON.parse(text).config.error).not.toContain('\n');
  });

  it('reads dataDir from a config that does not load, instead of guessing the default', async () => {
    const { dir, env } = setup();
    const data = join(dir, 'elsewhere');
    mkdirSync(data);
    writeFileSync(join(data, 'decisions.live.jsonl'), '{"decision":"bought"}\n');
    writeFileSync(join(dir, 'bad.yaml'), `mode: live\nnonsense: 1\ndataDir: "${data}"   # custom\n`);
    const b = JSON.parse(gunzipSync(readFileSync(await diagnose(join(dir, 'bad.yaml'), async () => 1, { env, outDir: dir }))).toString('utf8'));
    expect(b.dataDir).toContain('read from the config text');
    expect(Object.keys(b.files)).toEqual(['decisions.live.jsonl']);
  });
});

describe('credentials never reach a file', () => {
  beforeEach(() => clearSecrets());

  it('matches before JSON escaping, and in every 0x/case form', () => {
    addSecret('abcd"efgh\\ij');
    addSecret('0x' + 'ab'.repeat(32));
    const text = JSON.stringify(redact({ e: 'pw abcd"efgh\\ij', k: ['0X' + 'AB'.repeat(32), '0x' + 'AB'.repeat(32), 'ab'.repeat(32)] }));
    expect(text).toBe('{"e":"pw <redacted>","k":["<redacted>","<redacted>","<redacted>"]}');
  });

  it('keeps them out of the decisions file', async () => {
    const { BotState } = await import('../src/state.js');
    const dir = mkdtempSync(join(tmpdir(), 'pmw-dec-'));
    addSecret(KEY);
    new BotState(dir, 'live').logDecision({ decision: 'buy_rejected', reason: `signer ${KEY.toUpperCase()} refused` });
    const text = readFileSync(join(dir, 'decisions.live.jsonl'), 'utf8');
    expect(text).not.toContain(KEY.slice(2).toUpperCase());
    expect(text).toContain('signer <redacted> refused');
  });

  it('registers the keys of every config it loads, whatever the environment calls them', () => {
    const { dir } = setup();
    loadConfig(join(dir, 'config.yaml'), { PMW_API_KEY: PMW, POLY_PRIVATE_KEY: KEY });
    expect(redactText(`${PMW} ${KEY}`)).toBe('<redacted> <redacted>');
  });

  it('removes a PMWallets key by its shape, even one no longer in the config', () => {
    expect(redactText('old key pmw_zz99yy88_rotatedawaylongago in a 0.1.3 log')).toBe('old key <redacted> in a 0.1.3 log');
  });

  it.each([
    ['a placeholder for a variable of any name', 'polymarket:\n  apiSecret: ${CLOB_CREDENTIAL}\n  : broken\n'],
    ['junk after a literal', 'polymarket:\n  apiSecret: "clobsecretvalue123" junk\n'],
    ['a quoted key name, and an unknown setting', 'polymarket:\n  "apiSecret": clobsecretvalue123\n  nonsense: 1\n'],
    ['a folded block scalar, and an unknown setting', 'polymarket:\n  apiSecret: >-\n    clobsecretvalue123\n  nonsense: 1\n'],
    ['a double-quoted key with a placeholder', 'polymarket:\n  "apiSecret": ${CLOB_CREDENTIAL}\n  nonsense: 1\n'],
    ['a single-quoted key with a placeholder', "polymarket:\n  'apiPassphrase': ${CLOB_CREDENTIAL}\n  nonsense: 1\n"],
    ['a flow mapping with a placeholder', 'polymarket: {apiSecret: ${CLOB_CREDENTIAL}}\nnonsense: 1\n'],
    ['a quoted key given twice, the first holding it', 'polymarket:\n  "apiSecret": clobsecretvalue123\n  "apiSecret": secondsecret67890\n'],
    ['a block scalar given twice, the first holding it', 'polymarket:\n  apiSecret: >-\n    clobsecretvalue123\n  apiSecret: >-\n    secondsecret67890\n'],
    ['an alias to a value anchored elsewhere', 'stash: &k clobsecretvalue123\npolymarket:\n  apiSecret: *k\n'],
    ['a literal block scalar in a flow of lines', 'polymarket:\n  apiPassphrase: |-\n    clobsecretvalue123\nnonsense: 1\n'],
  ])('keeps a CLOB credential out of the bundle when the config does not load: %s', async (_, yaml) => {
    const { dir } = setup();
    writeFileSync(join(dir, 'broken.yaml'), `mode: live\ndataDir: ${join(dir, 'data')}\n${yaml}`);
    // an older build logged an exchange error quoting it
    writeFileSync(join(dir, 'data', 'decisions.live.jsonl'), '{"reason":"401 for key clobsecretvalue123"}\n');
    const env = { CLOB_CREDENTIAL: 'clobsecretvalue123' };
    const file = await diagnose(join(dir, 'broken.yaml'), async (p) => { loadConfig(p, env); return 0; }, { env, outDir: dir });
    expect(gunzipSync(readFileSync(file)).toString('utf8')).not.toContain('clobsecretvalue123');
  });

  it('a key put where a group belongs is not quoted back by the config error, in the bundle or anywhere', async () => {
    const { dir } = setup();
    writeFileSync(join(dir, 'broken.yaml'), 'mode: live\npolymarket: [apiSecret, clobsecretvalue123]\n');
    const file = await diagnose(join(dir, 'broken.yaml'), async (p) => { loadConfig(p, {}); return 0; }, { env: {}, outDir: dir });
    expect(gunzipSync(readFileSync(file)).toString('utf8')).not.toContain('clobsecretvalue123');
  });

  it('config errors do not quote a long value back: it may be a key in the wrong place', () => {
    const { dir } = setup();
    writeFileSync(join(dir, 'c.yaml'), 'mode: live\npmwallets:\n  apiKey: pmw_a_b\npolymarket: [apiSecret, CLOBSECRET-ROTATED-123456]\n');
    expect(() => loadConfig(join(dir, 'c.yaml'), {})).toThrow(/polymarket must be a group of settings, not a \d+-character value/);
    writeFileSync(join(dir, 'd.yaml'), 'mode: live\npmwallets:\n  apiKey: pmw_a_b\nrisk: 10\n');
    expect(() => loadConfig(join(dir, 'd.yaml'), {})).toThrow('risk must be a group of settings, not "10"');
  });

  it('keeps them out of the state file, where unfinished orders keep the exchange error', async () => {
    const { BotState } = await import('../src/state.js');
    const dir = mkdtempSync(join(tmpdir(), 'pmw-st-'));
    addSecret('clobsecretvalue123');
    const st = new BotState(dir, 'live');
    st.addPendingOrder({ key: 'k', side: 'buy', orderId: null, target: 't', tokenId: '1', conditionId: 'c', shares: '1', limit: '1', reserveUsdc: '1', sentAt: 0, attempts: 1,
      needsReconcile: 'exchange said: bad creds clobsecretvalue123' } as any);
    st.save();
    const text = readFileSync(join(dir, 'state.live.json'), 'utf8');
    expect(text).not.toContain('clobsecretvalue123');
    expect(st.pendingOrders()[0]!.needsReconcile).toContain('clobsecretvalue123'); // memory keeps what it had
  });

  it('never treats a short value as a secret: it would blank out ordinary text', () => {
    addConfigSecrets(null, { MY_TOKEN: 'abc', PATH: '/usr/bin/longenough' });
    expect(redactText('abc /usr/bin/longenough')).toBe('abc /usr/bin/longenough');
    expect(redactText('x https://a:b@h/ y')).toBe('x https://***@h/ y');
  });

  it('keeps them out of the run log, the terminal and the file alike', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmw-log-'));
    addConfigSecrets(null, { POLY_PRIVATE_KEY: KEY, PMW_API_KEY: PMW });
    addSecret('derived-clob-secret==');
    const printed: string[] = [];
    const orig = console.log;
    console.log = (l: string) => { printed.push(l); };
    try {
      teeLogger(consoleLogger(), new RotatingFile(join(dir, 'bot.log'), 1e6, 2))
        .warn(`order failed for ${PMW}`, { error: `bad key ${KEY.slice(2).toUpperCase()}`, stack: 'at x (derived-clob-secret==)' });
    } finally { console.log = orig; }
    const file = readFileSync(join(dir, 'bot.log'), 'utf8');
    for (const out of [file, printed.join('\n')]) {
      for (const s of [PMW, KEY.slice(2), KEY.slice(2).toUpperCase(), 'derived-clob-secret']) expect(out).not.toContain(s);
      expect(out).toContain('order failed for <redacted>');
    }
  });
});
