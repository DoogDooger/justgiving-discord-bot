import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import type { AppContext } from '../../context.js';
import { COLORS } from '../embeds.js';
import type { ReplyInteraction, UpdateInteraction } from '../interaction-ports.js';

export const FORGET_CONFIRM_ID = 'donor:forget-confirm';
export const FORGET_CANCEL_ID = 'donor:forget-cancel';

/** Step 1: explain exactly what will be deleted and ask for confirmation. */
export async function handleDonorForget(interaction: ReplyInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('Delete my data?')
    .setDescription(
      [
        'This deletes your Discord link and user-specific data from the active bot:',
        '• your personal donation code',
        '• the donation IDs linked to your Discord account',
        '• your donor wall setting',
        '',
        '**What happens next**',
        '• You disappear from the donor wall and the top donors list.',
        '• You **keep your donor role**, but the bot can no longer restore it or track later refunds for you.',
        '• We keep only each used **JustGiving donation ID**, without your Discord link, to prevent reuse while those donations remain redeemable. The drive deadline does not expire claims.',
        '• Those donations cannot be claimed again—even by you. A new donation can qualify.',
        '• Existing backups retain earlier records until their separate retention expires. Already served pages and Discord messages cannot be recalled.',
        '• Only want to hide your name? Use /donor-wall hide instead; that keeps role recovery and refund tracking.',
        '• Your donations on JustGiving are not affected. This bot never stored your name, email or payment details.',
        '',
        "This can't be undone.",
      ].join('\n'),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(FORGET_CONFIRM_ID).setStyle(ButtonStyle.Danger).setLabel('Delete my data'),
    new ButtonBuilder().setCustomId(FORGET_CANCEL_ID).setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
  );
  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

/** Step 2: the member confirmed or cancelled. */
export async function handleForgetChoice(interaction: UpdateInteraction, ctx: AppContext, confirmed: boolean): Promise<void> {
  if (!confirmed) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.neutral).setTitle('Nothing was deleted').setDescription('Your data is unchanged.')],
      components: [],
    });
    return;
  }
  ctx.claimPrompts.forget(interaction.user.id);
  ctx.donations.operations.forget(interaction.user.id);
  ctx.profiles.forget(interaction.user.id);
  const claims = ctx.donations.store.forgetUser(interaction.user.id);
  // No user/donation ID: do not rebuild the association in the deletion audit.
  ctx.donations.store.audit('user_forgotten', { detail: `${claims} claim${claims === 1 ? '' : 's'} deleted` });
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('Your Discord link has been deleted')
        .setDescription('Your linked records, personal code, wall preference and user audit have been removed from the active bot. You keep your role. Only used donation IDs remain, without your Discord link, to prevent reuse while donations remain redeemable. Earlier backups expire separately; already served pages and messages may remain. Use /donate for a new donation.'),
    ],
    components: [],
  });
}
