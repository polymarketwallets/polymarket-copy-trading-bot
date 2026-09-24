// Manual smoke test against the real, public Polymarket CLOB (read-only). Not part of `npm test`:
//   npx tsx test/live-readonly.smoke.ts
import { PolymarketGateway } from '../src/polymarket.js';
import { buildConfig } from '../src/config.js';
import { bookGate, marketGate } from '../src/filters.js';
import { fromMicro } from '../src/units.js';
import { applyProxyFromEnv } from '../src/proxy.js';

applyProxyFromEnv();

const log = { info: console.log, warn: console.warn, error: console.error };
const cfg = buildConfig({ pmwallets: { apiKey: 'pmw_x_y' } });
const pm = new PolymarketGateway(cfg.polymarket, log);
const sample = await (await fetch('https://clob.polymarket.com/sampling-markets')).json() as any;
for (const m of sample.data.slice(0, 3)) {
  const tokenId = m.tokens[0].token_id;
  const cid = await pm.conditionIdFor(tokenId);
  const market = await pm.market(cid);
  const book = await pm.orderbook(tokenId);
  console.log({
    question: market.question.slice(0, 50), cidMatches: cid === m.condition_id, endDate: market.endDate,
    bestAsk: book.asks[0] && fromMicro(book.asks[0].price), bestBid: book.bids[0] && fromMicro(book.bids[0].price),
    sorted: book.asks.every((l, i, a) => i === 0 || a[i - 1]!.price <= l.price) && book.bids.every((l, i, a) => i === 0 || a[i - 1]!.price >= l.price),
    tick: book.tickSize && fromMicro(book.tickSize), minOrder: book.minOrderSize && fromMicro(book.minOrderSize),
    marketGate: marketGate(market, 'buy', cfg.copy), bookGate: bookGate(book, 'buy', cfg.copy),
  });
}
