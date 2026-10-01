/**
 * One-off: registers the slash commands in the configured server.
 * Run with `npm run register-commands` after changing command definitions.
 */
import { REST, Routes, type APIApplication } from 'discord.js';
import { loadConfigOrExit } from '../config.js';
import { commandDefinitions } from './definitions.js';

const config = loadConfigOrExit();
const rest = new REST().setToken(config.discordToken);

// The application ID is derived from the bot token, so it doesn't need its own setting.
const app = (await rest.get(Routes.currentApplication())) as APIApplication;
await rest.put(Routes.applicationGuildCommands(app.id, config.guildId), { body: commandDefinitions });

console.log(`Registered ${commandDefinitions.length} commands (${commandDefinitions.map((c) => `/${c.name}`).join(', ')}) for "${app.name}" in server ${config.guildId}.`);
