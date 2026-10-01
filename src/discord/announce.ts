/**
 * Posts the charity drive announcement to a channel, or updates an existing post:
 *   npm run announce -- <channel-id>               post a new message
 *   npm run announce -- <channel-id> <message-id>  edit that message in place
 * Uses REST only, so it's safe to run while the live bot is online. The bot needs
 * View Channel, Send Messages and Embed Links in that channel.
 *
 * The donor wall button always links to the LIVE site (PUBLIC_BASE_URL in fly.toml),
 * never the local .env value, which is localhost during development.
 */
import { readFileSync } from 'node:fs';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, REST, Routes, type APIApplication, type APIApplicationCommand, type APIChannel, type APIMessage } from 'discord.js';
import { loadConfigOrExit } from '../config.js';
import { announcementEmbed } from './embeds.js';

const channelId = process.argv[2];
const messageId = process.argv[3];
if (!channelId || !/^\d{17,20}$/.test(channelId) || (messageId && !/^\d{17,20}$/.test(messageId))) {
  console.error('Usage: npm run announce -- <channel-id> [message-id-to-edit]');
  process.exit(1);
}

const config = loadConfigOrExit();

const fromFlyToml = /^\s*PUBLIC_BASE_URL\s*=\s*"(https:\/\/[^"]+)"/m.exec(readFileSync(new URL('../../fly.toml', import.meta.url), 'utf8'))?.[1];
const liveUrl = (fromFlyToml ?? (config.publicBaseUrl.startsWith('https://') ? config.publicBaseUrl : '')).replace(/\/+$/, '');
if (!liveUrl) {
  console.error('Could not find your live site address. Set PUBLIC_BASE_URL in fly.toml to your https:// address. Nothing sent.');
  process.exit(1);
}

const rest = new REST().setToken(config.discordToken);

try {
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  if (!('guild_id' in channel) || channel.guild_id !== config.guildId) {
    console.error('That channel is not in the configured server. Nothing sent.');
    process.exit(1);
  }

  const app = (await rest.get(Routes.currentApplication())) as APIApplication;
  const commands = (await rest.get(Routes.applicationGuildCommands(app.id, config.guildId))) as APIApplicationCommand[];
  const donate = commands.find((c) => c.name === 'donate');

  const embed = announcementEmbed({
    charity: config.charity,
    site: config.site,
    endsAt: config.driveEndsAt,
    donateCommand: donate ? `</donate:${donate.id}>` : '`/donate`',
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('See the donor wall').setURL(`${liveUrl}/`),
  );

  const body = { embeds: [embed.toJSON()], components: [row.toJSON()], allowed_mentions: { parse: [] } };
  const message = (
    messageId
      ? await rest.patch(Routes.channelMessage(channelId, messageId), { body })
      : await rest.post(Routes.channelMessages(channelId), { body })
  ) as APIMessage;
  console.log(`${messageId ? 'Updated' : 'Sent'}: https://discord.com/channels/${config.guildId}/${channelId}/${message.id} (donor wall link: ${liveUrl}/)`);
} catch (error) {
  if (error instanceof DiscordAPIError && (error.status === 403 || error.status === 404)) {
    console.error(`Discord refused (${error.message}). Give the bot View Channel, Send Messages and Embed Links in that channel.`);
  } else {
    console.error('Could not send the announcement:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
