/**
 * Fixed-point helpers. Prices, shares and USDC are all carried as bigint micro-units (1e-6), the
 * resolution Polymarket settles in — floats only at the edges (config values, SDK arguments).
 *
 * The size rounding here is lifted from a copy-trading bot that ran live on Polymarket; each rule
 * exists because the CLOB rejected an order without it.
 */
export const UNIT = 1_000_000n;

export function toMicro(x: number | string): bigint {
  const n = typeof x === 'number' ? x : Number.parseFloat(x);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(x)}`);
  return BigInt(Math.round(n * 1e6));
}

export function fromMicro(v: bigint): number {
  return Number(v) / 1e6;
}

export function fmtUsd(v: bigint): string {
  return `$${fromMicro(v).toFixed(2)}`;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * The highest price the CLOB accepts: 1 - tick. A near-resolved book can show 0.999 on a 0.01-tick
 * market and the order is rejected ("invalid price (0.999), min: 0.01 - max: 0.99"). Clamping a limit
 * DOWN is execution-safe: a match fills at the resting order's price. Unknown tick → the coarse 0.99.
 */
export function clampLimit(price: bigint, tick?: bigint): bigint {
  const max = tick && tick > 0n && tick < UNIT ? UNIT - tick : 990_000n;
  return price > max ? max : price;
}

/**
 * BUY size must satisfy two grids at once: the SDK signs sizes truncated to 0.01 share, and the server
 * wants size × price to land on a whole cent ("invalid amounts ... max accuracy of 2 decimals").
 * lcm of the two steps is the coarsest size meeting both; round DOWN to it.
 */
export function roundBuyShares(shares: bigint, price: bigint): bigint {
  if (price <= 0n) return 0n;
  const CENT_STEP = 10_000_000_000n; // size_units * price_units must be a multiple of 1e10 (one cent in 1e12)
  const centStep = CENT_STEP / gcd(price, CENT_STEP);
  const SHARE_STEP = 10_000n; // 0.01 share
  const step = (centStep * SHARE_STEP) / gcd(centStep, SHARE_STEP);
  return (shares / step) * step;
}

/** SELL: shares are the maker side, no cent rule — floor to 1e-4 share so a full exit leaves no dust. */
export function roundSellShares(shares: bigint): bigint {
  return (shares / 100n) * 100n;
}

/** Block time from the feed (`YYYY-MM-DD HH:MM:SS`, UTC) → epoch ms; NaN when malformed. */
export function parseFillTs(ts: string): number {
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(ts)) return Number.NaN;
  const iso = ts.replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}
