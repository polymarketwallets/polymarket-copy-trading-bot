/**
 * Where Polymarket lets orders come from. The bot trades through the API, so what matters is the API
 * rule for the machine's public IP — which is not the same as the website's: Polymarket's geoblock
 * endpoint answers `blocked: true` for countries that restrict only the website (Ireland, Japan, …),
 * where API orders are accepted. Lists from https://docs.polymarket.com/api-reference/geoblock
 * (checked 2026-09-25); review them when Polymarket changes its policy.
 */
export const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';

/** OFAC: no new orders, positions cannot be closed either */
const BLOCKED = ['IR', 'SY', 'CU', 'KP', 'UA-43', 'UA-14', 'UA-09'];
/** close-only on the website AND the API: new BUYs are refused */
const API_CLOSE_ONLY = ['AU', 'BY', 'BE', 'BI', 'BR', 'CA-BC', 'CA-ON', 'CA-AB', 'CA-QC', 'CF', 'CD', 'ET', 'FR', 'DE', 'IQ', 'IT', 'LB', 'LY',
  'MM', 'NZ', 'NI', 'PL', 'RU', 'SG', 'SO', 'SK', 'SS', 'SD', 'TW', 'TH', 'GB', 'US', 'UM', 'VE', 'YE', 'ZW'];
/** close-only on the website only: the API — and so this bot — can still open positions */
const WEBSITE_ONLY = ['IE', 'JP', 'MT', 'NL', 'KR'];

export type GeoVerdict = { api: 'ok' | 'close-only' | 'blocked'; country: string; region: string; ip: string; websiteRestricted: boolean };

export function classifyGeo(country: string, region: string): GeoVerdict['api'] | 'website-only' | 'ok' {
  const c = country.toUpperCase();
  const sub = region ? `${c}-${region.toUpperCase()}` : '';
  if (BLOCKED.includes(c) || (sub && BLOCKED.includes(sub))) return 'blocked';
  if (API_CLOSE_ONLY.includes(c) || (sub && API_CLOSE_ONLY.includes(sub))) return 'close-only';
  if (WEBSITE_ONLY.includes(c)) return 'website-only';
  return 'ok';
}

/** where this machine's orders appear to come from, and what the API allows there */
export async function checkGeo(fetchImpl: typeof fetch = fetch): Promise<GeoVerdict> {
  const r = await fetchImpl(GEOBLOCK_URL, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`geoblock lookup → HTTP ${r.status}`);
  const b = (await r.json()) as { ip?: string; country?: string; region?: string };
  const country = String(b.country ?? ''), region = String(b.region ?? '');
  if (!country) throw new Error('geoblock lookup returned no country');
  const k = classifyGeo(country, region);
  return { api: k === 'website-only' ? 'ok' : k, country, region, ip: String(b.ip ?? ''), websiteRestricted: k !== 'ok' };
}
