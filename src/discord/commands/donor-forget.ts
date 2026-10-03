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
        'This permanently deletes everything this bot stores about you:',
        '• your personal donation code',
        '• the donation IDs linked to your Discord account',
        '• your donor wall setting',
        '',
        '**What happens next**',
        '• You disappear from the donor wall and the top donors list.',
        '• You **keep your donor role**, but the bot can no longer give it back if you lose it.',
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
  const claims = ctx.donations.store.forgetUser(interaction.user.id);
  // Deliberately no user ID here: the point is to keep nothing about them.
  ctx.donations.store.audit('user_forgotten', { detail: `${claims} claim${claims === 1 ? '' : 's'} deleted` });
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('Your data has been deleted')
        .setDescription('This bot no longer holds anything about you. It can take a minute for the donor wall to update. If you donate again, run `/donate` to start fresh.'),
    ],
    components: [],
  });
}
