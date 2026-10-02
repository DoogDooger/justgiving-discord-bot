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
import { processDonation, resolveClaimInput } from '../../donations.js';
import { JustGivingError } from '../../justgiving.js';
import { failureEmbed, successEmbed } from '../embeds.js';

export const CLAIM_BUTTON_ID = 'donor:claim';
export const CLAIM_MODAL_ID = 'donor:claim-modal';
const DONATION_INPUT_ID = 'donation_id';

/** Shared by /claim and the "I've already donated" pop-up. */
async function claim(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, input: string, ctx: AppContext): Promise<void> {
  // JustGiving calls can take longer than Discord's 3-second limit, so acknowledge first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // Members type the reference from their JustGiving receipt; find the donation it belongs to.
  let donationId: string | null;
  try {
    donationId = await resolveClaimInput(input, ctx.donations);
  } catch (error) {
    if (!(error instanceof JustGivingError)) throw error;
    await interaction.editReply({ embeds: [failureEmbed('api_error')] });
    return;
  }
  if (donationId === null) {
    ctx.donations.store.audit('verification_failed', { discordUserId: interaction.user.id, detail: 'claim: receipt reference not on our page' });
    await interaction.editReply({ embeds: [failureEmbed('donation_not_found')] });
    return;
  }
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
        .setLabel('JustGiving receipt reference')
        .setDescription('The reference on your JustGiving receipt email. It looks like 123456789/1.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(DONATION_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('123456789/1')
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
