import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('donate')
    .setDescription('Get your personal JustGiving link to donate and earn a charity role')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Choose donor wall visibility, then link a donation using your receipt reference')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('donor-wall')
    .setDescription('Show or hide your name on the public donor wall')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('visibility')
        .setDescription('Leave empty to see your current setting')
        .addChoices({ name: 'Show me on the wall', value: 'show' }, { name: 'Hide me from the wall', value: 'hide' }),
    ),
  new SlashCommandBuilder()
    .setName('donor-forget')
    .setDescription('Delete your Discord donation links; used donation IDs remain to prevent reuse')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('donor-status')
    .setDescription('See your donor roles and get back any that are missing')
    .setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());
