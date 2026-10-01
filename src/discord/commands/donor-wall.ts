import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../context.js';
import { brandColor } from '../embeds.js';

export async function handleDonorWall(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const { store } = ctx.donations;
  const choice = interaction.options.getString('visibility');
  const wallUrl = `${ctx.config.publicBaseUrl}/`;

  if (choice === 'hide' || choice === 'show') {
    const hidden = choice === 'hide';
    store.setHiddenFromWall(interaction.user.id, hidden);
    store.audit(hidden ? 'wall_hidden' : 'wall_shown', { discordUserId: interaction.user.id });
  }

  const hidden = store.isHiddenFromWall(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(brandColor(ctx.config.site))
    .setTitle(hidden ? '🙈 You’re hidden from the donor wall' : '💖 You’re shown on the donor wall')
    .setURL(wallUrl)
    .setDescription(
      hidden
        ? 'Your donations still count and you keep your role, but your name and picture won’t appear on the public donor wall or in the top donors list. Run `/donor-wall visibility:show` to appear again.'
        : 'When you donate, your Discord name and picture appear on the public donor wall, and in the top donors list if you are one of the three biggest givers with a public amount on JustGiving. Run `/donor-wall visibility:hide` to stay anonymous.',
    )
    .setFooter({ text: 'Changes show on the wall within a minute.' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
