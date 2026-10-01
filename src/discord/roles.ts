import {
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  type APIGuildMember,
  type APIRole,
  type Client,
  type REST,
} from 'discord.js';
import type { SiteConfig } from '../config.js';
import type { DiscordActions, RoleResult } from '../donations.js';
import { thankYouDmEmbed } from './embeds.js';

/**
 * Role changes and DMs go straight to the REST API by user ID, so they work
 * with zero gateway intents and an empty member cache.
 */
export function createDiscordActions(client: Client, guildId: string, site: SiteConfig): DiscordActions {
  return {
    async addRole(discordUserId, roleId, reason): Promise<RoleResult> {
      try {
        await client.rest.put(Routes.guildMemberRole(guildId, discordUserId, roleId), { reason });
        return 'added';
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) return 'not_member';
        console.error(`Failed to add role ${roleId} to user ${discordUserId}:`, error instanceof Error ? error.message : error);
        return 'failed';
      }
    },

    async removeRole(discordUserId, roleId, reason) {
      try {
        await client.rest.delete(Routes.guildMemberRole(guildId, discordUserId, roleId), { reason });
        return true;
      } catch (error) {
        // Someone who has left the server no longer has the role anyway.
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) return true;
        console.error(`Failed to remove role ${roleId} from user ${discordUserId}:`, error instanceof Error ? error.message : error);
        return false;
      }
    },

    async sendThanks(discordUserId, charity, donationId) {
      await client.users.send(discordUserId, { embeds: [thankYouDmEmbed(site, charity, donationId)] });
    },
  };
}

/**
 * Checks the bot can manage the donor role. Returns plain-English problems (empty = all good).
 */
export async function checkRolePermissions(rest: REST, guildId: string, botUserId: string, roleId: string): Promise<string[]> {
  let roles: APIRole[];
  let me: APIGuildMember;
  try {
    roles = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
    me = (await rest.get(Routes.guildMember(guildId, botUserId))) as APIGuildMember;
  } catch (error) {
    if (error instanceof DiscordAPIError && (error.status === 403 || error.status === 404)) {
      return ['The bot is not in the Discord server set in DISCORD_GUILD_ID. Invite it using the link in the README.'];
    }
    throw error;
  }

  const byId = new Map(roles.map((role) => [role.id, role]));
  const myRoles = [guildId, ...me.roles].flatMap((id) => byId.get(id) ?? []);
  const permissions = myRoles.reduce((acc, role) => acc | BigInt(role.permissions), 0n);
  const highest = Math.max(0, ...myRoles.map((role) => role.position));

  const problems: string[] = [];
  const isAdmin = (permissions & PermissionFlagsBits.Administrator) !== 0n;
  if (!isAdmin && (permissions & PermissionFlagsBits.ManageRoles) === 0n) {
    problems.push('The bot does not have the "Manage Roles" permission. Give its role Manage Roles in Server Settings > Roles.');
  }

  const role = byId.get(roleId);
  if (!role) {
    problems.push(`Role ${roleId} does not exist in the server. Check the DONOR_ROLE_ID setting.`);
  } else if (role.managed) {
    problems.push(`Role "${role.name}" is managed by an integration and can't be given out. Create a normal role instead.`);
  } else if (role.position >= highest) {
    problems.push(`The bot's role must be above "${role.name}". In Server Settings > Roles, drag the bot's role higher than "${role.name}".`);
  }
  return problems;
}
