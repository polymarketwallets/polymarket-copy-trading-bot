import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributeFills, classifyPost } from '../src/polymarket.js';
import { toMicro } from '../src/units.js';

/** the shape the TS SDK hands back for each case (http-helpers errorHandling) */
function sdkShape(http: number | null, body: unknown): unknown {
  if (http === null) return { error: 'socket hang up' };
  if (http >= 200 && http < 300) return body;
  // an empty body is falsy in errorHandling: it falls through to err.message, and the status is lost
  if (body === null || body === undefined || body === '') return { error: `Request failed with status code ${http}` };
  if (typeof body === 'string') return { error: body, status: http };
  if (!Object.prototype.hasOwnProperty.call(body, 'error')) return { error: body, status: http };
  return { ...(body as object), status: http };
}

describe('classifyPost (shared contract with the Python bot)', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../../testdata/post-classification.json', import.meta.url), 'utf8'));
  for (const c of cases) it(c.name, () => expect(classifyPost(sdkShape(c.http, c.body))).toBe(c.expect));
});

const T = (o: Record<string, unknown>) => ({ taker_order_id: '0xa', trader_side: 'TAKER', asset_id: 'TOK', side: 'BUY', size: '10', price: '0.50', fee_rate_bps: '0', match_time: '1790000000', ...o });
const match = (o: Partial<{ shares: bigint; limit: bigint; booked: string[] }> = {}) => ({
  tokenId: 'TOK', side: 'buy' as const, shares: o.shares ?? toMicro(10), limit: o.limit ?? toMicro('0.51'),
  isBooked: (id: string) => (o.booked ?? []).includes(id),
});
const SINCE = 1_790_000_000_000 - 1000;

describe('attributeFills', () => {
  it('known id: every trade of that order', () => {
    const f = attributeFills([T({}), T({ taker_order_id: '0xb' }), T({ size: '5' })], '0xA', 0);
    expect(f.shares).toBe(toMicro(15));
    expect(f.orderIds).toEqual(['0xa']);
  });
  it('unknown id: the single consistent candidate', () => {
    const f = attributeFills([T({}), T({ taker_order_id: '0xz', asset_id: 'OTHER' })], null, SINCE, match());
    expect(f.shares).toBe(toMicro(10));
    expect(f.orderIds).toEqual(['0xa']);
  });
  it('a manual trade bigger than what we sent, or above our limit, is not ours', () => {
    expect(attributeFills([T({ size: '11' })], null, SINCE, match()).shares).toBe(0n);
    expect(attributeFills([T({ price: '0.52' })], null, SINCE, match()).shares).toBe(0n);
    expect(attributeFills([T({ trader_side: 'MAKER' })], null, SINCE, match()).shares).toBe(0n);
    expect(attributeFills([T({ match_time: '1789999000' })], null, SINCE, match()).shares).toBe(0n);
    expect(attributeFills([T({})], null, SINCE, match({ booked: ['0xa'] })).shares).toBe(0n);
  });
  it('two orders that could both be ours: ambiguous, nothing attributed', () => {
    const f = attributeFills([T({}), T({ taker_order_id: '0xb', size: '4' })], null, SINCE, match());
    expect(f).toMatchObject({ ambiguous: true, shares: 0n });
  });
});
