import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Windows: a log file open in another program cannot be renamed, while its older pieces still can
const locked = new Set<string>();
/** renames of these sources fail once, then work */
const failOnce = new Set<string>();
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: string, to: string) => { if (locked.has(from)) throw new Error('EBUSY'); if (failOnce.delete(from)) throw new Error('EBUSY'); fs.renameSync(from, to); } };
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

  it('a shift cut short and finished after a restart deletes nothing more', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'pmw-shift-')), 'bot.log');
    writeFileSync(`${p}.1`, 'A\n'); writeFileSync(`${p}.2`, 'B\n'); writeFileSync(`${p}.3`, 'C\n');
    const f = new RotatingFile(p, 10, 3);
    f.append('LLLLLLLLL\n');
    failOnce.add(`${p}.1`); // .1 -> .2 fails midway: C is gone (the oldest, as it should be), B moved to .3
    f.append('MMMMMMMMM\n');
    new RotatingFile(p, 10, 3); // restart: files the piece set aside
    expect([1, 2, 3].map((i) => readFileSync(`${p}.${i}`, 'utf8'))).toEqual(['LLLLLLLLL\n', 'A\n', 'B\n']);
    expect(readFileSync(p, 'utf8')).toBe('MMMMMMMMM\n');
  });
});
