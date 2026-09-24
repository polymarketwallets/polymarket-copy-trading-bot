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
