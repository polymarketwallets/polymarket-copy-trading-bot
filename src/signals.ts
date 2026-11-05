import type { SignalsConfig } from './config.js';
import type { SignalEntry } from './engine.js';

interface Reader { signals(q: Record<string, unknown>): Promise<Record<string, unknown>> }
interface Engine { onSignal(s: SignalEntry): Promise<void>; heldSignals(): string[] }

/**
 * One round. New signals come from the top of the list; the ones the bot holds are read by id, because a held signal
 * can be pushed off that list by newer ones and its fading must still be seen. Oldest first.
 */
export async function readSignals(client: Reader, engine: Engine, sc: Pick<SignalsConfig, 'source' | 'exitOnFading'>): Promise<void> {
  const r = await client.signals({ source: sc.source, limit: 50 });
  for (const s of [...(r['entries'] as SignalEntry[])].reverse()) await engine.onSignal(s);
  if (!sc.exitOnFading) return;
  const held = engine.heldSignals();
  for (let i = 0; i < held.length; i += 50) {
    const page = await client.signals({ ids: held.slice(i, i + 50).join(','), limit: 50 });
    for (const s of page['entries'] as SignalEntry[]) await engine.onSignal(s);
  }
}
