import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface CharityConfig {
  name: string;
  /**
   * JustGiving page path as the API expects it: "page/<name>" for newer pages
   * (justgiving.com/page/...), "<name>" for older ones (justgiving.com/fundraising/...).
   * Null if the page hasn't been set yet.
   */
  pageShortName: string | null;
  /** The Discord role donors receive. */
  roleId: string;
}

/** Branding and wording for the website and Discord messages. */
export interface SiteConfig {
  communityName: string;
  /** Where the logo/name in the site header links to. */
  communityUrl: string | null;
  /** "#rrggbb". Used for buttons, highlights and the Discord card colour. */
  accentColor: string;
  /** Path under public/ (e.g. "/logo.svg"). Null shows the community name as text. */
  logoPath: string | null;
  /** Path under public/ for the link preview image (16:9). Null = no preview image. */
  previewImagePath: string | null;
  /** Home page headline. Null uses "Raising money for <charity>". */
  headline: string | null;
  /** What donors get, shown on the /donate card. "{role}" is replaced by the role mention. */
  rewardText: string;
  /** Light snow and festive wording on the website during December. */
  seasonalTheme: boolean;
  /** IANA time zone for dates on the website, e.g. "Europe/London". */
  timeZone: string;
  /** BCP 47 locale for number and date formatting, e.g. "en-GB". */
  locale: string;
}

export interface Config {
  discordToken: string;
  guildId: string;
  inviteUrl: string | null;
  charity: CharityConfig;
  site: SiteConfig;
  justGivingAppId: string;
  justGivingApiBase: string;
  publicBaseUrl: string;
  port: number;
  databasePath: string;
  sendDmOnSuccess: boolean;
  /** When the charity drive ends; after this /donate stops handing out links. Null = no end date. */
  driveEndsAt: Date | null;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: string[] };

const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PUBLIC_PATH = /^\/[A-Za-z0-9._/-]+$/;
/** Values left over from the example files. */
const PLACEHOLDER = /change[-_ ]?me|your-|example\.com/i;

export const DEFAULT_ACCENT_COLOR = '#7c5cff';
export const DEFAULT_REWARD_TEXT = "you'll get the {role} role as a thank you";

/**
 * Turns a JustGiving page address into the path the API expects:
 *   https://www.justgiving.com/page/my-page        -> "page/my-page"  (newer pages)
 *   https://www.justgiving.com/fundraising/my-page -> "my-page"       (older pages)
 * Also accepts those two forms directly ("page/my-page" or "my-page").
 */
export function parsePageShortName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/(^|\.)justgiving\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((p) => p === 'page' || p === 'fundraising');
    const name = marker >= 0 ? (parts[marker + 1] ?? '') : '';
    candidate = parts[marker] === 'page' ? `page/${name}` : name;
  }
  return /^(page\/)?[A-Za-z0-9-]{1,100}$/.test(candidate) ? candidate : null;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isLocale(value: string): boolean {
  try {
    return Intl.NumberFormat.supportedLocalesOf(value).length > 0;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const errors: string[] = [];
  const get = (name: string) => env[name]?.trim() ?? '';

  const required = (name: string, hint: string) => {
    const value = get(name);
    if (!value) errors.push(`${name} is missing. ${hint}`);
    else if (PLACEHOLDER.test(value)) errors.push(`${name} still has its example value. ${hint}`);
    return value;
  };

  const snowflake = (name: string, hint: string) => {
    const value = required(name, hint);
    if (value && !PLACEHOLDER.test(value) && !SNOWFLAKE.test(value)) errors.push(`${name} should be a Discord ID (17-20 digits).`);
    return value;
  };

  const publicPath = (name: string) => {
    const value = get(name);
    if (value && !PUBLIC_PATH.test(value)) errors.push(`${name} should be a path to a file in the public/ folder, starting with "/", for example /logo.svg.`);
    return value || null;
  };

  const httpsUrl = (name: string) => {
    const value = get(name);
    if (value && !/^https:\/\//.test(value)) errors.push(`${name} should start with https://.`);
    return value || null;
  };

  // ---- Discord
  const discordToken = required('DISCORD_TOKEN', 'Copy it from the Discord Developer Portal > your app > Bot > Reset Token.');
  const guildId = snowflake('DISCORD_GUILD_ID', 'Right-click your server icon > Copy Server ID.');
  const roleId = snowflake('DONOR_ROLE_ID', 'Server Settings > Roles > right-click the donor role > Copy Role ID.');
  const inviteUrl = httpsUrl('DISCORD_INVITE_URL');

  // ---- Charity
  const charityName = required('CHARITY_NAME', 'The name of the charity you are raising money for, as you want it shown.');
  // The page is optional so the bot can start before the JustGiving page exists.
  const pageRaw = get('CHARITY_PAGE');
  let pageShortName: string | null = null;
  if (pageRaw) {
    pageShortName = parsePageShortName(pageRaw);
    if (!pageShortName) errors.push('CHARITY_PAGE should be a JustGiving page address like https://www.justgiving.com/page/your-page.');
  }

  // ---- JustGiving
  const justGivingAppId = required('JUSTGIVING_APP_ID', 'Find it on developer.justgiving.com > Applications.');
  const justGivingApiBase = (get('JUSTGIVING_API_BASE') || 'https://api.justgiving.com').replace(/\/+$/, '');

  // ---- Web
  const publicBaseUrl = required('PUBLIC_BASE_URL', 'The web address the bot is reachable on, e.g. https://my-donor-bot.fly.dev.').replace(/\/+$/, '');
  if (publicBaseUrl && !/^(https:\/\/|http:\/\/localhost(:\d+)?$|http:\/\/127\.0\.0\.1(:\d+)?$)/.test(publicBaseUrl)) {
    errors.push('PUBLIC_BASE_URL must start with https:// (http:// is only allowed for localhost).');
  }
  const port = Number(get('PORT') || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be a number between 1 and 65535.');
  const databasePath = get('DATABASE_PATH') || './data/donors.db';
  const sendDmOnSuccess = (get('SEND_DM_ON_SUCCESS') || 'true').toLowerCase() !== 'false';

  // ---- Drive
  const endsRaw = get('DRIVE_ENDS_AT');
  let driveEndsAt: Date | null = null;
  if (endsRaw) {
    driveEndsAt = /^\d{4}-\d{2}-\d{2}T/.test(endsRaw) ? new Date(endsRaw) : null;
    if (!driveEndsAt || Number.isNaN(driveEndsAt.getTime())) {
      errors.push('DRIVE_ENDS_AT should be a date and time like 2027-01-01T00:00:00Z.');
      driveEndsAt = null;
    }
  }

  // ---- Branding and wording
  const communityName = required('COMMUNITY_NAME', 'The name of your community or server, as you want it shown.');
  const accentColor = get('ACCENT_COLOR') || DEFAULT_ACCENT_COLOR;
  if (!HEX_COLOR.test(accentColor)) errors.push('ACCENT_COLOR should be a colour like #7c5cff (a # followed by six letters or digits).');
  const timeZone = get('TIME_ZONE') || 'UTC';
  if (!isTimeZone(timeZone)) errors.push('TIME_ZONE should be a time zone name like Europe/London or America/New_York.');
  const locale = get('LOCALE') || 'en-GB';
  if (!isLocale(locale)) errors.push('LOCALE should be a language code like en-GB or en-US.');

  const site: SiteConfig = {
    communityName,
    communityUrl: httpsUrl('COMMUNITY_URL'),
    accentColor: accentColor.toLowerCase(),
    logoPath: publicPath('SITE_LOGO'),
    previewImagePath: publicPath('SITE_PREVIEW_IMAGE'),
    headline: get('SITE_HEADLINE') || null,
    rewardText: get('REWARD_TEXT') || DEFAULT_REWARD_TEXT,
    seasonalTheme: get('SEASONAL_THEME').toLowerCase() === 'true',
    timeZone,
    locale,
  };

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      discordToken,
      guildId,
      inviteUrl,
      charity: { name: charityName, pageShortName, roleId },
      site,
      justGivingAppId,
      justGivingApiBase,
      publicBaseUrl,
      port,
      databasePath,
      sendDmOnSuccess,
      driveEndsAt,
    },
  };
}

/**
 * Reads the [env] block of a fly.toml file: lines like `KEY = "value"  # comment`.
 * Returns {} if the text has no such block.
 */
export function parseFlyTomlEnv(toml: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inEnv = false;
  for (const line of toml.split(/\r?\n/)) {
    const section = /^\s*\[+\s*([^\]\s]+)\s*\]+/.exec(line);
    if (section) {
      inEnv = section[1] === 'env';
      continue;
    }
    if (!inEnv) continue;
    // The value is everything between the first pair of double quotes (a # inside it is kept).
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

/**
 * The settings to load: fly.toml's [env] block, overridden by anything set in the real
 * environment or .env. This lets fly.toml be the one settings file: locally, .env only
 * needs the two secrets plus the local web address and database path. On Fly there is no
 * fly.toml in the image, and the same values arrive as environment variables instead.
 */
export function settingsFromEnvironment(env: NodeJS.ProcessEnv = process.env, flyTomlUrl: URL = new URL('../fly.toml', import.meta.url)): NodeJS.ProcessEnv {
  let fromFlyToml: Record<string, string> = {};
  try {
    fromFlyToml = parseFlyTomlEnv(readFileSync(flyTomlUrl, 'utf8'));
  } catch {
    // No fly.toml here (for example inside the deployed container).
  }
  const merged: NodeJS.ProcessEnv = { ...fromFlyToml };
  // An empty value in .env means "not set here", so it doesn't blank out fly.toml's value.
  for (const [key, value] of Object.entries(env)) if (value !== undefined && value.trim() !== '') merged[key] = value;
  return merged;
}

/** Loads config or exits the process with a readable list of problems. */
export function loadConfigOrExit(): Config {
  const result = loadConfig(settingsFromEnvironment());
  if (!result.ok) {
    console.error('Settings problems (check fly.toml, your .env file and your Fly.io secrets):');
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  return result.config;
}
