import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { PageDirectory } from '../src/pages.js';
import { createWebApi, isDecember, readableOn } from '../src/web/api.js';
import { createWebServer, type AstroHandler } from '../src/web/server.js';
import { USER_A, USER_B, charity, donation, setup, site } from './helpers.js';

const config: Config = {
  discordToken: 'x',
  guildId: '100000000000000000',
  inviteUrl: 'https://discord.gg/example',
  charity,
  site,
  justGivingAppId: 'app',
  justGivingApiBase: 'https://api.test',
  publicBaseUrl: 'https://donate.test',
  port: 0,
  databasePath: ':memory:',
  sendDmOnSuccess: false,
  driveEndsAt: new Date('2027-01-01T00:00:00Z'),
};

const profiles = {
  async getMany(ids: string[]) {
    return new Map(ids.map((id) => [id, { name: `User ${id.slice(0, 3)}`, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' }]));
  },
};

function context(deps: ReturnType<typeof setup>['deps']): AppContext {
  return { config, donations: deps, pages: new PageDirectory(deps.justGiving, charity), profiles };
}

describe('web API: JustGiving return', () => {
  it('adds the role and returns a thank-you view', async () => {
    const { deps, tokens, discord } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    const view = await createWebApi(() => context(deps)).handleReturn({ t: tokens.a, donationId: '100' });
    expect(view).toMatchObject({ status: 200, tone: 'success', title: 'Thank you for supporting Charity One!', retryUrl: null });
    expect(discord.calls).toHaveLength(1);
  });

  it('offers Try again only for retryable failures, without /claim advice', async () => {
    const { deps, tokens } = setup((t) => ({
      donations: { '100': donation('100', t.a, 'Pending'), '200': donation('200', t.a, 'Refunded') },
      pages: { 'page-one': ['100', '200'] },
    }));
    const api = createWebApi(() => context(deps));

    const pending = await api.handleReturn({ t: tokens.a, donationId: '100' });
    expect(pending).toMatchObject({ tone: 'retry', retryUrl: `/justgiving/return?t=${tokens.a}&donationId=100` });
    expect(pending.paragraphs.join(' ')).not.toContain('/claim');

    const refunded = await api.handleReturn({ t: tokens.a, donationId: '200' });
    expect(refunded).toMatchObject({ tone: 'error', retryUrl: null });
  });

  it('handles the unreplaced placeholder and junk input', async () => {
    const { deps } = setup();
    const api = createWebApi(() => context(deps));
    expect(await api.handleReturn({ t: 'ABC', donationId: 'JUSTGIVING-DONATION-ID' })).toMatchObject({ status: 400 });
    const junk = await api.handleReturn({ t: '<script>', donationId: '<img src=x>' });
    expect(junk.retryUrl).toBeNull();
    expect(JSON.stringify(junk)).not.toContain('<img');
  });
});

describe('web API: home page', () => {
  it('shows totals, stats and a feed that respects the opt-out', async () => {
    const { deps, store, tokens } = setup();
    store.insertClaim({ donationId: '1', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'redirect' });
    store.insertClaim({ donationId: '2', discordUserId: USER_B, token: tokens.b, pageShortName: 'page-one', source: 'claim' });
    store.setHiddenFromWall(USER_B, true);

    const home = await createWebApi(() => context(deps)).getHome();
    expect(home).toMatchObject({
      totals: { raised: 2, target: 1000, currencySymbol: '£' },
      endsAt: Date.parse('2027-01-01T00:00:00Z'),
    });
    expect(home.feed.map((f) => f.name)).toEqual([`User ${USER_A.slice(0, 3)}`]);
  });
});

describe('web API: site settings', () => {
  it('gives pages the branding, with defaults filled in', () => {
    const { deps } = setup();
    expect(createWebApi(() => context(deps)).getSite()).toEqual({
      communityName: 'Test Community',
      communityUrl: null,
      charityName: 'Charity One',
      inviteUrl: 'https://discord.gg/example',
      accentColor: '#7c5cff',
      onAccentColor: '#ffffff',
      logoPath: null,
      previewImageUrl: null,
      baseUrl: 'https://donate.test',
      headline: 'Raising money for Charity One',
      rewardText: "you'll get the donor role as a thank you",
      festive: false,
      timeZone: 'UTC',
      locale: 'en-GB',
    });
  });

  it('uses custom branding when set', () => {
    const { deps } = setup();
    const custom: Config = { ...config, site: { ...site, headline: 'Grant a wish', previewImagePath: '/preview.png', accentColor: '#ffe14d' } };
    const info = createWebApi(() => ({ ...context(deps), config: custom })).getSite();
    expect(info).toMatchObject({ headline: 'Grant a wish', previewImageUrl: 'https://donate.test/preview.png', onAccentColor: '#111111' });
  });

  it('picks readable text for the accent colour', () => {
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#c80d0d')).toBe('#ffffff');
    expect(readableOn('#ffffff')).toBe('#111111');
    expect(readableOn('#ffe14d')).toBe('#111111');
  });

  it('only turns festive in December for the configured time zone', () => {
    expect(isDecember('UTC', new Date('2026-12-15T12:00:00Z'))).toBe(true);
    expect(isDecember('UTC', new Date('2026-11-30T23:59:00Z'))).toBe(false);
    // Still November in UTC, already December in Auckland.
    expect(isDecember('Pacific/Auckland', new Date('2026-11-30T23:59:00Z'))).toBe(true);
  });
});

describe('web API: top donors', () => {
  it('ranks by public JustGiving amounts, skipping hidden amounts and hidden donors', async () => {
    const { deps, store, tokens } = setup(() => ({
      // Donation 3 has no public amount (hidden on JustGiving), so it doesn't count.
      amounts: { 'page-one': { '1': 10, '2': 5, '4': 100, '6': 7.5 } },
    }));
    const claim = (donationId: string, user: string, token: string) =>
      store.insertClaim({ donationId, discordUserId: user, token, pageShortName: 'page-one', source: 'redirect' });
    claim('1', USER_A, tokens.a);
    claim('3', USER_A, tokens.a);
    claim('6', USER_A, tokens.a);
    claim('2', USER_B, tokens.b);
    const hidden = '333333333333333333';
    claim('4', hidden, store.getOrCreateToken(hidden));
    store.setHiddenFromWall(hidden, true);

    const home = await createWebApi(() => context(deps)).getHome();
    expect(home.topDonors).toEqual([
      { name: `User ${USER_A.slice(0, 3)}`, avatarUrl: expect.any(String), total: 17.5, currencySymbol: '£', donations: 2 },
      { name: `User ${USER_B.slice(0, 3)}`, avatarUrl: expect.any(String), total: 5, currencySymbol: '£', donations: 1 },
    ]);
  });

  it('is empty when nobody has a public amount', async () => {
    const { deps, store, tokens } = setup();
    store.insertClaim({ donationId: '1', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'redirect' });
    expect((await createWebApi(() => context(deps)).getHome()).topDonors).toEqual([]);
  });
});

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(astro: AstroHandler) {
  const { deps } = setup();
  const server = createWebServer(() => context(deps), astro).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('web server', () => {
  it('serves a health check and security headers', async () => {
    const url = await start((_req, _res, next) => next());
    const res = await fetch(`${url}/health`);
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain('img-src');
  });

  it('hands pages to Astro with the web API in locals, and 404s the rest', async () => {
    const url = await start((req, res, next, locals) => {
      if (req.path === '/') {
        res.send(typeof locals.web.getHome === 'function' ? 'astro home' : 'no api');
        return;
      }
      next();
    });
    expect(await (await fetch(`${url}/`)).text()).toBe('astro home');
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it('redirects the old fly.dev address to the official domain, keeping the query', async () => {
    const url = await start((_req, res) => {
      res.send('page');
    });
    const get = (path: string) =>
      new Promise<{ status: number; location?: string }>((resolve, reject) => {
        http
          .get(`${url}${path}`, { headers: { host: 'my-donor-bot.fly.dev' } }, (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, location: res.headers.location });
          })
          .on('error', reject);
      });
    expect(await get('/justgiving/return?t=ABC&donationId=1')).toEqual({
      status: 301,
      location: 'https://donate.test/justgiving/return?t=ABC&donationId=1',
    });
    expect((await get('/health')).status).toBe(200);
  });

  it('renders the home page once and reuses it for a burst of visitors', async () => {
    let renders = 0;
    const url = await start((req, res, next) => {
      if (req.path !== '/') return next();
      renders++;
      setTimeout(() => res.type('html').send('<h1>home</h1>'), 20);
    });
    const pages = await Promise.all(Array.from({ length: 50 }, async () => (await fetch(`${url}/`)).text()));
    expect(new Set(pages)).toEqual(new Set(['<h1>home</h1>']));
    expect(renders).toBe(1);
  });

  it('never caches the return page', async () => {
    const url = await start((_req, res) => {
      res.send('ok');
    });
    const res = await fetch(`${url}/justgiving/return?t=A&donationId=1`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
