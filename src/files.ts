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
    this.size = 0; // whatever happens, the next attempt waits for another maxBytes
    // a piece still set aside must be filed first: moving the live file onto it would overwrite it
    if (existsSync(this.aside) && !this.shiftIn()) return;
    try { renameSync(this.path, this.aside); } catch { return; }
    this.shiftIn();
  }

  /**
   * `.rotating` becomes `.1`. The pieces above it move up only as far as the first free number, and the oldest is
   * deleted only when there is none — so a shift cut short and retried finds its own gap and deletes nothing more.
   */
  private shiftIn(): boolean {
    try {
      let free = 1;
      while (free <= this.keep && existsSync(`${this.path}.${free}`)) free++;
      if (free > this.keep) { unlinkSync(`${this.path}.${this.keep}`); free = this.keep; }
      for (let i = free - 1; i >= 1; i--) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.aside, `${this.path}.1`);
      return true;
    } catch { return false; }
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
