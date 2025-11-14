// register-commands.js (ESM)
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Set DISCORD_TOKEN, CLIENT_ID, GUILD_ID in env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('apply-panel').setDescription('Опубликовать панель заявок (кнопки)'),

  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Записать действие (аудит)')
    .addUserOption(o => o.setName('author').setDescription('Кто совершил действие').setRequired(true))
    .addUserOption(o => o.setName('target').setDescription('Кого действие касается').setRequired(true))
    .addStringOption(o => o.setName('action').setDescription('Тип действия').setRequired(true)
      .addChoices(
        { name: 'Повышение', value: 'promote' },
        { name: 'Понижение', value: 'demote' },
        { name: 'Выговор', value: 'warn' },
        { name: 'Увольнение', value: 'fire' },
        { name: 'Выдача ранга', value: 'give_rank' }
      ))
    .addStringOption(o => o.setName('from_rank').setDescription('С какого ранга').setRequired(false))
    .addStringOption(o => o.setName('to_rank').setDescription('На какой ранг').setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(false)),

  new SlashCommandBuilder()
    .setName('blacklist-add')
    .setDescription('Добавить статик/пользователя в ЧС')
    .addStringOption(o => o.setName('static').setDescription('Статик / имя').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Срок (30d/permanent)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('blacklist-list')
    .setDescription('Показать черный список'),

  new SlashCommandBuilder()
    .setName('blacklist-remove')
    .setDescription('Удалить запись из ЧС')
    .addStringOption(o => o.setName('static').setDescription('Статик / имя').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands to guild', GUILD_ID);
    const res = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Registered', Array.isArray(res) ? res.length : 'unknown', 'commands');
    process.exit(0);
  } catch (err) {
    console.error('Registration error:');
    console.error(err);
    process.exit(1);
  }
})();
