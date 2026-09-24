import { describe, expect, it } from 'vitest';
import { clampLimit, parseFillTs, roundBuyShares, roundSellShares, toMicro } from '../src/units.js';

describe('BUY size rounding (cent grid × 0.01-share grid)', () => {
  it.each([
    ['0.99', 1_000_000n],   // 1 share steps
    ['0.915', 2_000_000n],  // 2 shares: 0.915 × 2 = 1.83
    ['0.997', 10_000_000n], // 10 shares
    ['0.48', 250_000n],     // 0.25 share: 0.48 × 0.25 = 0.12 — and 0.25 is on the 0.01 grid
    ['0.5', 20_000n],       // 0.02 share: 0.01 USDC
  ])('price %s steps by %s micro-shares', (price, step) => {
    const p = toMicro(price);
    expect(roundBuyShares(step * 7n + 1n, p)).toBe(step * 7n);
    const s = roundBuyShares(123_456_789n, p);
    expect(s % 10_000n).toBe(0n);                   // what the SDK signs
    expect((s * p) % 10_000_000_000n).toBe(0n);     // what the server checks
  });
  it('the live 2026-06-04 case: $2 at 0.48 must not produce 4.125 shares', () => {
    const shares = roundBuyShares((toMicro(2) * 1_000_000n) / toMicro('0.48'), toMicro('0.48'));
    expect(shares).toBe(4_000_000n);
  });
});

describe('the rest', () => {
  it('SELL floors to 1e-4 share', () => expect(roundSellShares(50_123_456n)).toBe(50_123_400n));
  it('clamps the limit to 1 - tick, 0.99 when the tick is unknown', () => {
    expect(clampLimit(toMicro('0.999'))).toBe(990_000n);
    expect(clampLimit(toMicro('0.999'), toMicro('0.001'))).toBe(999_000n);
    expect(clampLimit(toMicro('0.5'), toMicro('0.01'))).toBe(500_000n);
  });
  it('reads the feed timestamp as UTC', () => {
    expect(parseFillTs('2026-09-16 14:02:11')).toBe(Date.UTC(2026, 8, 16, 14, 2, 11));
    expect(parseFillTs('garbage')).toBeNaN();
  });
});
