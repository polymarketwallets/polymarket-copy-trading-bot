import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITIONAL_V2, EXCHANGE_V3, PolymarketGateway, attributeFills, classifyPost, exchangeV3Approval, idKind, marketProtocol, orderAsset, type Market } from '../src/polymarket.js';
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

describe('Polymarket V2 position ids (shared contract with the Python bot)', () => {
  const { ids, markets } = JSON.parse(readFileSync(new URL('../testdata/position-ids.json', import.meta.url), 'utf8'));
  for (const c of ids) it(`idKind: ${c.name}`, () => expect(idKind(c.id)).toBe(c.kind));
  const market = (version: string | null): Market => ({ conditionId: 'C', question: '', closed: false, active: true, tokens: [], ...(version === null ? {} : { version }) });
  for (const c of markets) {
    it(`marketProtocol: ${c.name}`, () => {
      const r = marketProtocol(market(c.version), c.id);
      expect(r.ok ? (r.v2 ? 'v2' : 'ctf') : 'skip').toBe(c.expect);
    });
  }
  it('the order asset is positionID for a V2 position, tokenID for a CTF token — and never a guess', () => {
    const V2 = ids[0].id; const CTF = ids[6].id;
    expect(orderAsset(V2, true)).toEqual({ positionID: V2 });
    expect(orderAsset(CTF, false)).toEqual({ tokenID: CTF });
    expect(() => orderAsset(CTF, true)).toThrow(/not a V2 position/);
    expect(() => orderAsset(V2, false)).toThrow(/not a CTF token/);
    const COMBO = ids[4].id;
    for (const v2 of [true, false, undefined]) expect(() => orderAsset(COMBO, v2)).toThrow(/combinatorial/);
    // callers from before V2 pass no flag: CTF only
    expect(orderAsset(CTF)).toEqual({ tokenID: CTF });
    expect(() => orderAsset(V2)).toThrow(/not a CTF token/);
  });
});

describe('orders and balances by protocol', () => {
  const V2 = '456322662693127080402085893806415780684933579476723864069977356327020658688';
  const CTF = '69515744437473089728151261939146426925489297565662421305942992110046228478629';
  const gw = () => {
    const calls: { create: any[]; market: any[]; balance: any[] } = { create: [], market: [], balance: [] };
    const g = new PolymarketGateway({ clobUrl: 'http://x', signatureType: 0 }, { info() {}, warn() {}, error() {} });
    (g as any).clob = {
      createOrder: async (a: any) => { calls.create.push(a); return { signed: true }; },
      createMarketOrder: async (a: any) => { calls.market.push(a); return { signed: true }; },
      postOrder: async () => ({ success: true, orderID: '0xo', status: 'matched', makingAmount: '5', takingAmount: '10' }),
      getTrades: async () => [],
      updateBalanceAllowance: async (a: any) => { calls.balance.push(a); return ''; },
      getBalanceAllowance: async (a: any) => { calls.balance.push(a); return { balance: '1000000' }; },
    };
    return { g, calls };
  };
  it('BUY: positionID for a V2 position (ExchangeV3), tokenID for a CTF token', async () => {
    const { g, calls } = gw();
    expect((await g.buyFok(V2, 'C', toMicro('0.5'), toMicro(10), true)).status).toBe('filled');
    await g.buyFok(CTF, 'C', toMicro('0.5'), toMicro(10), false);
    expect(calls.create[0]).toMatchObject({ positionID: V2 });
    expect(calls.create[0]).not.toHaveProperty('tokenID');
    expect(calls.create[1]).toMatchObject({ tokenID: CTF });
    expect(calls.create[1]).not.toHaveProperty('positionID');
  });
  it('SELL: the same routing on the FAK market order', async () => {
    const { g, calls } = gw();
    await g.sellFak(V2, 'C', toMicro('0.5'), toMicro(10), true);
    await g.sellFak(CTF, 'C', toMicro('0.5'), toMicro(10), false);
    expect(calls.market[0]).toMatchObject({ positionID: V2 });
    expect(calls.market[0]).not.toHaveProperty('tokenID');
    expect(calls.market[1]).toMatchObject({ tokenID: CTF });
  });
  it('an id that does not fit the protocol fails before anything is signed or sent', async () => {
    const { g, calls } = gw();
    const r = await g.buyFok(CTF, 'C', toMicro('0.5'), toMicro(10), true);
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.reason).toMatch(/sign_error/);
    expect(calls.create).toEqual([]);
  });
  const COMBO = '1628948707922995775031622509772078765406110626872621424817699628095377506304';
  it('a combo is never signed, whatever the flag: both order methods fail before the SDK is called', async () => {
    const { g, calls } = gw();
    for (const v2 of [true, false, undefined]) {
      const b = await g.buyFok(COMBO, 'C', toMicro('0.5'), toMicro(10), v2);
      const s = await g.sellFak(COMBO, 'C', toMicro('0.5'), toMicro(10), v2);
      for (const r of [b, s]) { expect(r.status).toBe('failed'); expect(r.reason).toMatch(/combinatorial/); }
    }
    expect(calls.create).toEqual([]);
    expect(calls.market).toEqual([]);
    await expect(g.tokenBalance(COMBO, true)).rejects.toThrow(/combinatorial/);
    expect(calls.balance).toEqual([]);
  });
  it('an id not in canonical decimal form (hex, zero-padded, whitespace, signed, too large) never reaches the SDK or a lookup', async () => {
    const { ids } = JSON.parse(readFileSync(new URL('../testdata/position-ids.json', import.meta.url), 'utf8'));
    const invalid: string[] = ids.filter((c: any) => c.kind === 'invalid').map((c: any) => c.id);
    expect(invalid.length).toBeGreaterThan(10);
    const fetched = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetched);
    try {
      const { g, calls } = gw();
      for (const id of invalid) {
        for (const v2 of [true, false, undefined]) {
          for (const r of [await g.buyFok(id, 'C', toMicro('0.5'), toMicro(10), v2), await g.sellFak(id, 'C', toMicro('0.5'), toMicro(10), v2)]) {
            expect(r.status, id).toBe('failed');
            expect(r.reason).toMatch(/canonical/);
          }
          await expect(g.tokenBalance(id, v2)).rejects.toThrow(/canonical/);
          expect(() => orderAsset(id, v2)).toThrow(/canonical/);
        }
        await expect(g.conditionIdFor(id)).rejects.toThrow(/canonical/);
        await expect(g.orderbook(id)).rejects.toThrow(/canonical/);
      }
      expect(calls.create).toEqual([]);
      expect(calls.market).toEqual([]);
      expect(calls.balance).toEqual([]);
      expect(fetched).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('callers from before V2 (no flag) keep the CTF path and cannot reach a V2 position', async () => {
    const { g, calls } = gw();
    expect((await g.buyFok(CTF, 'C', toMicro('0.5'), toMicro(10))).status).toBe('filled');
    expect((await g.sellFak(CTF, 'C', toMicro('0.5'), toMicro(10))).status).toBe('filled');
    expect(await g.tokenBalance(CTF)).toBe(1_000_000n);
    expect(calls.create[0]).toMatchObject({ tokenID: CTF });
    expect(calls.market[0]).toMatchObject({ tokenID: CTF });
    expect(calls.balance.map((b) => b.asset_type)).toEqual(['CONDITIONAL', 'CONDITIONAL']);
    expect((await g.buyFok(V2, 'C', toMicro('0.5'), toMicro(10))).status).toBe('failed');
    expect((await g.sellFak(V2, 'C', toMicro('0.5'), toMicro(10))).status).toBe('failed');
    await expect(g.tokenBalance(V2)).rejects.toThrow(/not a CTF token/);
    expect(calls.create.length + calls.market.length + calls.balance.length).toBe(4);
  });
  it('balance: CONDITIONAL-V2 for a V2 position, CONDITIONAL for a CTF token — refresh and read alike', async () => {
    const { g, calls } = gw();
    expect(await g.tokenBalance(V2, true)).toBe(1_000_000n);
    await g.tokenBalance(CTF, false);
    expect(CONDITIONAL_V2).toBe('CONDITIONAL-V2');
    expect(calls.balance.map((b) => b.asset_type)).toEqual(['CONDITIONAL-V2', 'CONDITIONAL-V2', 'CONDITIONAL', 'CONDITIONAL']);
    expect(calls.balance.every((b) => b.token_id === (b.asset_type === 'CONDITIONAL' ? CTF : V2))).toBe(true);
  });
  it('reads the market version from the CLOB', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ condition_id: 'C', question: 'q', tokens: [], version: 'v2' }))));
    try {
      const g = new PolymarketGateway({ clobUrl: 'http://clob', signatureType: 0 }, { info() {}, warn() {}, error() {} });
      expect((await g.market('C', 0)).version).toBe('v2');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('ExchangeV3 pUSD approval', () => {
  it('found by address in any case; zero and not reported are told apart', () => {
    expect(exchangeV3Approval({ [EXCHANGE_V3.toLowerCase()]: 5n })).toBe('approved');
    expect(exchangeV3Approval({ '0xA': 1n, [EXCHANGE_V3]: 0n })).toBe('zero');
    expect(exchangeV3Approval({ '0xA': 1n })).toBe('missing');
  });
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
    await expect(gw({ error: 'internal', status: 500 }).tokenBalance('1001', false)).rejects.toThrow(/refresh failed/);
    await expect(gw(new Error('ECONNRESET')).tokenBalance('1001', false)).rejects.toThrow(/ECONNRESET/);
    expect(await gw('', '19000000').tokenBalance('1001', false)).toBe(19_000_000n);
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
