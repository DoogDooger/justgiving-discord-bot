import type { CharityConfig, SiteConfig } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import type { DiscordActions, DonationDeps, RoleResult } from '../src/donations.js';
import { JustGivingError, type Donation, type JustGivingApi, type PageInfo } from '../src/justgiving.js';
import { PageDirectory } from '../src/pages.js';

export const USER_A = '111111111111111111';
export const USER_B = '222222222222222222';

export const charity: CharityConfig = { name: 'Charity One', pageShortName: 'page-one', roleId: '900000000000000001' };

export const site: SiteConfig = {
  communityName: 'Test Community',
  communityUrl: null,
  accentColor: '#7c5cff',
  logoPath: null,
  previewImagePath: null,
  headline: null,
  rewardText: "you'll get the {role} role as a thank you",
  seasonalTheme: false,
  timeZone: 'UTC',
  locale: 'en-GB',
};

export const defaultPageInfo: Record<string, PageInfo> = {
  'page-one': { pageId: '111', charityId: 'C1', charityName: 'Charity One Org' },
};

export interface FakeJustGivingOptions {
  donations?: Record<string, Donation>;
  /** page path -> donation IDs listed on that page (fallback check) */
  pages?: Record<string, string[]>;
  /** donation ID -> charity ID returned by the reference lookup (primary check) */
  charityIds?: Record<string, string>;
  /** page path -> page details; defaults to page-one => charity C1 */
  pageInfo?: Record<string, PageInfo>;
  /** page path -> donation ID -> public amount (hidden amounts are simply absent) */
  amounts?: Record<string, Record<string, number>>;
  fail?: boolean;
}

export function fakeJustGiving(options: FakeJustGivingOptions = {}): JustGivingApi {
  const check = () => {
    if (options.fail) throw new JustGivingError('JustGiving request timed out');
  };
  return {
    async getDonation(id) {
      check();
      return options.donations?.[id] ?? null;
    },
    async getDonationCharityId(reference, id) {
      check();
      const donation = options.donations?.[id];
      return donation && donation.thirdPartyReference === reference ? (options.charityIds?.[id] ?? null) : null;
    },
    async pageHasDonation(page, id) {
      check();
      return Boolean(options.pages?.[page]?.includes(id));
    },
    async getPublicDonationAmounts(page) {
      check();
      return new Map(Object.entries(options.amounts?.[page] ?? {}));
    },
    async getPageTotals() {
      check();
      return { raised: 2, target: 1000, currencySymbol: '£' };
    },
    async getPage(page) {
      check();
      const info = (options.pageInfo ?? defaultPageInfo)[page];
      if (!info) throw new JustGivingError('not found', 404);
      return info;
    },
  };
}

export function donation(id: string, reference: string | null, status = 'Accepted', charityId: string | null = null): Donation {
  return { id, status, thirdPartyReference: reference, charityId };
}

export function fakeDiscord(result: RoleResult = 'added') {
  const calls: { userId: string; roleId: string }[] = [];
  const dms: string[] = [];
  const removed: { userId: string; roleId: string }[] = [];
  /** Set to make addRole slow (like Discord's rate-limit queue) or change its result. */
  const control = { delayMs: 0, result };
  const actions: DiscordActions = {
    async addRole(userId, roleId) {
      calls.push({ userId, roleId });
      if (control.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
      return control.result;
    },
    async removeRole(userId, roleId) {
      removed.push({ userId, roleId });
      return true;
    },
    async sendThanks(userId) {
      dms.push(userId);
    },
  };
  return { actions, calls, dms, removed, control };
}

/**
 * Creates an in-memory store with tokens for USER_A and USER_B, then builds the
 * fake JustGiving from those tokens (donations carry the token as their reference).
 */
export function setup(
  build: (tokens: { a: string; b: string }) => FakeJustGivingOptions = () => ({}),
  roleResult: RoleResult = 'added',
) {
  const store: Store = openStore(':memory:');
  const tokens = { a: store.getOrCreateToken(USER_A), b: store.getOrCreateToken(USER_B) };
  const discord = fakeDiscord(roleResult);
  const justGiving = fakeJustGiving(build(tokens));
  const deps: DonationDeps = {
    justGiving,
    store,
    charity,
    pages: new PageDirectory(justGiving, charity),
    discord: discord.actions,
    sendDmOnSuccess: true,
  };
  return { store, deps, discord, tokens };
}
