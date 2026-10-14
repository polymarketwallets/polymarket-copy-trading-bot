import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig, type Config } from '../src/config.js';
import { OrderKeys, microToward, mkdirDurable, onTick, describeMarket, placeOrder, positions, trades, validateOrder, walkBook, type AgentExchange, type OrderRequest } from '../src/agent.js';
import { agentTools, flagValue, rejectUnknownFlags } from '../src/agent-cli.js';
import type { Book, Market, OrderOutcome } from '../src/polymarket.js';
import { addSecret } from '../src/secrets.js';
import { toMicro } from '../src/units.js';

const TOKEN = '1001';
const V2_TOKEN = ((1n << 248n) | (5n << 120n) | (2n << 104n) | 1n).toString(); // binary module, arity 2

class FakeEx implements AgentExchange {
  canTrade = true;
  market_: Market = { conditionId: 'CID', question: 'Will it?', closed: false, active: true, acceptingOrders: true, version: 'v1', tokens: [{ tokenId: TOKEN, outcome: 'Yes' }, { tokenId: V2_TOKEN, outcome: 'No' }] };
  book: Book = { tokenId: TOKEN, asks: [{ price: toMicro('0.40'), size: toMicro('30') }, { price: toMicro('0.45'), size: toMicro('1000') }], bids: [{ price: toMicro('0.38'), size: toMicro('50') }, { price: toMicro('0.30'), size: toMicro('1000') }], tickSize: toMicro('0.01'), minOrderSize: toMicro('5') };
  balance = toMicro('120');
  sent: { side: string; limit: bigint; shares: bigint; v2?: boolean }[] = [];
  result: (side: 'buy' | 'sell', shares: bigint, limit: bigint) => Promise<OrderOutcome> = async (_s, shares, limit) => ({ orderId: 'o1', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares });
  async conditionIdFor() { return 'CID'; }
  async market() { return this.market_; }
  async orderbook() { return this.book; }
  async buyFok(_t: string, _c: string, limit: bigint, shares: bigint, v2?: boolean) { this.sent.push({ side: 'buy', limit, shares, v2 }); return this.result('buy', shares, limit); }
  async sellFak(_t: string, _c: string, limit: bigint, shares: bigint, v2?: boolean) { this.sent.push({ side: 'sell', limit, shares, v2 }); return this.result('sell', shares, limit); }
  async tokenBalance() { return this.balance; }
}

const cfgOf = (mode: 'live' | 'dry-run'): Config => buildConfig({
  mode, dataDir: mkdtempSync(join(tmpdir(), 'pmw-agent-')),
  pmwallets: { apiKey: 'pmw_abc_def' },
  polymarket: { privateKey: `0x${'1'.repeat(64)}`, signatureType: '0' },
});
const keysOf = (cfg: Config) => new OrderKeys(cfg.dataDir, cfg.mode);
const buy = (o: Partial<OrderRequest> = {}): OrderRequest => ({ side: 'buy', tokenId: TOKEN, usdc: 10, ...o });

describe('validateOrder', () => {
  it('takes exactly one size per side and prices strictly between 0 and 1', () => {
    expect(() => validateOrder(buy())).not.toThrow();
    expect(() => validateOrder(buy({ shares: 5 }))).toThrow(/exactly one/);
    expect(() => validateOrder({ side: 'buy', tokenId: TOKEN })).toThrow(/exactly one/);
    expect(() => validateOrder(buy({ usdc: 0 }))).toThrow(/above 0/);
    expect(() => validateOrder(buy({ usdc: Number.NaN }))).toThrow(/above 0/);
    expect(() => validateOrder(buy({ maxPrice: 1 }))).toThrow(/between 0 and 1/);
    expect(() => validateOrder(buy({ minPrice: 0.5 }))).toThrow(/minPrice is for SELL/);
    expect(() => validateOrder({ side: 'sell', tokenId: TOKEN, shares: 1, all: true })).toThrow(/exactly one/);
    expect(() => validateOrder({ side: 'sell', tokenId: TOKEN, all: true, usdc: 3 })).toThrow(/shares/);
    expect(() => validateOrder(buy({ tokenId: '0x12' }))).toThrow(/decimal/);
    expect(() => validateOrder(buy({ tokenId: ((3n << 248n) | 1n).toString() }))).toThrow(/combinatorial/);
    expect(() => validateOrder(buy({ key: '' }))).toThrow(/key/);
  });
});

describe('placeOrder — live', () => {
  it('a BUY never costs more than usdc: sized at the limit, sent once as fill-or-kill', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    const r = await placeOrder(cfg, ex, buy({ usdc: 10 }), keysOf(cfg));
    expect(ex.sent).toHaveLength(1);
    const s = ex.sent[0]!;
    expect(s.limit).toBe(toMicro('0.40'));
    expect((s.shares * s.limit) / 1_000_000n).toBeLessThanOrEqual(toMicro('10'));
    expect(s.v2).toBe(false);
    expect(r).toMatchObject({ status: 'filled', side: 'buy', limitPrice: 0.4, sharesAsked: 25, maxCost: 10, shares: 25, usdc: 10, market: { question: 'Will it?', outcome: 'Yes' } });

    // with a maxPrice above the ask, the limit is the maxPrice and the size shrinks so the ceiling still holds
    const ex2 = new FakeEx();
    await placeOrder(cfg, ex2, buy({ usdc: 10, maxPrice: 0.5 }), keysOf(cfg));
    expect(ex2.sent[0]!.limit).toBe(toMicro('0.5'));
    expect((ex2.sent[0]!.shares * ex2.sent[0]!.limit) / 1_000_000n).toBeLessThanOrEqual(toMicro('10'));
  });

  it('signs a V2 position for ExchangeV3', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.market_ = { ...ex.market_, version: 'v2' };
    await placeOrder(cfg, ex, buy({ tokenId: V2_TOKEN }), keysOf(cfg));
    expect(ex.sent[0]!.v2).toBe(true);
  });

  it('does not send when the price is outside the limit, and does not use up the key', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    const r = await placeOrder(cfg, ex, buy({ maxPrice: 0.35, key: 'k1' }), keysOf(cfg));
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/above maxPrice/);
    expect(ex.sent).toHaveLength(0);
    const again = await placeOrder(cfg, ex, buy({ maxPrice: 0.41, key: 'k1' }), keysOf(cfg));
    expect(again.status).toBe('filled');
    expect(ex.sent).toHaveLength(1);
  });

  it('the same key never sends a second order — sequentially or at the same time', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    const first = await placeOrder(cfg, ex, buy({ key: 'fill-1' }), keysOf(cfg));
    const second = await placeOrder(cfg, ex, buy({ key: 'fill-1', usdc: 50 }), keysOf(cfg));
    expect(ex.sent).toHaveLength(1);
    expect(second).toEqual({ ...first, duplicate: true });

    const ex2 = new FakeEx();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    ex2.result = async (_s, shares, limit) => { await gate; return { orderId: 'o2', status: 'filled', shares, usdc: (shares * limit) / 1_000_000n, feeUsdc: 0n, netShares: shares }; };
    const both = Promise.all([placeOrder(cfg, ex2, buy({ key: 'fill-2' }), keysOf(cfg)), placeOrder(cfg, ex2, buy({ key: 'fill-2' }), keysOf(cfg))]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;
    expect(ex2.sent).toHaveLength(1);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
    // the call that lost the race saw the key mid-send: it says so, and sends nothing
    expect([a, b].find((x) => x.duplicate)!.status).toBe('unknown');
  });

  it('an unconfirmed result asks the caller to verify; a crash mid-send is never resent', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.result = async () => ({ orderId: '', status: 'unknown', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: 'post_error: socket hang up', recheck: true });
    const r = await placeOrder(cfg, ex, buy({ key: 'k' }), keysOf(cfg));
    expect(r).toMatchObject({ status: 'unknown', verify: true });
    expect(r.note).toMatch(/check `trades`/);
    const retry = await placeOrder(cfg, ex, buy({ key: 'k' }), keysOf(cfg));
    expect(retry).toMatchObject({ status: 'unknown', duplicate: true });
    expect(ex.sent).toHaveLength(1);

    // a key file left at "sending" (the process died before recording) reads as unknown, never as free
    const keys = keysOf(cfg);
    mkdirSync(keys.dir, { recursive: true });
    writeFileSync(join(keys.dir, `${createHash('sha256').update('crashed').digest('hex').slice(0, 32)}.json`), JSON.stringify({ status: 'sending', key: 'crashed', claimedAt: '2026-10-14T00:00:00Z' }));
    const after = await placeOrder(cfg, ex, buy({ key: 'crashed' }), keys);
    expect(after).toMatchObject({ status: 'unknown', duplicate: true, verify: true });
    expect(ex.sent).toHaveLength(1);
  });

  it('a key file created but not yet written reads as taken (unknown), never as an error or as free', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    const keys = keysOf(cfg);
    mkdirSync(keys.dir, { recursive: true });
    for (const [k, body] of [['empty', ''], ['half', '{"status":"sen'], ['odd', '42']] as const) {
      writeFileSync(join(keys.dir, `${createHash('sha256').update(k).digest('hex').slice(0, 32)}.json`), body);
      expect(await placeOrder(cfg, ex, buy({ key: k }), keys)).toMatchObject({ status: 'unknown', duplicate: true, verify: true });
    }
    expect(ex.sent).toHaveLength(0);
  });

  it('a credential echoed in an exchange error never reaches the key journal', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    const secret = 'journal-secret-0123456789';
    addSecret(secret);
    ex.result = async () => ({ orderId: '', status: 'failed', shares: 0n, usdc: 0n, feeUsdc: 0n, netShares: 0n, reason: `rejected: bad key ${secret}` });
    await placeOrder(cfg, ex, buy({ key: 'j1' }), keysOf(cfg));
    const file = join(keysOf(cfg).dir, `${createHash('sha256').update('j1').digest('hex').slice(0, 32)}.json`);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('<redacted>');
  });

  it('an exception while sending is recorded as unknown, not left claimed', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.result = async () => { throw new Error('boom'); };
    const r = await placeOrder(cfg, ex, buy({ key: 'x' }), keysOf(cfg));
    expect(r).toMatchObject({ status: 'unknown', verify: true });
    expect(r.reason).toMatch(/boom/);
    expect(keysOf(cfg).get('x')).toMatchObject({ status: 'unknown' });
  });

  it('a SELL is capped at what the account holds and respects minPrice', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, shares: 500 }, keysOf(cfg));
    expect(ex.sent[0]).toMatchObject({ side: 'sell', shares: toMicro('120'), limit: toMicro('0.38') });
    await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, all: true, minPrice: 0.3 }, keysOf(cfg));
    expect(ex.sent[1]).toMatchObject({ shares: toMicro('120'), limit: toMicro('0.3') });
    const r = await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, all: true, minPrice: 0.39 }, keysOf(cfg));
    expect(r.status).toBe('skipped');
    ex.balance = 0n;
    expect((await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, all: true }, keysOf(cfg))).reason).toMatch(/holds none/);
    expect(ex.sent).toHaveLength(2);
  });

  it('refuses closed markets and markets not taking orders', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.market_ = { ...ex.market_, closed: true };
    expect((await placeOrder(cfg, ex, buy(), keysOf(cfg))).reason).toMatch(/closed/);
    ex.market_ = { ...ex.market_, closed: false, acceptingOrders: false };
    expect((await placeOrder(cfg, ex, buy(), keysOf(cfg))).reason).toMatch(/not accepting/);
    expect(ex.sent).toHaveLength(0);
  });
});

describe('mkdirDurable', () => {
  it('creates every missing level and syncs each into its parent', () => {
    const base = mkdtempSync(join(tmpdir(), 'pmw-mk-'));
    const deep = join(base, 'a', 'b', 'agent-orders.live');
    mkdirDurable(deep);
    expect(existsSync(deep)).toBe(true);
    mkdirDurable(deep); // existing: nothing to do
    // a first live order into a dataDir that does not exist yet still claims durably
    const cfg = buildConfig({ mode: 'live', dataDir: join(base, 'fresh', 'pmw-data'), pmwallets: { apiKey: 'pmw_abc_def' }, polymarket: { privateKey: `0x${'1'.repeat(64)}`, signatureType: '0' } });
    expect(keysOf(cfg).claim('k')).toBe(true);
    expect(keysOf(cfg).claim('k')).toBe(false);
  });
});

describe('placeOrder — dry-run', () => {
  it('simulates against the book and sends nothing; a fill-or-kill the book cannot fill fills nothing', async () => {
    const cfg = cfgOf('dry-run'); const ex = new FakeEx();
    const r = await placeOrder(cfg, ex, buy({ usdc: 10 }), keysOf(cfg));
    expect(r).toMatchObject({ status: 'dry_run', shares: 25, usdc: 10, avgPrice: 0.4 });
    const deep = await placeOrder(cfg, ex, buy({ usdc: undefined, shares: 100, maxPrice: 0.42 }), keysOf(cfg));
    expect(deep).toMatchObject({ status: 'dry_run', shares: 0 });
    expect(deep.note).toMatch(/could not fill/);
    expect(ex.sent).toHaveLength(0);
  });
});

describe('prices off the tick grid', () => {
  it('a BUY limit rounds down and a SELL floor rounds up — never past the caller\'s price', async () => {
    expect(onTick(toMicro('0.455'), toMicro('0.01'), 'down')).toBe(toMicro('0.45'));
    expect(onTick(toMicro('0.455'), toMicro('0.01'), 'up')).toBe(toMicro('0.46'));
    expect(onTick(toMicro('0.45'), toMicro('0.01'), 'up')).toBe(toMicro('0.45'));
    expect(onTick(toMicro('0.455'), undefined, 'down')).toBe(toMicro('0.455'));
    const cfg = cfgOf('live'); const ex = new FakeEx();
    await placeOrder(cfg, ex, buy({ usdc: 10, maxPrice: 0.459 }), keysOf(cfg));
    expect(ex.sent[0]!.limit).toBe(toMicro('0.45'));
    await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, shares: 10, minPrice: 0.371 }, keysOf(cfg));
    expect(ex.sent[1]!.limit).toBe(toMicro('0.38'));
    // 0.401 rounds down to 0.40 = the ask: still sent; 0.399 rounds to 0.39 < ask: refused
    expect((await placeOrder(cfg, ex, buy({ maxPrice: 0.401 }), keysOf(cfg))).status).toBe('filled');
    const r = await placeOrder(cfg, ex, buy({ maxPrice: 0.399 }), keysOf(cfg));
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/price grid/);
  });

  it('a SELL floor above the highest price the market takes is refused, never lowered', async () => {
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.book = { ...ex.book, bids: [{ price: toMicro('0.99'), size: toMicro('100') }] };
    const r = await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, shares: 10, minPrice: 0.995 }, keysOf(cfg));
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/highest price/);
    expect(ex.sent).toHaveLength(0);
    await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, shares: 10, minPrice: 0.99 }, keysOf(cfg));
    expect(ex.sent[0]!.limit).toBe(toMicro('0.99'));
  });
});

describe('caller numbers beyond 1e-6', () => {
  it('are rounded so the caller\'s limit is never widened', async () => {
    expect(microToward(0.29, 'down')).toBe(290_000n);
    expect(microToward(0.29, 'up')).toBe(290_000n);
    expect(microToward(1.9999999, 'down')).toBe(1_999_999n);
    expect(microToward(0.3800001, 'up')).toBe(380_001n);
    expect(microToward(0.3800001, 'down')).toBe(380_000n);
    // beyond 1e-9 too: no digit that decides the direction may be lost
    expect(microToward(0.3800000001, 'up')).toBe(380_001n);
    expect(microToward(9.9999999999, 'down')).toBe(9_999_999n);
    expect(microToward(1e-7, 'up')).toBe(1n);
    expect(microToward(1e-7, 'down')).toBe(0n);
    expect(microToward(0.38, 'up')).toBe(380_000n);
    expect(microToward(1e21, 'down')).toBe(10n ** 27n);
    expect(microToward(123.456789, 'up')).toBe(123_456_789n);
    const cfg = cfgOf('live'); const ex = new FakeEx();
    ex.book = { ...ex.book, tickSize: toMicro('0.000001') };
    // minPrice 0.3800001 must not sell at 0.38
    const r = await placeOrder(cfg, ex, { side: 'sell', tokenId: TOKEN, shares: 10, minPrice: 0.3800001 }, keysOf(cfg));
    expect(r.status).toBe('skipped');
    // usdc 9.9999999 must not spend 10
    await placeOrder(cfg, ex, buy({ usdc: 9.9999999 }), keysOf(cfg));
    expect((ex.sent[0]!.shares * ex.sent[0]!.limit) / 1_000_000n).toBeLessThan(toMicro('10'));
  });
});

describe('flagValue', () => {
  it('refuses a flag whose value is missing or is another option', () => {
    const argv = ['node', 'cli', 'order', 'sell', '1', '--key', 'k1', '--all'];
    expect(flagValue(argv, '--key')).toBe('k1');
    expect(flagValue(argv, '--usdc')).toBeUndefined();
    expect(() => flagValue(['order', 'sell', '1', '--key', '--all'], '--key')).toThrow(/--key needs a value/);
    expect(() => flagValue(['order', 'buy', '1', '--usdc'], '--usdc')).toThrow(/--usdc needs a value/);
    const known = ['--usdc', '--shares', '--all', '--max-price', '--min-price', '--key', '--config'];
    expect(() => rejectUnknownFlags(['buy', '1', '--usdc', '5', '--max_price', '0.3'], known)).toThrow(/unknown option --max_price/);
    expect(() => rejectUnknownFlags(['buy', '1', '--usdc', '5', '--kye', 'x'], known)).toThrow(/unknown option --kye/);
    expect(() => rejectUnknownFlags(['buy', '1', '--usdc', '5', '--max-price', '0.3', '--key', 'k'], known)).not.toThrow();
  });
});

describe('walkBook', () => {
  it('crosses levels up to the limit', () => {
    const asks = [{ price: toMicro('0.4'), size: toMicro('10') }, { price: toMicro('0.5'), size: toMicro('10') }];
    expect(walkBook(asks, 'buy', toMicro('0.5'), toMicro('15'))).toEqual({ shares: toMicro('15'), usdc: toMicro('6.5') });
    expect(walkBook(asks, 'buy', toMicro('0.45'), toMicro('15'))).toEqual({ shares: toMicro('10'), usdc: toMicro('4') });
  });
});

describe('read commands', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('describeMarket shows the outcome, all outcomes and the top of the book', async () => {
    const m = await describeMarket(new FakeEx(), TOKEN, 1);
    expect(m).toMatchObject({ question: 'Will it?', outcome: 'Yes', book: { bestAsk: 0.4, bestBid: 0.38, asks: [{ price: 0.4, shares: 30 }] } });
  });

  it('positions and trades read the public data API for the account address only', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(url.includes('/positions')
      ? [{ asset: '1', conditionId: '0xc', title: 'T', outcome: 'Yes', size: 2, avgPrice: 0.5, curPrice: 0.6, initialValue: 1, currentValue: 1.2, cashPnl: 0.2, redeemable: false }]
      : [{ timestamp: 1791961889, side: 'BUY', asset: '1', size: 2, price: 0.5, title: 'T', outcome: 'Yes', transactionHash: '0xt' }])); }) as unknown as typeof fetch;
    const addr = `0x${'a'.repeat(40)}`;
    expect(await positions(addr, f)).toEqual([expect.objectContaining({ tokenId: '1', shares: 2, pnl: 0.2 })]);
    expect(await trades(addr, 5, f)).toEqual([expect.objectContaining({ side: 'BUY', at: new Date(1791961889 * 1000).toISOString() })]);
    expect(urls[1]).toContain('limit=5');
    await expect(positions('0xnot', f)).rejects.toThrow(/address/);
  });

  it('a secret with quotes, backslashes or newlines is redacted before serialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmw-mcp-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, `mode: dry-run\npmwallets:\n  apiKey: pmw_abc_def\npolymarket:\n  funderAddress: "0x${'c'.repeat(40)}"\ndataDir: ${dir}\n`);
    const nasty = 'pa"ss\\word\nline2xyz';
    addSecret(nasty);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ asset: '1', title: `echo ${nasty}` }])));
    const text = await agentTools(path).find((t) => t.name === 'positions')!.handler({}) as string;
    expect(JSON.parse(text)[0].title).toBe('echo <redacted>');
    expect(text).not.toContain('ss\\\\word');
  });

  it('an MCP order with a key of the wrong type is refused, not sent unprotected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmw-mcp-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, `mode: dry-run\npmwallets:\n  apiKey: pmw_abc_def\ndataDir: ${dir}\n`);
    const buyTool = agentTools(path).find((t) => t.name === 'order_buy')!;
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, key: 123 })).rejects.toThrow(/key must be a (non-empty )?string/);
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, key: { id: 'x' } })).rejects.toThrow(/key must be a (non-empty )?string/);
    // an explicit null is a key of the wrong type too — only leaving it out means "no key"
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, key: null })).rejects.toThrow(/key must be a (non-empty )?string/);
  });

  it('an MCP order with a misspelt, null or mistyped limit is refused, never traded without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmw-mcp-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, `mode: dry-run\npmwallets:\n  apiKey: pmw_abc_def\ndataDir: ${dir}\n`);
    const tools = agentTools(path);
    const buyTool = tools.find((t) => t.name === 'order_buy')!;
    const sellTool = tools.find((t) => t.name === 'order_sell')!;
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, max_price: 0.3 })).rejects.toThrow(/unknown argument "max_price"/);
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, maxPrice: null })).rejects.toThrow(/maxPrice must be a number/);
    await expect(buyTool.handler({ tokenId: TOKEN, usdc: 5, maxPrice: '' })).rejects.toThrow(/maxPrice must be a number/);
    await expect(sellTool.handler({ tokenId: TOKEN, all: 'true' })).rejects.toThrow(/all must be a boolean/);
    await expect(sellTool.handler({ all: true })).rejects.toThrow(/tokenId is required/);
    await expect(tools.find((t) => t.name === 'balance')!.handler({ verbose: true })).rejects.toThrow(/unknown argument/);
  });

  it('MCP tool results and errors never carry a known credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmw-mcp-'));
    const funder = `0x${'b'.repeat(40)}`;
    const path = join(dir, 'config.yaml');
    writeFileSync(path, `mode: dry-run\npmwallets:\n  apiKey: pmw_abc_def\npolymarket:\n  funderAddress: "${funder}"\ndataDir: ${dir}\n`);
    const secret = 'sk_live_supersecretvalue';
    addSecret(secret);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ asset: '1', title: `leak ${secret}` }])));
    const tools = agentTools(path);
    const text = await tools.find((t) => t.name === 'positions')!.handler({}) as string;
    expect(text).not.toContain(secret);
    expect(text).toContain('<redacted>');
    vi.stubGlobal('fetch', async () => { throw new Error(`refused ${secret}`); });
    await expect(tools.find((t) => t.name === 'trades')!.handler({})).rejects.toThrow(/refused <redacted>/);
  });
});
