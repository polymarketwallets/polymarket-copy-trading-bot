import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** What we hold because we followed one target into one outcome. Keyed per target: target A's SELL
 *  never sells what we bought following target B. Amounts are 1e-6 micro-units, stored as strings. */
export interface Position {
  target: string;
  tokenId: string;
  conditionId: string;
  shares: string;
  costUsdc: string;
  buyCount: number;
  openedAt: string;
  question?: string;
  outcome?: string;
}

/**
 * An order whose result is not known yet. Written BEFORE the order is sent (orderId null), updated
 * with the id the exchange returns, and removed only once the fill (or its absence) is established —
 * so a crash, a restart or a failing lookup never loses a fill that actually happened.
 */
export interface PendingOrder {
  key: string;
  side: 'buy' | 'sell';
  orderId: string | null;
  target: string;
  tokenId: string;
  conditionId: string;
  question?: string;
  outcome?: string;
  /** what was sent (1e-6 units, strings) — the unknown-id lookup only accepts a fill consistent with it */
  shares: string;
  limit: string;
  /** BUY: USDC held against the daily cap and the position caps until the outcome is known */
  reserveUsdc: string;
  /** ms epoch the order was sent */
  sentAt: number;
  attempts: number;
  nextAt: number;
  /**
   * Set when the bot cannot establish the outcome by itself (several candidate orders, lookups failing
   * for a day, a record from an older build). The order may still have filled, so it KEEPS its
   * reservation and keeps blocking its outcome until `pmwallets-copytrade reconcile` settles it.
   */
  needsReconcile?: string;
}

/** A target exited and we still have to: retried until the position is gone. */
export interface PendingExit {
  eventId: string;
  target: string;
  tokenId: string;
  firstAt: number;
  attempts: number;
  nextAt: number;
}

interface Persisted {
  version: 1;
  positions: Record<string, Position>;
  /** eventIds already decided, oldest first — the at-most-once guarantee survives a restart */
  processed: string[];
  /** (target|tx|token|side) already acted on: one copy per target transaction */
  handledTx: string[];
  spend: { day: string; usdc: string };
  pendingOrders: PendingOrder[];
  pendingExits: PendingExit[];
  /** exchange order ids whose fills are already booked — so an unknown-id order is never matched to them */
  bookedOrderIds: string[];
}

const MAX_REMEMBERED = 20_000;
export const posKey = (target: string, tokenId: string) => `${target}|${tokenId}`;

/**
 * The bot's own memory: open positions, what it already decided, orders and exits still in flight,
 * today's spend. One JSON file per mode (dry-run never mixes with live), replaced atomically.
 */
export class BotState {
  private data: Persisted;
  private readonly processed = new Set<string>();
  private readonly handledTx = new Set<string>();
  private readonly booked = new Set<string>();
  readonly file: string;
  readonly decisionsFile: string;

  constructor(dir: string, mode: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `state.${mode}.json`);
    this.decisionsFile = join(dir, `decisions.${mode}.jsonl`);
    const d = (existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}) as Partial<Persisted>;
    this.data = {
      version: 1,
      positions: d.positions ?? {},
      processed: d.processed ?? [],
      handledTx: d.handledTx ?? [],
      spend: d.spend ?? { day: '', usdc: '0' },
      pendingOrders: d.pendingOrders ?? [],
      pendingExits: d.pendingExits ?? [],
      bookedOrderIds: d.bookedOrderIds ?? [],
    };
    // fail closed on a record that lacks what the reconciliation needs: never read a missing amount as 0
    this.data.pendingOrders = this.data.pendingOrders.map((p) =>
      p.needsReconcile || (p.shares && p.limit && p.reserveUsdc !== undefined) ? p
        : { ...p, needsReconcile: 'written by an older build: the size and limit that were sent are unknown' });
    for (const id of this.data.processed) this.processed.add(id);
    for (const k of this.data.handledTx) this.handledTx.add(k);
    for (const k of this.data.bookedOrderIds) this.booked.add(k);
  }

  save(): void {
    trim(this.data.processed, this.processed);
    trim(this.data.handledTx, this.handledTx);
    trim(this.data.bookedOrderIds, this.booked);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  isProcessed(eventId: string): boolean { return this.processed.has(eventId); }
  markProcessed(eventId: string): void {
    if (this.processed.has(eventId)) return;
    this.processed.add(eventId);
    this.data.processed.push(eventId);
  }

  isHandledTx(key: string): boolean { return this.handledTx.has(key); }
  markHandledTx(key: string): void {
    if (this.handledTx.has(key)) return;
    this.handledTx.add(key);
    this.data.handledTx.push(key);
  }

  isBooked(orderId: string): boolean { return this.booked.has(orderId.toLowerCase()); }
  markBooked(orderId: string): void {
    const id = orderId.toLowerCase();
    if (!id || this.booked.has(id)) return;
    this.booked.add(id);
    this.data.bookedOrderIds.push(id);
  }

  position(target: string, tokenId: string): Position | undefined { return this.data.positions[posKey(target, tokenId)]; }
  positions(): Position[] { return Object.values(this.data.positions); }
  /** shares of this token booked to targets other than `target` */
  sharesHeldByOthers(target: string, tokenId: string): bigint {
    let n = 0n;
    for (const p of this.positions()) if (p.tokenId === tokenId && p.target !== target) n += BigInt(p.shares);
    return n;
  }

  addBuy(p: Omit<Position, 'shares' | 'costUsdc' | 'buyCount' | 'openedAt'>, shares: bigint, usdc: bigint): Position {
    const key = posKey(p.target, p.tokenId);
    const cur = this.data.positions[key];
    const next: Position = cur
      ? { ...cur, shares: (BigInt(cur.shares) + shares).toString(), costUsdc: (BigInt(cur.costUsdc) + usdc).toString(), buyCount: cur.buyCount + 1 }
      : { ...p, shares: shares.toString(), costUsdc: usdc.toString(), buyCount: 1, openedAt: new Date().toISOString() };
    this.data.positions[key] = next;
    return next;
  }

  /** Reduce by what was sold; the position is dropped once nothing sellable is left. */
  reduce(target: string, tokenId: string, shares: bigint): void {
    const key = posKey(target, tokenId);
    const cur = this.data.positions[key];
    if (!cur) return;
    const held = BigInt(cur.shares);
    const left = held - shares;
    if (left <= 100n) { delete this.data.positions[key]; return; } // < 1e-4 share: dust
    // cost basis shrinks in proportion, so the remaining position keeps its average price
    const cost = (BigInt(cur.costUsdc) * left) / held;
    this.data.positions[key] = { ...cur, shares: left.toString(), costUsdc: cost.toString() };
  }

  drop(target: string, tokenId: string): void { delete this.data.positions[posKey(target, tokenId)]; }

  pendingOrders(): PendingOrder[] { return this.data.pendingOrders; }
  /** USDC reserved by BUYs whose outcome is not known yet */
  reservedUsdc(): bigint {
    let n = 0n;
    for (const p of this.data.pendingOrders) if (p.side === 'buy' && p.reserveUsdc) n += BigInt(p.reserveUsdc);
    return n;
  }
  /** a BUY whose reservation is unknown: the caps cannot be computed, so no new BUY may go out */
  hasUnknownReservation(): boolean {
    return this.data.pendingOrders.some((p) => p.side === 'buy' && !p.reserveUsdc);
  }
  /** (target, token) pairs that are open or may be about to be: booked positions plus unconfirmed BUYs */
  openOutcomes(): { target: string; tokenId: string }[] {
    const seen = new Set<string>();
    const out: { target: string; tokenId: string }[] = [];
    for (const x of [...this.positions(), ...this.data.pendingOrders.filter((p) => p.side === 'buy')]) {
      const k = posKey(x.target, x.tokenId);
      if (!seen.has(k)) { seen.add(k); out.push({ target: x.target, tokenId: x.tokenId }); }
    }
    return out;
  }
  addPendingOrder(p: PendingOrder): void { this.data.pendingOrders = [...this.data.pendingOrders.filter((x) => x.key !== p.key), p]; }
  updatePendingOrder(key: string, patch: Partial<PendingOrder>): void {
    this.data.pendingOrders = this.data.pendingOrders.map((x) => (x.key === key ? { ...x, ...patch } : x));
  }
  removePendingOrder(key: string): void { this.data.pendingOrders = this.data.pendingOrders.filter((x) => x.key !== key); }

  pendingExits(): PendingExit[] { return this.data.pendingExits; }
  /** one exit per (target, token) — a second SELL while one is queued changes nothing */
  addPendingExit(e: PendingExit): void {
    if (this.data.pendingExits.some((x) => x.target === e.target && x.tokenId === e.tokenId)) return;
    this.data.pendingExits.push(e);
  }
  updatePendingExit(target: string, tokenId: string, patch: Partial<PendingExit>): void {
    this.data.pendingExits = this.data.pendingExits.map((x) => (x.target === target && x.tokenId === tokenId ? { ...x, ...patch } : x));
  }
  removePendingExit(target: string, tokenId: string): void {
    this.data.pendingExits = this.data.pendingExits.filter((x) => !(x.target === target && x.tokenId === tokenId));
  }

  spentToday(now = new Date()): bigint {
    const day = now.toISOString().slice(0, 10);
    return this.data.spend.day === day ? BigInt(this.data.spend.usdc) : 0n;
  }
  addSpend(usdc: bigint, now = new Date()): void {
    const day = now.toISOString().slice(0, 10);
    const base = this.data.spend.day === day ? BigInt(this.data.spend.usdc) : 0n;
    this.data.spend = { day, usdc: (base + usdc).toString() };
  }

  /** Append-only audit trail: one line per decision, including every skip and its reason. */
  logDecision(entry: Record<string, unknown>): void {
    appendFileSync(this.decisionsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
  }
}

function trim(list: string[], index: Set<string>): void {
  if (list.length <= MAX_REMEMBERED) return;
  for (const id of list.splice(0, list.length - MAX_REMEMBERED)) index.delete(id);
}

/**
 * One bot per data directory and mode. Two instances on the same state would each think a fill is
 * new and each send an order; the lock makes the second one refuse to start. A lock left by a crashed
 * process on this machine is taken over; one held by a live process, or by another host, is not.
 * Same file format in the Python bot, so the two implementations exclude each other too.
 */
export class InstanceLock {
  readonly file: string;
  private held = false;
  constructor(dir: string, mode: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `lock.${mode}`);
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
        closeSync(fd);
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let owner: { pid?: number; host?: string } = {};
      try { owner = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* unreadable: treat as held */ }
      if (owner.host === hostname() && typeof owner.pid === 'number' && !alive(owner.pid)) {
        try { unlinkSync(this.file); } catch { /* raced with another starter; retry decides */ }
        continue;
      }
      throw new Error(`another pmwallets-copytrade is running on this data directory (${this.file}: pid ${owner.pid ?? '?'} on ${owner.host ?? '?'}). `
        + 'Stop it first; if it is really gone, delete the lock file.');
    }
    throw new Error(`could not take ${this.file}`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try { unlinkSync(this.file); } catch { /* already gone */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
