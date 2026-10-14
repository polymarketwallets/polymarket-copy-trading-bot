/**
 * One-off trading commands for AI agents and scripts: look a market up, read the account, place one order.
 *
 * These do not touch the copy engine's books (positions, daily spend, pending orders): an order placed here is the
 * caller's own trade. What they do keep is the rule the engine lives by — an order is sent at most once: with a
 * `key` (use the fill's eventId), the key is claimed on disk BEFORE the order leaves, and any later call with the
 * same key returns what happened the first time instead of sending again.
 */
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { idKind, marketProtocol, type Book, type Level, type Market, type OrderOutcome } from './polymarket.js';
import { UNIT, clampLimit, fromMicro, roundBuyShares, roundSellShares, toMicro } from './units.js';
import { redact } from './secrets.js';

/** The slice of PolymarketGateway these commands use — a fake in tests. */
export interface AgentExchange {
  conditionIdFor(tokenId: string): Promise<string>;
  market(conditionId: string, maxAgeMs?: number, withEndDate?: boolean): Promise<Market>;
  orderbook(tokenId: string): Promise<Book>;
  buyFok(tokenId: string, conditionId: string, limit: bigint, shares: bigint, v2?: boolean): Promise<OrderOutcome>;
  sellFak(tokenId: string, conditionId: string, limit: bigint, shares: bigint, v2?: boolean): Promise<OrderOutcome>;
  tokenBalance(tokenId: string, v2?: boolean): Promise<bigint>;
  readonly canTrade: boolean;
}

export interface OrderRequest {
  side: 'buy' | 'sell';
  tokenId: string;
  /** BUY: the most USDC to spend (the order never costs more) */
  usdc?: number;
  /** BUY: exact shares; SELL: shares to sell (capped at what the account holds) */
  shares?: number;
  /** SELL: everything the account holds of this outcome */
  all?: boolean;
  /** BUY: pay at most this per share (default: the best ask now) */
  maxPrice?: number;
  /** SELL: take at least this per share (default: the best bid now) */
  minPrice?: number;
  /** idempotency key: the same key never sends a second order */
  key?: string;
}

export interface OrderResult {
  mode: Config['mode'];
  /**
   * filled = got (some) shares · none = nothing matched · failed = rejected, nothing can fill · unknown = sent, no
   * usable answer: it MAY have filled · dry_run = simulated against the live book, nothing sent · skipped = not sent
   * (the price is outside your limit)
   */
  status: 'filled' | 'none' | 'failed' | 'unknown' | 'dry_run' | 'skipped';
  side: 'buy' | 'sell';
  tokenId: string;
  market: { conditionId: string; question: string; outcome: string | null };
  limitPrice?: number;
  sharesAsked?: number;
  /** BUY: what the order can cost at most (sharesAsked × limitPrice) — it is sized so this never exceeds usdc */
  maxCost?: number;
  shares?: number;
  usdc?: number;
  fee?: number;
  avgPrice?: number | null;
  orderId?: string;
  reason?: string;
  key?: string;
  /** this key was used before: the result is the first call's, and nothing was sent now */
  duplicate?: boolean;
  /** check the account's trades before acting again: the exchange's answer does not settle whether it filled */
  verify?: boolean;
  note?: string;
}

const VERIFY_NOTE = 'the result is not certain: check `trades` / `positions` before sending another order for this. Retrying with the same key never sends twice.';

export function validateOrder(r: OrderRequest): void {
  if (r.side !== 'buy' && r.side !== 'sell') throw new Error('side must be buy or sell');
  const kind = idKind(r.tokenId);
  if (kind === 'invalid') throw new Error('tokenId must be the outcome token id in decimal (the `tokenId` of a fill)');
  if (kind === 'combo') throw new Error('combinatorial positions are RFQ only, not on the order book');
  const pos = (v: number | undefined, name: string) => { if (v !== undefined && !(Number.isFinite(v) && v > 0)) throw new Error(`${name} must be a number above 0`); };
  const price = (v: number | undefined, name: string) => { if (v !== undefined && !(Number.isFinite(v) && v > 0 && v < 1)) throw new Error(`${name} must be between 0 and 1 (a price per share)`); };
  pos(r.usdc, 'usdc'); pos(r.shares, 'shares'); price(r.maxPrice, 'maxPrice'); price(r.minPrice, 'minPrice');
  if (r.side === 'buy') {
    if ((r.usdc === undefined) === (r.shares === undefined)) throw new Error('a BUY needs exactly one of usdc (the most to spend) or shares');
    if (r.all) throw new Error('all is for SELL');
    if (r.minPrice !== undefined) throw new Error('minPrice is for SELL; a BUY takes maxPrice');
  } else {
    if ((r.shares === undefined) === !r.all) throw new Error('a SELL needs exactly one of shares or all');
    if (r.usdc !== undefined) throw new Error('a SELL is sized in shares (or all), not usdc');
    if (r.maxPrice !== undefined) throw new Error('maxPrice is for BUY; a SELL takes minPrice');
  }
  if (r.key !== undefined && (typeof r.key !== 'string' || !r.key.trim() || r.key.length > 300)) throw new Error('key must be a non-empty string of at most 300 characters');
}

/** Claimed-key journal: one file per key, created exclusively, so two calls with one key cannot both send. */
export class OrderKeys {
  readonly dir: string;
  constructor(dataDir: string, mode: string) {
    this.dir = join(dataDir, `agent-orders.${mode}`);
  }
  private file(key: string): string { return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`); }
  /** the first call's record, if this key was claimed before */
  get(key: string): OrderResult | { status: 'sending'; key: string; claimedAt: string } | null {
    let text: string;
    try { text = readFileSync(this.file(key), 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    // created but not yet (or never fully) written: another call is sending now, or died doing it — the key is taken
    try {
      const rec = JSON.parse(text) as unknown;
      if (rec && typeof rec === 'object' && typeof (rec as { status?: unknown }).status === 'string') return rec as OrderResult;
    } catch { /* partial */ }
    return { status: 'sending', key, claimedAt: '(not recorded)' };
  }
  /**
   * true = claimed now; false = someone has it. The claim is synced to disk — file and directory entries — before
   * this returns, so a power cut after the order leaves cannot forget it; a failing sync throws and nothing is sent.
   */
  claim(key: string): boolean {
    mkdirDurable(this.dir);
    let fd: number;
    try {
      fd = openSync(this.file(key), 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    try {
      writeSync(fd, JSON.stringify({ status: 'sending', key, claimedAt: new Date().toISOString() }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDir(this.dir);
    return true;
  }
  record(key: string, result: OrderResult): void {
    const f = this.file(key);
    const fd = openSync(`${f}.tmp`, 'w');
    // an exchange error quoted in `reason` may echo a credential: none may reach the file (the key name is the hash)
    try { writeSync(fd, JSON.stringify(redact(result))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${f}.tmp`, f);
    syncDir(this.dir);
  }
}

/**
 * mkdir -p, durably: every directory level it creates is synced into its parent. Otherwise a power cut could take
 * a freshly created dataDir — and the key journal inside it — with it, and the same key would order again.
 */
export function mkdirDurable(dir: string): void {
  const missing: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    try { readdirSync(d); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.unshift(d);
      if (dirname(d) === d) break;
    }
  }
  for (const d of missing) {
    try { mkdirSync(d); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    syncDir(dirname(d));
  }
}

/** make new files and renames in `dir` durable; Windows cannot open a directory, and NTFS journals them anyway */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function duplicateOf(prev: NonNullable<ReturnType<OrderKeys['get']>>, req: OrderRequest, mode: Config['mode']): OrderResult {
  if (prev.status === 'sending') {
    // claimed, and the outcome was never written: the process died while sending, or another call is sending now
    return { mode, status: 'unknown', side: req.side, tokenId: req.tokenId, market: { conditionId: '', question: '', outcome: null }, key: req.key, duplicate: true, verify: true,
      reason: `an order with this key was being sent at ${prev.claimedAt} and its result was not recorded`, note: VERIFY_NOTE };
  }
  return { ...(prev as OrderResult), duplicate: true };
}

/** what crossing `levels` up to `limit` would fill, level by level (a dry run's answer) */
export function walkBook(levels: Level[], side: 'buy' | 'sell', limit: bigint, shares: bigint): { shares: bigint; usdc: bigint } {
  let left = shares;
  let usdc = 0n;
  for (const l of levels) {
    if (left <= 0n) break;
    if (side === 'buy' ? l.price > limit : l.price < limit) break;
    const take = l.size < left ? l.size : left;
    usdc += (take * l.price) / UNIT;
    left -= take;
  }
  return { shares: shares - left, usdc };
}

const round6 = (v: bigint) => fromMicro(v);

/**
 * A caller's number in 1e-6 units, rounded the way that never widens their limit: a budget, a maximum price or a
 * share count DOWN, a minimum price UP. Plain rounding would turn usdc 1.9999999 into 2 and minPrice 0.3800001 into
 * 0.38. Worked on the number's shortest decimal form (what the caller wrote, e.g. "0.3800000001" or "1e-7"), exactly,
 * so no digit that decides the direction is lost to binary floating point.
 */
export function microToward(x: number, dir: 'up' | 'down'): bigint {
  if (!Number.isFinite(x) || x < 0) throw new Error(`not a non-negative number: ${x}`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (!m) throw new Error(`cannot read ${x} as a decimal`);
  const digits = BigInt(`${m[1]}${m[2] ?? ''}`);
  // value = digits × 10^(exp − fractional digits); in micro units: × 10^6
  const shift = Number(m[3] ?? 0) - (m[2]?.length ?? 0) + 6;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const div = 10n ** BigInt(-shift);
  const q = digits / div;
  return dir === 'down' || digits % div === 0n ? q : q + 1n;
}

/** `price` on the market's tick grid, rounded the safe way for the side; unknown tick → unchanged */
export function onTick(price: bigint, tick: bigint | undefined, dir: 'up' | 'down'): bigint {
  if (!tick || tick <= 0n) return price;
  const down = (price / tick) * tick;
  return dir === 'down' || down === price ? down : down + tick;
}

/**
 * Place (or, in dry-run mode, simulate) one order. A BUY is fill-or-kill: exactly the computed shares at the limit or
 * better, or nothing. A SELL is fill-and-kill: whatever crosses at the limit or better, the rest cancelled.
 */
export async function placeOrder(cfg: Config, ex: AgentExchange, req: OrderRequest, keys: OrderKeys): Promise<OrderResult> {
  validateOrder(req);
  const mode = cfg.mode;
  if (req.key) {
    const prev = keys.get(req.key);
    if (prev) return duplicateOf(prev, req, mode);
  }
  const conditionId = await ex.conditionIdFor(req.tokenId);
  const market = await ex.market(conditionId, 0);
  const outcome = market.tokens.find((t) => t.tokenId === req.tokenId);
  const base = { mode, side: req.side, tokenId: req.tokenId, market: { conditionId, question: market.question, outcome: outcome?.outcome ?? null }, ...(req.key ? { key: req.key } : {}) };
  const refuse = (reason: string): OrderResult => ({ ...base, status: 'skipped', reason });
  if (!outcome) throw new Error('the token is not an outcome of the market the CLOB returned for it');
  if (market.closed) return refuse('market is closed (resolved): redeem on polymarket.com instead');
  if (market.active === false || market.acceptingOrders === false) return refuse('market is not accepting orders right now');
  const proto = marketProtocol(market, req.tokenId);
  if (!proto.ok) return refuse(proto.reason);
  const book = await ex.orderbook(req.tokenId);

  let limit: bigint;
  let shares: bigint;
  if (req.side === 'buy') {
    const ask = book.asks[0]?.price;
    if (ask === undefined) return refuse('nobody is selling: the book has no asks');
    const cap = req.maxPrice !== undefined ? microToward(req.maxPrice, 'down') : ask;
    // a caller's price need not sit on the tick grid: round a BUY limit DOWN to it, never above what they allowed
    limit = clampLimit(onTick(cap, book.tickSize, 'down'), book.tickSize);
    if (ask > limit) return refuse(`best ask ${fromMicro(ask)} is above maxPrice ${req.maxPrice ?? fromMicro(ask)}${limit !== cap ? ` (${fromMicro(limit)} on the market's price grid)` : ''}`);
    // usdc is a ceiling: sized at the limit, the order cannot cost more than it whatever it matches — so a maxPrice
    // well above the ask buys fewer shares (usdc / maxPrice); a maxPrice near the ask spends close to usdc
    shares = roundBuyShares(req.usdc !== undefined ? (microToward(req.usdc, 'down') * UNIT) / limit : microToward(req.shares!, 'down'), limit);
    if (shares <= 0n) return refuse('the amount is too small for one share at this price');
    if (book.minOrderSize && shares < book.minOrderSize) return refuse(`${fromMicro(shares)} shares is below the market's minimum order of ${fromMicro(book.minOrderSize)}`);
  } else {
    const bid = book.bids[0]?.price;
    if (bid === undefined) return refuse('nobody is buying: the book has no bids');
    const floor = req.minPrice !== undefined ? microToward(req.minPrice, 'up') : bid;
    // and a SELL floor UP to it, never below what they allowed — a floor above the highest price the market takes
    // cannot be met, and is refused rather than lowered to it
    const up = onTick(floor, book.tickSize, 'up');
    limit = clampLimit(up, book.tickSize);
    if (limit < up) return refuse(`minPrice ${req.minPrice} is above the highest price this market accepts (${fromMicro(limit)})`);
    if (bid < limit) return refuse(`best bid ${fromMicro(bid)} is below minPrice ${req.minPrice ?? fromMicro(bid)}${limit !== floor ? ` (${fromMicro(limit)} on the market's price grid)` : ''}`);
    let want = req.all ? null : microToward(req.shares!, 'down');
    if (ex.canTrade) {
      const held = await ex.tokenBalance(req.tokenId, proto.v2);
      if (want === null || want > held) want = held;
    } else if (want === null) {
      throw new Error('--all reads the account balance, which needs the Polymarket keys in the config (or give --shares)');
    }
    shares = roundSellShares(want);
    if (shares <= 0n) return refuse('the account holds none of this outcome');
  }
  const asked = { limitPrice: fromMicro(limit), sharesAsked: fromMicro(shares), ...(req.side === 'buy' ? { maxCost: fromMicro((shares * limit) / UNIT) } : {}) };

  if (mode === 'dry-run') {
    const sim = walkBook(req.side === 'buy' ? book.asks : book.bids, req.side, limit, shares);
    // a FOK BUY that cannot fill completely fills nothing
    const got = req.side === 'buy' && sim.shares < shares ? { shares: 0n, usdc: 0n } : sim;
    return { ...base, ...asked, status: 'dry_run', shares: round6(got.shares), usdc: round6(got.usdc), avgPrice: got.shares > 0n ? Number((got.usdc * UNIT) / got.shares) / 1e6 : null,
      note: got.shares > 0n ? 'dry-run: simulated against the current book, nothing was sent' : 'dry-run: the book could not fill this at the limit (a real order would match nothing); nothing was sent' };
  }
  if (!ex.canTrade) throw new Error('live mode needs the Polymarket keys in the config');
  if (req.key && !keys.claim(req.key)) {
    const prev = keys.get(req.key);
    if (prev) return duplicateOf(prev, req, mode);
    throw new Error('could not claim the key');
  }
  let r: OrderOutcome;
  try {
    r = req.side === 'buy'
      ? await ex.buyFok(req.tokenId, conditionId, limit, shares, proto.v2)
      : await ex.sellFak(req.tokenId, conditionId, limit, shares, proto.v2);
  } catch (e) {
    // the gateway reports send failures as outcomes; a throw here is unexpected, and the order may have left
    r = { orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: `error while sending: ${(e as Error).message}`.slice(0, 300), recheck: true };
  }
  const got = req.side === 'buy' ? r.netShares : r.shares;
  const result: OrderResult = {
    ...base, ...asked, status: r.status,
    ...(r.orderId ? { orderId: r.orderId } : {}),
    ...(r.status === 'filled' ? { shares: round6(got), usdc: round6(r.usdc), fee: round6(r.feeUsdc), avgPrice: r.shares > 0n ? Number((r.usdc * UNIT) / r.shares) / 1e6 : null } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.status === 'unknown' || r.recheck ? { verify: true, note: VERIFY_NOTE } : {}),
  };
  if (req.key) keys.record(req.key, result);
  return result;
}

/** Market, outcome and the top of the book for one token: what to look at before deciding. */
export async function describeMarket(ex: Pick<AgentExchange, 'conditionIdFor' | 'market' | 'orderbook'>, tokenId: string, depth = 5): Promise<Record<string, unknown>> {
  if (idKind(tokenId) === 'invalid') throw new Error('tokenId must be the outcome token id in decimal');
  const conditionId = await ex.conditionIdFor(tokenId);
  const market = await ex.market(conditionId, 0, true);
  const book = await ex.orderbook(tokenId).catch((e: Error) => ({ error: e.message }) as const);
  const lv = (l: Level) => ({ price: fromMicro(l.price), shares: fromMicro(l.size) });
  return {
    conditionId, question: market.question, endDate: market.endDate ?? null, closed: market.closed, acceptingOrders: market.acceptingOrders ?? null,
    outcome: market.tokens.find((t) => t.tokenId === tokenId)?.outcome ?? null,
    outcomes: market.tokens.map((t) => ({ tokenId: t.tokenId, outcome: t.outcome, price: t.price ?? null })),
    book: 'error' in book ? book : { bestAsk: book.asks[0] ? fromMicro(book.asks[0].price) : null, bestBid: book.bids[0] ? fromMicro(book.bids[0].price) : null, asks: book.asks.slice(0, depth).map(lv), bids: book.bids.slice(0, depth).map(lv), tickSize: book.tickSize ? fromMicro(book.tickSize) : null, minOrderSize: book.minOrderSize ? fromMicro(book.minOrderSize) : null },
  };
}

const DATA_API = 'https://data-api.polymarket.com';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function dataApi(path: string, fetchImpl: typeof fetch): Promise<any[]> {
  const res = await fetchImpl(DATA_API + path, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Polymarket data API ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body)) throw new Error('Polymarket data API: unexpected answer');
  return body;
}

/** Open positions of the trading account (Polymarket's public data API). */
export async function positions(address: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  if (!ADDRESS.test(address)) throw new Error('not an address');
  const rows = await dataApi(`/positions?user=${address}&sizeThreshold=0.01&limit=500`, fetchImpl);
  return rows.map((p) => ({
    tokenId: p.asset, conditionId: p.conditionId, title: p.title, outcome: p.outcome, slug: p.slug, endDate: p.endDate,
    shares: p.size, avgPrice: p.avgPrice, curPrice: p.curPrice, cost: p.initialValue, value: p.currentValue, pnl: p.cashPnl, redeemable: p.redeemable,
  }));
}

/** Recent trades of the trading account, newest first. */
export async function trades(address: string, limit = 50, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  if (!ADDRESS.test(address)) throw new Error('not an address');
  const n = Math.min(Math.max(1, Math.floor(limit)), 500);
  const rows = await dataApi(`/trades?user=${address}&limit=${n}&takerOnly=false`, fetchImpl);
  return rows.map((t) => ({
    at: typeof t.timestamp === 'number' ? new Date(t.timestamp * 1000).toISOString() : t.timestamp,
    side: t.side, tokenId: t.asset, conditionId: t.conditionId, title: t.title, outcome: t.outcome, shares: t.size, price: t.price, tx: t.transactionHash,
  }));
}
