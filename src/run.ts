import { join } from 'node:path';
import { FileStateStore, FillStream, PmwClient, PmwError, type StreamEvent } from 'pmwallets';
import type { Config, TargetConfig } from './config.js';
import { CopyEngine } from './engine.js';
import type { Logger } from './log.js';
import { PolymarketGateway } from './polymarket.js';
import { applyProxyFromEnv } from './proxy.js';
import { BotState } from './state.js';
import { fmtUsd, toMicro } from './units.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * Which entities to copy, as addresses. Handles are resolved through the entity endpoint, which only
 * returns the address for an entity you own — i.e. one you subscribe to or bought.
 */
export async function resolveTargets(cfg: Config, client: PmwClient, log: Logger): Promise<Map<string, TargetConfig> | null> {
  const subs = (await client.subscriptions()).filter((s) => s.status !== 'canceled');
  const active = new Map(subs.filter((s) => s.status === 'active').map((s) => [s.entityId.toLowerCase(), s]));
  for (const s of subs) {
    if (s.status === 'paused') log.warn('subscription is PAUSED (balance ran out) — no fills will arrive for it until you resume it', { entity: s.entityId, id: s.id });
    else if (!s.channels.includes('ws')) log.warn('subscription does not include the ws channel — its fills reach the bot only through replay', { entity: s.entityId });
  }
  if (!cfg.targets.length) {
    if (!active.size) log.warn('no active subscriptions: subscribe to an entity on pmwallets.com (or with the SDK) and the bot will copy it');
    else log.info(`copying every subscribed entity (${active.size})`, { entities: [...active.keys()] });
    return null;
  }
  const out = new Map<string, TargetConfig>();
  for (const t of cfg.targets) {
    let addr = t.entity.toLowerCase();
    if (!ADDRESS.test(t.entity)) {
      const e = await client.entity(t.entity).catch((err: unknown) => { throw new Error(`cannot resolve handle ${t.entity}: ${(err as Error).message}`); });
      const id = String(e['entityId'] ?? '');
      if (!ADDRESS.test(id)) throw new Error(`handle ${t.entity}: the API did not return its address — subscribe to it (or buy its address) first`);
      addr = id.toLowerCase();
    }
    if (!active.has(addr)) log.warn('target has no ACTIVE subscription: nothing will be copied from it until you subscribe', { entity: addr });
    out.set(addr, { ...t, entity: addr });
  }
  log.info(`copying ${out.size} target(s)`, { entities: [...out.keys()] });
  return out;
}

export async function run(cfg: Config, log: Logger): Promise<void> {
  const { agent, proxy } = applyProxyFromEnv();
  if (proxy) log.info('using proxy from the environment', { proxy });
  const client = new PmwClient({ apiKey: cfg.pmwallets.apiKey, baseUrl: cfg.pmwallets.baseUrl });
  const exchange = new PolymarketGateway(cfg.mode === 'live' ? cfg.polymarket : { ...cfg.polymarket, privateKey: undefined }, log);
  const state = new BotState(cfg.dataDir, cfg.mode);

  log.info(`pmwallets-copytrade starting in ${cfg.mode.toUpperCase()} mode`, { state: state.file, decisions: state.decisionsFile });
  if (cfg.mode === 'dry-run') log.info('dry-run: no order is sent; fills are simulated at the best price on the book');

  let targets: Map<string, TargetConfig> | null;
  try {
    targets = await resolveTargets(cfg, client, log);
  } catch (e) {
    if (e instanceof PmwError && e.status === 401) throw new Error('PMWallets rejected the API key (401)');
    throw e;
  }

  if (cfg.mode === 'live') {
    await exchange.connect();
    const usdc = await exchange.collateralBalance();
    log.info('polymarket balance', { usdc: fmtUsd(usdc) });
    if (usdc < toMicro(cfg.copy.orderSizeUsdc)) log.warn('balance is below one order: BUYs will be rejected until you deposit');
  }

  const engine = new CopyEngine({ cfg, exchange, state, log, targets });
  const stream = new FillStream({
    client,
    store: new FileStateStore(join(cfg.dataDir, `stream.${cfg.mode}.json`)),
    onFill: engine.onFill,
    wsOptions: agent ? { agent } : undefined,
    onEvent: (e: StreamEvent) => {
      if (e.type === 'hello') log.info('connected to the PMWallets fill stream', { session: e.session });
      else if (e.type === 'gap') log.warn('missed fills detected; replaying from the last one handled', { reason: e.reason, fromBlock: e.fromBlock });
      else if (e.type === 'replayed' && e.delivered) log.info('replay done', { delivered: e.delivered });
      else if (e.type === 'replaced') log.warn('another connection with this API account took over the stream (one per account) — close the other bot or the browser feed page');
      else if (e.type === 'disconnected') log.warn('stream disconnected; reconnecting', { code: e.code, reason: e.reason || undefined });
      else if (e.type === 'error') log.warn('stream error', { error: e.error.message });
      else if (e.type === 'fatal') { log.error('stream stopped', { error: e.error.message }); void shutdown(1); }
    },
  });

  await engine.sweepSettled();
  const sweep = setInterval(() => void engine.sweepSettled(), 10 * 60_000);
  await stream.start();

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    log.info('stopping…');
    clearInterval(sweep);
    engine.stop();
    await stream.stop();
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
