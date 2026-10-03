import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type APIInteractionGuildMember, type GuildMember } from 'discord.js';
import type { AppContext } from '../../context.js';
import { statusEmbed, wallChoiceEmbed } from '../embeds.js';
import type { DeferredInteraction } from '../interaction-ports.js';

/** Explicit consent before a user-requested role restoration. */
export const STATUS_SHOW_ID = 'donor:status-show';
/** Private-wall choice before a user-requested role restoration. */
export const STATUS_HIDE_ID = 'donor:status-hide';

function memberRoleIds(member: GuildMember | APIInteractionGuildMember | null): Set<string> {
  if (!member) return new Set();
  return new Set(Array.isArray(member.roles) ? member.roles : member.roles.cache.keys());
}

/** Read-only status needs no question; adding a missing role always does. */
export async function handleDonorStatus(interaction: DeferredInteraction & { readonly member: GuildMember | APIInteractionGuildMember | null }, ctx: AppContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { charity, site } = ctx.config;
  const { store } = ctx.donations;
  const claims = store.getClaimsForUser(interaction.user.id).filter((c) => c.status === 'granted');
  if (claims.length === 0) {
    await interaction.editReply({ embeds: [statusEmbed(site, charity, null)] });
    return;
  }
  if (memberRoleIds(interaction.member).has(charity.roleId)) {
    for (const claim of claims) store.setRoleState(claim.donationId, 'added');
    await interaction.editReply({ embeds: [statusEmbed(site, charity, { donations: claims.length, state: 'active' })] });
    return;
  }
  await interaction.editReply({
    embeds: [wallChoiceEmbed(site, `${ctx.config.publicBaseUrl}/`).setTitle('Before restoring your role: the donor wall')
      .setFooter({ text: 'Pick one to restore your role.' })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(STATUS_SHOW_ID).setStyle(ButtonStyle.Primary).setLabel('Show me on the donor wall'),
      new ButtonBuilder().setCustomId(STATUS_HIDE_ID).setStyle(ButtonStyle.Secondary).setLabel('Hide me from the donor wall'),
    )],
  });
}

/** Re-read eligible claims at the click, not from an earlier status response. */
export async function handleStatusChoice(interaction: DeferredInteraction, ctx: AppContext, hidden: boolean): Promise<void> {
  const operation = ctx.donations.operations.begin(interaction.user.id);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!operation.isCurrent()) {
      await interaction.editReply({ content: 'Your data was unlinked. Run /donor-status again.' });
      return;
    }
    const { charity, site } = ctx.config;
    const { store, discord } = ctx.donations;
    const claims = store.getClaimsForUser(interaction.user.id).filter((c) => c.status === 'granted');
    if (claims.length === 0) {
      await interaction.editReply({ embeds: [statusEmbed(site, charity, null)] });
      return;
    }
    store.setHiddenFromWall(interaction.user.id, hidden);
    store.audit(hidden ? 'wall_hidden' : 'wall_shown', { discordUserId: interaction.user.id, detail: 'donor-status' });
    const result = await discord.addRole(interaction.user.id, charity.roleId, `Re-applied by /donor-status for ${charity.name}`);
    if (!operation.isCurrent()) {
      await interaction.editReply({ content: 'Your data was unlinked. A role request already sent to Discord cannot be recalled.' });
      return;
    }
    if (result === 'added') {
      for (const claim of claims) {
        if (store.getClaim(claim.donationId)?.status === 'granted') store.setRoleState(claim.donationId, 'added');
      }
      store.audit('role_reapplied', { discordUserId: interaction.user.id });
    }
    await interaction.editReply({ embeds: [statusEmbed(site, charity, { donations: claims.length, state: result === 'added' ? 'restored' : 'failed' })] });
  } finally {
    operation.finish();
  }
}
