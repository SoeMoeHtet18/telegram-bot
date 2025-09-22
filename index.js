import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import axios from "axios";
import exifr from "exifr";
import sharp from "sharp";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
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

bot.use(async (ctx, next) => {
  const user = ctx.from
    ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""} (${
        ctx.from.username || "no-username"
      })`
    : "unknown-user";

  const type = ctx.updateType;
  let msg =
    ctx.message?.text ||
    ctx.message?.caption ||
    ctx.callbackQuery?.data ||
    null;

  if (ctx.message?.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    msg = `Photo URL: https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  }

  if (ctx.message?.document) {
    const doc = ctx.message.document;
    const file = await ctx.telegram.getFile(doc.file_id);
    msg = `Document URL: https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  }

  if (!msg) msg = "[non-text message]";
  logger.info(`${type} | From: ${user} | Message: ${msg}`);
  await next();
});

bot.catch((err, ctx) => {
  logger.error(`Bot error on ${ctx.updateType}: ${err.message}`);
});

async function fetchFileBuffer(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const resp = await axios.get(link.href, { responseType: "arraybuffer" });
  return Buffer.from(resp.data);
}

function gpsArrayToDecimal(arr, ref) {
  if (!Array.isArray(arr)) return 0;
  const [deg = 0, min = 0, sec = 0] = arr;
  let dec = deg + min / 60 + sec / 3600;
  if (ref && (ref === "S" || ref === "W")) dec = -dec;
  return dec;
}

function getLatLon(meta) {
  if (meta.latitude && meta.longitude)
    return { lat: meta.latitude, lon: meta.longitude };
  if (meta.GPSLatitude && meta.GPSLongitude) {
    const latRef = meta.GPSLatitudeRef || meta.GPSLatRef;
    const lonRef = meta.GPSLongitudeRef || meta.GPSLonRef;
    return {
      lat: gpsArrayToDecimal(meta.GPSLatitude, latRef),
      lon: gpsArrayToDecimal(meta.GPSLongitude, lonRef),
    };
  }
  return null;
}

function formatMetadata(meta) {
  if (!meta || Object.keys(meta).length === 0) return null;
  const small = {};

  for (const [k, v] of Object.entries(meta)) {
    if (
      k === "34965" ||
      k === "39594" ||
      k.toLowerCase().includes("thumbnail") ||
      k === "JFIFThumbnail" ||
      k === "XMP"
    ) {
      continue;
    }

    if (k === "39321") {
      try {
        small[k] = JSON.parse(typeof v === "string" ? v : String(v));
      } catch {
        small[k] = v;
      }
      continue;
    }

    small[k] = v;
  }

  return JSON.stringify(small, null, 2);
}

// Bot Commands
bot.start((ctx) => {
  ctx.replyWithMarkdown(`
  👋 မင်္ဂလာပါ *${ctx.from?.first_name}*

  📸 *ဓာတ်ပုံ Metadata Viewer and Cleaner Bot* မှကြိုဆိုပါတယ်။

  ℹ️ အသုံးပြုပုံ:
  1. ဓာတ်ပုံကို *Send as File* (document) နဲ့ ပေးပို့ပါ
  2. Metadata ကို စစ်ဆေးပေးမယ်
  3. Metadata ရှိရင် ဖယ်ရှားထားတဲ့ ဓာတ်ပုံ ပြန်ပေးမယ်
  `);
});

bot.help((ctx) => {
  ctx.replyWithMarkdown(`
  📖 *အသုံးပြုပုံ*
  • ဓာတ်ပုံ (JPEG/PNG) ကို *Send as File* (document) နဲ့ပေးပို့ပါ
  • Metadata ရှိရင် ဖော်ပြပေးမယ်
  • Metadata ရှိမှသာ ဖယ်ရှားထားတဲ့ ဓာတ်ပုံ ပြန်ပေးမယ်
  `);
});

// Handle photo/document
bot.on(["photo", "document"], async (ctx) => {
  try {
    const msg = ctx.message;
    let fileId = null;

    if (msg.photo) {
      await ctx.reply(
        "⚠️ Telegram က photo အနေနဲ့ ပို့တဲ့ ဓာတ်ပုံတွေမှာ metadata မရှိနိုင်ပါ။ 'Send as File' (document) နဲ့ ပို့ပါ။"
      );
      fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document?.mime_type?.startsWith("image/")) {
      fileId = msg.document.file_id;
    } else {
      return ctx.reply("📂 JPEG/PNG ဓာတ်ပုံကိုသာ ပေးပို့နိုင်ပါတယ်။");
    }

    const statusMsg = await ctx.reply(
      "🔎 ဓာတ်ပုံကို ဒေါင်းလုဒ်ဆွဲနေပြီး metadata စစ်ဆေးနေပါတယ်..."
    );

    const buffer = await fetchFileBuffer(ctx, fileId);

    let metadata = null;
    try {
      metadata = await exifr.parse(buffer, {
        translateValues: true,
        tiff: true,
        ifd0: true,
        exif: true,
        gps: true,
        iptc: true,
        xmp: true,
      });
    } catch (err) {
      logger.warn(`exifr parse failed: ${err?.message || err}`);
      metadata = null;
    }

    const metaText = formatMetadata(metadata);
    if (!metaText) {
      await ctx.deleteMessage(statusMsg.message_id);
      return ctx.reply("ℹ️ ဓာတ်ပုံထဲမှာ metadata မတွေ့ပါ။");
    }

    const gps = getLatLon(metadata);
    if (gps) {
      await ctx.replyWithMarkdown(
        `📍 *တည်နေရာ:* ${gps.lat}, ${gps.lon}\nhttps://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lon}`
      );
    }

    let baseName = msg.document?.file_name
      ? path.parse(msg.document.file_name).name
      : "photo";
    baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, "_");

    const metaFilename = `${baseName}-metadata-${Date.now()}.txt`;
    writeFileSync(metaFilename, metaText);
    await ctx.replyWithDocument({ source: metaFilename, filename: metaFilename });
    unlinkSync(metaFilename);

    const clearedBuffer = await sharp(buffer).rotate().toBuffer();
    await ctx.replyWithPhoto(
      { source: clearedBuffer },
      { caption: "🧹 Metadata ဖယ်ရှားပြီး ဓာတ်ပုံကို ပြန်ပေးထားပါတယ်။" }
    );

    await ctx.deleteMessage(statusMsg.message_id);
  } catch (error) {
    logger.error(`Processing error: ${error.message}`);
    await ctx.reply("⚠️ ဓာတ်ပုံကို စစ်ဆေးရာမှာ အမှားဖြစ်သွားပါတယ်။ JPEG/PNG ပုံနဲ့ စမ်းကြည့်ပါ။");
  }
});

bot.on("message", (ctx) => {
  ctx.reply("📷 JPEG/PNG ဓာတ်ပုံကို *Send as File* (document) နဲ့ပေးပို့ပါ။");
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