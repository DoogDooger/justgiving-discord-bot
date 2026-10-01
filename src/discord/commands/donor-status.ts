import { MessageFlags, type APIInteractionGuildMember, type ChatInputCommandInteraction, type GuildMember } from 'discord.js';
import type { AppContext } from '../../context.js';
import { statusEmbed, type StatusRow } from '../embeds.js';

/** Role IDs from the interaction itself, so no member cache or Server Members intent is needed. */
function memberRoleIds(member: GuildMember | APIInteractionGuildMember | null): Set<string> {
  if (!member) return new Set();
  return new Set(Array.isArray(member.roles) ? member.roles : member.roles.cache.keys());
}

export async function handleDonorStatus(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { charity, site } = ctx.config;
  const { store } = ctx.donations;
  const claims = store.getClaimsForUser(interaction.user.id).filter((c) => c.status === 'granted');
  if (claims.length === 0) {
    await interaction.editReply({ embeds: [statusEmbed(site, charity, null)] });
    return;
  }

  const markAdded = () => {
    for (const claim of claims) store.setRoleState(claim.donationId, 'added');
  };

  let state: StatusRow['state'];
  if (memberRoleIds(interaction.member).has(charity.roleId)) {
    markAdded();
    state = 'active';
  } else {
    const result = await ctx.donations.discord.addRole(interaction.user.id, charity.roleId, `Re-applied by /donor-status for ${charity.name}`);
    if (result === 'added') {
      markAdded();
      store.audit('role_reapplied', { discordUserId: interaction.user.id });
    }
    state = result === 'added' ? 'restored' : 'failed';
  }

  await interaction.editReply({ embeds: [statusEmbed(site, charity, { donations: claims.length, state })] });
}
