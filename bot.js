// Service riêng chỉ chạy bot Telegram và Discord (start command: node bot.js)
const app = require('./server');
const { startAdminBot } = require('./admin-bot');
const { startDiscordGateway } = require('./discordGateway');

const db = app.locals.db;
const admin = app.locals.admin;

console.log('TDMS1VN bot service starting');
startAdminBot(db, admin).catch(error => console.error('Admin Telegram bot startup:', error));
startDiscordGateway(db, admin);
