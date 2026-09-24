import type { Fill, FillMeta } from 'pmwallets';
import type { Config, TargetConfig } from './config.js';
import { bookGate, marketGate, slippageGate } from './filters.js';
import type { Logger } from './log.js';
import type { Book, Market, OrderOutcome } from './polymarket.js';
import type { BotState, Position } from './state.js';
import { UNIT, clampLimit, fmtUsd, fromMicro, parseFillTs, roundBuyShares, toMicro } from './units.js';

/** The slice of PolymarketGateway the engine uses — a fake in tests, the real one in production. */
export interface Exchange {
  readonly canTrade: boolean;
  conditionIdFor(tokenId: string): Promise<string>;
  market(conditionId: string, maxAgeMs?: number): Promise<Market>;
  orderbook(tokenId: string): Promise<Book>;
  buyFok(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome>;
  sellFak(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome>;
  fillsOf(orderId: string, conditionId: string, sinceMs: number): Promise<{ shares: bigint; usdc: bigint; feeUsdc: bigint; feeShares: bigint }>;
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
  /** delay before re-checking a "killed" order for a fill that landed anyway */
  recheckMs?: number;
}

type Base = Record<string, unknown> & { eventId: string; target: string };

/**
 * Turns the fills of the traders you follow into your own orders.
 *
 * Every fill is decided exactly once: the eventId is written to the state file BEFORE any order is
 * sent, so a crash between "sent" and "recorded" can at worst miss a copy — never place it twice.
 * All state changes run one at a time through a single lock.
 */
export class CopyEngine {
  private lock: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly timers = new Set<NodeJS.Timeout>();

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
        this.o.log.error('fill handling failed', { eventId: fill.eventId, error: (e as Error).message });
        this.o.state.markProcessed(fill.eventId);
        this.o.state.logDecision({ eventId: fill.eventId, decision: 'error', reason: (e as Error).message });
        this.o.state.save();
      }
    });

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private decide(base: Base, decision: string, extra: Record<string, unknown> = {}): void {
    const { state, log } = this.o;
    state.markProcessed(base.eventId);
    state.logDecision({ ...base, decision, ...extra });
    state.save();
    log.info(decision, { target: short(base.target), ...pick(base, ['side', 'role', 'price']), ...extra });
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
    const age = this.now() - parseFillTs(fill.ts);
    if (!(age <= cfg.copy.maxFillAgeSec * 1000)) return this.decide(base, 'skipped_stale', { ageSec: Math.round(age / 1000) });
    // one copy per target transaction: a taker order that walks several makers, or a maker order
    // hit several times in one tx, is still one decision by the trader
    const txKey = `${target}|${fill.txHash}|${fill.tokenId}|${fill.side}`;
    if (state.isHandledTx(txKey)) return this.decide(base, 'skipped_same_tx');
    state.markHandledTx(txKey);

    if (fill.side === 'BUY') await this.buy(fill, base, target, tcfg);
    else await this.sell(fill, base, target);
  }

  private async buy(fill: Fill, base: Base, target: string, tcfg?: TargetConfig): Promise<void> {
    const { cfg, state, exchange } = this.o;
    if (fromMicro(BigInt(fill.usdc)) < cfg.copy.minTargetNotionalUsdc) return this.decide(base, 'skipped_small_target_trade');

    const held = state.position(target, fill.tokenId);
    const maxBuys = tcfg?.maxBuysPerOutcome ?? cfg.copy.maxBuysPerOutcome;
    if (held && held.buyCount >= maxBuys) return this.decide(base, 'skipped_max_buys_per_outcome', { buyCount: held.buyCount });
    if (!held) {
      const open = state.positions();
      if (open.filter((p) => p.target === target).length >= cfg.copy.maxOpenPositionsPerTarget) return this.decide(base, 'skipped_target_position_cap');
      if (open.length >= cfg.copy.maxOpenPositions) return this.decide(base, 'skipped_position_cap');
    }
    const budget = toMicro(tcfg?.orderSizeUsdc ?? cfg.copy.orderSizeUsdc);
    if (cfg.risk.maxDailySpendUsdc > 0 && state.spentToday(new Date(this.now())) + budget > toMicro(cfg.risk.maxDailySpendUsdc)) {
      return this.decide(base, 'skipped_daily_spend_cap', { spentToday: fmtUsd(state.spentToday(new Date(this.now()))) });
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

    state.logDecision({ ...base, decision: 'buy_submitted', limit: fromMicro(limit), shares: fromMicro(shares) });
    const r = await exchange.buyFok(fill.tokenId, conditionId, limit, shares);
    if (r.status === 'filled') {
      state.addBuy(pos, r.netShares, r.usdc);
      state.addSpend(r.usdc, new Date(this.now()));
      return this.decide(base, 'bought', { orderId: r.orderId, shares: fromMicro(r.netShares), cost: fmtUsd(r.usdc), fee: fmtUsd(r.feeUsdc), avg: avg(r), market: market.question, outcome: outcome.outcome });
    }
    this.decide(base, 'buy_not_filled', { orderId: r.orderId || null, reason: r.reason });
    if (r.recheck && r.orderId) this.recheck('buy', r.orderId, pos, market.question);
  }

  private async sell(fill: Fill, base: Base, target: string): Promise<void> {
    const { cfg, state, exchange, log } = this.o;
    if (cfg.copy.sellMode === 'none') return this.decide(base, 'skipped_sell_mode_none');
    const held = state.position(target, fill.tokenId);
    if (!held) return this.decide(base, 'skipped_no_position');

    let market: Market; let book: Book;
    try {
      market = await exchange.market(held.conditionId, 0);
      book = await exchange.orderbook(fill.tokenId);
    } catch (e) { return this.decide(base, 'sell_lookup_failed', { reason: (e as Error).message.slice(0, 200) }); }
    const mg = marketGate(market, 'sell', cfg.copy, this.now());
    if (!mg.ok) return this.decide(base, 'skipped_market', { reason: mg.reason });
    const bg = bookGate(book, 'sell', cfg.copy);
    if (!bg.ok) return this.decide(base, 'sell_no_bids', { reason: bg.reason });
    const bid = book.bids[0]!.price;

    let shares = BigInt(held.shares);
    if (cfg.mode === 'dry-run') {
      const usdc = (shares * bid) / UNIT;
      state.reduce(target, fill.tokenId, shares);
      return this.decide(base, 'dry_run_sell', { shares: fromMicro(shares), at: fromMicro(bid), proceeds: fmtUsd(usdc), pnl: fmtUsd(usdc - BigInt(held.costUsdc)) });
    }

    // never try to sell more than the account holds: fees, a manual trade or a redeem can leave less
    const balance = await exchange.tokenBalance(fill.tokenId);
    if (balance < shares) shares = balance;
    if (shares <= 0n) {
      state.drop(target, fill.tokenId);
      return this.decide(base, 'skipped_no_balance');
    }
    state.logDecision({ ...base, decision: 'sell_submitted', limit: fromMicro(bid), shares: fromMicro(shares) });
    const r = await exchange.sellFak(fill.tokenId, held.conditionId, bid, shares);
    if (r.status === 'filled') {
      const cost = (BigInt(held.costUsdc) * r.shares) / BigInt(held.shares);
      state.reduce(target, fill.tokenId, r.shares);
      return this.decide(base, 'sold', { orderId: r.orderId, shares: fromMicro(r.shares), proceeds: fmtUsd(r.usdc), pnl: fmtUsd(r.usdc - r.feeUsdc - cost), avg: avg(r) });
    }
    log.warn('target exited but our SELL did not fill — the position is still open', { target: short(target), tokenId: fill.tokenId.slice(0, 16), reason: r.reason });
    this.decide(base, 'sell_not_filled', { orderId: r.orderId || null, reason: r.reason });
    if (r.recheck && r.orderId) this.recheck('sell', r.orderId, { target, tokenId: fill.tokenId, conditionId: held.conditionId }, market.question);
  }

  /**
   * An order the exchange reported as not filled is looked up once more after the trade indexer has
   * caught up. If shares did land, they are booked — otherwise the wallet would hold a position the
   * bot does not know about, and nothing would ever sell it.
   */
  private recheck(side: 'buy' | 'sell', orderId: string, pos: { target: string; tokenId: string; conditionId: string }, question: string): void {
    const since = this.now() - 120_000;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.serial(async () => {
        try {
          const f = await this.o.exchange.fillsOf(orderId, pos.conditionId, since);
          if (f.shares === 0n) return;
          if (side === 'buy') { this.o.state.addBuy({ ...pos, question }, f.shares - f.feeShares, f.usdc); this.o.state.addSpend(f.usdc, new Date(this.now())); }
          else this.o.state.reduce(pos.target, pos.tokenId, f.shares);
          this.o.state.logDecision({ eventId: `recheck:${orderId}`, target: pos.target, decision: 'late_fill', side, orderId, shares: fromMicro(f.shares), usdc: fmtUsd(f.usdc) });
          this.o.state.save();
          this.o.log.warn('an order reported as not filled did fill; position updated', { side, orderId, shares: fromMicro(f.shares) });
        } catch (e) {
          this.o.log.error('could not re-check an unfilled order — verify it on polymarket.com', { side, orderId, error: (e as Error).message });
        }
      });
    }, this.o.recheckMs ?? 30_000);
    this.timers.add(t);
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
