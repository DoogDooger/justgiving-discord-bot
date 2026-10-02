/**
 * `npm run preview:web`: serves the web pages on http://localhost:4321 with sample
 * data, without logging in to Discord or calling JustGiving. For design work
 * while the live bot is running (two copies of the real bot must never run at once).
 */
import { DEFAULT_ACCENT_COLOR, DEFAULT_REWARD_TEXT, settingsFromEnvironment, type Config } from './config.js';
import type { AppContext } from './context.js';
import { openStore } from './db.js';
import type { DiscordActions } from './donations.js';
import type { JustGivingApi } from './justgiving.js';
import { PageDirectory } from './pages.js';
import { defaultAvatarUrl } from './profiles.js';
import { ReceiptDirectory } from './receipts.js';
import { createWebServer, loadAstroHandler } from './web/server.js';

const PORT = Number(process.env.PREVIEW_PORT) || 4321;
// Branding comes from fly.toml (and .env), so the preview shows your own look.
const env = settingsFromEnvironment();
const setting = (name: string) => {
  const value = env[name]?.trim() ?? '';
  return /change[-_ ]?me/i.test(value) ? '' : value;
};
const charity = { name: setting('CHARITY_NAME') || 'Example Charity', pageShortName: 'page/preview', roleId: '100000000000000001' };

const config: Config = {
  discordToken: 'preview',
  guildId: '100000000000000000',
  inviteUrl: 'https://discord.gg/example',
  charity,
  site: {
    communityName: setting('COMMUNITY_NAME') || 'Example Community',
    communityUrl: setting('COMMUNITY_URL') || null,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(setting('ACCENT_COLOR')) ? setting('ACCENT_COLOR').toLowerCase() : DEFAULT_ACCENT_COLOR,
    logoPath: setting('SITE_LOGO') || null,
    previewImagePath: setting('SITE_PREVIEW_IMAGE') || null,
    headline: setting('SITE_HEADLINE') || null,
    rewardText: setting('REWARD_TEXT') || DEFAULT_REWARD_TEXT,
    seasonalTheme: setting('SEASONAL_THEME') === 'true',
    timeZone: setting('TIME_ZONE') || 'UTC',
    locale: setting('LOCALE') || 'en-GB',
  },
  justGivingAppId: 'preview',
  justGivingApiBase: 'https://api.justgiving.com',
  publicBaseUrl: `http://localhost:${PORT}`,
  port: PORT,
  databasePath: ':memory:',
  sendDmOnSuccess: false,
  driveEndsAt: new Date('2027-01-01T00:00:00Z'),
};

const store = openStore(':memory:');
const names = ['Aurora', 'Mo', 'jess 🌸', 'Kai', 'Priya', 'ThatOneGamer', 'Sam', 'Lottie', 'Dev', 'Robin'];
const users = names.map((_, i) => String(200000000000000000n + BigInt(i) * 4194304n * 7n));
users.forEach((id, i) => {
  const token = store.getOrCreateToken(id);
  store.insertClaim({ donationId: String(9000 + i), discordUserId: id, token, pageShortName: charity.pageShortName, source: 'redirect' });
});
const justGiving: JustGivingApi = {
  // Sample donations for previewing each return page: 1 = still processing, 3 = refunded,
  // anything from 100 up = accepted (a new number each time shows the thank-you page again).
  getDonation: async (id) => {
    const reference = store.getOrCreateToken(users[0]!);
    if (id === '1') return { id, status: 'Pending', thirdPartyReference: reference, charityId: null, donatedAtMs: Date.now(), receiptRef: null };
    if (id === '3') return { id, status: 'Refunded', thirdPartyReference: reference, charityId: '4321', donatedAtMs: Date.now(), receiptRef: null };
    if (Number(id) >= 100) return { id, status: 'Accepted', thirdPartyReference: reference, charityId: '4321', donatedAtMs: Date.now(), receiptRef: null };
    return null;
  },
  getDonationCharityId: async () => null,
  pageHasDonation: async () => false,
  getPageDonationIds: async () => [],
  getPage: async () => ({ pageId: '1', charityId: '4321', charityName: charity.name }),
  getPageTotals: async () => ({ raised: 437.5, target: 1000, currencySymbol: '£' }),
  // Sample public amounts for a few donors; the rest are 'hidden'.
  getPublicDonationAmounts: async () => new Map([['9000', 100], ['9003', 50], ['9005', 25], ['9007', 10]]),
};

const pages = new PageDirectory(justGiving, charity);
const discord: DiscordActions = { addRole: async () => 'added', removeRole: async () => true, sendThanks: async () => undefined };

const ctx: AppContext = {
  config,
  pages,
  donations: { justGiving, store, charity, pages, receipts: new ReceiptDirectory(justGiving, charity), discord, sendDmOnSuccess: false },
  profiles: {
    getMany: async (ids) => new Map(ids.map((id) => [id, { name: names[users.indexOf(id)] ?? 'Donor', avatarUrl: defaultAvatarUrl(id) }])),
  },
};

const astro = await loadAstroHandler();
const server = createWebServer(() => ctx, astro).listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  const back = `${base}/justgiving/return?t=${store.getOrCreateToken(users[0]!)}&donationId=`;
  console.log(
    [
      `Preview running. Open these in your browser:`,
      `  Home page and donor wall   ${base}/`,
      `  Thank you (role added)     ${back}${100 + Math.floor(Math.random() * 900000)}`,
      `  Still processing           ${back}1`,
      `  Donation not accepted      ${back}3`,
      `  Nothing came back          ${base}/justgiving/return`,
      `Press Ctrl+C to stop.`,
    ].join('\n'),
  );
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is in use (another preview still running?). Try PREVIEW_PORT=4322 npm run preview:web` : error.message);
  process.exit(1);
});
