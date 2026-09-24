import type { Fill, FillMeta } from 'pmwallets';
import type { Config, TargetConfig } from './config.js';
import { bookGate, marketGate, slippageGate } from './filters.js';
import type { Logger } from './log.js';
import type { Book, Market, OrderMatch, OrderOutcome, TradeFill } from './polymarket.js';
import type { BotState, PendingExit, PendingOrder, Position } from './state.js';
import { UNIT, clampLimit, fmtUsd, fromMicro, parseFillTs, roundBuyShares, toMicro } from './units.js';

/** The slice of PolymarketGateway the engine uses — a fake in tests, the real one in production. */
export interface Exchange {
  readonly canTrade: boolean;
  conditionIdFor(tokenId: string): Promise<string>;
  market(conditionId: string, maxAgeMs?: number): Promise<Market>;
  orderbook(tokenId: string): Promise<Book>;
  buyFok(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome>;
  sellFak(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome>;
  fillsOf(orderId: string | null, conditionId: string, sinceMs: number, match?: OrderMatch): Promise<TradeFill>;
  tokenBalance(tokenId: string): Promise<bigint>;
}

export interface EngineOptions {
  cfg: Config;
  exchange: Exchange;
  state: BotState;
  log: Logger;
  /** address → per-target settings; null = copy every entity the account subscribes to */
  targets: Map<string, TargetConfig> | null;
  now?: () => number;
  /** first delay before an unconfirmed order is looked up again (default 30 s, doubling) */
  recheckMs?: number;
  /** first delay before a failed exit is retried (default 30 s, doubling, capped at 5 min) */
  exitRetryMs?: number;
}

type Base = Record<string, unknown> & { eventId: string; target: string };

/** an unconfirmed order that stays unmatched after this many lookups (and 5 minutes) had no fill */
const RECHECK_ATTEMPTS = 5;
const RECHECK_MIN_AGE_MS = 5 * 60_000;
/** an order that cannot be looked up for a day is surrendered to the operator */
const RECHECK_GIVE_UP_MS = 24 * 3600_000;

/**
 * Turns the fills of the traders you follow into your own orders.
 *
 * - Every fill is decided at most once: the eventId — and, for an order, a pending-order record — is
 *   written to the state file BEFORE the order is sent. A crash then costs at most a missed copy,
 *   never a second order, and the pending record lets the next run find out whether it filled.
 * - An order whose result is not known (killed-but-maybe-filled, or no answer) is looked up again
 *   from `tick()` until its fill or its absence is established — the record survives restarts.
 * - A target's SELL becomes a persisted exit, retried until the position is gone.
 * - All state changes run one at a time through a single lock.
 */
export class CopyEngine {
  private lock: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly o: EngineOptions) {
    this.now = o.now ?? Date.now;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The FillStream handler. Never throws: a throw would make the stream redeliver, forever. */
  onFill = (fill: Fill, meta: FillMeta): Promise<void> =>
    this.serial(async () => {
      try {
        await this.handle(fill, meta);
      } catch (e) {
        // only reached by a bug: every expected failure is a decision, a pending order or a pending exit
        this.o.log.error('fill handling failed', { eventId: fill.eventId, error: (e as Error).message });
        this.o.state.markProcessed(fill.eventId);
        this.o.state.logDecision({ eventId: fill.eventId, decision: 'error', reason: (e as Error).message });
        this.o.state.save();
      }
    });

  private decide(base: Base, decision: string, extra: Record<string, unknown> = {}): void {
    const { state, log } = this.o;
    state.markProcessed(base.eventId);
    state.logDecision({ ...base, decision, ...extra });
    state.save();
    log.info(decision, { target: short(base.target), ...pick(base, ['side', 'role', 'price']), ...extra });
  }

  private record(entry: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.o.state.logDecision(entry);
    this.o.state.save();
    this.o.log[level](String(entry['decision']), { ...entry, target: typeof entry['target'] === 'string' ? short(entry['target']) : undefined });
  }

  /**
   * Persist "decided" plus a pending-order record BEFORE the order leaves. This is the at-most-once
   * guarantee, and the record is how a fill whose answer was lost still gets booked.
   */
  private commitOrder(eventId: string | null, pending: PendingOrder, entry: Record<string, unknown>): void {
    const { state } = this.o;
    if (eventId) state.markProcessed(eventId);
    state.addPendingOrder(pending);
    state.logDecision(entry);
    state.save();
  }

  private async handle(fill: Fill, meta: FillMeta): Promise<void> {
    const { cfg, state, targets } = this.o;
    if (state.isProcessed(fill.eventId)) return;
    const target = fill.entityId.toLowerCase();
    const base: Base = {
      eventId: fill.eventId, target, wallet: fill.wallet, side: fill.side, role: fill.role, tokenId: fill.tokenId,
      price: fill.price, usdc: fromMicro(BigInt(fill.usdc)), tx: fill.txHash, source: meta.source,
    };

    const tcfg = targets?.get(target);
    if (targets && !tcfg) return this.decide(base, 'skipped_not_a_target');
    if (!cfg.copy.roles.includes(fill.role)) return this.decide(base, 'skipped_role');
    // one copy per target transaction: a taker order that walks several makers, or a maker order
    // hit several times in one tx, is still one decision by the trader
    const txKey = `${target}|${fill.txHash}|${fill.tokenId}|${fill.side}`;
    if (state.isHandledTx(txKey)) return this.decide(base, 'skipped_same_tx');

    if (fill.side === 'BUY') {
      // freshness is an ENTRY rule: a replay after downtime must not buy history. An exit is not
      // subject to it — if the target left while we were down, we still want out.
      const age = this.now() - parseFillTs(fill.ts);
      if (!(age <= cfg.copy.maxFillAgeSec * 1000)) return this.decide(base, 'skipped_stale', { ageSec: Math.round(age / 1000) });
      state.markHandledTx(txKey);
      return this.buy(fill, base, target, tcfg);
    }
    state.markHandledTx(txKey);
    if (cfg.copy.sellMode === 'none') return this.decide(base, 'skipped_sell_mode_none');
    // a BUY still being confirmed may turn into a position: queue the exit anyway, it waits for the BUY
    const buyPending = this.pendingBuy(target, fill.tokenId);
    if (!state.position(target, fill.tokenId) && !buyPending) return this.decide(base, 'skipped_no_position');
    state.addPendingExit({ eventId: fill.eventId, target, tokenId: fill.tokenId, firstAt: this.now(), attempts: 0, nextAt: this.now() });
    this.decide(base, 'exit_queued');
    await this.attemptExit(state.pendingExits().find((e) => e.target === target && e.tokenId === fill.tokenId)!);
  }

  private async buy(fill: Fill, base: Base, target: string, tcfg?: TargetConfig): Promise<void> {
    const { cfg, state, exchange } = this.o;
    if (fromMicro(BigInt(fill.usdc)) < cfg.copy.minTargetNotionalUsdc) return this.decide(base, 'skipped_small_target_trade');

    const held = state.position(target, fill.tokenId);
    const maxBuys = tcfg?.maxBuysPerOutcome ?? cfg.copy.maxBuysPerOutcome;
    if (held && held.buyCount >= maxBuys) return this.decide(base, 'skipped_max_buys_per_outcome', { buyCount: held.buyCount });
    if (state.hasUnknownReservation()) return this.decide(base, 'skipped_reconcile_required');
    // an order still being confirmed on this outcome counts as open: buying again could double up
    if (state.pendingOrders().some((p) => p.target === target && p.tokenId === fill.tokenId && p.side === 'buy')) {
      return this.decide(base, 'skipped_order_unconfirmed');
    }
    // the caps count unconfirmed BUYs too: each may turn out filled, and all of them together must
    // still fit inside the limits the user set
    if (!held) {
      const open = state.openOutcomes();
      if (open.filter((p) => p.target === target).length >= cfg.copy.maxOpenPositionsPerTarget) return this.decide(base, 'skipped_target_position_cap');
      if (open.length >= cfg.copy.maxOpenPositions) return this.decide(base, 'skipped_position_cap');
    }
    const budget = toMicro(tcfg?.orderSizeUsdc ?? cfg.copy.orderSizeUsdc);
    const committed = state.spentToday(new Date(this.now())) + state.reservedUsdc();
    if (cfg.risk.maxDailySpendUsdc > 0 && committed + budget > toMicro(cfg.risk.maxDailySpendUsdc)) {
      return this.decide(base, 'skipped_daily_spend_cap', { spentToday: fmtUsd(state.spentToday(new Date(this.now()))), reserved: fmtUsd(state.reservedUsdc()) });
    }

    let conditionId: string; let market: Market; let book: Book;
    try {
      conditionId = held?.conditionId ?? await exchange.conditionIdFor(fill.tokenId);
      market = await exchange.market(conditionId);
    } catch (e) { return this.decide(base, 'skipped_market_lookup_failed', { reason: (e as Error).message.slice(0, 200) }); }
    const mg = marketGate(market, 'buy', cfg.copy, this.now());
    if (!mg.ok) return this.decide(base, 'skipped_market', { reason: mg.reason });
    const outcome = market.tokens.find((t) => t.tokenId === fill.tokenId);
    if (!outcome) return this.decide(base, 'skipped_token_not_in_market');
    try { book = await exchange.orderbook(fill.tokenId); } catch (e) { return this.decide(base, 'skipped_book_failed', { reason: (e as Error).message.slice(0, 200) }); }
    const bg = bookGate(book, 'buy', cfg.copy);
    if (!bg.ok) return this.decide(base, 'skipped_book', { reason: bg.reason });
    const ask = book.asks[0]!.price;
    const sg = slippageGate(ask, toMicro(fill.price), cfg.copy);
    if (!sg.ok) return this.decide(base, 'skipped_slippage', { reason: sg.reason });

    const limit = clampLimit(ask, book.tickSize);
    const shares = roundBuyShares((budget * UNIT) / ask, limit);
    if (shares <= 0n || (book.minOrderSize && shares < book.minOrderSize)) {
      return this.decide(base, 'skipped_below_min_order', { shares: fromMicro(shares), min: book.minOrderSize ? fromMicro(book.minOrderSize) : null });
    }
    const pos = { target, tokenId: fill.tokenId, conditionId, question: market.question, outcome: outcome.outcome };

    if (cfg.mode === 'dry-run') {
      const usdc = (shares * ask) / UNIT;
      state.addBuy(pos, shares, usdc);
      state.addSpend(usdc, new Date(this.now()));
      return this.decide(base, 'dry_run_buy', { shares: fromMicro(shares), at: fromMicro(ask), cost: fmtUsd(usdc), market: market.question, outcome: outcome.outcome });
    }

    const key = `buy|${fill.eventId}`;
    const reserve = (shares * limit) / UNIT;
    this.commitOrder(fill.eventId, { key, side: 'buy', orderId: null, ...pos, shares: shares.toString(), limit: limit.toString(), reserveUsdc: reserve.toString(), sentAt: this.now(), attempts: 0, nextAt: this.now() + this.recheckDelay(0) },
      { ...base, decision: 'buy_submitted', limit: fromMicro(limit), shares: fromMicro(shares) });
    const r = await exchange.buyFok(fill.tokenId, conditionId, limit, shares);
    this.afterOrder(key, r, base, { market: market.question, outcome: outcome.outcome });
  }

  /** Book what an order did, or leave its pending record for tick() to resolve. */
  private afterOrder(key: string, r: OrderOutcome, base: Record<string, unknown>, extra: Record<string, unknown>): void {
    const { state } = this.o;
    const p = state.pendingOrders().find((x) => x.key === key);
    if (!p) return;
    if (r.status === 'filled') {
      state.removePendingOrder(key);
      this.book(p, { shares: r.shares, usdc: r.usdc, feeUsdc: r.feeUsdc, feeShares: r.shares - r.netShares, orderIds: [r.orderId] });
      this.record({ ...base, decision: p.side === 'buy' ? 'bought' : 'sold', orderId: r.orderId, shares: fromMicro(p.side === 'buy' ? r.netShares : r.shares), usdc: fmtUsd(r.usdc), fee: fmtUsd(r.feeUsdc), avg: avg(r), ...extra });
      return;
    }
    if (r.status === 'failed') {
      state.removePendingOrder(key);
      this.record({ ...base, decision: p.side === 'buy' ? 'buy_rejected' : 'sell_rejected', reason: r.reason });
      return;
    }
    // none / unknown: it may still have filled — keep the record, tick() will find out
    state.updatePendingOrder(key, { orderId: r.orderId || null });
    this.record({ ...base, decision: p.side === 'buy' ? 'buy_unconfirmed' : 'sell_unconfirmed', orderId: r.orderId || null, reason: r.reason }, r.status === 'unknown' ? 'warn' : 'info');
  }

  private pendingBuy(target: string, tokenId: string): boolean {
    return this.o.state.pendingOrders().some((p) => p.side === 'buy' && p.target === target && p.tokenId === tokenId);
  }

  /** Hand an order to a human. It stays pending — reservation and all — until `reconcile()`. */
  private needsReconcile(p: PendingOrder, reason: string): void {
    this.o.state.updatePendingOrder(p.key, { needsReconcile: reason });
    this.record({ eventId: `recheck:${p.key}`, target: p.target, decision: 'order_needs_reconcile', side: p.side, orderId: p.orderId, tokenId: p.tokenId, key: p.key, reason }, 'error');
  }

  /**
   * The operator's verdict on an order the bot could not settle: `null` = it did not fill; otherwise
   * the shares and USDC it filled for (read them off polymarket.com). Releases the reservation.
   */
  reconcile(key: string, result: { shares: bigint; usdc: bigint } | null): Promise<void> {
    return this.serial(async () => {
      const { state } = this.o;
      const p = state.pendingOrders().find((x) => x.key === key);
      if (!p) throw new Error(`no pending order ${key}`);
      state.removePendingOrder(key);
      if (result && result.shares > 0n) this.book(p, { shares: result.shares, usdc: result.usdc, feeUsdc: 0n, feeShares: 0n, orderIds: p.orderId ? [p.orderId] : [] });
      this.record({ eventId: `reconcile:${key}`, target: p.target, decision: 'reconciled', side: p.side, tokenId: p.tokenId, filled: result ? fromMicro(result.shares) : 0, usdc: result ? fmtUsd(result.usdc) : '$0.00' });
    });
  }

  /** Apply a fill to the books. BUY fees are taken in shares, so the position is what actually landed. */
  private book(p: PendingOrder, f: TradeFill): void {
    const { state } = this.o;
    for (const id of f.orderIds) if (id) state.markBooked(id);
    if (p.side === 'buy') {
      state.addBuy({ target: p.target, tokenId: p.tokenId, conditionId: p.conditionId, question: p.question, outcome: p.outcome }, f.shares - f.feeShares, f.usdc);
      state.addSpend(f.usdc, new Date(this.now()));
    } else {
      state.reduce(p.target, p.tokenId, f.shares);
    }
  }

  private recheckDelay(attempts: number): number {
    return Math.min((this.o.recheckMs ?? 30_000) * 2 ** attempts, 10 * 60_000);
  }
  private exitDelay(attempts: number): number {
    return Math.min((this.o.exitRetryMs ?? 30_000) * 2 ** attempts, 5 * 60_000);
  }

  /**
   * Sell what this target led us into. Called right away when the target sells, and again from tick()
   * until the position is gone. Sells at most min(our position, balance − what other targets hold
   * in the same token): the wallet's balance is shared, the books are per target.
   */
  private async attemptExit(exit: PendingExit): Promise<void> {
    const { cfg, state, exchange, log } = this.o;
    const { target, tokenId } = exit;
    const base = { eventId: exit.eventId, target, tokenId, side: 'SELL' };
    const retry = (decision: string, extra: Record<string, unknown> = {}) => {
      state.updatePendingExit(target, tokenId, { attempts: exit.attempts + 1, nextAt: this.now() + this.exitDelay(exit.attempts) });
      this.record({ ...base, decision, attempt: exit.attempts + 1, ...extra }, 'warn');
    };
    const done = (decision: string, extra: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') => {
      state.removePendingExit(target, tokenId);
      this.record({ ...base, decision, ...extra }, level);
    };

    const held = state.position(target, tokenId);
    if (!held) {
      // the BUY that would give us the position is still being confirmed (or awaits reconcile): wait
      // for its verdict — filled means sell it, not filled means there is nothing to exit
      if (this.pendingBuy(target, tokenId)) {
        state.updatePendingExit(target, tokenId, { nextAt: this.now() + this.exitDelay(0) });
        state.save();
        return;
      }
      return done('exit_done');
    }
    // an exit order still being confirmed: wait for it rather than sell the same shares twice
    if (state.pendingOrders().some((p) => p.target === target && p.tokenId === tokenId && p.side === 'sell')) {
      state.updatePendingExit(target, tokenId, { nextAt: this.now() + this.exitDelay(0) });
      state.save();
      return;
    }

    let market: Market; let book: Book;
    try {
      market = await exchange.market(held.conditionId, 0);
      book = await exchange.orderbook(tokenId);
    } catch (e) { return retry('exit_retry_lookup_failed', { reason: (e as Error).message.slice(0, 200) }); }
    // resolved: the settlement sweep takes it from here. Paused (inactive / not accepting orders) is
    // temporary — keep the exit and try again, or a pause during the target's SELL strands us in it.
    if (market.closed) return done('exit_dropped_market_closed');
    const mg = marketGate(market, 'sell', cfg.copy, this.now());
    if (!mg.ok) return retry('exit_retry_market_paused', { reason: mg.reason });
    const bg = bookGate(book, 'sell', cfg.copy);
    if (!bg.ok) return retry('exit_retry_no_bids');
    const bid = book.bids[0]!.price;
    let shares = BigInt(held.shares);

    if (cfg.mode === 'dry-run') {
      const usdc = (shares * bid) / UNIT;
      state.reduce(target, tokenId, shares);
      return done('dry_run_sell', { shares: fromMicro(shares), at: fromMicro(bid), proceeds: fmtUsd(usdc), pnl: fmtUsd(usdc - BigInt(held.costUsdc)) });
    }

    let balance: bigint;
    try { balance = await exchange.tokenBalance(tokenId); } catch (e) { return retry('exit_retry_balance_failed', { reason: (e as Error).message.slice(0, 200) }); }
    const others = state.sharesHeldByOthers(target, tokenId);
    const available = balance - others;
    if (available < shares) shares = available > 0n ? available : 0n;
    if (shares <= 0n) {
      if (balance === 0n) { state.drop(target, tokenId); return done('exit_no_balance'); }
      log.error('the wallet holds less of this outcome than the books say; not selling shares booked to other targets — reconcile by hand', { target: short(target), tokenId: tokenId.slice(0, 16), balance: fromMicro(balance), bookedToOthers: fromMicro(others) });
      return done('exit_blocked_reconcile', { balance: fromMicro(balance), bookedToOthers: fromMicro(others) }, 'error');
    }

    const key = `sell|${exit.eventId}|${exit.attempts}`;
    this.commitOrder(null, { key, side: 'sell', orderId: null, target, tokenId, conditionId: held.conditionId, question: held.question, outcome: held.outcome, shares: shares.toString(), limit: clampLimit(bid, book.tickSize).toString(), reserveUsdc: '0', sentAt: this.now(), attempts: 0, nextAt: this.now() + this.recheckDelay(0) },
      { ...base, decision: 'sell_submitted', limit: fromMicro(bid), shares: fromMicro(shares) });
    const r = await exchange.sellFak(tokenId, held.conditionId, bid, shares);
    const costOfSold = (BigInt(held.costUsdc) * r.shares) / BigInt(held.shares);
    this.afterOrder(key, r, base, r.status === 'filled' ? { pnl: fmtUsd(r.usdc - r.feeUsdc - costOfSold) } : {});
    if (r.status === 'filled' && !state.position(target, tokenId)) return done('exit_done');
    // partial, unfilled, unconfirmed or rejected: try again later
    state.updatePendingExit(target, tokenId, { attempts: exit.attempts + 1, nextAt: this.now() + this.exitDelay(exit.attempts) });
    state.save();
  }

  /**
   * Periodic work: resolve orders whose outcome is not known yet, retry pending exits. Everything it
   * needs is in the state file, so it picks up exactly where a previous run stopped.
   */
  tick(): Promise<void> {
    return this.serial(async () => {
      const { state, exchange } = this.o;
      const now = this.now();
      for (const p of [...state.pendingOrders()]) {
        if (p.needsReconcile || p.nextAt > now) continue;
        let f: TradeFill;
        try {
          f = await exchange.fillsOf(p.orderId, p.conditionId, p.orderId ? p.sentAt - 30_000 : p.sentAt - 5_000,
            { tokenId: p.tokenId, side: p.side, shares: BigInt(p.shares), limit: BigInt(p.limit), isBooked: (id) => state.isBooked(id) });
        } catch (e) {
          if (now - p.sentAt > RECHECK_GIVE_UP_MS) {
            this.needsReconcile(p, `could not look the order up for a day: ${(e as Error).message.slice(0, 160)}`);
          } else {
            state.updatePendingOrder(p.key, { attempts: p.attempts + 1, nextAt: now + this.recheckDelay(p.attempts + 1) });
            state.save();
          }
          continue;
        }
        if (f.candidates?.length) {
          // the answer to our post was lost and something that looks like it filled: it may be ours, a
          // manual trade, or another target's order — booking it to this target could sell the wrong
          // position later. Keep the reservation and let the operator decide.
          this.needsReconcile(p, `the order id never came back; possible fill(s): ${f.candidates.map((c) => `${c.orderId} ${fromMicro(c.shares)} sh / ${fmtUsd(c.usdc)}`).join('; ')}`);
          continue;
        }
        if (f.shares > 0n) {
          state.removePendingOrder(p.key);
          this.book(p, f);
          this.record({ eventId: `recheck:${p.key}`, target: p.target, decision: 'late_fill', side: p.side, orderId: p.orderId ?? f.orderIds.join(','), shares: fromMicro(p.side === 'buy' ? f.shares - f.feeShares : f.shares), usdc: fmtUsd(f.usdc) }, 'warn');
          continue;
        }
        if (p.attempts + 1 >= RECHECK_ATTEMPTS && now - p.sentAt >= RECHECK_MIN_AGE_MS) {
          state.removePendingOrder(p.key);
          this.record({ eventId: `recheck:${p.key}`, target: p.target, decision: 'confirmed_no_fill', side: p.side, orderId: p.orderId });
        } else {
          state.updatePendingOrder(p.key, { attempts: p.attempts + 1, nextAt: now + this.recheckDelay(p.attempts + 1) });
          state.save();
        }
      }
      for (const e of [...state.pendingExits()]) {
        if (e.nextAt > now) continue;
        await this.attemptExit(e);
      }
    });
  }

  /**
   * Drop positions whose market has resolved: the winning side is redeemed on Polymarket (auto-redeem
   * or by hand), and a resolved position must stop counting against the position caps.
   */
  sweepSettled(): Promise<void> {
    return this.serial(async () => {
      for (const p of this.o.state.positions()) {
        let m: Market;
        try { m = await this.o.exchange.market(p.conditionId, 0); } catch { continue; }
        if (!m.closed) continue;
        const tok = m.tokens.find((t) => t.tokenId === p.tokenId);
        const winner = tok?.winner === true || (tok?.price !== undefined && tok.price >= 0.99);
        const value = winner ? BigInt(p.shares) : 0n;
        this.o.state.drop(p.target, p.tokenId);
        this.o.state.removePendingExit(p.target, p.tokenId);
        this.o.state.logDecision({ eventId: `settle:${p.conditionId}:${p.tokenId}:${p.target}`, target: p.target, decision: 'settled', market: m.question, outcome: p.outcome, won: winner, payout: fmtUsd(value), pnl: fmtUsd(value - BigInt(p.costUsdc)) });
        this.o.log.info('settled', { target: short(p.target), market: m.question, outcome: p.outcome, won: winner, pnl: fmtUsd(value - BigInt(p.costUsdc)) });
      }
      this.o.state.save();
    });
  }

  /** for tests and the status command */
  positions(): Position[] { return this.o.state.positions(); }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const avg = (r: OrderOutcome) => (r.shares > 0n ? Number(((r.usdc * UNIT) / r.shares)) / 1e6 : null);
function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
