import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RotatingFile, tailOf } from '../src/files.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pmw-files-'));

describe('rotating files', () => {
  it('rolls over at the size limit and keeps only `keep` old pieces', () => {
    const p = join(dir(), 'sub', 'bot.log');
    const f = new RotatingFile(p, 20, 2);
    for (const l of ['aaaaaaaaa\n', 'bbbbbbbbb\n', 'ccccccccc\n', 'ddddddddd\n', 'eeeeeeeee\n', 'fffffffff\n', 'ggggggggg\n']) f.append(l);
    expect(readFileSync(p, 'utf8')).toBe('ggggggggg\n');
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('eeeeeeeee\nfffffffff\n');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('ccccccccc\nddddddddd\n');
    expect(existsSync(`${p}.3`)).toBe(false);
  });

  it('a crash between the two steps of a rotation loses nothing', () => {
    const p = join(dir(), 'bot.log');
    writeFileSync(`${p}.rotating`, 'moved aside\n');
    writeFileSync(`${p}.1`, 'older\n');
    new RotatingFile(p, 100, 3).append('new\n');
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('moved aside\n');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('older\n');
    expect(readFileSync(p, 'utf8')).toBe('new\n');
  });

  it('picks up the size of a file it did not write', () => {
    const p = join(dir(), 'bot.log');
    writeFileSync(p, 'x'.repeat(15) + '\n');
    new RotatingFile(p, 20, 2).append('yyyyyyyyy\n');
    expect(readFileSync(p, 'utf8')).toBe('yyyyyyyyy\n');
  });

  it('tails across the last rotation and starts at a whole line', () => {
    const p = join(dir(), 'bot.log');
    writeFileSync(`${p}.1`, 'one\ntwo\n');
    writeFileSync(p, 'three\n');
    expect(tailOf(p, 1000)).toBe('one\ntwo\nthree\n');
    expect(tailOf(p, 9)).toBe('three\n'); // 'o\nthree\n' cut to the whole line
    expect(tailOf(p, 12)).toBe('two\nthree\n');
    expect(tailOf(join(dir(), 'none.log'), 100)).toBe('');
  });
});
