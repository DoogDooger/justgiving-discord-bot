import { Events } from 'discord.js';
import { ClaimPrompts } from './claim-prompts.js';
import { loadConfigOrExit } from './config.js';
import type { AppContext } from './context.js';
import { openStore } from './db.js';
import { createDiscordClient, registerInteractionHandler } from './discord/client.js';
import { checkRolePermissions, createDiscordActions } from './discord/roles.js';
import { recheckDonations, syncPendingRoles } from './donations.js';
import { createJustGivingClient } from './justgiving.js';
import { PageDirectory } from './pages.js';
import { ProfileDirectory } from './profiles.js';
import { UserOperations } from './user-operations.js';
import { ReceiptDirectory } from './receipts.js';
import { createWebServer, loadAstroHandler } from './web/server.js';

const config = loadConfigOrExit();
const store = openStore(config.databasePath);
const justGiving = createJustGivingClient({ appId: config.justGivingAppId, apiBase: config.justGivingApiBase });
const pages = new PageDirectory(justGiving, config.charity);
const receipts = new ReceiptDirectory(justGiving, config.charity);
const client = createDiscordClient();

const ctx: AppContext = {
  claimPrompts: new ClaimPrompts(),
  config,
  pages,
  profiles: new ProfileDirectory(client.rest),
  donations: {
    operations: new UserOperations(),
    justGiving,
    store,
    charity: config.charity,
    driveEndsAt: config.driveEndsAt,
    pages,
    receipts,
    listingRetries: 3,
    retryDelayMs: 3000,
    discord: createDiscordActions(client, config.guildId, config.site),
    sendDmOnSuccess: config.sendDmOnSuccess,
  },
};

registerInteractionHandler(client, () => ctx);

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in to Discord as ${ready.user.tag}.`);
  try {
    const problems = await checkRolePermissions(client.rest, config.guildId, ready.user.id, config.charity.roleId);
    if (problems.length === 0) console.log('Discord permissions look good: the bot can manage the donor role.');
    for (const problem of problems) console.error(`PERMISSION PROBLEM: ${problem}`);
  } catch (error) {
    console.error('Could not check Discord permissions:', error instanceof Error ? error.message : error);
  }
  await pages.warmUp();
  // In the background: one JustGiving lookup per donation on the page, so it takes a minute or two.
  void receipts.warmUp();

  // Background role queue: picks up roles that were still waiting on Discord's rate
  // limit (or interrupted by a restart). One pass at a time.
  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const added = await syncPendingRoles(ctx.donations, { maxAgeMs: 24 * 60 * 60 * 1000, limit: 200 });
      if (added > 0) console.log(`Role queue: added ${added} pending role${added === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('Role queue failed:', error instanceof Error ? error.message : error);
    } finally {
      syncing = false;
    }
  };
  void sync();
  setInterval(() => void sync(), 30_000).unref();

  // Refund re-check, once a day (first run an hour after startup so deploys stay quiet).
  const recheck = async () => {
    try {
      const { checked, revoked } = await recheckDonations(ctx.donations, { minAgeMs: 60 * 60 * 1000, pauseMs: 300 });
      console.log(`Refund re-check: ${checked} donation${checked === 1 ? '' : 's'} checked, ${revoked} revoked.`);
    } catch (error) {
      console.error('Refund re-check failed:', error instanceof Error ? error.message : error);
    }
  };
  setTimeout(() => void recheck(), 60 * 60 * 1000).unref();
  setInterval(() => void recheck(), 24 * 60 * 60 * 1000).unref();
});

const astro = await loadAstroHandler().catch((error: unknown) => {
  console.error('Could not load the web pages. Run `npm run build:web` first.', error instanceof Error ? error.message : error);
  process.exit(1);
});

const server = createWebServer(() => ctx, astro).listen(config.port, () => {
  console.log(`Web server listening on port ${config.port} (public address ${config.publicBaseUrl}).`);
});
server.on('error', (error: NodeJS.ErrnoException) => {
  // Most likely another copy of the bot is already running: two copies would both answer Discord.
  const hint = error.code === 'EADDRINUSE' ? ` Port ${config.port} is in use. Is another copy of the bot already running?` : '';
  console.error(`Web server failed to start.${hint}`, error.message);
  process.exit(1);
});

await client.login(config.discordToken);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  server.close();
  void client.destroy().finally(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
