import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolymarketGateway, attributeFills, classifyPost } from '../src/polymarket.js';
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
  const { cases } = JSON.parse(readFileSync(new URL('../testdata/post-classification.json', import.meta.url), 'utf8'));
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
  it('unknown id: nothing is attributed — consistent orders are only offered as candidates', () => {
    const f = attributeFills([T({}), T({ taker_order_id: '0xz', asset_id: 'OTHER' })], null, SINCE, match());
    expect(f.shares).toBe(0n);
    expect(f.candidates).toEqual([{ orderId: '0xa', shares: toMicro(10), usdc: toMicro(5) }]);
  });
  it('a trade bigger than what we sent, above our limit, a maker fill, too early or already booked is not even a candidate', () => {
    for (const t of [T({ size: '11' }), T({ price: '0.52' }), T({ trader_side: 'MAKER' }), T({ match_time: '1789999000' })]) {
      expect(attributeFills([t], null, SINCE, match()).candidates).toEqual([]);
    }
    expect(attributeFills([T({})], null, SINCE, match({ booked: ['0xa'] })).candidates).toEqual([]);
  });
});

describe('tokenBalance', () => {
  const gw = (update: unknown, balance = '0') => {
    const g = new PolymarketGateway({ clobUrl: 'http://x', signatureType: 0 }, { info() {}, warn() {}, error() {} });
    (g as any).clob = { updateBalanceAllowance: async () => { if (update instanceof Error) throw update; return update; }, getBalanceAllowance: async () => ({ balance }) };
    return g;
  };
  it('a failed cache refresh fails the read — a stale 0 must not count as a fresh one', async () => {
    await expect(gw({ error: 'internal', status: 500 }).tokenBalance('T')).rejects.toThrow(/refresh failed/);
    await expect(gw(new Error('ECONNRESET')).tokenBalance('T')).rejects.toThrow(/ECONNRESET/);
    expect(await gw('', '19000000').tokenBalance('T')).toBe(19_000_000n);
  });
});

describe('collateral approvals', () => {
  const gw = (resp: unknown) => {
    const g = new PolymarketGateway({ clobUrl: 'http://x', signatureType: 0 }, { info() {}, warn() {}, error() {} });
    (g as any).clob = { updateBalanceAllowance: async () => '', getBalanceAllowance: async () => resp };
    return g;
  };
  it('reads spender → amount, and treats a missing or malformed map as none known', async () => {
    expect(await gw({ balance: '5000000', allowances: { '0xA': '0', '0xB': '1000' } }).collateral()).toEqual({ balance: 5_000_000n, allowances: { '0xA': 0n, '0xB': 1000n } });
    expect((await gw({ balance: '5000000' }).collateral()).allowances).toEqual({});
    expect((await gw({ balance: '5000000', allowances: [] }).collateral()).allowances).toEqual({});
    expect((await gw({ balance: '5000000', allowances: 'x' }).collateral()).allowances).toEqual({});
  });
});

describe('when a market settles', () => {
  const CID = '0xe1648bc0c286911bcb5fc228972268d3ca413aa4a6b4a6b03b8c983ba706f957';
  const clob = { condition_id: CID, question: 'Bitcoin Up or Down - 5m', closed: false, active: true, accepting_orders: true, end_date_iso: '2026-09-25T00:00:00Z', tokens: [] };
  const gw = () => new PolymarketGateway({ clobUrl: 'http://clob', signatureType: 0 }, { info() {}, warn() {}, error() {} });
  let gammaCalls = 0;
  const serve = (gamma: (url: string) => Response) => vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    if (u.startsWith('http://clob')) return new Response(JSON.stringify(clob));
    gammaCalls++;
    return gamma(u);
  }));
  const at = (endDate: string) => () => new Response(JSON.stringify([{ conditionId: CID, endDate }]));
  afterEach(() => vi.unstubAllGlobals());

  it('takes the time from Gamma: the CLOB gives short markets only a date', async () => {
    serve(at('2026-09-25T03:45:00Z'));
    expect((await gw().market(CID, 30_000, true)).endDate).toBe('2026-09-25T03:45:00Z');
  });

  it('asks Gamma only when the caller needs the end date (exits and the settlement sweep do not)', async () => {
    serve(at('2026-09-25T03:45:00Z'));
    gammaCalls = 0;
    expect((await gw().market(CID, 0)).endDate).toBe('2026-09-25T00:00:00Z');
    expect(gammaCalls).toBe(0);
  });

  it('follows an end date that moves: Gamma is asked again once the market is stale', async () => {
    const g = gw();
    serve(at('2026-09-25T03:45:00Z'));
    expect((await g.market(CID, 30_000, true)).endDate).toBe('2026-09-25T03:45:00Z');
    serve(at('2026-09-26T03:45:00Z'));
    expect((await g.market(CID, 0, true)).endDate).toBe('2026-09-26T03:45:00Z');
  });

  it('remembers that Gamma failed, so an outage costs one wait per market, not one per fill', async () => {
    const g = gw();
    serve(() => new Response('oops', { status: 502 }));
    gammaCalls = 0;
    await g.market(CID, 0, true);
    expect((await g.market(CID, 0, true)).endDate).toBe('2026-09-25T00:00:00Z');
    expect(gammaCalls).toBe(1);
  });

  it.each([
    ['Gamma is down', () => new Response('oops', { status: 502 })],
    ['Gamma does not know the market', () => new Response('[]')],
    ['Gamma answers for another market', () => new Response(JSON.stringify([{ conditionId: '0xother', endDate: '2026-09-25T03:45:00Z' }]))],
    ['Gamma has no usable date', () => new Response(JSON.stringify([{ conditionId: CID, endDate: 'soon' }]))],
  ])('falls back to the CLOB date when %s', async (_, gamma) => {
    serve(gamma);
    expect((await gw().market(CID, 30_000, true)).endDate).toBe('2026-09-25T00:00:00Z');
  });
});
