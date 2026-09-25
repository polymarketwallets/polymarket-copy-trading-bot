import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { diagnose, scrub, secretsOf } from '../src/diagnose.js';
import { VERSION } from '../src/version.js';

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

  it('never treats a short value as a secret: it would blank out ordinary text', () => {
    expect(secretsOf(null, { MY_TOKEN: 'abc', PATH: '/usr/bin/longenough' })).toEqual([]);
    expect(scrub('x https://a:b@h/ y', [])).toBe('x https://***@h/ y');
  });
});
