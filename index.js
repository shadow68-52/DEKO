// index.js (ESM)
// Requires: discord.js v14, @discordjs/rest, discord-api-types, express, node-fetch, cookie-parser, express-session, dotenv
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import session from 'express-session';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField
} from 'discord.js';

import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// ----------------------------- ENV -----------------------------
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  GUILD_ID,
  APP_CHANNEL_ID,
  AUDIT_CHANNEL_ID,
  BLACKLIST_CHANNEL_ID,
  LEADERS_LOG_CHANNEL_ID,
  ALLOWED_ROLES,
  OAUTH_REDIRECT_URI,
  SESSION_SECRET,
  ACCEPT_ROLE_ID, // optional: role to grant on accept
  PORT = 3000
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN or CLIENT_ID missing in env. Abort.');
  process.exit(1);
}

// parse allowed roles (comma separated)
const ALLOWED_ROLE_IDS = (ALLOWED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);

// ----------------------------- BLACKLIST STORAGE -----------------------------
const BLACKLIST_FILE = path.resolve('./blacklist.json');

function saveBlacklist(data) {
  try {
    if (!data || typeof data !== 'object') data = { items: [] };
    if (!Array.isArray(data.items)) data.items = [];
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save blacklist.json', e);
  }
}

function loadBlacklist() {
  try {
    // create default if not exists
    if (!fs.existsSync(BLACKLIST_FILE)) {
      const def = { items: [] };
      fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }

    const raw = fs.readFileSync(BLACKLIST_FILE, 'utf8').trim();
    if (!raw) {
      const def = { items: [] };
      fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      const def = { items: [] };
      saveBlacklist(def);
      return def;
    }
    if (!Array.isArray(parsed.items)) {
      parsed.items = Array.isArray(parsed?.items) ? parsed.items : [];
      saveBlacklist(parsed);
    }
    return parsed;
  } catch (e) {
    console.error('Failed to load/parse blacklist.json, recreating default.', e);
    try {
      const def = { items: [] };
      fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(def, null, 2), 'utf8');
      return def;
    } catch (ee) {
      console.error('Failed to recreate blacklist.json', ee);
      return { items: [] };
    }
  }
}

let BLACKLIST = loadBlacklist(); // { items: [...] }

// ----------------------------- BLACKLIST EXPIRY CHECK (auto) -----------------------------
const BLACKLIST_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(async () => {
  try {
    if (!BLACKLIST || !Array.isArray(BLACKLIST.items)) {
      BLACKLIST = loadBlacklist();
    }
    const now = Date.now();
    const expired = (BLACKLIST.items || []).filter(item => item.until && item.until <= now);
    if (!expired.length) return;

    BLACKLIST.items = (BLACKLIST.items || []).filter(item => !item.until || item.until > now);
    saveBlacklist(BLACKLIST);

    if (BLACKLIST_CHANNEL_ID) {
      try {
        const ch = await client.channels.fetch(BLACKLIST_CHANNEL_ID).catch(()=>null);
        if (ch && ch.isTextBased()) {
          for (const it of expired) {
            await ch.send(`♻️ Срок ЧС истёк: **${it.id}** — причина: ${it.reason || '—'} (добавил: ${it.addedBy || '—'})`).catch(()=>{});
          }
        }
      } catch (e) {
        console.warn('Blacklist expiry notify failed', e?.message || e);
      }
    }
    console.log(`Blacklist: removed ${expired.length} expired items.`);
  } catch (e) {
    console.error('Blacklist expiry check error', e);
  }
}, BLACKLIST_EXPIRY_CHECK_INTERVAL_MS);

// ----------------------------- DISCORD CLIENT -----------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ----------------------------- UTILS -----------------------------
async function ensureThreadActive(thread) {
  try {
    if (!thread) return;
    if (typeof thread.archived === 'boolean' && thread.archived) {
      await thread.setArchived(false, 'Auto-unarchive for bot action').catch(() => {});
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (e) {
    console.error('ensureThreadActive error:', e?.message || e);
  }
}

function hasLeaderRole(member) {
  if (!member) return false;
  try {
    if (!member.roles) return false;
    return ALLOWED_ROLE_IDS.some(r => member.roles.cache.has(r));
  } catch (e) {
    return false;
  }
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

// ----------------------------- COMMANDS SETUP -----------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('apply-panel')
    .setDescription('Отправить панель заявок'),

  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Создать запись аудита')
    .addUserOption(o => o.setName('author').setDescription('Кто совершил действие').setRequired(true))
    .addUserOption(o => o.setName('target').setDescription('Кого касается действие').setRequired(true))
    .addStringOption(o => o.setName('action')
      .setDescription('Тип действия').setRequired(true)
      .addChoices(
        { name: 'Повышение', value: 'promote' },
        { name: 'Понижение', value: 'demote' },
        { name: 'Выговор', value: 'warn' },
        { name: 'Увольнение', value: 'fire' },
        { name: 'Выдача ранга', value: 'give_rank' }
      ))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(false))
    .addStringOption(o => o.setName('from_rank').setDescription('С какого ранга').setRequired(false))
    .addStringOption(o => o.setName('to_rank').setDescription('На какой ранг').setRequired(false)),

  new SlashCommandBuilder()
    .setName('blacklist-add')
    .setDescription('Добавить статик в черный список')
    .addStringOption(o => o.setName('static').setDescription('IC / статик участника (например: Name#1234)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Срок (например 7d, 30d или "permanent")').setRequired(false)),

  new SlashCommandBuilder()
    .setName('blacklist-remove')
    .setDescription('Убрать статик из черного списка')
    .addStringOption(o => o.setName('static').setDescription('IC / статик участника').setRequired(true)),

  new SlashCommandBuilder()
    .setName('blacklist-list')
    .setDescription('Показать текущий чёрный список'),
].map(c => c.toJSON());

// Register commands (guild level for quick update)
(async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    if (!GUILD_ID) {
      console.warn('GUILD_ID not set — commands will be registered globally (may take up to 1 hour).');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands.');
    } else {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Slash commands registered for guild', GUILD_ID);
    }
  } catch (err) {
    console.error('Slash registration error:', err);
  }
})();

// ----------------------------- CLIENT READY -----------------------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ----------------------------- INTERACTIONS -----------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // apply-panel
      if (cmd === 'apply-panel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
          const member = interaction.member;
          if (!hasLeaderRole(member)) {
            await interaction.reply({ content: 'У вас нет прав на публикацию панели.', ephemeral: true });
            return;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('✉️ Панель заявок')
          .setDescription('Выберите тип заявки')
          .setColor(0x7b68ee);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('apply_family').setLabel('Вступление').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('apply_restore').setLabel('Восстановление').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('apply_unblack').setLabel('Снятие ЧС').setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [embed], components: [row] });
        return;
      }

      // audit
      if (cmd === 'audit') {
        const actor = interaction.options.getUser('author', true);
        const target = interaction.options.getUser('target', true);
        const action = interaction.options.getString('action', true);
        const reason = interaction.options.getString('reason') || '—';
        const fromRank = interaction.options.getString('from_rank') || '—';
        const toRank = interaction.options.getString('to_rank') || '—';

        const ACTION_MAP = {
          promote: 'Повышение',
          demote: 'Понижение',
          warn: 'Выговор',
          fire: 'Увольнение',
          give_rank: 'Выдача ранга'
        };

        const embed = new EmbedBuilder()
          .setTitle('📘 Аудит действия')
          .setColor(0xf1c40f)
          .addFields(
            { name: 'Действие', value: ACTION_MAP[action] || action, inline: true },
            { name: 'Кто', value: `<@${actor.id}>`, inline: true },
            { name: 'Кого', value: `<@${target.id}>`, inline: true },
            { name: 'С ранга', value: `${fromRank}`, inline: true },
            { name: 'На ранг', value: `${toRank}`, inline: true },
            { name: 'Причина', value: reason, inline: false },
          )
          .setTimestamp();

        if (AUDIT_CHANNEL_ID) {
          try {
            const ch = await client.channels.fetch(AUDIT_CHANNEL_ID);
            if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(()=>{});
          } catch (e) {
            console.warn('Cannot send audit to AUDIT_CHANNEL_ID', e?.message || e);
          }
        }

        if (action === 'fire' && GUILD_ID) {
          try {
            const guild = await client.guilds.fetch(GUILD_ID);
            await guild.members.kick(target.id, reason).catch(e => {
              console.warn('Kick failed:', e?.message || e);
            });
          } catch (e) {
            console.error('Failed to kick user on fire action:', e);
          }
        }

        await interaction.reply({ content: 'Аудит записан.', ephemeral: true });
        return;
      }

      // blacklist-add
      if (cmd === 'blacklist-add') {
        const member = interaction.member;
        if (!hasLeaderRole(member)) {
          await interaction.reply({ content: 'У вас нет прав для добавления в ЧС.', ephemeral: true });
          return;
        }

        const ic = interaction.options.getString('static', true).trim();
        const reason = interaction.options.getString('reason', true);
        const duration = interaction.options.getString('duration') || 'permanent';

        let until = null;
        if (duration !== 'permanent') {
          const m = duration.match(/^(\d+)(d|h)$/);
          if (m) {
            const n = parseInt(m[1], 10);
            const unit = m[2];
            const now = Date.now();
            if (unit === 'd') until = now + n * 24 * 60 * 60 * 1000;
            if (unit === 'h') until = now + n * 60 * 60 * 1000;
          }
        }

        // ensure structure exists
        if (!BLACKLIST || typeof BLACKLIST !== 'object') BLACKLIST = { items: [] };
        if (!Array.isArray(BLACKLIST.items)) BLACKLIST.items = [];

        BLACKLIST.items.push({
          id: ic,
          reason,
          addedBy: interaction.user.tag,
          until,
          createdAt: Date.now()
        });
        saveBlacklist(BLACKLIST);

        const embed = new EmbedBuilder()
          .setTitle('⛔ Новый черный список — добавление')
          .addFields(
            { name: 'Статик', value: ic, inline: true },
            { name: 'Кто добавил', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Причина', value: reason, inline: false },
            { name: 'Действует до', value: until ? formatDate(until) : 'Навсегда', inline: true },
          )
          .setTimestamp()
          .setColor(0xe74c3c);

        if (BLACKLIST_CHANNEL_ID) {
          try {
            const ch = await client.channels.fetch(BLACKLIST_CHANNEL_ID);
            if (ch && ch.isTextBased()) {
              await ch.send({ embeds: [embed] }).catch(()=>{});
            }
          } catch (e) { console.warn('Cannot send to Blacklist channel', e?.message || e); }
        }

        await interaction.reply({ content: `Добавлено в ЧС: ${ic}`, ephemeral: true });
        return;
      }

      // blacklist-remove
      if (cmd === 'blacklist-remove') {
        const member = interaction.member;
        if (!hasLeaderRole(member)) {
          await interaction.reply({ content: 'У вас нет прав для удаления из ЧС.', ephemeral: true });
          return;
        }
        const ic = interaction.options.getString('static', true).trim();

        if (!BLACKLIST || !Array.isArray(BLACKLIST.items)) BLACKLIST = { items: [] };
        const before = BLACKLIST.items.length;
        BLACKLIST.items = BLACKLIST.items.filter(it => it.id.toLowerCase() !== ic.toLowerCase());
        saveBlacklist(BLACKLIST);

        const removed = before !== BLACKLIST.items.length;
        if (removed && BLACKLIST_CHANNEL_ID) {
          const embed = new EmbedBuilder()
            .setTitle('✅ Удаление из ЧС')
            .addFields(
              { name: 'Статик', value: ic, inline: true },
              { name: 'Кто', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setTimestamp()
            .setColor(0x2ecc71);
          try {
            const ch = await client.channels.fetch(BLACKLIST_CHANNEL_ID);
            if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(()=>{});
          } catch (e) {}
        }

        await interaction.reply({ content: removed ? `Удалено: ${ic}` : `Не найдено в ЧС: ${ic}`, ephemeral: true });
        return;
      }

      // blacklist-list
      if (cmd === 'blacklist-list') {
        const items = (BLACKLIST && Array.isArray(BLACKLIST.items)) ? BLACKLIST.items : [];
        if (!items.length) {
          await interaction.reply({ content: 'ЧС пуст.', ephemeral: true });
          return;
        }
        const lines = items.slice(0, 10).map(it => `• ${it.id} — ${it.reason} — ${it.addedBy} — ${it.until ? formatDate(it.until) : 'Навсегда'}`);
        await interaction.reply({ content: lines.join('\n'), ephemeral: true });
        return;
      }
    }

    // Buttons
    if (interaction.isButton()) {
      // apply buttons open modal
      if (interaction.customId.startsWith('apply_')) {
        const type = interaction.customId.replace('apply_', '');
        const modal = new ModalBuilder()
          .setCustomId(`apply_modal_${type}`)
          .setTitle(type === 'family' ? 'Заявка — вступление' : type === 'restore' ? 'Заявка — восстановление' : 'Заявка — снятие ЧС');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('your_name').setLabel('Ваше имя (OOC)').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('discord').setLabel('Ваш Discord').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ic_name').setLabel('IC - Имя, Фамилия, #статик').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('history').setLabel('В каких семьях состояли?').setStyle(TextInputStyle.Paragraph).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('motivation').setLabel('Почему выбираете нас?').setStyle(TextInputStyle.Paragraph).setRequired(true)
          ),
        );

        await interaction.showModal(modal);
        return;
      }

      // accept button inside thread
      if (interaction.customId.startsWith('accept_')) {
        const thread = interaction.channel;
        if (!thread || !thread.isThread()) {
          await interaction.reply({ content: 'Кнопка работает только внутри тредов.', ephemeral: true });
          return;
        }

        await ensureThreadActive(thread);

        const embed = new EmbedBuilder()
          .setTitle('✅ Заявка одобрена')
          .setDescription(`Лидер: <@${interaction.user.id}>`)
          .setColor(0x2ecc71)
          .setTimestamp();

        await thread.send({ embeds: [embed] }).catch(()=>{});

        // Auto grant role (if configured)
        if (ACCEPT_ROLE_ID) {
          try {
            const applicantId = thread.ownerId || null;
            if (applicantId && thread.guild) {
              const guild = await thread.guild.fetch().catch(()=>null);
              const member = guild ? await guild.members.fetch(applicantId).catch(()=>null) : null;
              if (member) {
                await member.roles.add(ACCEPT_ROLE_ID).catch(e => {
                  console.warn('Grant role failed:', e?.message || e);
                });
              } else {
                // fallback: try find last message author
                try {
                  const fetched = await thread.fetch();
                  const lastMsg = fetched?.messages?.cache?.first();
                  const possibleAuthor = lastMsg?.author?.id;
                  if (possibleAuthor && thread.guild) {
                    const guild2 = await thread.guild.fetch().catch(()=>null);
                    const member2 = guild2 ? await guild2.members.fetch(possibleAuthor).catch(()=>null) : null;
                    if (member2) {
                      await member2.roles.add(ACCEPT_ROLE_ID).catch(e => {
                        console.warn('Grant role failed (fallback):', e?.message || e);
                      });
                    }
                  }
                } catch (e) {}
              }
            } else {
              // fallback attempt
              try {
                const fetched = await thread.fetch();
                const lastMsg = fetched?.messages?.cache?.first();
                const possibleAuthor = lastMsg?.author?.id;
                if (possibleAuthor && thread.guild) {
                  const guild2 = await thread.guild.fetch().catch(()=>null);
                  const member2 = guild2 ? await guild2.members.fetch(possibleAuthor).catch(()=>null) : null;
                  if (member2) {
                    await member2.roles.add(ACCEPT_ROLE_ID).catch(e => {
                      console.warn('Grant role failed (fallback2):', e?.message || e);
                    });
                  }
                }
              } catch (e) {}
            }
          } catch (e) {
            console.warn('Auto-grant role error:', e?.message || e);
          }
        }

        await thread.setArchived(true).catch(()=>{});

        if (LEADERS_LOG_CHANNEL_ID) {
          const logCh = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
          if (logCh && logCh.isTextBased()) {
            await logCh.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('📗 Одобрение заявки')
                  .addFields({ name: 'Лидер', value: `<@${interaction.user.id}>` }, { name: 'Тред', value: thread.name })
                  .setColor(0x2ecc71)
              ]
            }).catch(()=>{});
          }
        }

        await interaction.reply({ content: 'Одобрено.', ephemeral: true });
        return;
      }

      // deny button shows modal for reason
      if (interaction.customId.startsWith('deny_')) {
        const modal = new ModalBuilder()
          .setCustomId('deny_reason_modal')
          .setTitle('Причина отклонения')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('reason').setLabel('Причина отказа').setStyle(TextInputStyle.Paragraph).setRequired(true)
            )
          );
        await interaction.showModal(modal);
        return;
      }
    }

    // Modal submit
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'deny_reason_modal') {
        const reason = interaction.fields.getTextInputValue('reason');
        const thread = interaction.channel;
        await ensureThreadActive(thread);
        const embed = new EmbedBuilder()
          .setTitle('❌ Заявка отклонена')
          .setDescription(`Причина: **${reason}**\nЛидер: <@${interaction.user.id}>`)
          .setColor(0xe74c3c)
          .setTimestamp();

        await thread.send({ embeds: [embed] }).catch(()=>{});
        await thread.setArchived(true).catch(()=>{});

        if (LEADERS_LOG_CHANNEL_ID) {
          const logCh = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
          if (logCh && logCh.isTextBased()) {
            await logCh.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('📕 Отклонение заявки')
                  .addFields({ name: 'Лидер', value: `<@${interaction.user.id}>` }, { name: 'Причина', value: reason })
                  .setColor(0xe74c3c)
              ]
            }).catch(()=>{});
          }
        }

        await interaction.reply({ content: 'Заявка отклонена.', ephemeral: true });
        return;
      }

      // main apply modal
      if (interaction.customId.startsWith('apply_modal_')) {
        const type = interaction.customId.replace('apply_modal_', '');
        const yourName = interaction.fields.getTextInputValue('your_name');
        const discord = interaction.fields.getTextInputValue('discord');
        const ic = interaction.fields.getTextInputValue('ic_name');
        const history = interaction.fields.getTextInputValue('history');
        const motivation = interaction.fields.getTextInputValue('motivation');

        const errors = [];
        if (yourName.length < 2) errors.push('Имя слишком короткое.');
        if (!discord.includes('#') && !discord.includes('@')) errors.push('Discord указан неверно.');
        if (ic.length < 3) errors.push('IC слишком короткое.');
        if (history.length < 10) errors.push('История слишком короткая.');
        if (motivation.length < 10) errors.push('Мотивация слишком короткая.');

        if (errors.length) {
          await interaction.reply({ content: '❌ Ошибки:\n' + errors.map(e => `• ${e}`).join('\n'), ephemeral: true });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(type === 'family' ? '📩 Заявка на вступление' : type === 'restore' ? '📩 Заявка на восстановление' : '📩 Заявка на снятие ЧС')
          .setColor(0x7b68ee)
          .addFields(
            { name: 'Имя (OOC)', value: yourName },
            { name: 'Discord', value: discord },
            { name: 'IC данные', value: ic },
            { name: 'История', value: history },
            { name: 'Мотивация', value: motivation },
          )
          .setFooter({ text: 'Заявка из формы' })
          .setTimestamp();

        if (!APP_CHANNEL_ID) {
          await interaction.reply({ content: 'Ошибка: APP_CHANNEL_ID не задан.', ephemeral: true });
          return;
        }

        const forum = await client.channels.fetch(APP_CHANNEL_ID).catch(() => null);
        if (!forum || forum.type !== ChannelType.GuildForum) {
          if (!forum || !forum.isTextBased()) {
            await interaction.reply({ content: 'Не удалось найти форум/канал заявок или бот не имеет прав.', ephemeral: true });
            return;
          }
        }

        try {
          const msgPayload = {
            content: ALLOWED_ROLE_IDS.length ? ALLOWED_ROLE_IDS.map(r => `<@&${r}>`).join(' ') : '',
            embeds: [embed],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accept_${interaction.user.id}`).setLabel('Принять').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`deny_${interaction.user.id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger)
              )
            ]
          };

          if (forum.type === ChannelType.GuildForum) {
            const thread = await forum.threads.create({
              name: `Заявка — ${yourName}`,
              message: msgPayload
            });
            await interaction.reply({ content: 'Заявка отправлена!', ephemeral: true });
            return;
          } else {
            const sent = await forum.send(msgPayload);
            if (sent?.startThread) {
              const thread = await sent.startThread({ name: `Заявка — ${yourName}` }).catch(()=>null);
              if (thread) {
                await thread.send(`Тред создан для обсуждения. ${ALLOWED_ROLE_IDS.map(r => `<@&${r}>`).join(' ')}`.trim()).catch(()=>{});
              }
            }
            await interaction.reply({ content: 'Заявка отправлена!', ephemeral: true });
            return;
          }
        } catch (e) {
          console.error('Failed to create forum thread', e);
          await interaction.reply({ content: 'Ошибка при отправке заявки: ' + (e?.message || e), ephemeral: true });
          return;
        }
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction && !interaction.replied) {
        await interaction.reply({ content: 'Произошла ошибка.', ephemeral: true });
      }
    } catch {}
  }
});

// ----------------------------- EXPRESS (WEB PANEL) -----------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET || 'versize_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

// simple storage for oauth tokens
global.oauthTokens = {};

const DISCORD_OAUTH_URL =
  'https://discord.com/api/oauth2/authorize'
  + `?client_id=${CLIENT_ID}`
  + '&response_type=code'
  + '&scope=identify%20guilds%20guilds.members.read'
  + `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`)}`;

// requireAuth middleware (uses oauth session)
async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  try {
    if (GUILD_ID && global.oauthTokens[req.session.user.id]) {
      const token = global.oauthTokens[req.session.user.id];
      const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${GUILD_ID}/member`, {
        headers: { Authorization: `Bearer ${token}` }
      }).catch(()=>null);
      if (!r || !r.ok) {
        return res.send('<h1>Вы не состоите на сервере или токен устарел.</h1>');
      }
      const member = await r.json();
      const has = (member.roles || []).some(r => ALLOWED_ROLE_IDS.includes(r));
      if (!has) return res.send('<h1>У вас нет прав доступа к панели.</h1>');
    }
  } catch (e) {
    console.warn('requireAuth check failed', e);
  }
  next();
}

// login route
app.get('/login', (req, res) => {
  res.send(`<html><body style="background:#0b0b12;color:white;font-family:Arial;padding:40px;">
    <h1>Versize — Панель</h1>
    <a href="${DISCORD_OAUTH_URL}" style="padding:12px 20px;background:#7b68ee;color:white;border-radius:8px;text-decoration:none;">Войти через Discord</a>
  </body></html>`);
});

// callback
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('No code.');
  const params = new URLSearchParams();
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET || '');
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return res.send('Auth failed.');

  const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` }});
  const userData = await userRes.json();
  global.oauthTokens[userData.id] = tokenData.access_token;
  req.session.user = { id: userData.id, username: userData.username, avatar: userData.avatar };
  res.redirect('/panel');
});

// simple panel home
function sidebarHTML(username) {
  return `<div style="width:220px;position:fixed;left:0;top:0;height:100vh;background:#0f0e18;padding:20px;color:#ddd;">
    <h2 style="color:#7b68ee;">VERSIZE</h2>
    <a style="display:block;color:#bbb;margin:10px 0;" href="/panel">Dashboard</a>
    <a style="display:block;color:#bbb;margin:10px 0;" href="/panel/applications">Заявки</a>
    <a style="display:block;color:#bbb;margin:10px 0;" href="/panel/logs">Логи лидеров</a>
    <a style="display:block;color:#bbb;margin:10px 0;" href="/panel/settings">Настройки</a>
    <a style="display:block;color:#bbb;margin:10px 0;" href="/logout">Выйти (${username})</a>
  </div>`;
}

app.get('/panel', requireAuth, (req, res) => {
  const username = req.session.user?.username || 'guest';
  res.send(`<html><head><meta charset="utf-8"></head><body style="margin:0;">
    ${sidebarHTML(username)}
    <div style="margin-left:240px;padding:24px;">
      <h1>Панель управления</h1>
      <p>Бот: <b>${client?.user?.tag || 'offline'}</b></p>
      <p>Канал заявок: <b>${APP_CHANNEL_ID || '—'}</b></p>
    </div>
  </body></html>`);
});

app.get('/panel/applications', requireAuth, async (req, res) => {
  const username = req.session.user?.username || 'guest';
  try {
    const forum = await client.channels.fetch(APP_CHANNEL_ID);
    const threads = forum?.threads ? await forum.threads.fetchActive().catch(()=>({ threads: [] })) : { threads: [] };
    const rows = threads.threads.map(t => `<tr><td>${t.name}</td><td>${t.ownerId || '-'}</td><td>${new Date(t.createdTimestamp).toLocaleString()}</td><td>
      <a href="/api/thread/accept?id=${t.id}" style="padding:6px 10px;background:#7b68ee;color:white;border-radius:6px;text-decoration:none;">Принять</a>
      <a href="/api/thread/deny?id=${t.id}" style="padding:6px 10px;background:#e74c3c;color:white;border-radius:6px;text-decoration:none;margin-left:6px;">Отклонить</a>
    </td></tr>`).join('');
    res.send(`<html><body>${sidebarHTML(username)}<div style="margin-left:240px;padding:24px;"><h1>Активные заявки</h1><table border="0" cellpadding="8" cellspacing="0">${rows}</table></div></body></html>`);
  } catch (e) {
    res.send(`<html><body>${sidebarHTML(username)}<div style="margin-left:240px;padding:24px;"><h1>Ошибка</h1><pre>${e?.message||e}</pre></div></body></html>`);
  }
});

app.get('/panel/logs', requireAuth, async (req, res) => {
  const username = req.session.user?.username || 'guest';
  try {
    const logCh = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID);
    const msgs = await logCh.messages.fetch({ limit: 30 });
    const rows = msgs.map(m => `<tr><td>${m.author?.username||'bot'}</td><td>${m.embeds[0]?.title || '—'}</td><td>${(m.embeds[0]?.fields || []).map(f => `${f.name}: ${f.value}`).join('<br>')}</td><td>${new Date(m.createdTimestamp).toLocaleString()}</td></tr>`).join('');
    res.send(`<html><body>${sidebarHTML(username)}<div style="margin-left:240px;padding:24px;"><h1>Логи лидеров</h1><table border="0" cellpadding="8">${rows}</table></div></body></html>`);
  } catch (e) {
    res.send(`<html><body>${sidebarHTML(username)}<div style="margin-left:240px;padding:24px;"><h1>Ошибка</h1><pre>${e?.message||e}</pre></div></body></html>`);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// API for panel accept/deny (no complex auth)
app.get('/api/thread/accept', requireAuth, async (req, res) => {
  const threadId = req.query.id;
  const uid = req.session.user?.id;
  try {
    if (!threadId) return res.send('No id.');
    const thread = await client.channels.fetch(threadId);
    if (!thread || !thread.isThread()) return res.send('Not a thread.');
    await ensureThreadActive(thread);
    await thread.send({ embeds: [new EmbedBuilder().setTitle('✅ Заявка одобрена (WEB)').setDescription(`Лидер: <@${uid}>`).setColor(0x2ecc71)] }).catch(()=>{});
    await thread.setArchived(true).catch(()=>{});
    if (LEADERS_LOG_CHANNEL_ID) {
      const logCh = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
      if (logCh && logCh.isTextBased()) logCh.send({ embeds: [new EmbedBuilder().setTitle('📗 Одобрение (WEB)').addFields({ name: 'Лидер', value: `<@${uid}>` }, { name: 'Thread', value: thread.name }).setColor(0x2ecc71)] }).catch(()=>{});
    }
    if (ACCEPT_ROLE_ID) {
      try {
        const applicantId = thread.ownerId || null;
        if (applicantId && thread.guild) {
          const guild = await thread.guild.fetch().catch(()=>null);
          const member = guild ? await guild.members.fetch(applicantId).catch(()=>null) : null;
          if (member) {
            await member.roles.add(ACCEPT_ROLE_ID).catch(e => { console.warn('Grant role failed (WEB):', e?.message || e); });
          }
        }
      } catch (e) {
        console.warn('Auto-grant role error (WEB):', e?.message || e);
      }
    }
    res.redirect('/panel/applications');
  } catch (e) {
    console.error('API accept error', e);
    res.send('Ошибка');
  }
});

app.get('/api/thread/deny', requireAuth, async (req, res) => {
  const threadId = req.query.id;
  const reason = req.query.reason;
  const uid = req.session.user?.id;
  if (!threadId) return res.send('No id.');
  if (!reason) {
    // show form
    return res.send(`<html><body><form><input type="hidden" name="id" value="${threadId}"><textarea name="reason" style="width:400px;height:150px;"></textarea><br><button>Send</button></form></body></html>`);
  }
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread || !thread.isThread()) return res.send('Not a thread.');
    await ensureThreadActive(thread);
    await thread.send({ embeds: [new EmbedBuilder().setTitle('❌ Заявка отклонена (WEB)').addFields({ name: 'Лидер', value: `<@${uid}>` }, { name: 'Причина', value: reason }).setColor(0xe74c3c)] }).catch(()=>{});
    await thread.setArchived(true).catch(()=>{});
    if (LEADERS_LOG_CHANNEL_ID) {
      const logCh = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
      if (logCh && logCh.isTextBased()) logCh.send({ embeds: [new EmbedBuilder().setTitle('📕 Отклонение (WEB)').addFields({ name: 'Лидер', value: `<@${uid}>` }, { name: 'Причина', value: reason }).setColor(0xe74c3c)] }).catch(()=>{});
    }
    res.redirect('/panel/applications');
  } catch (e) {
    console.error('API deny error', e);
    res.send('Ошибка');
  }
});

// ----------------------------- WEBHOOK: forms / zapier -> create application -----------------------------
app.post('/webhook/form', async (req, res) => {
  try {
    const { name, discord, ic, motivation, type = 'family' } = req.body || {};

    if (!name || !discord || !ic || !motivation) {
      return res.status(400).json({ error: 'Missing fields. Required: name, discord, ic, motivation' });
    }

    if (!APP_CHANNEL_ID) {
      return res.status(500).json({ error: 'APP_CHANNEL_ID not configured' });
    }

    const forum = await client.channels.fetch(APP_CHANNEL_ID).catch(()=>null);
    if (!forum) return res.status(500).json({ error: 'Application channel not found' });

    const embed = new EmbedBuilder()
      .setTitle(type === 'family' ? '📩 Заявка на вступление (WEBHOOK)' : type === 'restore' ? '📩 Восстановление (WEBHOOK)' : '📩 Снятие ЧС (WEBHOOK)')
      .setColor(0x7b68ee)
      .addFields(
        { name: 'Имя (OOC)', value: name },
        { name: 'Discord', value: discord },
        { name: 'IC данные', value: ic },
        { name: 'Мотивация', value: motivation }
      )
      .setFooter({ text: 'Заявка из WEBHOOK' })
      .setTimestamp();

    const msgPayload = {
      content: ALLOWED_ROLE_IDS.length ? ALLOWED_ROLE_IDS.map(r => `<@&${r}>`).join(' ') : '',
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`accept_webhook_${Date.now()}`).setLabel('Принять').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`deny_webhook_${Date.now()}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger)
        )
      ]
    };

    if (forum.type === ChannelType.GuildForum) {
      const thread = await forum.threads.create({
        name: `Заявка — ${name}`,
        message: msgPayload
      }).catch(e => { throw e; });
      res.json({ ok: true, threadId: thread.id });
      return;
    } else {
      const sent = await forum.send(msgPayload).catch(e => { throw e; });
      if (sent?.startThread) await sent.startThread({ name: `Заявка — ${name}` }).catch(()=>null);
      res.json({ ok: true });
      return;
    }
  } catch (e) {
    console.error('Webhook create application failed', e);
    res.status(500).json({ error: e?.message || 'internal error' });
  }
});

// start express
app.listen(PORT, () => {
  console.log(`🌐 Versize Web Panel запущена на порте: ${PORT}`);
});

// ----------------------------- LOGIN -----------------------------
client.login(DISCORD_TOKEN).catch(err => console.error('Failed to login:', err));
