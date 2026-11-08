const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleInteraction } = require('./discordBot');
const COMMANDS = require('./discord-commands.json');

let started = false;

// Bot Discord chạy qua Gateway (kết nối liên tục), giống polling của Telegram.
// Không cần Interactions Endpoint URL, không cần Public Key.
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
    if (!interaction.isChatInputCommand()) return;
    try {
      const body = {
        type: 2,
        user: { id: interaction.user.id },
        data: {
          name: interaction.commandName,
          options: interaction.options.data.map(o => ({ name: o.name, value: o.value }))
        }
      };
      const result = await handleInteraction(body, db, admin);
      await interaction.reply({ content: result?.data?.content || 'Có lỗi, thử lại sau.', flags: 64 });
    } catch (error) {
      console.error('Discord command:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Có lỗi, thử lại sau.', flags: 64 }).catch(() => {});
      }
    }
  });

  client.login(token).catch(error => console.error('Discord login:', error.message));
  return client;
}

module.exports = { startDiscordGateway };
