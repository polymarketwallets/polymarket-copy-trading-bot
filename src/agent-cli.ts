/**
 * The agent-facing commands (`market`, `balance`, `positions`, `trades`, `order`, `mcp`): JSON out, logs to stderr.
 */
import { serveMcp, type McpTool } from 'pmwallets';
import { privateKeyToAccount } from 'viem/accounts';
import { checkTradingConfig, loadConfig, type Config } from './config.js';
import { OrderKeys, describeMarket, placeOrder, positions, trades, type OrderRequest } from './agent.js';
import { applyProxyFromEnv } from './proxy.js';
import { EXCHANGE_V3, PolymarketGateway, exchangeV3Approval } from './polymarket.js';
import { funderMismatch } from './run.js';
import { redact, redactText } from './secrets.js';
import { fromMicro } from './units.js';
import { VERSION } from './version.js';
import { checkFunder } from './wallets.js';

/** gateway logs go to stderr: stdout carries the answer (or, for `mcp`, the protocol) */
const stderrLog = {
  info: (m: string, f?: Record<string, unknown>) => process.stderr.write(`${redactText(`${m}${f ? ` ${JSON.stringify(f)}` : ''}`)}\n`),
  warn: (m: string, f?: Record<string, unknown>) => process.stderr.write(`${redactText(`WARN ${m}${f ? ` ${JSON.stringify(f)}` : ''}`)}\n`),
  error: (m: string, f?: Record<string, unknown>) => process.stderr.write(`${redactText(`ERROR ${m}${f ? ` ${JSON.stringify(f)}` : ''}`)}\n`),
};

/**
 * The gateway, connected when the config has Polymarket keys (any mode: `balance` and the SELL size read the
 * account even in dry-run). A funder that is not this key's account is refused before anything else happens.
 */
async function exchangeFor(cfg: Config, needKeys: boolean): Promise<PolymarketGateway> {
  applyProxyFromEnv();
  const hasKey = !!cfg.polymarket.privateKey;
  if (!hasKey) {
    if (needKeys) throw new Error('this needs the Polymarket keys in the config (polymarket.privateKey, signatureType, funderAddress)');
    return new PolymarketGateway({ ...cfg.polymarket, privateKey: undefined }, stderrLog);
  }
  checkTradingConfig(cfg);
  const gw = new PolymarketGateway(cfg.polymarket, stderrLog);
  await gw.connect();
  const fc = checkFunder(gw.signerAddress as `0x${string}`, cfg.polymarket.funderAddress, cfg.polymarket.signatureType!);
  if (!fc.ok) throw new Error(funderMismatch(cfg.polymarket.funderAddress, cfg.polymarket.signatureType!, fc));
  return gw;
}

/** the address that holds the account's funds and positions, without any network call */
export function accountAddress(cfg: Config): string {
  if (cfg.polymarket.funderAddress) return cfg.polymarket.funderAddress;
  if (!cfg.polymarket.privateKey) throw new Error('set polymarket.funderAddress (or privateKey) in the config');
  checkTradingConfig(cfg);
  return privateKeyToAccount(cfg.polymarket.privateKey as `0x${string}`).address;
}

export async function balanceOf(cfg: Config): Promise<Record<string, unknown>> {
  const gw = await exchangeFor(cfg, true);
  const { balance, allowances } = await gw.collateral();
  return { account: accountAddress(cfg), usdc: fromMicro(balance), exchangeV3Approval: exchangeV3Approval(allowances), exchangeV3: EXCHANGE_V3, mode: cfg.mode };
}

export async function order(cfg: Config, req: OrderRequest): Promise<Record<string, unknown>> {
  const gw = await exchangeFor(cfg, cfg.mode === 'live');
  return { ...await placeOrder(cfg, gw, req, new OrderKeys(cfg.dataDir, cfg.mode)) };
}

export async function marketInfo(cfg: Config, tokenId: string): Promise<Record<string, unknown>> {
  return describeMarket(new PolymarketGateway({ ...cfg.polymarket, privateKey: undefined }, stderrLog), tokenId);
}

/**
 * The value after `name` in argv; undefined when the flag is absent. A flag with no value — the end of the line, or
 * another option right after it (`--key --all`) — is an error: taking `--all` as the key would trade under it.
 */
/** an option the command does not know is an error: a misspelt `--max_price` must not leave the order without its limit */
export function rejectUnknownFlags(argv: string[], known: string[]): void {
  for (const a of argv) if (a.startsWith('--') && !known.includes(a)) throw new Error(`unknown option ${a} (known: ${known.join(' ')})`);
}

export function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

/**
 * The arguments against the tool's schema, strictly: an MCP host does not have to validate them, and a field that is
 * misspelt (`max_price`), null or of the wrong type must never be dropped quietly — that would remove a limit the
 * caller meant to set and trade without it.
 */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>): void {
  const props = (schema['properties'] ?? {}) as Record<string, { type?: string }>;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) throw new Error(`unknown argument ${JSON.stringify(k)} (allowed: ${Object.keys(props).join(', ') || 'none'})`);
    const ok = p.type === 'number' ? (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
      : p.type === 'string' ? typeof v === 'string'
        : p.type === 'boolean' ? typeof v === 'boolean'
          : true;
    if (!ok) throw new Error(`${k} must be a ${p.type}${v === null ? ' (null is not "not given": leave it out instead)' : ''}`);
  }
  for (const r of (schema['required'] ?? []) as string[]) if (!(r in args)) throw new Error(`${r} is required`);
}

const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const str = (description: string) => ({ type: 'string', description });
const numS = (description: string) => ({ type: 'number', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const AGENT_MCP_INSTRUCTIONS = `pmwallets-copytrade: trade on Polymarket from the account in this config. The config's mode decides: dry-run simulates every order against the live book and sends nothing; live sends real orders with real money.
- Before an order: market (question, outcomes, order book) and balance / positions.
- order_buy spends at most usdc (or buys exact shares), fill-or-kill at maxPrice or better (default: the best ask now). order_sell sells shares (or all) fill-and-kill at minPrice or better.
- Always pass key (e.g. the eventId of the fill you are reacting to): the same key never sends a second order, so retrying is safe.
- status unknown, or verify: true, means the order may have filled: check trades before sending another.`;

export function agentTools(configPath: string): McpTool[] {
  const cfg = () => loadConfig(configPath);
  const sideReq = (side: 'buy' | 'sell', a: Record<string, unknown>): OrderRequest => ({
    side, tokenId: String(a['tokenId'] ?? ''),
    usdc: num(a['usdc'], 'usdc'), shares: num(a['shares'], 'shares'), all: a['all'] === true || undefined,
    maxPrice: num(a['maxPrice'], 'maxPrice'), minPrice: num(a['minPrice'], 'minPrice'),
    // a key of the wrong type is an error, never dropped: a caller retrying would believe it is protected
    key: a['key'] === undefined ? undefined : a['key'] as string,
  });
  const tools: McpTool[] = [
    { name: 'market', description: 'A Polymarket outcome token: its market question, all outcomes with prices, end date and the top of the order book.', inputSchema: schema({ tokenId: str('outcome token id (decimal), e.g. the tokenId of a fill') }, ['tokenId']), handler: async (a) => marketInfo(cfg(), String(a['tokenId'] ?? '')) },
    { name: 'balance', description: 'USDC available to trade in the Polymarket account, and whether its approvals are in place.', inputSchema: schema({}), handler: async () => balanceOf(cfg()) },
    { name: 'positions', description: 'Open positions of the Polymarket account (shares, average price, current value, PnL).', inputSchema: schema({}), handler: async () => positions(accountAddress(cfg())) },
    { name: 'trades', description: 'Recent trades of the Polymarket account, newest first.', inputSchema: schema({ limit: numS('default 50, max 500') }), handler: async (a) => trades(accountAddress(cfg()), num(a['limit'], 'limit') ?? 50) },
    {
      name: 'order_buy',
      description: 'BUY an outcome (fill-or-kill). Give usdc (the most to spend) or shares. In live mode this spends real money.',
      inputSchema: schema({ tokenId: str('outcome token id (decimal)'), usdc: numS('most USDC to spend'), shares: numS('exact shares to buy'), maxPrice: numS('pay at most this per share, 0–1 (default: best ask now)'), key: str('idempotency key, e.g. the fill eventId: the same key never orders twice') }, ['tokenId']),
      handler: async (a) => order(cfg(), sideReq('buy', a)),
    },
    {
      name: 'order_sell',
      description: 'SELL an outcome the account holds (fill-and-kill). Give shares or all: true. In live mode this is a real trade.',
      inputSchema: schema({ tokenId: str('outcome token id (decimal)'), shares: numS('shares to sell'), all: { type: 'boolean', description: 'sell everything held' }, minPrice: numS('take at least this per share, 0–1 (default: best bid now)'), key: str('idempotency key: the same key never orders twice') }, ['tokenId']),
      handler: async (a) => order(cfg(), sideReq('sell', a)),
    },
  ];
  // nothing a tool returns or throws may carry a credential: the agent's transcript goes to its model provider
  return tools.map((t) => ({
    ...t,
    handler: async (a) => {
      // redacted BEFORE it is serialized: JSON escaping (a quote or backslash in a secret) would hide it from the match
      try {
        checkArgs(t.inputSchema, a);
        return JSON.stringify(redact(await t.handler(a)), null, 2);
      } catch (e) { throw new Error(redactText((e as Error).message ?? String(e))); }
    },
  }));
}

export async function serveAgentMcp(configPath: string): Promise<void> {
  loadConfig(configPath); // a broken config fails at start, where the host shows it, not on the first call
  await serveMcp({ name: 'pmwallets-copytrade', version: VERSION, tools: agentTools(configPath), instructions: AGENT_MCP_INSTRUCTIONS });
}
