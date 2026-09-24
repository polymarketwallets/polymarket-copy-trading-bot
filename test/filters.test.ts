import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import { bookGate, marketGate, parseMarketEndDate, slippageGate } from '../src/filters.js';
import { toMicro } from '../src/units.js';

const cfg = DEFAULTS.copy;
const mkt = (o = {}) => ({ conditionId: 'c', question: 'q', closed: false, active: true, acceptingOrders: true, endDate: '2030-01-01T00:00:00Z', tokens: [], ...o });
const lv = (p: string, s: string) => ({ price: toMicro(p), size: toMicro(s) });

describe('gates', () => {
  it('market lifecycle; a SELL is never blocked by the time gates', () => {
    const now = Date.parse('2029-12-31T23:55:00Z');
    expect(marketGate(mkt(), 'buy', cfg, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/settles_in_300s/) });
    expect(marketGate(mkt(), 'sell', cfg, now)).toEqual({ ok: true });
    expect(marketGate(mkt({ closed: true }), 'sell', cfg, now).ok).toBe(false);
    expect(marketGate(mkt({ endDate: undefined }), 'buy', { ...cfg, maxSecondsToEndDate: 3600 }, now)).toMatchObject({ reason: 'market_end_date_unknown' });
  });
  it('book: price band and depth for BUY, only a bid for SELL', () => {
    const book = { tokenId: 't', asks: [lv('0.97', '1000')], bids: [lv('0.96', '1')] };
    expect(bookGate(book, 'buy', cfg)).toMatchObject({ ok: false, reason: expect.stringMatching(/out_of_band/) });
    expect(bookGate(book, 'sell', cfg)).toEqual({ ok: true });
    expect(bookGate({ tokenId: 't', asks: [lv('0.5', '10'), lv('0.51', '10')], bids: [] }, 'buy', cfg)).toMatchObject({ reason: expect.stringMatching(/depth_10.10_below_50/) });
  });
  it('slippage vs what the target paid', () => {
    expect(slippageGate(toMicro('0.53'), toMicro('0.50'), cfg).ok).toBe(true);
    expect(slippageGate(toMicro('0.54'), toMicro('0.50'), cfg).ok).toBe(false);
  });
  it('end dates: ISO or date-only, nothing else', () => {
    expect(parseMarketEndDate('2026-02-31')).toBeNull();
    expect(parseMarketEndDate('0')).toBeNull();
    expect(parseMarketEndDate('2026-02-28')).toBe(Date.UTC(2026, 1, 28));
  });
});
