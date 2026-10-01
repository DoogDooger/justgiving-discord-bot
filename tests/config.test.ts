import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT_COLOR, DEFAULT_REWARD_TEXT, loadConfig, parseFlyTomlEnv, parsePageShortName, settingsFromEnvironment } from '../src/config.js';

const base = {
  DISCORD_TOKEN: 'token',
  DISCORD_GUILD_ID: '100000000000000000',
  DONOR_ROLE_ID: '100000000000000001',
  JUSTGIVING_APP_ID: 'app',
  PUBLIC_BASE_URL: 'https://my-donor-bot.fly.dev/',
  COMMUNITY_NAME: 'Test Community',
  CHARITY_NAME: 'Example Charity',
};

describe('parsePageShortName', () => {
  it.each([
    ['my-page', 'my-page'],
    ['https://www.justgiving.com/page/my-page', 'page/my-page'],
    ['page/my-page', 'page/my-page'],
    ['https://www.justgiving.com/fundraising/my-page?utm=x', 'my-page'],
    ['https://example.com/page/my-page', null],
    ['not a page!', null],
  ])('%s -> %s', (input, expected) => {
    expect(parsePageShortName(input)).toBe(expected);
  });
});

describe('loadConfig', () => {
  it('accepts a minimal config, with sensible defaults', () => {
    const result = loadConfig(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.publicBaseUrl).toBe('https://my-donor-bot.fly.dev');
    expect(result.config.charity).toEqual({ name: 'Example Charity', pageShortName: null, roleId: '100000000000000001' });
    expect(result.config.site).toEqual({
      communityName: 'Test Community',
      communityUrl: null,
      accentColor: DEFAULT_ACCENT_COLOR,
      logoPath: null,
      previewImagePath: null,
      headline: null,
      rewardText: DEFAULT_REWARD_TEXT,
      seasonalTheme: false,
      timeZone: 'UTC',
      locale: 'en-GB',
    });
    expect(result.config.driveEndsAt).toBeNull();
  });

  it('reads the charity page and branding', () => {
    const result = loadConfig({
      ...base,
      CHARITY_PAGE: 'https://www.justgiving.com/page/my-page',
      ACCENT_COLOR: '#FF3131',
      SITE_LOGO: '/logo.svg',
      SITE_PREVIEW_IMAGE: '/preview.png',
      SITE_HEADLINE: 'Grant a wish',
      REWARD_TEXT: "you'll unlock the {role} role and extra giveaway entries",
      SEASONAL_THEME: 'true',
      TIME_ZONE: 'Europe/London',
      LOCALE: 'en-US',
      COMMUNITY_URL: 'https://example.org',
      DRIVE_ENDS_AT: '2027-01-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.charity.pageShortName).toBe('page/my-page');
    expect(result.config.site).toMatchObject({
      accentColor: '#ff3131',
      logoPath: '/logo.svg',
      previewImagePath: '/preview.png',
      headline: 'Grant a wish',
      seasonalTheme: true,
      timeZone: 'Europe/London',
      locale: 'en-US',
      communityUrl: 'https://example.org',
    });
    expect(result.config.driveEndsAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('lists every missing required setting', () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join('\n');
    for (const name of ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DONOR_ROLE_ID', 'JUSTGIVING_APP_ID', 'PUBLIC_BASE_URL', 'COMMUNITY_NAME', 'CHARITY_NAME']) {
      expect(text).toContain(`${name} is missing`);
    }
  });

  it('spots values left over from the example files', () => {
    const result = loadConfig({ ...base, DISCORD_GUILD_ID: 'CHANGE-ME', PUBLIC_BASE_URL: 'https://your-app-name.fly.dev', COMMUNITY_NAME: 'CHANGE ME' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join('\n');
    for (const name of ['DISCORD_GUILD_ID', 'PUBLIC_BASE_URL', 'COMMUNITY_NAME']) {
      expect(text).toContain(`${name} still has its example value`);
    }
  });

  it('rejects bad values with a plain explanation', () => {
    const result = loadConfig({
      ...base,
      DONOR_ROLE_ID: 'not-a-role',
      CHARITY_PAGE: 'https://evil.example.org/page/x',
      PUBLIC_BASE_URL: 'http://my-donor-bot.fly.dev',
      ACCENT_COLOR: 'purple',
      SITE_LOGO: 'logo.svg',
      TIME_ZONE: 'Mars/Olympus',
      DRIVE_ENDS_AT: 'new year',
      DISCORD_INVITE_URL: 'discord.gg/x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join('\n');
    for (const name of ['DONOR_ROLE_ID', 'CHARITY_PAGE', 'PUBLIC_BASE_URL must start with https://', 'ACCENT_COLOR', 'SITE_LOGO', 'TIME_ZONE', 'DRIVE_ENDS_AT', 'DISCORD_INVITE_URL']) {
      expect(text).toContain(name);
    }
  });

  it('allows http for localhost testing', () => {
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000' }).ok).toBe(true);
  });
});

describe('fly.toml as the settings file', () => {
  const toml = `
app = "my-donor-bot"

[env]
  # a comment
  DISCORD_GUILD_ID = "100000000000000000"   # Right-click your server icon
  ACCENT_COLOR = "#ff3131"         # Buttons
  CHARITY_PAGE = ""                # empty until the page exists
  PUBLIC_BASE_URL = "https://my-donor-bot.fly.dev"

[mounts]
  source = "donor_data"
`;

  it('reads only the [env] block, keeping # inside values', () => {
    expect(parseFlyTomlEnv(toml)).toEqual({
      DISCORD_GUILD_ID: '100000000000000000',
      ACCENT_COLOR: '#ff3131',
      CHARITY_PAGE: '',
      PUBLIC_BASE_URL: 'https://my-donor-bot.fly.dev',
    });
    expect(parseFlyTomlEnv('app = "x"')).toEqual({});
  });

  it('works without a fly.toml, as inside the deployed container', () => {
    const missing = new URL('file:///no/such/folder/fly.toml');
    expect(settingsFromEnvironment({ DISCORD_TOKEN: 'secret' }, missing)).toEqual({ DISCORD_TOKEN: 'secret' });
  });

  it('ships a fly.toml whose placeholders are caught by the settings check', () => {
    const merged = settingsFromEnvironment({ DISCORD_TOKEN: 'secret', JUSTGIVING_APP_ID: 'app', PUBLIC_BASE_URL: 'http://localhost:3000', ACCENT_COLOR: '' });
    // .env overrides the live address; the empty ACCENT_COLOR doesn't blank out fly.toml's default.
    expect(merged.PUBLIC_BASE_URL).toBe('http://localhost:3000');
    expect(merged.ACCENT_COLOR).toBe('#7c5cff');
    const result = loadConfig(merged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join('\n');
    for (const name of ['DISCORD_GUILD_ID', 'DONOR_ROLE_ID', 'CHARITY_NAME', 'COMMUNITY_NAME']) {
      expect(text).toContain(`${name} still has its example value`);
    }
  });
});
