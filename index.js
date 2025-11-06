// bot.js
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";
import logger from "./logger.js"; // keep your logger

// ---------- Required env ----------
const {
  BOT_TOKEN,
  WEBHOOK_URL,
  PORT = 3000,
  ADMIN_IDS = "", // comma separated Telegram numeric IDs of admins
  DRIVE_FOLDER_NAME = "TestEcommTickets",
  GOOGLE_APPLICATION_CREDENTIALS, // path to service account JSON or unset (see notes)
} = process.env;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL in .env");
  process.exit(1);
}
if (!GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS in .env (path to service account JSON)");
  process.exit(1);
}

const adminIds = ADMIN_IDS.split(",").map((s) => s.trim()).filter(Boolean).map(Number);

// ---------- Google Drive setup ----------
const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_APPLICATION_CREDENTIALS,
  scopes: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ],
});
const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });  // New: Sheets client

// Helper: find or create root folder for tickets
async function ensureDriveFolder(folderName = DRIVE_FOLDER_NAME) {
  // find folder
  const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace("'", "\\'")}' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id, name)" });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;

  // create
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });
  return createRes.data.id;
}

// Helper: retrieve products from sheet
async function getItemsFromSheet(sheetId, range = "Sheet1!A:G") {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range,  // e.g., "Sheet1!A1:E" for first sheet, all rows
  });
  
  try {
    
    const rows = response.data.values || [];
    if (rows.length === 0) {
      logger.warn("No data in products sheet");
      return [];
    }

    // Assume row 0 is headers; map rest to objects
    const headers = rows[0];  // e.g., ['ID', 'Name', 'Price', ...]
    
    return rows.slice(1).map(row => {
      return headers.reduce((obj, header, i) => {
        obj[header.toLowerCase().replace(/\s+/g, '')] = row[i] || '';  // e.g., 'id': '1', 'name': 'Widget A'
        return obj;
      }, {});
    }).filter(product => product.id);  // Skip invalid rows
  } catch (err) {
    logger.error(`Error fetching products: ${err.message}`);
    return [];
  }
}

// Save a ticket (JSON file) inside Drive folder
async function saveTicketToDrive(folderId, ticket) {
  const fileName = `ticket_${ticket.userId}_${ticket.timestamp}.json`;
  const tmpPath = path.join(process.cwd(), fileName);
  fs.writeFileSync(tmpPath, JSON.stringify(ticket, null, 2), "utf8");

  const media = { mimeType: "application/json", body: fs.createReadStream(tmpPath) };
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: "application/json",
    },
    media,
    fields: "id, name",
  });

  fs.unlinkSync(tmpPath);
  return res.data;
}

// Upload an attachment (photo, document, voice) to Drive and return file metadata
async function uploadAttachmentToDrive(folderId, filename, buffer, mimeType) {
  // write to temp file
  const tmpPath = path.join(process.cwd(), `upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, buffer);

  const media = { mimeType: mimeType || "application/octet-stream", body: fs.createReadStream(tmpPath) };
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media,
    fields: "id, name, mimeType, webViewLink",
  });

  fs.unlinkSync(tmpPath);
  return res.data;
}

// List tickets (list files in folder)
async function listTickets(folderId, pageSize = 50) {
  const q = `'${folderId}' in parents and trashed=false and name contains 'ticket_'`;
  const res = await drive.files.list({ q, pageSize, fields: "files(id, name, createdTime)" });
  return res.data.files || [];
}

// Get ticket content (download JSON)
async function getTicketContent(fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  return new Promise((resolve, reject) => {
    let data = "";
    res.data.on("data", (chunk) => (data += chunk.toString("utf8")));
    res.data.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    res.data.on("error", reject);
  });
}

// Append a reply to the ticket by creating a small replies JSON file inside folder
async function saveReplyToDrive(folderId, ticketFileId, reply) {
  const fileName = `reply_${ticketFileId}_${Date.now()}.json`;
  const tmpPath = path.join(process.cwd(), fileName);
  fs.writeFileSync(tmpPath, JSON.stringify(reply, null, 2), "utf8");

  const media = { mimeType: "application/json", body: fs.createReadStream(tmpPath) };
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: "application/json" },
    media,
    fields: "id, name",
  });

  fs.unlinkSync(tmpPath);
  return res.data;
}

// ---------- Bot setup ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Simple in-memory map for pending admin replies: adminId -> ticketFileId
// (works across single process run; not persistent)
const pendingReplies = new Map();
const userStates = new Map();

// Middleware logging
bot.use(async (ctx, next) => {
  const user = ctx.from ? `${ctx.from.first_name || ""} ${ctx.from.last_name || ""} (${ctx.from.username || "no-username"} | ${ctx.from.id})` : "unknown";
  const type = ctx.updateType;
  const msg = ctx.message?.text || ctx.callbackQuery?.data || "[non-text]";
  logger.info(`${type} | From: ${user} | Message: ${msg}`);
  return next();
});

// Error handling
bot.catch((err, ctx) => {
  logger.error(`Bot error on ${ctx.updateType}: ${err?.message}`);
});

// Util: isAdmin
function isAdmin(ctx) {
  const id = ctx.from?.id;
  return id && adminIds.includes(id);
}

// Start (customer-facing)
bot.start(async (ctx) => {
  const user_first_name = ctx.from?.first_name;
  const user_last_name = ctx.from?.last_name;
  const username = user_first_name && user_last_name ? user_first_name + ' ' + user_last_name : !user_last_name ? user_first_name : !user_first_name ? ctx.from?.username : 'Customer';
  const bot_first_name = ctx.botInfo?.first_name;
  const bot_last_name = ctx.botInfo?.last_name;
  const bot = bot_first_name && bot_last_name ? bot_first_name + ' ' + bot_last_name : !bot_last_name ? bot_first_name : !bot_first_name ? ctx.botInfo?.username : 'Customer Service Bot'
  await ctx.replyWithMarkdown(
    `👋 မင်္ဂလာပါ ${username || "Customer"}!\n` +
      `Welcome from ${bot}. What do you prefer from us?.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🧪 Buy Goods", callback_data: "buy" },
              { text: "🔹 Help", callback_data: "help" },
            ],
          ],
        },
      }
  );
});

// Help
bot.help((ctx) => {
  if (isAdmin(ctx)) {
    ctx.reply(
      "Admin commands:\n" +
        "/list - list recent tickets\n" +
        "/reply <ticket_file_id> - start responding to a ticket\n" +
        "/cancel - cancel current pending reply\n"
    );
  } else {
    ctx.replyWithMarkdown(
      `📖 *အသုံးပြုပုံ*\n• အောက်က ခလုတ်တွေထဲက တစ်ခုကို ရွေးပါ:\n  - 🧪 Buy Goods: ပစ္စည်းဝယ်ယူမည် \n  - 🔹 Help: အကူအညီ ရယူမည်`
    );
  }
});

// When user sends a message (customer)
bot.on("message", async (ctx) => {
  try {
    // Build ticket object
    const user = ctx.from || {};
    const timestamp = Date.now();
    const ticket = {
      userId: user.id,
      username: user.username || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      chatId: ctx.chat?.id || ctx.from?.id,
      text: ctx.message?.text || null,
      createdAt: new Date(timestamp).toISOString(),
      type: ctx.updateSubTypes?.join(",") || ctx.updateSubTypes || ctx.updateType,
      attachments: [],
    };

    // Ensure drive folder exists
    const folderId = await ensureDriveFolder();

    // If there are photos/documents/voice — download via Telegram API and upload to Drive
    // Note: Telegraf provides ctx.telegram.getFileLink(fileId) to download
    // We'll download the file buffer via fetch from that URL.
    // Use node-fetch or native https; to avoid extra deps, use node built-in https.
    async function downloadFileToBuffer(fileId) {
      const link = await ctx.telegram.getFileLink(fileId); // returns a URL
      // Use global fetch to download the file and return a Buffer
      const res = await fetch(link.href);
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // To avoid adding dependencies, we'll fetch files using node's global fetch (Node 18+).
    if (ctx.message?.photo) {
      // photo is an array - choose highest resolution
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      const link = await ctx.telegram.getFileLink(ph.file_id);
      const r = await fetch(link.href);
      const buffer = await r.arrayBuffer();
      const meta = await uploadAttachmentToDrive(folderId, `photo_${user.id}_${timestamp}.jpg`, Buffer.from(buffer), ph.mime_type || "image/jpeg");
      ticket.attachments.push({ type: "photo", driveFile: meta });
    }
    if (ctx.message?.document) {
      const doc = ctx.message.document;
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const r = await fetch(link.href);
      const buffer = await r.arrayBuffer();
      const meta = await uploadAttachmentToDrive(folderId, doc.file_name || `doc_${user.id}_${timestamp}`, Buffer.from(buffer), doc.mime_type);
      ticket.attachments.push({ type: "document", driveFile: meta });
    }
    if (ctx.message?.voice) {
      const v = ctx.message.voice;
      const link = await ctx.telegram.getFileLink(v.file_id);
      const r = await fetch(link.href);
      const buffer = await r.arrayBuffer();
      const meta = await uploadAttachmentToDrive(folderId, `voice_${user.id}_${timestamp}.oga`, Buffer.from(buffer), v.mime_type || "audio/ogg");
      ticket.attachments.push({ type: "voice", driveFile: meta });
    }
    // other types like video/photo etc. could be added similarly

    // Save ticket JSON to Drive
    const saved = await saveTicketToDrive(folderId, ticket);

    // Notify customer
    await ctx.reply("✅ Your message has been received. Support will contact you soon.\nRef: " + saved.id);

    // Notify admin(s)
    const adminMessage = `📩 New ticket from @${ticket.username || ticket.firstName || ticket.userId}\nTicket file id: ${saved.id}\nMessage: ${ticket.text ?? "[no text]"}\nCreated: ${ticket.createdAt}`;
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback("View ticket", `view_${saved.id}`),
      Markup.button.callback("Reply to customer", `reply_${saved.id}`),
    ]);
    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(aid, adminMessage, keyboard);
      } catch (err) {
        logger.error(`Failed notifying admin ${aid}: ${err.message}`);
      }
    }
  } catch (error) {
    logger.error("Error processing customer message: " + (error?.message || error));
    await ctx.reply("⚠️ An error occurred processing your message. Please try again later.");
  }
});

// Admin: list tickets
bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Unauthorized");
  try {
    const folderId = await ensureDriveFolder();
    const files = await listTickets(folderId, 50);
    if (!files.length) return ctx.reply("No tickets found.");
    // Show top 10
    const buttons = files.slice(0, 10).map((f) => [Markup.button.callback(`${f.name}`, `view_${f.id}`)]);
    await ctx.reply("Recent tickets:", Markup.inlineKeyboard(buttons));
  } catch (err) {
    logger.error("List error: " + err.message);
    ctx.reply("Error listing tickets.");
  }
});

// Admin: /reply <fileId> command (start reply flow)
bot.command("reply", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Unauthorized");
  const parts = ctx.message.text.trim().split(/\s+/);
  const fileId = parts[1];
  if (!fileId) return ctx.reply("Usage: /reply <ticket_file_id>");
  pendingReplies.set(ctx.from.id, fileId);
  ctx.reply(`Replying to ticket ${fileId}. Send the message you want to forward to the customer. Send /cancel to stop.`);
});

// Admin: cancel pending
bot.command("cancel", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Unauthorized");
  pendingReplies.delete(ctx.from.id);
  ctx.reply("Pending reply canceled.");
});

// Admin: when admin sends a message and has a pending reply -> forward to customer
bot.on("message", async (ctx) => {
  try {
    if (!isAdmin(ctx)) return; // only intercept admin messages here
    const pending = pendingReplies.get(ctx.from.id);
    if (!pending) return; // nothing to do

    // Retrieve ticket to get chatId (customer)
    const ticket = await getTicketContent(pending);
    const customerChatId = ticket.chatId;
    if (!customerChatId) {
      await ctx.reply("Could not find customer chat id in ticket.");
      pendingReplies.delete(ctx.from.id);
      return;
    }

    // forward admin message text or attachments to customer
    // If admin sent text, send text. Otherwise, handle photo/document/voice similarly.
    if (ctx.message.text) {
      await bot.telegram.sendMessage(customerChatId, `💬 Support: ${ctx.message.text}`);
    } else if (ctx.message.photo) {
      // send the largest photo file_id
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      await bot.telegram.sendPhoto(customerChatId, { source: await ctx.telegram.getFileLink(ph.file_id) });
    } else if (ctx.message.document) {
      const doc = ctx.message.document;
      await bot.telegram.sendDocument(customerChatId, { source: await ctx.telegram.getFileLink(doc.file_id) });
    } else {
      // fallback: send a short notification
      await bot.telegram.sendMessage(customerChatId, `💬 Support sent an update. Please check.`);
    }

    // Save reply to Drive
    const folderId = await ensureDriveFolder();
    const reply = {
      fromAdminId: ctx.from.id,
      fromAdminUsername: ctx.from.username,
      sentAt: new Date().toISOString(),
      content: ctx.message.text ?? "[non-text]",
    };
    await saveReplyToDrive(folderId, pending, reply);

    // Confirm to admin and clear pending
    await ctx.reply(`Reply sent to customer (ticket ${pending}).`);
    pendingReplies.delete(ctx.from.id);
  } catch (err) {
    logger.error("Error sending admin reply: " + err.message);
    ctx.reply("Error sending reply.");
  }
});

// Inline buttons handling (admins)
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    let userId;
    let state;

    switch (data) {
      case "buy":
        userId = ctx.from.id;
        state = userStates.get(userId);
        const perPage = 5;  // Configurable

        if (!state || !state.products) {
          state = { products: await getItemsFromSheet(process.env.SHEETS_ID, 'Products!A:G'), page: 0, perPage };
          const imageMap = new Map(images.map(img => [img.product, img.img_url]));
          products.forEach(p => p.img_url = imageMap.get(p.id) || '');
          userStates.set(userId, state);
        }

        if (state.products.length === 0) {
          await ctx.reply("No products available right now. Try later!");
          await ctx.answerCbQuery();
          break;
        }

        // Render current page
        await renderProductPage(ctx, state, perPage);
        await ctx.answerCbQuery("Browsing products!");
        break;

      case data.startsWith("next_page_"):
        userId = ctx.from.id;
        state = userStates.get(userId);
        if (state) {
          state.page = Math.min(state.page + 1, Math.floor(state.products.length / state.perPage));
          await renderProductPage(ctx, state, state.perPage);
        }
        await ctx.answerCbQuery();
        break;

      case data.startsWith("prev_page_"):
        // Similar to next, but state.page = Math.max(state.page - 1, 0)
        // Then renderProductPage
        await ctx.answerCbQuery();
        break;

      // Add new helper function (outside switch)
      async function renderProductPage(ctx, state, perPage) {
        const start = state.page * perPage;
        const pageItems = state.products.slice(start, start + perPage);
        const totalPages = Math.ceil(state.products.length / perPage);

        let message = `🛒 *Products (Page ${state.page + 1}/${totalPages})*\n\n`;
        const itemButtons = [];
        const navButtons = [];

        console.log(pageItems);

        for (const item of pageItems) {
          message += `• *${item.name}*\n  💰 $${item.price}\n  📝 ${item.description}\n\n`;
          itemButtons.push([{ text: item.name, callback_data: `select_${item.id}` }]);
        }

        // Nav: Add Prev if not first, Next if not last
        if (state.page > 0) navButtons.push({ text: "⬅️ Prev", callback_data: "prev_page_" });
        if (state.page < totalPages - 1) navButtons.push({ text: "➡️ Next", callback_data: "next_page_" });

        const keyboard = [...itemButtons, navButtons].filter(row => row.length > 0);  // Flatten if needed
        await ctx.reply(message, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
      }

      // In select case (add after buy):
      if (data.startsWith("select_")) {
        const itemId = data.slice("select_".length);
        const state = userStates.get(ctx.from.id);
        const item = state?.products.find(p => p.id == itemId);
        if (item) {
          await ctx.reply(`Selected: *${item.name}* ($${item.price})\n${item.description}\n\nWhat next? Add to cart?`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🛒 Buy Now", callback_data: `buy_now_${itemId}` }]] }
          });
        }
        await ctx.answerCbQuery();
      }
    }

    // // view_<fileId>, reply_<fileId>
    // if (data.startsWith("view_")) {
    //   if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    //   const fileId = data.slice("view_".length);
    //   const ticket = await getTicketContent(fileId);
    //   let msg = `📄 Ticket ${fileId}\nFrom: @${ticket.username ?? ticket.firstName ?? ticket.userId}\nCreated: ${ticket.createdAt}\nMessage: ${ticket.text ?? "[no text]"}`;
    //   if (ticket.attachments?.length) {
    //     msg += `\nAttachments: ${ticket.attachments.map((a) => a.driveFile?.webViewLink ?? a.driveFile?.name).join(", ")}`;
    //   }
    //   await ctx.reply(msg);
    //   await ctx.answerCbQuery();
    // } else if (data.startsWith("reply_")) {
    //   if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    //   const fileId = data.slice("reply_".length);
    //   pendingReplies.set(ctx.from.id, fileId);
    //   await ctx.reply(`Replying to ticket ${fileId}. Send your reply message now. Send /cancel to abort.`);
    //   await ctx.answerCbQuery();
    // } else {
    //   await ctx.answerCbQuery();
    // }
  } catch (err) {
    logger.error("Callback handling error: " + err.message);
    await ctx.answerCbQuery("Error handling action.");
  }
});

// ---------- Express webhook wiring ----------
app.use(express.json());
app.use(bot.webhookCallback("/webhook"));

bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`).then(() => {
  console.log("Webhook set:", `${WEBHOOK_URL}/webhook`);
  logger.info("Webhook registered.");
}).catch((err) => {
  logger.error("Failed to set webhook: " + (err?.message || err));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  logger.info(`🚀 Webhook server started on port ${PORT}`);
});
