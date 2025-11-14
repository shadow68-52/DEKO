// index.js (ESM)
import 'dotenv/config';
import fs from 'fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} from 'discord.js';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  APP_CHANNEL_ID,
  AUDIT_CHANNEL_ID,
  BLACKLIST_CHANNEL_ID,
  LEADERS_LOG_CHANNEL_ID,
  ALLOWED_ROLES,
  PORT,
  SESSION_SECRET
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

// role allowed to accept/deny (as requested)
const AUTH_DECIDER_ROLE = '1432734700065263683';
const ALLOWED_ROLE_IDS = (ALLOWED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);

// blacklist file helpers
const BLACKLIST_FILE = './blacklist.json';
async function loadBlacklist(){
  try {
    const txt = await fs.readFile(BLACKLIST_FILE, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return [];
  }
}
async function saveBlacklist(data){
  await fs.writeFile(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// create client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => {
  console.log('Logged in as', client.user.tag);
});

// Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      // apply-panel
      if (name === 'apply-panel') {
        const member = interaction.member;
        const allowed = member.permissions?.has?.('Administrator') || ALLOWED_ROLE_IDS.some(id => member.roles?.cache?.has?.(id));
        if (!allowed) {
          await interaction.reply({ content: 'У вас нет прав публиковать панель.', ephemeral: true });
          return;
        }

        const embed = new EmbedBuilder().setTitle('✉️ Панель заявок — Versize').setDescription('Выберите тип заявки:').setColor(0x8e44ad);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('apply_family').setLabel('Вступление').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('apply_restore').setLabel('Восстановление').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('apply_unblack').setLabel('Снятие ЧС').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ embeds: [embed], components: [row] });
        return;
      }

      // audit
      if (name === 'audit') {
        const actor = interaction.options.getUser('author', true);
        const target = interaction.options.getUser('target', true);
        const action = interaction.options.getString('action', true);
        const fromRank = interaction.options.getString('from_rank') || '—';
        const toRank = interaction.options.getString('to_rank') || '—';
        const reason = interaction.options.getString('reason') || '—';
        const MAP = { promote: 'Повышение', demote: 'Понижение', warn: 'Выговор', fire: 'Увольнение', give_rank: 'Выдача ранга' };

        const embed = new EmbedBuilder().setTitle('📝 Аудит').setColor(0xf1c40f)
          .addFields(
            { name: 'Действие', value: MAP[action] || action, inline: true },
            { name: 'Кто', value: `<@${actor.id}>`, inline: true },
            { name: 'Кого', value: `<@${target.id}>`, inline: true },
            { name: 'С ранга', value: fromRank, inline: true },
            { name: 'На ранг', value: toRank, inline: true },
            { name: 'Причина', value: reason, inline: false }
          ).setTimestamp();

        if (!AUDIT_CHANNEL_ID) {
          await interaction.reply({ content: 'AUDIT_CHANNEL_ID не задан', ephemeral: true });
          return;
        }
        const auditCh = await client.channels.fetch(AUDIT_CHANNEL_ID).catch(()=>null);
        if (auditCh && auditCh.isTextBased()) await auditCh.send({ embeds: [embed] }).catch(()=>{});

        // if fire -> try kick
        if (action === 'fire') {
          try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(target.id).catch(()=>null);
            if (member) await member.kick(reason).catch(()=>{});
          } catch (e) {
            console.error('Kick error:', e);
          }
        }

        await interaction.reply({ content: 'Аудит записан.', ephemeral: true });
        return;
      }

      // blacklist-add
      if (name === 'blacklist-add') {
        const member = interaction.member;
        const allowed = member.permissions?.has?.('Administrator') || ALLOWED_ROLE_IDS.some(id => member.roles?.cache?.has?.(id));
        if (!allowed) {
          await interaction.reply({ content: 'У вас нет прав добавлять в ЧС.', ephemeral: true });
          return;
        }
        const staticName = interaction.options.getString('static', true);
        const reason = interaction.options.getString('reason', true);
        const duration = interaction.options.getString('duration') || '—';
        const user = interaction.options.getUser('target');

        const list = await loadBlacklist();
        const entry = { id: Date.now().toString(), static: staticName, reason, duration, userId: user ? user.id : null, addedBy: interaction.user.id, addedAt: new Date().toISOString() };
        list.push(entry);
        await saveBlacklist(list);

        const embed = new EmbedBuilder().setTitle('🚫 Черный список — добавлено').setColor(0xe74c3c)
          .addFields(
            { name: 'Статик', value: staticName, inline: true },
            { name: 'Причина', value: reason, inline: true },
            { name: 'Срок', value: duration, inline: true },
            { name: 'Пользователь', value: user ? `<@${user.id}>` : '—', inline: true },
            { name: 'Кто добавил', value: `<@${interaction.user.id}>`, inline: true }
          ).setTimestamp();

        if (BLACKLIST_CHANNEL_ID) {
          const ch = await client.channels.fetch(BLACKLIST_CHANNEL_ID).catch(()=>null);
          if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(()=>{});
        }

        await interaction.reply({ content: 'Добавлено в ЧС.', ephemeral: true });
        return;
      }

      // blacklist-list
      if (name === 'blacklist-list') {
        const list = await loadBlacklist();
        if (!list.length) { await interaction.reply({ content: 'ЧС пуст.', ephemeral: true }); return; }
        const lines = list.slice().reverse().map(e => `ID:${e.id} • ${e.static} • ${e.reason} • ${e.duration} • ${e.userId ? `<@${e.userId}>` : '-'}`).slice(0,50);
        await interaction.reply({ content: lines.join('\\n'), ephemeral: true });
        return;
      }

      // blacklist-remove
      if (name === 'blacklist-remove') {
        const member = interaction.member;
        const allowed = member.permissions?.has?.('Administrator') || ALLOWED_ROLE_IDS.some(id => member.roles?.cache?.has?.(id));
        if (!allowed) { await interaction.reply({ content: 'У вас нет прав удалять из ЧС.', ephemeral: true }); return; }
        const id = interaction.options.getString('id', true);
        let list = await loadBlacklist();
        const idx = list.findIndex(x => x.id === id);
        if (idx === -1) { await interaction.reply({ content: 'Запись не найдена.', ephemeral: true }); return; }
        const removed = list.splice(idx,1)[0];
        await saveBlacklist(list);
        if (BLACKLIST_CHANNEL_ID) {
          const ch = await client.channels.fetch(BLACKLIST_CHANNEL_ID).catch(()=>null);
          if (ch && ch.isTextBased()) {
            await ch.send({ embeds: [ new EmbedBuilder().setTitle('🗑️ Удаление из ЧС').addFields(
              { name: 'ID', value: removed.id }, { name: 'Статик', value: removed.static }, { name: 'Причина', value: removed.reason }, { name: 'Кто удалил', value: `<@${interaction.user.id}>` }
            ).setColor(0x95a5a6).setTimestamp() ] }).catch(()=>{});
          }
        }
        await interaction.reply({ content: 'Запись удалена.', ephemeral: true });
        return;
      }
    }

    // Buttons handler
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('apply_')) {
        const type = interaction.customId.replace('apply_','');
        const modal = new ModalBuilder().setCustomId(`apply_modal_${type}`).setTitle(
          type === 'family' ? 'Заявка — вступление' : type === 'restore' ? 'Заявка — восстановление' : 'Заявка — снятие ЧС'
        );
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Ваше имя (OOC)').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord').setLabel('Ваш Discord').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ic').setLabel('IC — Имя, Фамилия, #статик').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('history').setLabel('В каких семьях состояли?').setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('extra').setLabel(type === 'restore' ? 'Причина восстановления' : type === 'unblack' ? 'Причина снятия ЧС' : 'Почему именно мы?').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        await interaction.showModal(modal);
        return;
      }

      // accept / deny buttons inside threads
      if (interaction.customId.startsWith('accept_') || interaction.customId.startsWith('deny_')) {
        const member = interaction.member;
        const hasRole = member.roles?.cache?.has(AUTH_DECIDER_ROLE);
        if (!hasRole && !member.permissions?.has?.('Administrator')) {
          await interaction.reply({ content: 'У вас нет прав принимать/отклонять заявки.', ephemeral: true });
          return;
        }
        const thread = interaction.channel;
        if (!thread?.isThread?.()) { await interaction.reply({ content: 'Кнопка работает в треде/форум посте.', ephemeral: true }); return; }

        if (interaction.customId.startsWith('accept_')) {
          await thread.send({ embeds: [ new EmbedBuilder().setTitle('✅ Заявка принята').setDescription(`Принял: <@${interaction.user.id}>`).setColor(0x2ecc71) ] }).catch(()=>{});
          await thread.setArchived(true).catch(()=>{});
          if (LEADERS_LOG_CHANNEL_ID) {
            const lc = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
            if (lc && lc.isTextBased()) await lc.send({ embeds: [ new EmbedBuilder().setTitle('📗 Одобрение заявки').addFields({ name: 'Лидер', value: `<@${interaction.user.id}>` }, { name: 'Тред', value: thread.name }).setColor(0x2ecc71).setTimestamp() ] }).catch(()=>{});
          }
          await interaction.reply({ content: 'Одобрено.', ephemeral: true });
          return;
        } else {
          const modal = new ModalBuilder().setCustomId('deny_reason_modal').setTitle('Причина отклонения');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Причина').setStyle(TextInputStyle.Paragraph).setRequired(true)));
          await interaction.showModal(modal);
          return;
        }
      }
    }

    // Modal submit
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'deny_reason_modal') {
        const reason = interaction.fields.getTextInputValue('reason');
        const thread = interaction.channel;
        await thread.send({ embeds: [ new EmbedBuilder().setTitle('❌ Заявка отклонена').setDescription(`Причина: **${reason}**\\nРешил: <@${interaction.user.id}>`).setColor(0xe74c3c).setTimestamp() ] }).catch(()=>{});
        await thread.setArchived(true).catch(()=>{});
        if (LEADERS_LOG_CHANNEL_ID) {
          const lc = await client.channels.fetch(LEADERS_LOG_CHANNEL_ID).catch(()=>null);
          if (lc && lc.isTextBased()) await lc.send({ embeds: [ new EmbedBuilder().setTitle('📕 Отклонение (WEB)').addFields({ name: 'Лидер', value: `<@${interaction.user.id}>` }, { name: 'Причина', value: reason }).setColor(0xe74c3c).setTimestamp() ] }).catch(()=>{});
        }
        await interaction.reply({ content: 'Отклонено.', ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith('apply_modal_')) {
        const type = interaction.customId.replace('apply_modal_','');
        const name = interaction.fields.getTextInputValue('name');
        const discord = interaction.fields.getTextInputValue('discord');
        const ic = interaction.fields.getTextInputValue('ic');
        const history = interaction.fields.getTextInputValue('history');
        const extra = interaction.fields.getTextInputValue('extra');

        const errors = [];
        if (!name || name.length < 2) errors.push('Имя слишком короткое');
        if (!discord || discord.length < 3) errors.push('Discord неверен');
        if (!ic || ic.length < 3) errors.push('IC неверен');
        if (!history || history.length < 6) errors.push('История слишком короткая');
        if (!extra || extra.length < 6) errors.push('Причина/мотивация слишком короткая');
        if (errors.length) { await interaction.reply({ content: 'Ошибки:\\n' + errors.map(e=>'• '+e).join('\\n'), ephemeral: true }); return; }

        const title = type === 'family' ? '📩 Заявка — Вступление' : type === 'restore' ? '📩 Заявка — Восстановление' : '📩 Заявка — Снятие ЧС';
        const embed = new EmbedBuilder().setTitle(title).setColor(0x7b68ee)
          .addFields(
            { name: 'Имя (OOC)', value: name },
            { name: 'Discord', value: discord },
            { name: 'IC', value: ic },
            { name: type === 'restore' ? 'Причина восстановления' : type === 'unblack' ? 'Причина снятия ЧС' : 'История', value: extra },
            { name: 'Прошлые семьи / опыт', value: history }
          ).setTimestamp().setFooter({ text: 'Заявка' });

        if (!APP_CHANNEL_ID) { await interaction.reply({ content: 'APP_CHANNEL_ID не задан', ephemeral: true }); return; }
        const forum = await client.channels.fetch(APP_CHANNEL_ID).catch(()=>null);
        if (!forum) { await interaction.reply({ content: 'Канал заявок не найден.', ephemeral: true }); return; }
        const mentions = ALLOWED_ROLE_IDS.length ? ALLOWED_ROLE_IDS.map(r=>`<@&${r}>`).join(' ') : '';

        try {
          const thread = await forum.threads.create({
            name: `Заявка — ${name}`,
            message: {
              content: mentions,
              embeds: [embed],
              components: [ new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accept_${Date.now()}`).setLabel('Принять').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`deny_${Date.now()}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger)
              ) ]
            }
          });
          await interaction.reply({ content: 'Заявка отправлена в форум.', ephemeral: true });
        } catch (e) {
          await forum.send({ content: mentions, embeds: [embed] }).catch(()=>{});
          await interaction.reply({ content: 'Заявка отправлена (канал).', ephemeral: true });
        }
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: 'Произошла ошибка.', ephemeral: true }); } catch {}
  }
});

// minimal web server
const app = express();
app.use(cookieParser());
app.use(session({ secret: SESSION_SECRET || 'versize_secret_key', resave: false, saveUninitialized: false }));
app.get('/', (req, res) => res.send('Versize bot running'));
app.listen(PORT || 3000, () => console.log(`Web on ${PORT || 3000}`));

client.login(DISCORD_TOKEN).catch(err => { console.error('Login error:', err); process.exit(1); });
