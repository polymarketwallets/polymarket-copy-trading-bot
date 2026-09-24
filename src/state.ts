import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

interface Persisted {
  version: 1;
  positions: Record<string, Position>;
  /** eventIds already decided, oldest first — the at-most-once guarantee survives a restart */
  processed: string[];
  /** (target|tx|token|side) already acted on: one copy per target transaction */
  handledTx: string[];
  spend: { day: string; usdc: string };
}

const MAX_REMEMBERED = 20_000;
export const posKey = (target: string, tokenId: string) => `${target}|${tokenId}`;

/**
 * The bot's own memory: open positions, what it already decided, today's spend. One JSON file per
 * mode (dry-run never mixes with live), replaced atomically after every change.
 */
export class BotState {
  private data: Persisted;
  private readonly processed = new Set<string>();
  private readonly handledTx = new Set<string>();
  readonly file: string;
  readonly decisionsFile: string;

  constructor(dir: string, mode: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `state.${mode}.json`);
    this.decisionsFile = join(dir, `decisions.${mode}.jsonl`);
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Persisted)
      : { version: 1, positions: {}, processed: [], handledTx: [], spend: { day: '', usdc: '0' } };
    this.data.handledTx ??= [];
    for (const id of this.data.processed) this.processed.add(id);
    for (const k of this.data.handledTx) this.handledTx.add(k);
  }

  save(): void {
    if (this.data.processed.length > MAX_REMEMBERED) {
      for (const id of this.data.processed.splice(0, this.data.processed.length - MAX_REMEMBERED)) this.processed.delete(id);
    }
    if (this.data.handledTx.length > MAX_REMEMBERED) {
      for (const k of this.data.handledTx.splice(0, this.data.handledTx.length - MAX_REMEMBERED)) this.handledTx.delete(k);
    }
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

  position(target: string, tokenId: string): Position | undefined { return this.data.positions[posKey(target, tokenId)]; }
  positions(): Position[] { return Object.values(this.data.positions); }

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
