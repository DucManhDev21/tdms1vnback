const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { handleInteraction } = require('./discordBot');
const COMMANDS = require('./discord-commands.json');

let started = false;

function menuRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cust:sodu').setLabel('💰 Số dư').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cust:donhang').setLabel('🧾 Đơn hàng').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cust:menu').setLabel('❓ Hướng dẫn').setStyle(ButtonStyle.Secondary)
  )];
}

function run(db, admin, name, options, userId, guildId) {
  return handleInteraction({
    type: 2,
    user: { id: userId },
    guild_id: guildId || undefined,
    data: { name, options }
  }, db, admin);
}

// Bot Discord chạy qua Gateway (kết nối liên tục), giống polling của Telegram.
function startDiscordGateway(db, admin) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('Discord bot tắt: thiếu DISCORD_BOT_TOKEN');
    return null;
  }
  if (started) return null;
  started = true;

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  client.once(Events.ClientReady, async c => {
    console.log(`Discord bot online: ${c.user.tag}`);
    try {
      await c.application.commands.set(COMMANDS);
      console.log('Discord slash commands đã đăng ký');
    } catch (error) {
      console.error('Discord register commands:', error.message);
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        const options = interaction.options.data.map(o => ({ name: o.name, value: o.value }));
        const result = await run(db, admin, interaction.commandName, options, interaction.user.id, interaction.guildId);
        const payload = { content: result?.data?.content || 'Có lỗi, thử lại sau.', flags: 64 };
        if (interaction.commandName === 'menu') payload.components = menuRows();
        return interaction.reply(payload);
      }
      if (interaction.isButton() && interaction.customId.startsWith('cust:')) {
        const action = interaction.customId.slice(5);
        const name = action === 'sodu' ? 'sodu' : action === 'donhang' ? 'donhang' : 'menu';
        const result = await run(db, admin, name, [], interaction.user.id, interaction.guildId);
        const payload = { content: result?.data?.content || 'Có lỗi, thử lại sau.', flags: 64 };
        if (name === 'menu') payload.components = menuRows();
        return interaction.reply(payload);
      }
    } catch (error) {
      console.error('Discord interaction:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Có lỗi, thử lại sau.', flags: 64 }).catch(() => {});
      }
    }
  });

  client.login(token).catch(error => console.error('Discord login:', error.message));
  return client;
}

module.exports = { startDiscordGateway };
