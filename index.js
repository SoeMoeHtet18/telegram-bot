import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import logger from "./logger.js";

if (!process.env.BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}
if (!process.env.WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL in .env");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for logging user interactions
bot.use(async (ctx, next) => {
  const user = ctx.from
    ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""} (${
        ctx.from.username || "no-username"
      })`
    : "unknown-user";

  const type = ctx.updateType;
  const msg =
    ctx.message?.text ||
    ctx.callbackQuery?.data ||
    "[non-text message]";

  logger.info(`${type} | From: ${user} | Message: ${msg}`);
  await next();
});

// Error handling
bot.catch((err, ctx) => {
  logger.error(`Bot error on ${ctx.updateType}: ${err.message}`);
});

// Bot Commands
bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `👋 မင်္ဂလာပါ *${ctx.from?.first_name}*!\n\nဘာလုပ်ချင်လဲ? အောက်က ရွေးချယ်မှုတွေထဲက တစ်ခုကို ရွေးပါ:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🧪 Test", callback_data: "test" },
            { text: "🔹 Other", callback_data: "other" },
          ],
        ],
      },
    }
  );
});

bot.help((ctx) => {
  ctx.replyWithMarkdown(
    `📖 *အသုံးပြုပုံ*\n• အောက်က ခလုတ်တွေထဲက တစ်ခုကို ရွေးပါ:\n  - 🧪 Test: စမ်းသပ်မှုတစ်ခုလုပ်ကြည့်မယ်\n  - 🔹 Other: အခြားအရာတစ်ခုလုပ်မယ်`
  );
});

// Handle any message
bot.on("message", (ctx) => {
  ctx.replyWithMarkdown(
    `📋 ဘာလုပ်ချင်လဲ? အောက်က ရွေးချယ်မှုတွေထဲက တစ်ခုကို ရွေးပါ:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🧪 Test", callback_data: "test" },
            { text: "🔹 Other", callback_data: "other" },
          ],
        ],
      },
    }
  );
});

// Handle callback queries from inline keyboard
bot.on("callback_query", async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery.data;

    switch (callbackData) {
      case "test":
        await ctx.reply("🧪 သင်ရွေးချယ်ခဲ့တာက *Test* ပါ! ဒါက စမ်းသပ်မှုတစ်ခုပါ။ နောက်ထပ်ဘာလုပ်ချင်လဲ?", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧪 Test Again", callback_data: "test" },
                { text: "🔹 Other", callback_data: "other" },
              ],
            ],
          },
        });
        await ctx.answerCbQuery("Test selected!");
        break;

      case "other":
        await ctx.reply("🔹 သင်ရွေးချယ်ခဲ့တာက *Other* ပါ! အခြားလုပ်စရာတစ်ခုကို ရွေးချယ်ခဲ့ပါတယ်။ နောက်ထပ်ဘာလုပ်ချင်လဲ?", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧪 Test", callback_data: "test" },
                { text: "🔹 Other Again", callback_data: "other" },
              ],
            ],
          },
        });
        await ctx.answerCbQuery("Other selected!");
        break;

      default:
        await ctx.answerCbQuery("⚠️ Unknown action.");
    }
  } catch (error) {
    logger.error(`Callback query error: ${error.message}`);
    await ctx.answerCbQuery("⚠️ An error occurred. Please try again.");
  }
});

// Express Webhook
app.use(express.json());
app.use(bot.webhookCallback("/webhook"));

// Register webhook with Telegram
bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  logger.info(`🚀 Webhook server started on port ${PORT}`);
});