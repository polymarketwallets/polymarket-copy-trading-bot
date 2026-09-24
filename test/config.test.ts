import { describe, expect, it } from 'vitest';
import { buildConfig, substituteEnv } from '../src/config.js';

const key = { pmwallets: { apiKey: 'pmw_a_b' } };

describe('config', () => {
  it('defaults to dry-run with the live-proven gates', () => {
    const c = buildConfig(key);
    expect(c.mode).toBe('dry-run');
    expect(c.copy).toMatchObject({ orderSizeUsdc: 10, maxBuysPerOutcome: 3, minPrice: 0.05, maxPrice: 0.95, minBookDepthUsdc: 50 });
  });
  it('refuses live mode without a key, or a proxy account without its funder address', () => {
    expect(() => buildConfig({ ...key, mode: 'live' })).toThrow(/privateKey/);
    expect(() => buildConfig({ ...key, mode: 'live', polymarket: { privateKey: 'ab'.repeat(32) } })).toThrow(/funderAddress/);
    const c = buildConfig({ ...key, mode: 'live', polymarket: { privateKey: 'ab'.repeat(32), signatureType: 0 } });
    expect(c.polymarket.privateKey).toBe(`0x${'ab'.repeat(32)}`);
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
