import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fill } from 'pmwallets';
import { buildConfig, type Config } from '../src/config.js';
import { CopyEngine, type Exchange } from '../src/engine.js';
import type { Book, Market, OrderOutcome, TradeFill } from '../src/polymarket.js';
import { BotState, InstanceLock } from '../src/state.js';
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
  lateFill: TradeFill = { shares: 0n, usdc: 0n, feeUsdc: 0n, feeShares: 0n, orderIds: [] };
  fillsCalls: (string | null)[] = [];
  balanceFails = 0;
  async conditionIdFor() { return 'CID'; }
  async market() { return this.market_; }
  async orderbook() { return this.book; }
  async buyFok(_t: string, _c: string, limit: bigint, shares: bigint) { this.buys.push({ limit, shares }); return this.buyResult(shares, limit); }
  async sellFak(_t: string, _c: string, limit: bigint, shares: bigint) { this.sells.push({ limit, shares }); return this.sellResult(shares, limit); }
  async fillsOf(orderId: string | null) { this.fillsCalls.push(orderId); return this.lateFill; }
  async tokenBalance() { if (this.balanceFails > 0) { this.balanceFails--; throw new Error('timeout'); } return this.balance; }
}

const LIVE = { mode: 'live', polymarket: { privateKey: 'ab'.repeat(32), signatureType: 0 } };

function setup(raw: Record<string, any> = {}, targets: string[] | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pmwct-'));
  const cfg: Config = buildConfig({ pmwallets: { apiKey: 'pmw_a_b' }, dataDir: dir, ...raw });
  const ex = new FakeExchange();
  const clock = { t: NOW };
  const make = (state: BotState, exchange: Exchange = ex) => new CopyEngine({
    cfg, exchange, state, log: silent, now: () => clock.t, recheckMs: 1000, exitRetryMs: 1000,
    targets: targets ? new Map(targets.map((t) => [t, { entity: t }])) : null,
  });
  const state = new BotState(dir, cfg.mode);
  const engine = make(state);
  const decisions = () => readFileSync(state.decisionsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = () => decisions().at(-1)!;
  const kinds = () => decisions().map((d) => d.decision);
  /** a fresh engine on the same data directory — what a restart looks like */
  const restart = (exchange: Exchange = ex) => make(new BotState(dir, cfg.mode), exchange);
  return { cfg, ex, state, engine, dir, decisions, last, kinds, clock, restart };
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
    const h = setup(LIVE);
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

  it('the fill is on disk as decided before the order leaves (a crash mid-order cannot double it)', async () => {
    for (const side of ['BUY', 'SELL'] as const) {
      const h = setup(LIVE);
      await h.engine.onFill(fill(), ws);
      const f = fill({ side });
      let onDiskAtSend: boolean | null = null;
      const seeDisk = () => { onDiskAtSend = JSON.parse(readFileSync(h.state.file, 'utf8')).processed.includes(f.eventId); };
      h.ex.buyResult = (shares, limit) => { seeDisk(); return { orderId: 'o', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares }; };
      h.ex.sellResult = (shares, limit) => { seeDisk(); return { orderId: 's', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares }; };
      await h.engine.onFill(f, ws);
      expect(onDiskAtSend).toBe(true);
    }
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

  it('an order still being confirmed on this outcome blocks a second BUY', async () => {
    const h = setup(LIVE);
    h.ex.buyResult = () => ({ orderId: 'o9', status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'killed', recheck: true });
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill(), ws);
    expect(h.kinds()).toEqual(['buy_submitted', 'buy_unconfirmed', 'skipped_order_unconfirmed']);
  });
});

describe('orders whose result is not known', () => {
  it('unconfirmed BUYs hold their budget and position slot against the caps', async () => {
    const h = setup({ ...LIVE, risk: { maxDailySpendUsdc: 15 } });
    h.ex.buyResult = () => ({ orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'post_error', recheck: true });
    await h.engine.onFill(fill({ tokenId: 'TOK' }), ws);
    await h.engine.onFill(fill({ tokenId: 'TOK2' }), ws);
    expect(h.kinds().at(-1)).toBe('skipped_daily_spend_cap');
    expect(h.ex.buys.length).toBe(1);
    const g = setup({ ...LIVE, copy: { maxOpenPositions: 1 } });
    g.ex.buyResult = h.ex.buyResult;
    await g.engine.onFill(fill({ tokenId: 'TOK' }), ws);
    await g.engine.onFill(fill({ tokenId: 'TOK2' }), ws);
    expect(g.kinds().at(-1)).toBe('skipped_position_cap');
  });

  it('an ambiguous match is never booked; it is handed to a human after 5 minutes', async () => {
    const h = setup(LIVE);
    h.ex.buyResult = () => ({ orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'post_error', recheck: true });
    await h.engine.onFill(fill(), ws);
    h.ex.lateFill = { shares: 0n, usdc: 0n, feeUsdc: 0n, feeShares: 0n, orderIds: [], ambiguous: true };
    for (let i = 0; i < 20 && h.state.pendingOrders().length; i++) { h.clock.t += 60_000; await h.engine.tick(); }
    expect(h.state.positions()).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'order_needs_reconcile' });
  });

  it('a "killed" order that did fill is booked by tick() — even after a restart', async () => {
    const h = setup(LIVE);
    h.ex.buyResult = () => ({ orderId: 'o9', status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: "order couldn't be fully filled", recheck: true });
    await h.engine.onFill(fill(), ws);
    expect(h.state.position(T1, 'TOK')).toBeUndefined();
    expect(h.state.pendingOrders()).toMatchObject([{ orderId: 'o9', side: 'buy' }]);
    // the process restarts before the re-check is due
    const again = h.restart();
    h.ex.lateFill = { shares: 12_000_000n, usdc: 6_120_000n, feeUsdc: 0n, feeShares: 0n, orderIds: ['o9'] };
    await again.tick();                       // not due yet
    expect(h.ex.fillsCalls).toEqual([]);
    h.clock.t += 1_000;
    await again.tick();
    expect(h.ex.fillsCalls).toEqual(['o9']);
    const st = new BotState(h.dir, 'live');
    expect(st.position(T1, 'TOK')!.shares).toBe('12000000');
    expect(st.pendingOrders()).toEqual([]);
    expect(st.isBooked('o9')).toBe(true);
    expect(h.last()).toMatchObject({ decision: 'late_fill' });
  });

  it('an order sent without an answer (orderId unknown) is reconciled by matching unattributed trades', async () => {
    const h = setup(LIVE);
    h.ex.buyResult = () => ({ orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'post_error: socket hang up', recheck: true });
    await h.engine.onFill(fill(), ws);
    expect(h.state.pendingOrders()).toMatchObject([{ orderId: null }]);
    h.ex.lateFill = { shares: 19_000_000n, usdc: 9_690_000n, feeUsdc: 0n, feeShares: 0n, orderIds: ['0xabc'] };
    h.clock.t += 1_000;
    await h.engine.tick();
    expect(h.ex.fillsCalls).toEqual([null]);
    expect(h.state.position(T1, 'TOK')!.shares).toBe('19000000');
    expect(h.state.isBooked('0xabc')).toBe(true);
  });

  it('gives up only after repeated empty lookups spanning 5 minutes', async () => {
    const h = setup(LIVE);
    h.ex.buyResult = () => ({ orderId: 'o9', status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'killed', recheck: true });
    await h.engine.onFill(fill(), ws);
    for (let i = 0; i < 20 && h.state.pendingOrders().length; i++) { h.clock.t += 60_000; await h.engine.tick(); }
    expect(h.state.pendingOrders()).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'confirmed_no_fill' });
    expect(h.clock.t - NOW).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('SELL', () => {
  it('exits what we bought following this target — capped at the real balance', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill(), ws);
    h.ex.balance = 10_000_000n; // less than the 19 we think we hold
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.ex.sells).toEqual([{ limit: toMicro('0.49'), shares: 10_000_000n }]);
    expect(h.state.position(T1, 'TOK')!.shares).toBe('9000000');
    expect(h.kinds().slice(-3)).toEqual(['exit_queued', 'sell_submitted', 'sold']);
    expect(h.state.pendingExits().length).toBe(1); // 9 shares still booked: keep trying
  });

  it('never sells shares booked to another target, even when the balance is short', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill({ entityId: T1 }), ws);
    await h.engine.onFill(fill({ entityId: T2 }), ws);
    h.ex.balance = 25_000_000n; // books say 19 + 19; someone sold 13 by hand
    await h.engine.onFill(fill({ entityId: T1, side: 'SELL' }), ws);
    expect(h.ex.sells).toEqual([{ limit: toMicro('0.49'), shares: 6_000_000n }]); // 25 − T2's 19
    expect(h.state.position(T2, 'TOK')!.shares).toBe('19000000');
  });

  it('refuses to sell and asks for a reconcile when everything left is booked to others', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill({ entityId: T1 }), ws);
    await h.engine.onFill(fill({ entityId: T2 }), ws);
    h.ex.balance = 19_000_000n;
    await h.engine.onFill(fill({ entityId: T1, side: 'SELL' }), ws);
    expect(h.ex.sells).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'exit_blocked_reconcile' });
  });

  it('a transient failure before the order is retried until the exit happens', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill(), ws);
    h.ex.balanceFails = 2;
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.ex.sells).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'exit_retry_balance_failed' });
    h.clock.t += 1_000; await h.engine.tick();
    h.clock.t += 2_000; await h.engine.tick();
    expect(h.ex.sells.length).toBe(1);
    expect(h.state.positions()).toEqual([]);
    expect(h.state.pendingExits()).toEqual([]);
    expect(h.last()).toMatchObject({ decision: 'exit_done' });
  });

  it('the pending exit survives a restart', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill(), ws);
    h.ex.balanceFails = 1;
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    const again = h.restart();
    h.clock.t += 1_000;
    await again.tick();
    expect(h.ex.sells.length).toBe(1);
  });

  it('a paused market keeps the exit and retries it; only a resolved one drops it', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill(), ws);
    h.ex.market_ = { ...h.ex.market_, acceptingOrders: false };
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    expect(h.last()).toMatchObject({ decision: 'exit_retry_market_paused' });
    h.ex.market_ = { ...h.ex.market_, acceptingOrders: true };
    h.clock.t += 1_000; await h.engine.tick();
    expect(h.ex.sells.length).toBe(1);
    expect(h.state.positions()).toEqual([]);
  });

  it('an old SELL still exits — freshness is an entry rule only', async () => {
    const h = setup();
    await h.engine.onFill(fill(), ws);
    await h.engine.onFill(fill({ side: 'SELL', ts: '2026-09-24 09:00:00' }), replay);
    expect(h.state.positions()).toEqual([]);
  });

  it('an unconfirmed exit order is waited for, not doubled', async () => {
    const h = setup(LIVE);
    await h.engine.onFill(fill(), ws);
    h.ex.sellResult = () => ({ orderId: 's9', status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'no orders found', recheck: true });
    await h.engine.onFill(fill({ side: 'SELL' }), ws);
    h.clock.t += 1_000;
    h.ex.lateFill = { shares: 19_000_000n, usdc: 9_310_000n, feeUsdc: 0n, feeShares: 0n, orderIds: ['s9'] };
    await h.engine.tick(); // books the late sell first, then the exit finds nothing left
    expect(h.ex.sells.length).toBe(1);
    expect(h.state.positions()).toEqual([]);
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

describe('InstanceLock', () => {
  it('lets one bot per data directory run, and takes over a lock left by a dead process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmwlock-'));
    const a = new InstanceLock(dir, 'live');
    a.acquire();
    expect(() => new InstanceLock(dir, 'live').acquire()).toThrow(/another pmwallets-copytrade/);
    expect(() => new InstanceLock(dir, 'dry-run').acquire()).not.toThrow();
    a.release();
    writeFileSync(join(dir, 'lock.live'), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
    expect(() => new InstanceLock(dir, 'live').acquire()).not.toThrow();
  });
});
