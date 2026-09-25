import { describe, expect, it } from 'vitest';
import { checkGeo, classifyGeo } from '../src/geo.js';

describe('where Polymarket accepts API orders from', () => {
  it.each([
    ['US', 'CA', 'close-only'], ['GB', 'ENG', 'close-only'], ['DE', '', 'close-only'], ['CA', 'ON', 'close-only'],
    ['IR', '', 'blocked'], ['UA', '43', 'blocked'],
    ['IE', 'L', 'website-only'], ['JP', '13', 'website-only'], ['NL', '', 'website-only'],
    ['CA', 'NS', 'ok'], ['ES', 'MD', 'ok'], ['HK', '', 'ok'],
  ])('%s-%s → %s', (c, r, want) => expect(classifyGeo(c, r)).toBe(want));

  it('treats the website-only countries as allowed for the API, whatever the endpoint says', async () => {
    const f = (async () => new Response(JSON.stringify({ blocked: true, ip: '1.2.3.4', country: 'IE', region: 'L' }))) as unknown as typeof fetch;
    expect(await checkGeo(f)).toEqual({ api: 'ok', country: 'IE', region: 'L', ip: '1.2.3.4', websiteRestricted: true });
  });
});
