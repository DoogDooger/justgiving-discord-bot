import { describe, expect, it } from 'vitest';
import { DONATION_ID_PLACEHOLDER, JustGivingError, buildDonateLink, buildExitUrl, createJustGivingClient } from '../src/justgiving.js';

describe('SDI links', () => {
  it('builds the exit URL with the donation ID placeholder left intact', () => {
    expect(buildExitUrl('https://my-donor-bot.fly.dev', 'ABCD2345')).toBe(
      'https://my-donor-bot.fly.dev/justgiving/return?t=ABCD2345&donationId=JUSTGIVING-DONATION-ID',
    );
  });

  it('URL-encodes the exit URL inside the donate link', () => {
    const exitUrl = buildExitUrl('https://my-donor-bot.fly.dev', 'ABCD2345');
    const link = buildDonateLink('123456', 'ABCD2345', exitUrl);

    expect(link.startsWith('https://link.justgiving.com/v1/fundraisingpage/donate/pageid/123456?')).toBe(true);
    expect(link).not.toContain('https://my-donor-bot.fly.dev/justgiving');

    const params = new URL(link).searchParams;
    expect(params.get('reference')).toBe('ABCD2345');
    expect(params.get('exitUrl')).toBe(exitUrl);
    expect(params.get('exitUrl')).toContain(DONATION_ID_PLACEHOLDER);
    // Exactly one "?" in the outer link: the inner one must be encoded.
    expect(link.split('?')).toHaveLength(2);
  });
});

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const path = url.replace('https://api.test/APPID/v1', '');
    const route = routes[path];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fn, seen };
}

describe('JustGiving client', () => {
  it('reads a donation and normalises the ID to a string', async () => {
    const { fn } = fakeFetch({ '/donation/1234': { body: { id: 1234, status: 'Accepted', thirdPartyReference: ' ABCD2345 ', charityId: 4321 } } });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect(await client.getDonation('1234')).toEqual({ id: '1234', status: 'Accepted', thirdPartyReference: 'ABCD2345', charityId: '4321', donatedAtMs: null });
  });

  it.each(['+0000', '+0100', '-0100', ''])('reads the UTC donation timestamp without applying offset %s', async (offset) => {
    const { fn } = fakeFetch({ '/donation/1234': { body: { id: 1234, status: 'Accepted', donationDate: `/Date(1790904657895${offset})/` } } });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect((await client.getDonation('1234'))?.donatedAtMs).toBe(1790904657895);
  });

  it.each([undefined, null, 1790904657895, '', '2026-10-01T00:00:00Z', '/Date(123+010)/', `/Date(${'9'.repeat(400)})/`])('reports an unavailable date for unsupported donationDate %j', async (donationDate) => {
    const { fn } = fakeFetch({ '/donation/1234': { body: { id: 1234, status: 'Accepted', donationDate } } });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect((await client.getDonation('1234'))?.donatedAtMs).toBeNull();
  });

  it('returns null for an unknown donation', async () => {
    const { fn } = fakeFetch({});
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect(await client.getDonation('999')).toBeNull();
  });

  it('throws JustGivingError on server errors and network failures', async () => {
    const { fn } = fakeFetch({ '/donation/1': { status: 500 } });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn, retryDelayMs: 1 });
    await expect(client.getDonation('1')).rejects.toBeInstanceOf(JustGivingError);

    const broken = createJustGivingClient({
      appId: 'APPID',
      apiBase: 'https://api.test',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(broken.getDonation('1')).rejects.toBeInstanceOf(JustGivingError);
  });

  it('retries when JustGiving is busy, then gives up cleanly', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls < 3
        ? new Response('slow down', { status: 429 })
        : new Response(JSON.stringify({ id: 1, status: 'Accepted', thirdPartyReference: 'ABCD2345' }), { status: 200 });
    }) as typeof fetch;
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: flaky, retryDelayMs: 1 });
    expect(await client.getDonation('1')).toMatchObject({ id: '1', status: 'Accepted' });
    expect(calls).toBe(3);

    const down = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    const failing = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: down, retryDelayMs: 1 });
    await expect(failing.getDonation('1')).rejects.toBeInstanceOf(JustGivingError);
  });

  it('finds the charity of a donation through its reference', async () => {
    const { fn } = fakeFetch({
      '/donation/ref/ABCD2345': { body: { donations: [{ id: 1, charityId: 11 }, { id: 2, charityId: 4321 }] } },
    });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect(await client.getDonationCharityId('ABCD2345', '2')).toBe('4321');
    expect(await client.getDonationCharityId('ABCD2345', '3')).toBeNull();
    expect(await client.getDonationCharityId('NOPE', '2')).toBeNull();
  });

  it('checks the donation list of newer (page/...) and older pages', async () => {
    const { fn, seen } = fakeFetch({
      '/fundraising/pages/page/my-page/donations': { body: { donations: [{ id: 5, status: 'Accepted' }] } },
      '/fundraising/pages/old-page/donations': { body: { donations: [] } },
    });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect(await client.pageHasDonation('page/my-page', '5')).toBe(true);
    expect(await client.pageHasDonation('old-page', '5')).toBe(false);
    expect(seen[0]).toBe('https://api.test/APPID/v1/fundraising/pages/page/my-page/donations');
  });

  it('reads public donation amounts across pages and skips hidden ones', async () => {
    const base = '/fundraising/pages/page/my-page/donations';
    const { fn, seen } = fakeFetch({
      [`${base}?pageSize=100`]: {
        body: { donations: [{ id: 1, amount: '5.0' }, { id: 2, amount: null }], pagination: { nextPageCursor: 'abc=' } },
      },
      [`${base}?pageSize=100&pageCursor=abc%3D`]: {
        body: { donations: [{ id: 3, amount: '25.50' }], pagination: { nextPageCursor: null } },
      },
    });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect([...(await client.getPublicDonationAmounts('page/my-page'))]).toEqual([['1', 5], ['3', 25.5]]);
    expect(seen).toHaveLength(2);
  });

  it('looks up page details', async () => {
    const { fn } = fakeFetch({
      '/fundraising/pages/page/my-page': { body: { pageId: '987654', charity: { id: 4321, name: 'Example Charity' } } },
    });
    const client = createJustGivingClient({ appId: 'APPID', apiBase: 'https://api.test', fetch: fn });
    expect(await client.getPage('page/my-page')).toEqual({ pageId: '987654', charityId: '4321', charityName: 'Example Charity' });
    await expect(client.getPage('missing')).rejects.toBeInstanceOf(JustGivingError);
  });
});
