import type { AppContext } from '../context.js';
import { processDonation } from '../donations.js';
import { DONATION_ID_PLACEHOLDER, type PageTotals } from '../justgiving.js';
import { failureMessage, isRetryable } from '../messages.js';

/**
 * What the Astro pages (web/) can ask the bot for. Passed to Astro as
 * `Astro.locals.web`, so pages never touch the database or Discord directly.
 */
export interface WebApi {
  /** Branding and wording from settings. */
  getSite(): SiteInfo;
  getHome(): Promise<HomeData>;
  handleReturn(query: { t?: unknown; donationId?: unknown }): Promise<ReturnView>;
}

export interface SiteInfo {
  communityName: string;
  communityUrl: string | null;
  charityName: string;
  inviteUrl: string | null;
  /** "#rrggbb". */
  accentColor: string;
  /** Black or white, whichever reads better on the accent colour. */
  onAccentColor: string;
  logoPath: string | null;
  /** Absolute URL of the link preview image, if one is set. */
  previewImageUrl: string | null;
  /** The site's public address, without a trailing slash. */
  baseUrl: string;
  headline: string;
  /** The reward line in plain words (the role mention becomes "donor"). */
  rewardText: string;
  /** True when the seasonal theme is on and it's December in the site's time zone. */
  festive: boolean;
  timeZone: string;
  locale: string;
}

export interface FeedItem {
  name: string;
  avatarUrl: string;
  /** Epoch ms. */
  at: number;
}

export interface TopDonor {
  name: string;
  avatarUrl: string;
  /** Sum of this donor's publicly visible donations, in the page's currency. */
  total: number;
  currencySymbol: string;
  donations: number;
}

export interface HomeData {
  totals: PageTotals | null;
  endsAt: number | null;
  feed: FeedItem[];
  /** Up to three donors with the highest public totals. */
  topDonors: TopDonor[];
}

export interface ReturnView {
  status: number;
  tone: 'success' | 'retry' | 'error';
  title: string;
  paragraphs: string[];
  /** Relative URL for a "Try again" button, only for retryable failures. */
  retryUrl: string | null;
  inviteUrl: string | null;
}

const FEED_SIZE = 30;
const TOP_DONORS = 3;

const queryString = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

/** Black or white text, whichever contrasts better with the given "#rrggbb" background. */
export function readableOn(hex: string): string {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#111111' : '#ffffff';
}

/** True during December in the given time zone. SEASON=december / SEASON=off forces it (for previews). */
export function isDecember(timeZone: string, now = new Date()): boolean {
  const forced = process.env.SEASON;
  if (forced === 'december') return true;
  if (forced === 'off') return false;
  return new Intl.DateTimeFormat('en-GB', { month: 'numeric', timeZone }).format(now) === '12';
}

export function createWebApi(getContext: () => AppContext): WebApi {
  return {
    getSite() {
      const { site, charity, inviteUrl, publicBaseUrl } = getContext().config;
      return {
        communityName: site.communityName,
        communityUrl: site.communityUrl,
        charityName: charity.name,
        inviteUrl,
        accentColor: site.accentColor,
        onAccentColor: readableOn(site.accentColor),
        logoPath: site.logoPath,
        previewImageUrl: site.previewImagePath ? `${publicBaseUrl}${site.previewImagePath}` : null,
        baseUrl: publicBaseUrl,
        headline: site.headline ?? `Raising money for ${charity.name}`,
        rewardText: site.rewardText.replaceAll('{role}', 'donor'),
        festive: site.seasonalTheme && isDecember(site.timeZone),
        timeZone: site.timeZone,
        locale: site.locale,
      };
    },

    // Not cached here: the server reuses the rendered home page for a few seconds (web/server.ts).
    async getHome() {
      const ctx = getContext();
      const { store } = ctx.donations;
      // Top donors: public amounts from JustGiving (cached, never stored), matched to the
      // Discord member who claimed each donation. Hidden amounts and hidden donors don't count.
      const amounts = await ctx.pages.getPublicAmounts();
      // Read associations after the await: a forgotten user must not start a new
      // profile lookup from an earlier snapshot after their cache was evicted.
      const claims = store.getRecentPublicClaims(FEED_SIZE);
      const sums = new Map<string, { total: number; donations: number }>();
      for (const owner of store.getPublicClaimOwners()) {
        const amount = amounts.get(owner.donationId);
        if (!amount) continue;
        const entry = sums.get(owner.discordUserId) ?? { total: 0, donations: 0 };
        entry.total += amount;
        entry.donations += 1;
        sums.set(owner.discordUserId, entry);
      }
      const leaders = [...sums.entries()].sort((x, y) => y[1].total - x[1].total || y[1].donations - x[1].donations).slice(0, TOP_DONORS);

      const [totals, profiles] = await Promise.all([
        ctx.pages.getTotals(),
        ctx.profiles.getMany([...claims.map((c) => c.discordUserId), ...leaders.map(([id]) => id)]),
      ]);

      return {
        totals,
        endsAt: ctx.config.driveEndsAt?.getTime() ?? null,
        // Provider/profile reads may have overlapped hide, revoke or forget.
        feed: claims.filter((c) => store.getClaim(c.donationId)?.status === 'granted' &&
          store.getClaim(c.donationId)?.discordUserId === c.discordUserId && !store.isHiddenFromWall(c.discordUserId)).map((c) => {
          const profile = profiles.get(c.discordUserId)!;
          return { name: profile.name, avatarUrl: profile.avatarUrl, at: c.createdAt };
        }),
        topDonors: leaders.flatMap(([id]) => {
          if (store.isHiddenFromWall(id)) return [];
          const publicAmounts = store.getClaimsForUser(id).filter((c) => c.status === 'granted')
            .flatMap((c) => { const amount = amounts.get(c.donationId); return amount ? [amount] : []; });
          if (publicAmounts.length === 0) return [];
          const sum = { total: publicAmounts.reduce((a, b) => a + b, 0), donations: publicAmounts.length };
          const profile = profiles.get(id)!;
          return [{
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            total: Math.round(sum.total * 100) / 100,
            currencySymbol: totals?.currencySymbol ?? '£',
            donations: sum.donations,
          }];
        }),
      };
    },

    async handleReturn(query) {
      const ctx = getContext();
      const inviteUrl = ctx.config.inviteUrl;
      const token = queryString(query.t, 16);
      const donationId = queryString(query.donationId, 32);

      if (!donationId || donationId === DONATION_ID_PLACEHOLDER) {
        return {
          status: 400,
          tone: 'error',
          title: 'No donation came back from JustGiving',
          paragraphs: ['If you did donate, tap "I\'ve already donated" under /donate in Discord and enter the reference from your JustGiving receipt email.'],
          retryUrl: null,
          inviteUrl,
        };
      }

      const outcome = await processDonation({ source: 'redirect', donationId, token }, ctx.donations);
      if (outcome.ok) {
        const name = ctx.config.charity.name;
        const paragraphs =
          outcome.role === 'added'
            ? ['Your donor role has been added in Discord.', 'You can close this page and head back to the server.']
            : outcome.role === 'queued'
              ? ['Your donation is confirmed and your donor role is on its way.', "Lots of people are donating right now, so it can take a few minutes to appear in Discord. You don't need to do anything."]
            : outcome.role === 'not_member'
              ? ['Your donation is recorded, but you are not in the Discord server right now.', 'Join the server, then run /donor-status and your role will be added.']
              : ["Your donation is recorded, but the role couldn't be added just now.", 'Run /donor-status in Discord in a minute to try again.'];
        return { status: 200, tone: 'success', title: `Thank you for supporting ${name}!`, paragraphs, retryUrl: null, inviteUrl };
      }

      const { title, text } = failureMessage(outcome.reason);
      const retry = isRetryable(outcome.reason);
      // Only rebuild the URL from values that passed validation.
      const retryUrl =
        retry && /^[A-Za-z0-9]{1,8}$/.test(token) && /^\d{1,15}$/.test(donationId)
          ? `/justgiving/return?t=${encodeURIComponent(token)}&donationId=${encodeURIComponent(donationId)}`
          : null;
      // On the web page the button replaces the "/claim" advice.
      const paragraph = retryUrl
        ? `${text.split(/(?<=\.)\s+/).filter((sentence) => !sentence.includes('/claim')).join(' ')} Wait a moment, then tap Try again.`
        : text;
      return {
        status: outcome.reason === 'api_error' ? 502 : 200,
        tone: retry ? 'retry' : 'error',
        title,
        paragraphs: [paragraph],
        retryUrl,
        inviteUrl,
      };
    },
  };
}
