import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * An append-only file that never grows far past `keep + 1` pieces of `maxBytes`: `name` is written, `name.1` is
 * the piece before it, … `name.<keep>` the oldest. Rotation first moves the current file aside under one name; only
 * once that worked are the older pieces shifted, so a rename that keeps failing (Windows, a file open elsewhere)
 * never eats them. After a failure the next attempt waits for another `maxBytes`: a log must never stop the bot,
 * and losing the size limit for a while is better than losing lines.
 */
export class RotatingFile {
  private size: number;
  private readonly aside: string;

  constructor(readonly path: string, private readonly maxBytes: number, private readonly keep: number) {
    mkdirSync(dirname(path), { recursive: true });
    this.aside = `${path}.rotating`;
    this.size = existsSync(path) ? statSync(path).size : 0;
    if (existsSync(this.aside)) this.shiftIn(); // a rotation cut short by a crash
  }

  append(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, line);
    this.size += bytes;
  }

  private rotate(): void {
    try {
      if (existsSync(this.aside)) this.shiftIn();
      renameSync(this.path, this.aside);
    } catch {
      this.size = 0; // try again after another maxBytes
      return;
    }
    this.size = 0;
    this.shiftIn();
  }

  /** `.rotating` becomes `.1`, the older pieces move up one, the oldest goes */
  private shiftIn(): void {
    try {
      if (existsSync(`${this.path}.${this.keep}`)) unlinkSync(`${this.path}.${this.keep}`);
      for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.aside, `${this.path}.1`);
    } catch { /* left as .rotating: the next rotation finishes it */ }
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
