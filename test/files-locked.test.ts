import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Windows: a log file open in another program cannot be renamed, while its older pieces still can
const locked = new Set<string>();
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: string, to: string) => { if (locked.has(from)) throw new Error('EBUSY'); fs.renameSync(from, to); } };
});
const { RotatingFile } = await import('../src/files.js');

describe('rotating a file that is open elsewhere', () => {
  it('never eats the older pieces, however often it retries', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'pmw-locked-')), 'bot.log');
    writeFileSync(`${p}.1`, 'one\n');
    writeFileSync(`${p}.2`, 'two\n');
    const f = new RotatingFile(p, 20, 2);
    locked.add(p);
    for (let i = 0; i < 12; i++) f.append('xxxxxxxxx\n');
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('one\n');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('two\n');
    expect(readFileSync(p, 'utf8')).toBe('xxxxxxxxx\n'.repeat(12));
    locked.delete(p);
    f.append('yyyyyyyyy\n'); // unlocked: the next rotation goes through
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('xxxxxxxxx\n'.repeat(12));
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('one\n');
  });
});
