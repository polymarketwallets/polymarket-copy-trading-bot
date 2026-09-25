import type { RotatingFile } from './files.js';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** One line per event on stdout: human-readable, with the fields as JSON. */
export function consoleLogger(json = false): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    if (json) { console.log(JSON.stringify({ ts, level, msg, ...fields }, big)); return; }
    const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields, big)}` : '';
    (level === 'error' ? console.error : console.log)(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`);
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/**
 * `inner`, and a JSON line per event in `file` — the log a user can send us when something went wrong, whether
 * or not their terminal kept it. A failed write is dropped: the log must never stop the bot.
 */
export function teeLogger(inner: Logger, file: RotatingFile): Logger {
  const write = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => {
    inner[level](msg, fields);
    try { file.append(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, big)}\n`); } catch { /* see above */ }
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
