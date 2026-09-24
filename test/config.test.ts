import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, substituteEnv } from '../src/config.js';

const key = { pmwallets: { apiKey: 'pmw_a_b' } };

describe('config', () => {
  it('defaults to dry-run with the live-proven gates', () => {
    const c = buildConfig(key);
    expect(c.mode).toBe('dry-run');
    expect(c.copy).toMatchObject({ orderSizeUsdc: 10, maxBuysPerOutcome: 3, minPrice: 0.05, maxPrice: 0.95, minBookDepthUsdc: 50 });
  });
  it('refuses live mode without a key, without an explicit account type, or without the funder address', () => {
    const pk = 'ab'.repeat(32);
    const FUNDER = '0x1111111111111111111111111111111111111111';
    expect(() => buildConfig({ ...key, mode: 'live' })).toThrow(/privateKey/);
    // no default account type: signing as the wrong one gets every order rejected
    expect(() => buildConfig({ ...key, mode: 'live', polymarket: { privateKey: pk } })).toThrow(/signatureType: 3 for accounts created on polymarket.com since 2026-05-04/);
    expect(() => buildConfig({ ...key, mode: 'live', polymarket: { privateKey: pk, signatureType: 3 } })).toThrow(/funderAddress/);
    expect(() => buildConfig({ ...key, mode: 'live', polymarket: { privateKey: pk, signatureType: 4, funderAddress: FUNDER } })).toThrow(/signatureType must be a number in \[0, 3\]/);
    const dw = buildConfig({ ...key, mode: 'live', polymarket: { privateKey: pk, signatureType: '3', funderAddress: FUNDER } });
    expect(dw.polymarket.signatureType).toBe(3);
    const eoa = buildConfig({ ...key, mode: 'live', polymarket: { privateKey: pk, signatureType: 0 } });
    expect(eoa.polymarket.privateKey).toBe(`0x${pk}`);
  });
  it('dry-run needs no Polymarket settings at all', () => {
    expect(buildConfig(key).polymarket.signatureType).toBeUndefined();
  });
  it('rejects settings that would silently block every trade', () => {
    expect(() => buildConfig({ ...key, copy: { minPrice: 0.9, maxPrice: 0.5 } })).toThrow(/minPrice/);
    expect(() => buildConfig({ ...key, copy: { roles: [] } })).toThrow(/roles/);
    expect(() => buildConfig({ ...key, targets: ['0x4b96…984e'] })).toThrow(/targets\[0\]/);
  });
  it('lowercases target addresses and accepts bare strings', () => {
    const c = buildConfig({ ...key, targets: ['0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', { entity: '7KQ2MF9X4B1C', orderSizeUsdc: 5 }] });
    expect(c.targets[0]!.entity).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(c.targets[1]).toEqual({ entity: '7KQ2MF9X4B1C', orderSizeUsdc: 5 });
  });
  it('substitutes env vars and fails on a missing one', () => {
    expect(substituteEnv('k: ${A}', { A: 'x' })).toBe('k: x');
    expect(() => substituteEnv('k: ${B}', {})).toThrow(/B/);
  });
});

describe('the shared config contract (the Python suite checks the same file)', () => {
  it('normalises every YAML scalar form to the same values', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { readFileSync } = await import('node:fs');
    const root = new URL('../testdata/', import.meta.url);
    const c = loadConfig(new URL('config-contract.yaml', root).pathname, {});
    const expected = JSON.parse(readFileSync(new URL('config-contract.expected.json', root), 'utf8'));
    const got = { mode: c.mode, polymarket: c.polymarket, targets: c.targets, copy: c.copy, risk: c.risk, dataDir: c.dataDir };
    expect(JSON.parse(JSON.stringify(got))).toEqual(expected);
  });
});

describe('configs both implementations refuse (shared testdata/config-invalid.json)', () => {
  it.each(JSON.parse(readFileSync(new URL('../testdata/config-invalid.json', import.meta.url), 'utf8')).cases as { name: string; yaml: string }[])('$name', async ({ yaml }) => {
    const { loadConfig } = await import('../src/config.js');
    const dir = mkdtempSync(join(tmpdir(), 'pmwcfg-'));
    writeFileSync(join(dir, 'c.yaml'), yaml);
    expect(() => loadConfig(join(dir, 'c.yaml'), {})).toThrow();
  });
});
