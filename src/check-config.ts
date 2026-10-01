/**
 * `npm run check-config`: validates settings and tests the Discord and JustGiving
 * connections without printing any secret values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { REST, Routes, type APIUser } from 'discord.js';
import { loadConfig, parseFlyTomlEnv, settingsFromEnvironment } from './config.js';
import { checkRolePermissions } from './discord/roles.js';
import { createJustGivingClient } from './justgiving.js';

const result = loadConfig(settingsFromEnvironment());
if (!result.ok) {
  console.error('✗ Settings have problems:');
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
const config = result.config;
console.log('✓ All required settings are present.');

let failed = false;

try {
  const rest = new REST().setToken(config.discordToken);
  const me = (await rest.get(Routes.user('@me'))) as APIUser;
  console.log(`✓ Discord token works (bot: ${me.username}).`);
  // Scopes: bot + applications.commands. Permissions: Manage Roles only (268435456).
  console.log(`  Invite link: https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot+applications.commands&permissions=268435456`);
  const problems = await checkRolePermissions(rest, config.guildId, me.id, config.charity.roleId);
  if (problems.length === 0) console.log('✓ The bot is in the server and can manage the donor role.');
  for (const problem of problems) {
    failed = true;
    console.error(`✗ ${problem}`);
  }
} catch (error) {
  failed = true;
  console.error('✗ Discord check failed. Is DISCORD_TOKEN correct?', error instanceof Error ? error.message : '');
}

// Any public lookup proves the App ID is accepted (an unknown App ID gets HTTP 403).
try {
  const response = await fetch(`${config.justGivingApiBase}/${encodeURIComponent(config.justGivingAppId)}/v1/charity/2357`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) {
    console.log('✓ JustGiving App ID works.');
  } else {
    failed = true;
    console.error(`✗ JustGiving rejected the App ID (HTTP ${response.status}). Check JUSTGIVING_APP_ID.`);
  }
} catch {
  failed = true;
  console.error("✗ Couldn't reach JustGiving to check the App ID.");
}

const justGiving = createJustGivingClient({ appId: config.justGivingAppId, apiBase: config.justGivingApiBase });
const { charity } = config;
if (!charity.pageShortName) {
  console.log(`- ${charity.name}: no JustGiving page set yet (CHARITY_PAGE).`);
} else {
  try {
    const page = await justGiving.getPage(charity.pageShortName);
    console.log(`✓ ${charity.name}: JustGiving page "${charity.pageShortName}" found (page ID ${page.pageId}, raising for ${page.charityName ?? `charity ${page.charityId}`}).`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${charity.name}: ${error instanceof Error ? error.message : 'JustGiving lookup failed'}. Check CHARITY_PAGE and JUSTGIVING_APP_ID.`);
  }
}

// fly.toml is what the live bot uses. Locally .env overrides the web address, so check the live one here.
const flyTomlUrl = new URL('../fly.toml', import.meta.url);
if (existsSync(flyTomlUrl)) {
  const toml = readFileSync(flyTomlUrl, 'utf8');
  const app = /^app\s*=\s*"([^"]*)"/m.exec(toml)?.[1] ?? '';
  const liveUrl = parseFlyTomlEnv(toml).PUBLIC_BASE_URL ?? '';
  if (!app || /change[-_ ]?me/i.test(app)) {
    failed = true;
    console.error('✗ fly.toml: set `app` to the name you created with `fly apps create`.');
  } else if (!/^https:\/\//.test(liveUrl) || /change[-_ ]?me/i.test(liveUrl)) {
    failed = true;
    console.error(`✗ fly.toml: set PUBLIC_BASE_URL to your live address, for example https://${app}.fly.dev.`);
  } else {
    console.log(`✓ fly.toml: app "${app}", live address ${liveUrl}.`);
  }
}

// Branding files must exist in public/ or the site shows a broken image.
for (const [name, path] of [['SITE_LOGO', config.site.logoPath], ['SITE_PREVIEW_IMAGE', config.site.previewImagePath]] as const) {
  if (!path) continue;
  if (existsSync(new URL(`../public${path}`, import.meta.url))) {
    console.log(`✓ ${name}: public${path} found.`);
  } else {
    failed = true;
    console.error(`✗ ${name}: there is no file at public${path}. Add it, or remove the setting.`);
  }
}

console.log(failed ? '\nFix the ✗ lines above, then run this again.' : '\nEverything looks good.');
process.exit(failed ? 1 : 0);
