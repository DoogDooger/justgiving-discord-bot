import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('donate')
    .setDescription('Get your personal JustGiving link to donate and earn a charity role')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription("Link a donation you've already made (if the role wasn't added automatically)")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('donation_id')
        .setDescription('The reference on your JustGiving receipt email, e.g. 123456789/1')
        .setRequired(true)
        .setMaxLength(20),
    ),
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
    .setDescription('Delete everything this bot stores about you')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('donor-status')
    .setDescription('See your donor roles and get back any that are missing')
    .setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());
