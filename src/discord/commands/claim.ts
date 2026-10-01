import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { processDonation } from '../../donations.js';
import { failureEmbed, successEmbed } from '../embeds.js';

export const CLAIM_BUTTON_ID = 'donor:claim';
export const CLAIM_MODAL_ID = 'donor:claim-modal';
const DONATION_INPUT_ID = 'donation_id';

/** Shared by /claim and the "I've already donated" pop-up. */
async function claim(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, donationId: string, ctx: AppContext): Promise<void> {
  // JustGiving calls can take longer than Discord's 3-second limit, so acknowledge first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await processDonation({ source: 'claim', donationId, discordUserId: interaction.user.id }, ctx.donations);
  const embed = outcome.ok ? successEmbed(ctx.config.charity, outcome.role, donationId) : failureEmbed(outcome.reason);
  await interaction.editReply({ embeds: [embed] });
}

export async function handleClaim(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  await claim(interaction, interaction.options.getString('donation_id', true).trim(), ctx);
}

export async function handleClaimButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(CLAIM_MODAL_ID)
    .setTitle('Link your donation')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('JustGiving donation ID')
        .setDescription("It's in your JustGiving confirmation email (a number).")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(DONATION_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1234567890')
            .setMinLength(1)
            .setMaxLength(20)
            .setRequired(true),
        ),
    );
  await interaction.showModal(modal);
}

export async function handleClaimModal(interaction: ModalSubmitInteraction, ctx: AppContext): Promise<void> {
  await claim(interaction, interaction.fields.getTextInputValue(DONATION_INPUT_ID).trim(), ctx);
}
