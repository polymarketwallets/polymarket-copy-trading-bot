import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fill } from 'pmwallets';
import { buildConfig, type Config } from '../src/config.js';
import { CopyEngine, type Exchange } from '../src/engine.js';
import type { Book, Market, OrderOutcome } from '../src/polymarket.js';
import { BotState } from '../src/state.js';
import { toMicro } from '../src/units.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const T1 = '0x1111111111111111111111111111111111111111';
const T2 = '0x2222222222222222222222222222222222222222';
const silent = { info() {}, warn() {}, error() {} };

let n = 0;
function fill(o: Partial<Fill> = {}): Fill {
  n++;
  return {
    eventId: `137:${n}:0xh:0xtx${n}:1`, chain: 137, entityId: T1, wallet: T1, ts: '2026-09-24 11:59:50',
    block: 1000 + n, blockHash: '0xh', txHash: `0xtx${n}`, logIndex: 1, exchange: 'pm_ctf_v2',
    side: 'BUY', role: 'taker', tokenId: 'TOK', price: '0.500000', shares: '100000000', usdc: '50000000', fee: '0', ...o,
  };
}

class FakeExchange implements Exchange {
  canTrade = true;
  market_: Market = { conditionId: 'CID', question: 'Will it?', closed: false, active: true, acceptingOrders: true, endDate: '2026-12-31T00:00:00Z', tokens: [{ tokenId: 'TOK', outcome: 'Yes' }] };
  book: Book = { tokenId: 'TOK', asks: [{ price: toMicro('0.51'), size: toMicro('1000') }], bids: [{ price: toMicro('0.49'), size: toMicro('1000') }], tickSize: toMicro('0.01'), minOrderSize: toMicro('5') };
  buys: { limit: bigint; shares: bigint }[] = [];
  sells: { limit: bigint; shares: bigint }[] = [];
  buyResult: (shares: bigint, limit: bigint) => OrderOutcome = (shares, limit) => ({ orderId: 'o1', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares });
  sellResult: (shares: bigint, limit: bigint) => OrderOutcome = (shares, limit) => ({ orderId: 's1', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares });
  balance = 10n ** 12n;
  lateFill = { shares: 0n, usdc: 0n, feeUsdc: 0n, feeShares: 0n };
  async conditionIdFor() { return 'CID'; }
  async market() { return this.market_; }
  async orderbook() { return this.book; }
  async buyFok(_t: string, _c: string, limit: bigint, shares: bigint) { this.buys.push({ limit, shares }); return this.buyResult(shares, limit); }
  async sellFak(_t: string, _c: string, limit: bigint, shares: bigint) { this.sells.push({ limit, shares }); return this.sellResult(shares, limit); }
  async fillsOf() { return this.lateFill; }
  async tokenBalance() { return this.balance; }
}

function setup(raw: Record<string, any> = {}, targets: string[] | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pmwct-'));
  const cfg: Config = buildConfig({ pmwallets: { apiKey: 'pmw_a_b' }, dataDir: dir, ...raw });
  const ex = new FakeExchange();
  const state = new BotState(dir, cfg.mode);
  const engine = new CopyEngine({
    cfg, exchange: ex, state, log: silent, now: () => NOW, recheckMs: 5,
    targets: targets ? new Map(targets.map((t) => [t, { entity: t }])) : null,
  });
  const decisions = () => readFileSync(state.decisionsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = () => decisions().at(-1)!;
  return { cfg, ex, state, engine, dir, decisions, last };
}
const replay = { source: 'replay' as const };
const ws = { source: 'ws' as const };

describe('BUY', () => {
  it('dry-run: sizes to the budget at the best ask and books the position', async () => {
    const h = setup();
    await h.engine.onFill(fill(), ws);
    expect(h.last()).toMatchObject({ decision: 'dry_run_buy', at: 0.51 });
    const p = h.state.position(T1, 'TOK')!;
    expect(p.shares).toBe('19000000'); // $10 / 0.51 = 19.6, but at 0.51 only whole shares land on the cent grid
    expect(p.buyCount).toBe(1);
    expect(h.ex.buys.length).toBe(0);
  });

  it('live: FOK at the ask, position = net shares after fees', async () => {
    const h = setup({ mode: 'live', polymarket: { privateKey: 'ab'.repeat(32), signatureType: 0 } });
    h.ex.buyResult = (shares, limit) => ({ orderId: 'o1', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 10_000n, netShares: shares - 20_000n });
    await h.engine.onFill(fill(), ws);
    expect(h.ex.buys).toEqual([{ limit: toMicro('0.51'), shares: 19_000_000n }]);
    expect(h.state.position(T1, 'TOK')!.shares).toBe(String(19_000_000n - 20_000n));
    expect(h.last()).toMatchObject({ decision: 'bought', orderId: 'o1' });
    expect(h.state.spentToday(new Date(NOW))).toBe((19_000_000n * 510_000n) / 1_000_000n);
  });

  it('never decides the same fill twice, and copies one decision per target transaction', async () => {
    const h = setup();
    const f = fill();
    await h.engine.onFill(f, ws);
    await h.engine.onFill(f, replay);
    await h.engine.onFill({ ...f, eventId: f.eventId.replace(/:1$/, ':2'), logIndex: 2 }, ws); // another leg of the same tx
    expect(h.decisions().map((d) => d.decision)).toEqual(['dry_run_buy', 'skipped_same_tx']);
  });

  it('remembers decided fills across a restart', async () => {
    const h = setup();
    const f = fill();
    await h.engine.onFill(f, ws);
    const again = new CopyEngine({ cfg: h.cfg, exchange: h.ex, state: new BotState(h.dir, h.cfg.mode), log: silent, now: () => NOW, targets: null });
    await again.onFill(f, replay);
    expect(h.decisions().length).toBe(1);
  });

  it('skips stale fills — a replay after downtime must not trade history', async () => {
    const h = setup();
    await h.engine.onFill(fill({ ts: '2026-09-24 11:55:00' }), replay);
    expect(h.last()).toMatchObject({ decision: 'skipped_stale', ageSec: 300 });
  });

  it.each([
    ['skipped_small_target_trade', { usdc: '5000000' }, {}],
    ['skipped_slippage', { price: '0.450000' }, {}],
    ['skipped_role', { role: 'maker' as const }, { copy: { roles: ['taker'] } }],
  ])('%s', async (decision, f, raw) => {
    const h = setup(raw);
    await h.engine.onFill(fill(f), ws);
    expect(h.last().decision).toBe(decision);
  });

  it('only copies configured targets', async () => {
    const h = setup({}, [T2]);
    await h.engine.onFill(fill(), ws);
    expect(h.last().decision).toBe('skipped_not_a_target');
  });

  it('skips when the book has moved out of band or is thin', async () => {
    const h = setup();
    h.ex.book = { ...h.ex.book, asks: [{ price: toMicro('0.51'), size: toMicro('20') }] };
    await h.engine.onFill(fill(), ws);
    expect(h.last()).toMatchObject({ decision: 'skipped_book', reason: expect.stringMatching(/depth/) });
  });

  it('caps DCA at maxBuysPerOutcome and opens at most maxOpenPositionsPerTarget outcomes', async () => {
    const h = setup({ copy: { maxBuysPerOutcome: 2, maxOpenPositionsPerTarget: 1 } });
    for (let i = 0; i < 3; i++) await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill({ tokenId: 'OTHER' }), ws);
    expect(h.decisions().map((d) => d.decision)).toEqual(['dry_run_buy', 'dry_run_buy', 'skipped_max_buys_per_outcome', 'skipped_target_position_cap']);
  });

  it('stops buying at the daily spend cap', async () => {
    const h = setup({ risk: { maxDailySpendUsdc: 15 }, copy: { maxBuysPerOutcome: 5 } });
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill(), ws);
    expect(h.decisions().map((d) => d.decision)).toEqual(['dry_run_buy', 'skipped_daily_spend_cap']);
  });

  it('books a fill that landed after the exchange said "killed"', async () => {
    const h = setup({ mode: 'live', polymarket: { privateKey: 'ab'.repeat(32), signatureType: 0 } });
    h.ex.buyResult = () => ({ orderId: 'o9', status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: "order couldn't be fully filled", recheck: true });
    h.ex.lateFill = { shares: 12_000_000n, usdc: 6_120_000n, feeUsdc: 0n, feeShares: 0n };
    await h.engine.onFill(fill(), ws);
    expect(h.state.position(T1, 'TOK')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.state.position(T1, 'TOK')!.shares).toBe('12000000');
    expect(h.last()).toMatchObject({ decision: 'late_fill', orderId: 'o9' });
  });
});

describe('SELL', () => {
  it('exits what we bought following this target — capped at the real balance', async () => {
    const h = setup({ mode: 'live', polymarket: { privateKey: 'ab'.repeat(32), signatureType: 0 } });
    await h.engine.onFill(fill(), ws);
    h.ex.balance = 10_000_000n; // less than the 19 we think we hold
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.ex.sells).toEqual([{ limit: toMicro('0.49'), shares: 10_000_000n }]);
    expect(h.state.position(T1, 'TOK')!.shares).toBe('9000000');
    expect(h.last()).toMatchObject({ decision: 'sold' });
  });

  it('never sells what another target led us into', async () => {
    const h = setup();
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill({ entityId: T2, side: 'SELL' }), ws);
    expect(h.last().decision).toBe('skipped_no_position');
    expect(h.state.position(T1, 'TOK')).toBeDefined();
  });

  it('dry-run sells the whole position at the bid', async () => {
    const h = setup();
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.last()).toMatchObject({ decision: 'dry_run_sell', at: 0.49 });
    expect(h.state.positions()).toEqual([]);
  });

  it('sellMode none holds to settlement', async () => {
    const h = setup({ copy: { sellMode: 'none' } });
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.last().decision).toBe('skipped_sell_mode_none');
  });
});

describe('settlement sweep', () => {
  it('drops resolved positions and records the result', async () => {
    const h = setup();
    await h.engine.onFill(fill(), ws);
    h.ex.market_ = { ...h.ex.market_, closed: true, tokens: [{ tokenId: 'TOK', outcome: 'Yes', winner: true }] };
    await h.engine.sweepSettled();
    expect(h.state.positions()).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'settled', won: true, payout: '$19.00' });
  });
});
