import type { CopyConfig } from './config.js';
import type { Book, Market } from './polymarket.js';
import { fromMicro } from './units.js';

export type Gate = { ok: true } | { ok: false; reason: string };
const pass: Gate = { ok: true };

/**
 * ISO or date-only strings only. A bare number must not reach Date.parse: "0" is upstream's
 * "unknown" sentinel and JavaScript would read it as a year. Rejects calendar overflow (Feb 31).
 */
export function parseMarketEndDate(value?: string): number | null {
  if (!value) return null;
  const raw = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Market lifecycle, from the CLOB (the source of truth). `side` is OUR side: the time-to-settle
 * limits are an entry policy, so a SELL is never blocked by them — a held position must always be
 * exitable. A past endDate is not a reject: sports markets keep accepting orders after the whistle.
 */
export function marketGate(market: Market, side: 'buy' | 'sell', cfg: CopyConfig, now = Date.now()): Gate {
  if (market.closed) return { ok: false, reason: 'market_closed' };
  if (market.active === false) return { ok: false, reason: 'market_inactive' };
  if (market.acceptingOrders === false) return { ok: false, reason: 'market_not_accepting_orders' };
  if (side === 'sell') return pass;
  const end = parseMarketEndDate(market.endDate);
  if (end === null) return cfg.maxSecondsToEndDate > 0 ? { ok: false, reason: 'market_end_date_unknown' } : pass;
  const secs = (end - now) / 1000;
  if (secs > 0 && secs < cfg.minSecondsToEndDate) return { ok: false, reason: `market_settles_in_${Math.floor(secs)}s` };
  if (cfg.maxSecondsToEndDate > 0 && secs > cfg.maxSecondsToEndDate) return { ok: false, reason: `market_settles_in_${Math.floor(secs)}s_too_far` };
  return pass;
}

/**
 * Depth and price on the side we take (asks for a BUY, bids for a SELL). The price band applies to
 * BUYs only: for an exit any bid beats redeeming at zero, so a SELL only needs a bid to exist.
 */
export function bookGate(book: Book, side: 'buy' | 'sell', cfg: CopyConfig): Gate {
  const levels = side === 'buy' ? book.asks : book.bids;
  const top = levels[0];
  if (!top) return { ok: false, reason: 'book_empty_side' };
  if (side === 'sell') return pass;
  const px = fromMicro(top.price);
  if (px < cfg.minPrice || px > cfg.maxPrice) return { ok: false, reason: `price_${px.toFixed(3)}_out_of_band` };
  let depth = 0;
  for (const l of levels) {
    depth += fromMicro(l.price) * fromMicro(l.size);
    if (depth >= cfg.minBookDepthUsdc) return pass;
  }
  return { ok: false, reason: `depth_${depth.toFixed(2)}_below_${cfg.minBookDepthUsdc}` };
}

/** We see the fill after the target; if the ask has already run away, the copy is a different trade. */
export function slippageGate(bestAsk: bigint, targetPrice: bigint, cfg: CopyConfig): Gate {
  const over = fromMicro(bestAsk) - fromMicro(targetPrice);
  if (over > cfg.maxSlippage + 1e-9) return { ok: false, reason: `ask_${fromMicro(bestAsk).toFixed(3)}_vs_target_${fromMicro(targetPrice).toFixed(3)}` };
  return pass;
}
