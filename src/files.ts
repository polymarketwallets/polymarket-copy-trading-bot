import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * An append-only file that never grows past `keep + 1` pieces of `maxBytes`: `name` is written, `name.1` is the
 * piece before it, … `name.<keep>` the oldest. A failed rotation keeps appending to the current file — losing
 * the size limit is better than losing the line, and a log must never stop the bot.
 */
export class RotatingFile {
  private size: number;

  constructor(readonly path: string, private readonly maxBytes: number, private readonly keep: number) {
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  append(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, line);
    this.size += bytes;
  }

  private rotate(): void {
    try {
      if (existsSync(`${this.path}.${this.keep}`)) unlinkSync(`${this.path}.${this.keep}`);
      for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.path, `${this.path}.1`);
      this.size = 0;
    } catch { /* keep writing where we are */ }
  }
}

/** The last `maxBytes` of a rotated file (older piece first), starting at a whole line; '' when there is none. */
export function tailOf(path: string, maxBytes: number): string {
  const pieces = [`${path}.1`, path].filter((p) => existsSync(p));
  const chunks: Buffer[] = [];
  let left = maxBytes;
  let cut = false;
  for (const p of pieces.reverse()) {
    const size = statSync(p).size;
    const take = Math.min(size, left);
    if (take < size) cut = true;
    if (take <= 0) break;
    const buf = Buffer.alloc(take);
    const fd = openSync(p, 'r');
    try { readSync(fd, buf, 0, take, size - take); } finally { closeSync(fd); }
    chunks.unshift(buf);
    left -= take;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!cut) return text;
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : '';
}
