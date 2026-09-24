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
  /** filled = got shares (possibly fewer than asked for a FAK); none = nothing matched; failed = rejected */
  status: 'filled' | 'none' | 'failed';
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

interface TradeFill { shares: bigint; usdc: bigint; feeUsdc: bigint; feeShares: bigint }

const ZERO_FILL = /no orders found|couldn't be fully filled|fully filled or killed/i;

export class PolymarketGateway {
  private clob: ClobClient | null = null;
  private readonly tokenToCondition = new Map<string, string>();
  private readonly tickSizes = new Map<string, bigint>();
  private readonly marketCache = new Map<string, { at: number; market: Market }>();

  constructor(private readonly cfg: PolymarketConfig, private readonly log: Logger) {}

  get canTrade(): boolean { return this.clob !== null; }

  /** Build the trading client and its L2 credentials. Without a private key the gateway is read-only. */
  async connect(): Promise<void> {
    if (!this.cfg.privateKey) return;
    const account = privateKeyToAccount(this.cfg.privateKey as `0x${string}`);
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
    let resp: any;
    try {
      const signed = await clob.createOrder({ tokenID: tokenId, price: fromMicro(price), size: fromMicro(size), side: Side.BUY });
      resp = await clob.postOrder(signed, OrderType.FOK);
    } catch (e) {
      return this.failed(`sdk_error: ${(e as Error).message}`.slice(0, 300));
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
    let resp: any;
    try {
      resp = await clob.createAndPostMarketOrder(
        { tokenID: tokenId, price: fromMicro(price), amount: fromMicro(size), side: Side.SELL },
        undefined,
        OrderType.FAK,
      );
    } catch (e) {
      return this.failed(`sdk_error: ${(e as Error).message}`.slice(0, 300));
    }
    return this.settle(resp, 'sell', tokenId, conditionId, since, { shares: size, price });
  }

  private failed(reason: string): OrderOutcome {
    return { orderId: '', status: 'failed', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason };
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
    const orderId: string = resp?.orderID || resp?.orderId || resp?.id || '';
    const err = String(resp?.errorMsg || resp?.error || '');
    if (!resp || (err && !orderId)) return this.failed(err || 'empty_response');
    if (err && ZERO_FILL.test(err)) {
      return { orderId, status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: err.slice(0, 200), recheck: true };
    }
    if (err) this.log.warn('order response carried an error with an order id; reading fills', { orderId, err: err.slice(0, 200) });

    let fill = await this.fillsOf(orderId, conditionId, since).catch(() => null);
    if (!fill || fill.shares === 0n) {
      // trade history can lag the match; take the response's own amounts
      const making = Number.parseFloat(resp?.makingAmount ?? '0');
      const taking = Number.parseFloat(resp?.takingAmount ?? '0');
      if (making > 0 && taking > 0) {
        const shares = toMicro(side === 'buy' ? taking : making);
        const usdc = toMicro(side === 'buy' ? making : taking);
        fill = { shares, usdc, feeUsdc: 0n, feeShares: 0n };
      } else if (String(resp?.status ?? '').toLowerCase() === 'matched') {
        fill = { shares: asked.shares, usdc: (asked.shares * asked.price) / UNIT, feeUsdc: 0n, feeShares: 0n };
      }
    }
    if (!fill || fill.shares === 0n) {
      return { orderId, status: 'none', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'no_fill_found', recheck: true };
    }
    const netShares = side === 'buy' ? fill.shares - fill.feeShares : fill.shares;
    return { orderId, status: 'filled', shares: fill.shares, usdc: fill.usdc, feeUsdc: fill.feeUsdc, netShares, recheck: false };
  }

  /**
   * Our fills for one order. The CLOB cannot filter trades by order id, so scope by market + time
   * and match taker_order_id here (a lookup by `id` silently returns nothing — the trade id is not
   * the order id). All pages: other volume in a busy market can push ours off the first one.
   * BUY taker fees are charged in shares: fee = size × fee_rate_bps / 10000, converted at fill price.
   */
  async fillsOf(orderId: string, conditionId: string, sinceMs: number): Promise<TradeFill> {
    const clob = this.requireClob();
    const trades = await clob.getTrades({ market: conditionId, after: String(Math.floor(sinceMs / 1000)) }, false);
    const out: TradeFill = { shares: 0n, usdc: 0n, feeUsdc: 0n, feeShares: 0n };
    const id = orderId.toLowerCase();
    for (const t of Array.isArray(trades) ? trades : []) {
      if (String(t.taker_order_id ?? '').toLowerCase() !== id) continue;
      const size = toMicro(t.size);
      const price = toMicro(t.price);
      const feeShares = (size * BigInt(t.fee_rate_bps || '0')) / 10_000n;
      out.shares += size;
      out.usdc += (size * price) / UNIT;
      out.feeShares += feeShares;
      out.feeUsdc += (feeShares * price) / UNIT;
    }
    return out;
  }

  /** Outcome-token balance of the trading account (1e-6 shares). */
  async tokenBalance(tokenId: string): Promise<bigint> {
    const r: any = await this.requireClob().getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    return r?.balance ? (String(r.balance).includes('.') ? toMicro(r.balance) : BigInt(r.balance)) : 0n;
  }

  /** USDC available to trade (1e-6). */
  async collateralBalance(): Promise<bigint> {
    const r: any = await this.requireClob().getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    if (r?.error || r?.errorMsg) throw new Error(String(r.errorMsg || r.error));
    return r?.balance ? (String(r.balance).includes('.') ? toMicro(r.balance) : BigInt(r.balance)) : 0n;
  }
}
