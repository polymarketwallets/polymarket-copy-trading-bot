/**
 * The Polymarket side: market lookups, order books and order placement on the CLOB v2.
 *
 * Ported from a copy-trading bot that ran live on Polymarket. The comments keep the reason for each
 * rule, because every one of them is the answer to an order that was rejected or a fill that was lost.
 */
import { AssetType, Chain, ClobClient, OrderType, Side, type ApiKeyCreds } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import type { PolymarketConfig } from './config.js';
import type { Logger } from './log.js';
import { UNIT, clampLimit, fromMicro, roundBuyShares, roundSellShares, toMicro } from './units.js';

export interface Level { price: bigint; size: bigint }
export interface Book { tokenId: string; bids: Level[]; asks: Level[]; tickSize?: bigint; minOrderSize?: bigint }
export interface Market {
  conditionId: string;
  question: string;
  closed: boolean;
  active: boolean;
  acceptingOrders?: boolean;
  endDate?: string;
  tokens: { tokenId: string; outcome: string; winner?: boolean; price?: number }[];
}

export interface OrderOutcome {
  orderId: string;
  /**
   * filled  = got shares (possibly fewer than asked for a FAK)
   * none    = the exchange took the order and matched nothing
   * failed  = nothing was sent, or the exchange rejected it outright: no fill is possible
   * unknown = sent, but no usable answer came back (timeout, dropped connection): it may have filled
   */
  status: 'filled' | 'none' | 'failed' | 'unknown';
  shares: bigint;
  /** USDC paid (BUY) or received (SELL), fees not deducted */
  usdc: bigint;
  /** taker fee in USDC */
  feeUsdc: bigint;
  /** BUY fees are taken in shares; this is what actually lands in the wallet */
  netShares: bigint;
  reason?: string;
  /** the exchange said "killed" but such responses have carried real partial fills — re-check later */
  recheck?: boolean;
}

export interface TradeFill {
  shares: bigint; usdc: bigint; feeUsdc: bigint; feeShares: bigint; orderIds: string[];
  /**
   * unknown-id lookup: taker orders in this token and side, sent since then, not attributed to anything
   * we booked, that are consistent with what we sent. Never booked automatically — any of them could
   * be a manual trade or another target's order — they are shown to the operator to reconcile.
   */
  candidates?: { orderId: string; shares: bigint; usdc: bigint }[];
}

/** What the unknown-id lookup must match: the order exactly as we sent it. */
export interface OrderMatch { tokenId: string; side: 'buy' | 'sell'; shares: bigint; limit: bigint; isBooked: (id: string) => boolean }

/**
 * How to read what postOrder gave back. Shared rule with the Python bot (testdata/post-classification.json):
 *   answer   — a 2xx body, or any body carrying an order id: the exchange took the order; read it
 *   rejected — a 4xx with a readable error and no order id: the exchange refused it, nothing can fill
 *   unknown  — everything else (5xx, gateway errors, empty or unreadable bodies, transport errors):
 *              the order may have been accepted, so it must be treated as possibly filled
 * The TS SDK does not throw on HTTP errors; it returns `{ error, status }` (status = HTTP code), and
 * `{ error }` with no status when no response arrived at all.
 */
export function classifyPost(resp: unknown): 'answer' | 'rejected' | 'unknown' {
  if (!resp || typeof resp !== 'object') return 'unknown';
  const r = resp as Record<string, unknown>;
  if (r['orderID'] || r['orderId']) return 'answer';
  const httpStatus = typeof r['status'] === 'number' ? (r['status'] as number) : null;
  const err = r['errorMsg'] || r['error'];
  if (httpStatus === null) {
    // a 2xx body has no numeric status; an error with no status is a transport failure
    if (r['error'] !== undefined && r['success'] === undefined) return 'unknown';
    return err ? 'rejected' : 'answer';
  }
  if (httpStatus >= 400 && httpStatus < 500 && typeof err === 'string' && err.trim()) return 'rejected';
  return 'unknown';
}

const ZERO_FILL = /no orders found|couldn't be fully filled|fully filled or killed/i;

export class PolymarketGateway {
  private clob: ClobClient | null = null;
  private readonly tokenToCondition = new Map<string, string>();
  private readonly tickSizes = new Map<string, bigint>();
  private readonly marketCache = new Map<string, { at: number; market: Market }>();

  constructor(private readonly cfg: PolymarketConfig, private readonly log: Logger) {}

  get canTrade(): boolean { return this.clob !== null; }

  private signer: string | null = null;
  /** the address that signs (the private key's), after connect() */
  get signerAddress(): string | null { return this.signer; }

  /** true when Polymarket only lets this account close positions (e.g. a restricted region) */
  async closedOnly(): Promise<boolean> {
    const r: any = await this.requireClob().getClosedOnlyMode();
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    return r?.closed_only === true;
  }

  /** Build the trading client and its L2 credentials. Without a private key the gateway is read-only. */
  async connect(): Promise<void> {
    if (!this.cfg.privateKey) return;
    const account = privateKeyToAccount(this.cfg.privateKey as `0x${string}`);
    this.signer = account.address;
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    const base = {
      host: this.cfg.clobUrl,
      chain: Chain.POLYGON,
      signer,
      signatureType: this.cfg.signatureType,
      funderAddress: this.cfg.funderAddress,
    };
    let creds: ApiKeyCreds | undefined = this.cfg.apiKey && this.cfg.apiSecret && this.cfg.apiPassphrase
      ? { key: this.cfg.apiKey, secret: this.cfg.apiSecret, passphrase: this.cfg.apiPassphrase }
      : undefined;
    if (!creds) {
      const l1 = new ClobClient(base);
      // derive first: it is idempotent and returns the key this wallet already has. create-or-derive
      // tries create() first, and on an existing key the server answers 400 and the SDK throws.
      try { creds = await l1.deriveApiKey(); } catch { creds = undefined; }
      if (!creds?.key) creds = await l1.createApiKey();
      if (!creds?.key || !creds.secret || !creds.passphrase) throw new Error('could not derive Polymarket API credentials');
    }
    this.clob = new ClobClient({ ...base, creds });
    this.log.info('polymarket trading client ready', { signer: account.address, funder: this.cfg.funderAddress ?? account.address });
  }

  private async getJson(path: string): Promise<any> {
    const res = await fetch(`${this.cfg.clobUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) throw new Error(`CLOB ${path} → HTTP ${res.status}: ${String(text).slice(0, 200)}`);
    return body;
  }

  async conditionIdFor(tokenId: string): Promise<string> {
    const hit = this.tokenToCondition.get(tokenId);
    if (hit) return hit;
    const r = await this.getJson(`/markets-by-token/${encodeURIComponent(tokenId)}`);
    const cid = r?.condition_id;
    if (typeof cid !== 'string' || !cid) throw new Error(`no market for token ${tokenId.slice(0, 16)}…`);
    this.tokenToCondition.set(tokenId, cid);
    return cid;
  }

  /** CLOB market by condition id; cached for `maxAgeMs` */
  async market(conditionId: string, maxAgeMs = 30_000): Promise<Market> {
    const hit = this.marketCache.get(conditionId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.market;
    const m = await this.getJson(`/markets/${encodeURIComponent(conditionId)}`);
    if (!m || typeof m !== 'object' || m.error) throw new Error(`CLOB market ${conditionId}: ${JSON.stringify(m).slice(0, 200)}`);
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : typeof v === 'string' ? v.toLowerCase() === 'true' : d);
    const market: Market = {
      conditionId: m.condition_id ?? conditionId,
      question: m.question ?? '',
      closed: bool(m.closed, false),
      active: bool(m.active, true),
      acceptingOrders: m.accepting_orders === undefined ? undefined : bool(m.accepting_orders, true),
      endDate: typeof m.end_date_iso === 'string' && m.end_date_iso ? m.end_date_iso : undefined,
      tokens: (m.tokens ?? []).map((t: any) => ({
        tokenId: String(t.token_id ?? ''), outcome: String(t.outcome ?? ''),
        winner: typeof t.winner === 'boolean' ? t.winner : undefined,
        price: typeof t.price === 'number' ? t.price : undefined,
      })),
    };
    this.marketCache.set(conditionId, { at: Date.now(), market });
    return market;
  }

  /**
   * The CLOB returns asks DESCENDING and bids ASCENDING — the best price is the LAST element. Every
   * caller reads levels[0] as the best, so normalise here: asks ascending, bids descending.
   */
  async orderbook(tokenId: string): Promise<Book> {
    const ob = await this.getJson(`/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!Array.isArray(ob?.bids) || !Array.isArray(ob?.asks)) throw new Error(`malformed book for ${tokenId.slice(0, 16)}…`);
    const lv = (l: any): Level => ({ price: toMicro(l.price), size: toMicro(l.size) });
    const tickSize = ob.tick_size ? toMicro(ob.tick_size) : undefined;
    if (tickSize) this.tickSizes.set(tokenId, tickSize);
    return {
      tokenId,
      asks: ob.asks.map(lv).sort((a: Level, b: Level) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)),
      bids: ob.bids.map(lv).sort((a: Level, b: Level) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0)),
      tickSize,
      minOrderSize: ob.min_order_size ? toMicro(ob.min_order_size) : undefined,
    };
  }

  private requireClob(): ClobClient {
    if (!this.clob) throw new Error('trading client not connected (live mode needs a private key)');
    return this.clob;
  }

  /**
   * BUY exactly `shares` at `limit` or better, or nothing (FOK).
   *
   * Share-denominated createOrder + postOrder, NOT createAndPostMarketOrder: a USDC-budget market BUY
   * can overfill when the book improves between our read and the match (limit 0.21, $10.50 budget,
   * ask 0.20 → 52.5 shares instead of 50). A share-based FOK is exactly N or 0.
   */
  async buyFok(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome> {
    const clob = this.requireClob();
    const price = clampLimit(limit, this.tickSizes.get(tokenId));
    const size = roundBuyShares(shares, price);
    if (size <= 0n) return this.failed('size_zero_after_rounding');
    const since = Date.now() - 30_000;
    let signed;
    try {
      signed = await clob.createOrder({ tokenID: tokenId, price: fromMicro(price), size: fromMicro(size), side: Side.BUY });
    } catch (e) {
      return this.failed(`sign_error: ${(e as Error).message}`.slice(0, 300)); // nothing left this machine
    }
    let resp: any;
    try {
      resp = await clob.postOrder(signed, OrderType.FOK);
    } catch (e) {
      return this.unknown(e);
    }
    return this.settle(resp, 'buy', tokenId, conditionId, since, { shares: size, price });
  }

  /**
   * SELL up to `shares`, taking whatever crosses at `limit` or better, cancelling the rest (FAK). A
   * partial exit beats none; the residual is sold on the target's next SELL or redeemed at settlement.
   */
  async sellFak(tokenId: string, conditionId: string, limit: bigint, shares: bigint): Promise<OrderOutcome> {
    const clob = this.requireClob();
    const price = clampLimit(limit, this.tickSizes.get(tokenId));
    const size = roundSellShares(shares);
    if (size <= 0n) return this.failed('size_zero_after_rounding');
    const since = Date.now() - 30_000;
    let signed;
    try {
      signed = await clob.createMarketOrder({ tokenID: tokenId, price: fromMicro(price), amount: fromMicro(size), side: Side.SELL, orderType: OrderType.FAK });
    } catch (e) {
      return this.failed(`sign_error: ${(e as Error).message}`.slice(0, 300));
    }
    let resp: any;
    try {
      resp = await clob.postOrder(signed, OrderType.FAK);
    } catch (e) {
      return this.unknown(e);
    }
    return this.settle(resp, 'sell', tokenId, conditionId, since, { shares: size, price });
  }

  private failed(reason: string): OrderOutcome {
    return { orderId: '', status: 'failed', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason };
  }

  private unknown(e: unknown): OrderOutcome {
    return { orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: `post_error: ${(e as Error)?.message ?? String(e)}`.slice(0, 300), recheck: true };
  }

  /**
   * Turn the post-order response into what we actually got.
   *
   * The SDK does not throw on HTTP errors; it returns the body. An error WITH an orderID is the
   * exchange's zero-fill answer for FOK/FAK — but a FOK "couldn't be fully filled" reply has been seen
   * carrying a real partial fill (35.22 of 50 shares), so those are flagged for a later re-check. The
   * fill itself is read from our trade history (the response has no reliable per-trade fee), matched
   * on taker_order_id; the response's making/taking amounts are the fallback when history lags.
   */
  private async settle(resp: any, side: 'buy' | 'sell', tokenId: string, conditionId: string, since: number, asked: { shares: bigint; price: bigint }): Promise<OrderOutcome> {
    const kind = classifyPost(resp);
    if (kind === 'unknown') return this.unknown(new Error(`no usable answer: ${JSON.stringify(resp ?? null).slice(0, 200)}`));
    const orderId: string = resp?.orderID || resp?.orderId || '';
    const err = String(resp?.errorMsg || resp?.error || '');
    if (kind === 'rejected') return this.failed(err.slice(0, 300));
    if (err && ZERO_FILL.test(err)) {
      return { orderId, status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: err.slice(0, 200), recheck: true };
    }
    if (err) this.log.warn('order response carried an error with an order id; reading fills', { orderId, err: err.slice(0, 200) });

    let fill: TradeFill | null = await this.fillsOf(orderId, conditionId, since).catch(() => null);
    if (!fill || fill.shares === 0n) {
      // trade history can lag the match; take the response's own amounts
      const making = Number.parseFloat(resp?.makingAmount ?? '0');
      const taking = Number.parseFloat(resp?.takingAmount ?? '0');
      if (making > 0 && taking > 0) {
        const shares = toMicro(side === 'buy' ? taking : making);
        const usdc = toMicro(side === 'buy' ? making : taking);
        fill = { shares, usdc, feeUsdc: 0n, feeShares: 0n, orderIds: [orderId] };
      } else if (String(resp?.status ?? '').toLowerCase() === 'matched') {
        fill = { shares: asked.shares, usdc: (asked.shares * asked.price) / UNIT, feeUsdc: 0n, feeShares: 0n, orderIds: [orderId] };
      }
    }
    if (!fill || fill.shares === 0n) {
      return { orderId, status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'no_fill_found', recheck: true };
    }
    const netShares = side === 'buy' ? fill.shares - fill.feeShares : fill.shares;
    return { orderId, status: 'filled', shares: fill.shares, usdc: fill.usdc, feeUsdc: fill.feeUsdc, netShares, recheck: false };
  }

  /**
   * Our taker fills for one order — or, when the order id never came back (`orderId` null), the taker
   * fills in this token and side since `sinceMs` that are not attributed to any order we already booked.
   *
   * The CLOB cannot filter trades by order id, so scope by market + time and match taker_order_id here
   * (a lookup by `id` silently returns nothing — the trade id is not the order id). All pages: other
   * volume in a busy market can push ours off the first one. BUY taker fees are charged in shares:
   * fee = size × fee_rate_bps / 10000, converted at the fill price.
   */
  async fillsOf(orderId: string | null, conditionId: string, sinceMs: number, match?: OrderMatch): Promise<TradeFill> {
    const clob = this.requireClob();
    const trades = await clob.getTrades({ market: conditionId, after: String(Math.floor(sinceMs / 1000)) }, false);
    return attributeFills(Array.isArray(trades) ? trades : [], orderId, sinceMs, match);
  }

  /** Outcome-token balance of the trading account (1e-6 shares). */
  async tokenBalance(tokenId: string): Promise<bigint> {
    const clob = this.requireClob();
    // The CLOB caches balances server-side: make it re-read the chain first. If that fails, the reading
    // would be the same possibly-stale cache — fail the read instead of letting it count as a fresh one.
    const upd: any = await clob.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    if (upd && typeof upd === 'object' && (upd.error || upd.errorMsg)) throw new Error(`balance refresh failed: ${String(upd.errorMsg || upd.error).slice(0, 200)}`);
    const r: any = await clob.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    return r?.balance ? (String(r.balance).includes('.') ? toMicro(r.balance) : BigInt(r.balance)) : 0n;
  }

  /** USDC balance plus the exchange approvals the CLOB sees for it (spender → allowance, 1e-6). */
  async collateral(): Promise<{ balance: bigint; allowances: Record<string, bigint> }> {
    const clob = this.requireClob();
    const upd: any = await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    if (upd && typeof upd === 'object' && (upd.error || upd.errorMsg)) throw new Error(`balance refresh failed: ${String(upd.errorMsg || upd.error).slice(0, 200)}`);
    const r: any = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    const amount = (v: unknown) => { const t = String(v ?? '0'); return t.includes('.') ? toMicro(t) : BigInt(t || '0'); };
    const allowances: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(r?.allowances ?? {})) allowances[k] = amount(v);
    return { balance: amount(r?.balance), allowances };
  }

  /** USDC available to trade (1e-6). */
  async collateralBalance(): Promise<bigint> {
    const r: any = await this.requireClob().getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    return r?.balance ? (String(r.balance).includes('.') ? toMicro(r.balance) : BigInt(r.balance)) : 0n;
  }
}

/** match_time comes as unix seconds (string or number) or an ISO string */
export function tradeTimeMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const str = String(v ?? '');
  if (/^\d+(\.\d+)?$/.test(str)) { const n = Number(str); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : 0;
}

const EMPTY = (): TradeFill => ({ shares: 0n, usdc: 0n, feeUsdc: 0n, feeShares: 0n, orderIds: [] });

function add(out: TradeFill, t: any): void {
  const size = toMicro(t.size);
  const price = toMicro(t.price);
  const feeShares = (size * BigInt(t.fee_rate_bps || '0')) / 10_000n;
  out.shares += size;
  out.usdc += (size * price) / UNIT;
  out.feeShares += feeShares;
  out.feeUsdc += (feeShares * price) / UNIT;
}

/**
 * Our fills for one order, from our own trade history.
 *
 * Known order id: every trade whose taker_order_id is it. Unknown id (the post never answered): nothing
 * is attributed. The unattributed taker orders in this token and side since the send time that are
 * consistent with what we sent (no more shares than we asked for, every fill at our limit or better)
 * are returned as `candidates`: a similar manual trade, or another target's order in the same token,
 * is indistinguishable from ours by its shape, so only a human can say which one it was.
 */
export function attributeFills(trades: any[], orderId: string | null, sinceMs: number, match?: OrderMatch): TradeFill {
  if (orderId) {
    const out = EMPTY();
    const id = orderId.toLowerCase();
    for (const t of trades) if (String(t.taker_order_id ?? '').toLowerCase() === id) add(out, t);
    if (out.shares > 0n) out.orderIds.push(id);
    return out;
  }
  if (!match) return { ...EMPTY(), candidates: [] };
  const byOrder = new Map<string, any[]>();
  for (const t of trades) {
    const taker = String(t.taker_order_id ?? '').toLowerCase();
    if (!taker || match.isBooked(taker)) continue;
    if (String(t.trader_side ?? '').toUpperCase() !== 'TAKER') continue;
    if (String(t.asset_id) !== match.tokenId || String(t.side ?? '').toLowerCase() !== match.side) continue;
    if (tradeTimeMs(t.match_time) < sinceMs) continue;
    (byOrder.get(taker) ?? byOrder.set(taker, []).get(taker)!).push(t);
  }
  const candidates: { orderId: string; shares: bigint; usdc: bigint }[] = [];
  for (const [id, ts] of byOrder) {
    const out = EMPTY();
    let withinLimit = true;
    for (const t of ts) {
      const px = toMicro(t.price);
      if (match.side === 'buy' ? px > match.limit : px < match.limit) withinLimit = false;
      add(out, t);
    }
    if (withinLimit && out.shares <= match.shares) candidates.push({ orderId: id, shares: out.shares, usdc: out.usdc });
  }
  return { ...EMPTY(), candidates };
}
