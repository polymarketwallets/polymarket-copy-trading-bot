import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface TargetConfig {
  /** 0x address of the entity (or its 12-character handle, resolved at start-up) */
  entity: string;
  /** per-target override of copy.orderSizeUsdc */
  orderSizeUsdc?: number;
  /** per-target override of copy.maxBuysPerOutcome */
  maxBuysPerOutcome?: number;
}

export interface CopyConfig {
  /** USDC spent on each mirrored BUY */
  orderSizeUsdc: number;
  /** which of the target's fills to act on */
  roles: ('taker' | 'maker')[];
  /** mirror the first N BUYs into the same outcome (DCA), skip the rest */
  maxBuysPerOutcome: number;
  maxOpenPositions: number;
  maxOpenPositionsPerTarget: number;
  /** a fill older than this when we see it is not copied (a replay after downtime must not trade history) */
  maxFillAgeSec: number;
  /** ignore target BUYs smaller than this — bots trade $1-2 fills */
  minTargetNotionalUsdc: number;
  /** only BUY when the best ask is inside [minPrice, maxPrice] */
  minPrice: number;
  maxPrice: number;
  /** skip when our BUY would cost more than the target paid + this (price units, 0.03 = 3 cents) */
  maxSlippage: number;
  /** skip when the side we take has less than this much USDC in depth */
  minBookDepthUsdc: number;
  /** don't BUY a market that settles sooner than this */
  minSecondsToEndDate: number;
  /** don't BUY a market that settles later than this (0 = no limit) */
  maxSecondsToEndDate: number;
  /** when the target sells: `all` = exit everything we bought following them in that outcome, `none` = hold to settlement */
  sellMode: 'all' | 'none';
}

export interface RiskConfig {
  /** total USDC of mirrored BUYs per UTC day (0 = no limit) */
  maxDailySpendUsdc: number;
}

export interface PolymarketConfig {
  clobUrl: string;
  privateKey?: string;
  /** 0 = EOA, 1 = POLY_PROXY (email / Magic login), 2 = POLY_GNOSIS_SAFE (browser-wallet login) */
  signatureType: number;
  /** the Polymarket account address that holds your USDC (your profile address) */
  funderAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

export interface Config {
  mode: 'dry-run' | 'live';
  pmwallets: { apiKey: string; baseUrl: string };
  polymarket: PolymarketConfig;
  /** empty = every entity your PMWallets account subscribes to */
  targets: TargetConfig[];
  copy: CopyConfig;
  risk: RiskConfig;
  /** directory for state and the decision log */
  dataDir: string;
}

export const DEFAULTS: Omit<Config, 'pmwallets' | 'polymarket' | 'targets'> & { polymarket: Pick<PolymarketConfig, 'clobUrl' | 'signatureType'> } = {
  mode: 'dry-run',
  polymarket: { clobUrl: 'https://clob.polymarket.com', signatureType: 2 },
  copy: {
    orderSizeUsdc: 10,
    roles: ['taker', 'maker'],
    maxBuysPerOutcome: 3,
    maxOpenPositions: 20,
    maxOpenPositionsPerTarget: 5,
    maxFillAgeSec: 60,
    minTargetNotionalUsdc: 25,
    minPrice: 0.05,
    maxPrice: 0.95,
    maxSlippage: 0.03,
    minBookDepthUsdc: 50,
    minSecondsToEndDate: 600,
    maxSecondsToEndDate: 0,
    sellMode: 'all',
  },
  risk: { maxDailySpendUsdc: 200 },
  dataDir: './pmw-data',
};

/** `${NAME}` → process.env.NAME; a missing variable is an error, not an empty string */
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') throw new Error(`config refers to \${${name}} but it is not set`);
    return v;
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HANDLE = /^[0-9A-Z]{12}$/;

function num(v: unknown, path: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${path} must be a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
  return n;
}

function int(v: unknown, path: string, min: number, max: number): number {
  const n = num(v, path, min, max);
  if (!Number.isInteger(n)) throw new Error(`${path} must be a whole number, got ${JSON.stringify(v)}`);
  return n;
}

/** Merge onto the defaults and validate. Fail loud on anything that would make the bot trade wrong. */
export function buildConfig(raw: Record<string, any>): Config {
  const copyRaw = raw['copy'] ?? {};
  const copy: CopyConfig = { ...DEFAULTS.copy, ...copyRaw };
  const c: Config = {
    mode: raw['mode'] ?? DEFAULTS.mode,
    pmwallets: { apiKey: raw['pmwallets']?.apiKey, baseUrl: raw['pmwallets']?.baseUrl ?? 'https://api.pmwallets.com' },
    polymarket: { ...DEFAULTS.polymarket, ...(raw['polymarket'] ?? {}) },
    targets: (raw['targets'] ?? []).map((t: unknown) => (typeof t === 'string' ? { entity: t } : t)),
    copy,
    risk: { ...DEFAULTS.risk, ...(raw['risk'] ?? {}) },
    dataDir: raw['dataDir'] ?? DEFAULTS.dataDir,
  };

  if (c.mode !== 'dry-run' && c.mode !== 'live') throw new Error(`mode must be dry-run or live, got ${JSON.stringify(c.mode)}`);
  if (!c.pmwallets.apiKey || !/^pmw_/.test(c.pmwallets.apiKey)) throw new Error('pmwallets.apiKey is required (pmw_…, from https://pmwallets.com/keys)');

  // validated AND written back as numbers: YAML allows "60" and both implementations must compute with 60
  copy.orderSizeUsdc = num(copy.orderSizeUsdc, 'copy.orderSizeUsdc', 1, 1_000_000);
  copy.maxBuysPerOutcome = int(copy.maxBuysPerOutcome, 'copy.maxBuysPerOutcome', 1, 1000);
  copy.maxOpenPositions = int(copy.maxOpenPositions, 'copy.maxOpenPositions', 1, 100_000);
  copy.maxOpenPositionsPerTarget = int(copy.maxOpenPositionsPerTarget, 'copy.maxOpenPositionsPerTarget', 1, 100_000);
  copy.maxFillAgeSec = num(copy.maxFillAgeSec, 'copy.maxFillAgeSec', 1, 86_400);
  copy.minTargetNotionalUsdc = num(copy.minTargetNotionalUsdc, 'copy.minTargetNotionalUsdc', 0, 1_000_000_000);
  copy.minPrice = num(copy.minPrice, 'copy.minPrice', 0, 1);
  copy.maxPrice = num(copy.maxPrice, 'copy.maxPrice', 0, 1);
  copy.maxSlippage = num(copy.maxSlippage, 'copy.maxSlippage', 0, 1);
  copy.minBookDepthUsdc = num(copy.minBookDepthUsdc, 'copy.minBookDepthUsdc', 0, 1_000_000_000);
  copy.minSecondsToEndDate = num(copy.minSecondsToEndDate, 'copy.minSecondsToEndDate', 0, 1e9);
  copy.maxSecondsToEndDate = num(copy.maxSecondsToEndDate, 'copy.maxSecondsToEndDate', 0, 1e9);
  c.risk.maxDailySpendUsdc = num(c.risk.maxDailySpendUsdc, 'risk.maxDailySpendUsdc', 0, 1e12);
  if (copy.minPrice >= copy.maxPrice) throw new Error(`copy.minPrice ${copy.minPrice} >= copy.maxPrice ${copy.maxPrice}: every BUY would be rejected`);
  if (copy.maxSecondsToEndDate > 0 && copy.maxSecondsToEndDate <= copy.minSecondsToEndDate) {
    throw new Error('copy.maxSecondsToEndDate must be above copy.minSecondsToEndDate (or 0 to disable)');
  }
  if (!Array.isArray(copy.roles) || !copy.roles.length || copy.roles.some((r) => r !== 'taker' && r !== 'maker')) {
    throw new Error('copy.roles must be a non-empty list of taker / maker');
  }
  if (copy.sellMode !== 'all' && copy.sellMode !== 'none') throw new Error('copy.sellMode must be all or none');

  for (const [i, t] of c.targets.entries()) {
    if (!t || typeof t.entity !== 'string' || !(ADDRESS.test(t.entity) || HANDLE.test(t.entity))) {
      throw new Error(`targets[${i}].entity must be a 0x address or a 12-character handle`);
    }
    t.entity = ADDRESS.test(t.entity) ? t.entity.toLowerCase() : t.entity;
    if (t.orderSizeUsdc !== undefined) t.orderSizeUsdc = num(t.orderSizeUsdc, `targets[${i}].orderSizeUsdc`, 1, 1_000_000);
    if (t.maxBuysPerOutcome !== undefined) t.maxBuysPerOutcome = int(t.maxBuysPerOutcome, `targets[${i}].maxBuysPerOutcome`, 1, 1000);
  }

  const pm = c.polymarket;
  pm.signatureType = int(pm.signatureType, 'polymarket.signatureType', 0, 2);
  if (c.mode === 'live') {
    if (!pm.privateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(pm.privateKey)) throw new Error('live mode needs polymarket.privateKey (64 hex characters)');
    if (!pm.privateKey.startsWith('0x')) pm.privateKey = `0x${pm.privateKey}`;
    if (pm.signatureType !== 0 && !(pm.funderAddress && ADDRESS.test(pm.funderAddress))) {
      throw new Error('live mode with a proxy/safe signature type needs polymarket.funderAddress (your Polymarket profile address)');
    }
  }
  return c;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const text = readFileSync(path, 'utf8');
  // substitute only in non-comment content so an unset variable named in a comment is not an error
  const withoutComments = text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  return buildConfig((parse(substituteEnv(withoutComments, env)) ?? {}) as Record<string, any>);
}
