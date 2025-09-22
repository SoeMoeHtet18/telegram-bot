const express = require('express');
const { Telegraf } = require('telegraf');

const app = express();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  throw new Error('Please provide TELEGRAM_BOT_TOKEN as env variable');
}

const bot = new Telegraf(TOKEN);
bot.on('text', async (ctx) => {
  // Explicit usage
  await ctx.telegram.sendMessage(ctx.message.chat.id, `Hello ${ctx.state.role}`)

  // Using context shortcut
  await ctx.reply(`Hello ${ctx.state.role}`)
})

app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => res.send('Bot is running'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);

  const url = process.env.WEBHOOK_URL;
  if (!url) {
    console.error('Please set WEBHOOK_URL env variable to your webhook URL');
    return;
  }
  try {
    await bot.telegram.setWebhook(url);
    console.log(`Webhook set to ${url}`);
  } catch (err) {
    console.error('Error setting webhook:', err);
  }
});
