import { describe, expect, it } from 'vitest';
import { checkGeo, classifyGeo, describeGeo } from '../src/geo.js';

describe('where Polymarket accepts API orders from', () => {
  it.each([
    ['US', 'CA', 'close-only'], ['GB', 'ENG', 'close-only'], ['DE', '', 'close-only'], ['CA', 'ON', 'close-only'],
    ['IR', '', 'blocked'], ['UA', '43', 'blocked'],
    ['IE', 'L', 'website-only'], ['JP', '13', 'website-only'], ['NL', '', 'website-only'],
    ['CA', 'NS', 'ok'], ['ES', 'MD', 'ok'], ['HK', '', 'ok'],
  ])('%s-%s → %s', (c, r, want) => expect(classifyGeo(c, r)).toBe(want));

  it('treats the website-only countries as allowed for the API, whatever the endpoint says', async () => {
    const f = (async () => new Response(JSON.stringify({ blocked: true, ip: '1.2.3.4', country: 'IE', region: 'L' }))) as unknown as typeof fetch;
    expect(await checkGeo(f)).toEqual({ api: 'ok', country: 'IE', region: 'L', ip: '1.2.3.4', websiteRestricted: true, unlisted: false });
  });

  const reply = (body: object) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it('believes the endpoint about a restriction newer than its own lists', async () => {
    const g = await checkGeo(reply({ blocked: true, ip: '1.2.3.4', country: 'ES', region: 'MD' }));
    expect(g).toMatchObject({ api: 'close-only', unlisted: true, websiteRestricted: true });
    expect(describeGeo(g)).toContain('not on this bot');
  });

  it('allows an unrestricted region', async () => {
    expect(await checkGeo(reply({ blocked: false, ip: '1.2.3.4', country: 'ES', region: 'MD' }))).toMatchObject({ api: 'ok', unlisted: false, websiteRestricted: false });
  });

  it('keeps the list verdict when the endpoint disagrees in the permissive direction', async () => {
    expect(await checkGeo(reply({ blocked: false, ip: '1.2.3.4', country: 'US', region: 'CA' }))).toMatchObject({ api: 'close-only', unlisted: false });
  });

  it.each([[{ ip: '1.2.3.4', country: 'ES' }], [{ blocked: 'yes', country: 'ES' }], [{ blocked: false }]])('rejects a malformed reply %j', async (body) => {
    await expect(checkGeo(reply(body))).rejects.toThrow(/geoblock lookup/);
  });

  it('says that a sanctioned region cannot even close positions', () => {
    expect(describeGeo({ api: 'blocked', country: 'IR', region: '', ip: '', websiteRestricted: true, unlisted: false })).toContain('closing positions included');
  });
});
