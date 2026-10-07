// ═══════════════════════════════════════════════════════════════
//  TELEGRAM SMM BOT — DB Backed + Inline Buttons
// ═══════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Database = require('better-sqlite3');
process.on('unhandledRejection', (e) => console.error('❌ Unhandled:', e?.message || e));
process.on('uncaughtException',  (e) => console.error('❌ Uncaught:',  e?.message || e));
const _origLog = console.log; console.log = (...a) => _origLog(...a.map(x => (x && typeof x === 'object' && x.message) ? x.message : x));

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY   = process.env.API_KEY;
const API_URL   = process.env.API_URL || 'https://veersmm.site/api/v2/';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const DB_PATH   = process.env.DB_PATH || './bot.db';

const SERVICE_ID  = 'P2';
const DEFAULT_QTY = 10;

if (!BOT_TOKEN || !API_KEY) {
  console.error('❌ Missing BOT_TOKEN or API_KEY');
  process.exit(1);
}

const isAdmin = (id) => ADMIN_IDS.includes(id);

// ─────────────────────────────────────────────────────────────
//  DB
// ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS processed (
    message_id INTEGER PRIMARY KEY,
    processed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS channels (
    username TEXT PRIMARY KEY,
    chat_id  INTEGER,
    title    TEXT,
    added_by INTEGER,
    added_at INTEGER,
    active   INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER,
    order_id TEXT,
    status TEXT,
    created_at INTEGER
  );
`); 

const q = {
  getState: db.prepare('SELECT value FROM state WHERE key = ?'),
  setState: db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  isDup:    db.prepare('SELECT 1 FROM processed WHERE message_id = ?'),
  markDup:  db.prepare('INSERT OR IGNORE INTO processed (message_id, processed_at) VALUES (?, ?)'),

  addChannel: db.prepare('INSERT INTO channels (username, chat_id, title, added_by, added_at, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(username) DO UPDATE SET active = 1, title = excluded.title'),
  removeChannel: db.prepare('UPDATE channels SET active = 0 WHERE username = ?'),
  listChannels: db.prepare('SELECT * FROM channels WHERE active = 1 ORDER BY added_at DESC'),
  getChannel: db.prepare('SELECT * FROM channels WHERE username = ? AND active = 1'),

  statsTotal: db.prepare('SELECT COUNT(*) c FROM orders').c ? null : null,
};

const getState   = (k) => q.getState.get(k)?.value;
const setState   = (k, v) => q.setState.run(k, String(v));
const getQty     = () => Number(getState('quantity') || DEFAULT_QTY);

const addChannel    = (u, id, t, by) => q.addChannel.run(u.replace(/^@/,'').toLowerCase(), id, t, by, Date.now());
const removeChannel = (u) => q.removeChannel.run(u.replace(/^@/,'').toLowerCase());
const listChannels  = () => q.listChannels.all();
const getChannel    = (u) => q.getChannel.get(u.replace(/^@/,'').toLowerCase());

// ─────────────────────────────────────────────────────────────
//  BOT
// ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  INLINE KEYBOARD
// ─────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📊 Stats', callback_data: 'stats' }, { text: '💰 Balance', callback_data: 'balance' }],
      [{ text: '📡 Channels', callback_data: 'channels' }, { text: '🔢 Quantity', callback_data: 'qty' }],
      [{ text: '➕ Add Channel', callback_data: 'add_help' }, { text: '➖ Remove Channel', callback_data: 'remove_help' }],
      [{ text: '🔄 Refresh', callback_data: 'refresh' }],
    ],
  },
  parse_mode: 'Markdown',
};

function menuText() {
  const chans = listChannels();
  const chanList = chans.length
    ? chans.map(c => `@${c.username}`).join(', ')
    : '_none_';
  return (
    `🤖 *SMM Bot*\n\n` +
    `📡 Channels: ${chanList}\n` +
    `🔢 Quantity: *${getQty()}*\n\n` +
    `Tap a button below 👇`
  );
}

// ─────────────────────────────────────────────────────────────
//  /start
// ─────────────────────────────────────────────────────────────
bot.onText(/^\/start$/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '❌ You are not an admin.');
  }
  bot.sendMessage(msg.chat.id, menuText(), mainMenu);
});

// ─────────────────────────────────────────────────────────────
//  CALLBACK QUERY HANDLER (button clicks)
// ─────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  if (!isAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Not admin', show_alert: true });
  }

  const action = query.data;
  bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    switch (action) {
      case 'stats': {
        const total = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
        const ok    = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='ok'").get().c;
        const fail  = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='fail'").get().c;
        const text  = `📊 *Stats*\n\nTotal: *${total}*\n✅ OK: *${ok}*\n❌ Fail: *${fail}*`;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
        });
      }

      case 'balance': {
        try {
          const { data } = await axios.post(API_URL, { key: API_KEY, action: 'balance' });
          const text = `💰 *Balance*\n\n${data.balance} ${data.currency || ''}`;
          return bot.editMessageText(text, {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
          });
        } catch (e) {
          return bot.editMessageText(`❌ Error: ${e.message}`, {
            chat_id: chatId, message_id: msgId,
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
          });
        }
      }

      case 'channels': {
        const rows = listChannels();
        const text = rows.length
          ? `📡 *Active Channels*\n\n` + rows.map((c, i) => `${i + 1}. *${c.title || c.username}*\n   @${c.username}`).join('\n\n')
          : `📡 *Active Channels*\n\n_no channels added_`;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
        });
      }

      case 'qty': {
        const text = `🔢 *Current Quantity*\n\n*${getQty()}*\n\nTo change:\n\`/setqty 200\``;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
        });
      }

      case 'add_help': {
        const text = `➕ *Add Channel*\n\nSend this command:\n\n\`/addchannel @channelname\`\n\n⚠️ Bot must be admin in that channel.`;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
        });
      }

      case 'remove_help': {
        const text = `➖ *Remove Channel*\n\nSend this command:\n\n\`/removechannel @channelname\``;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] },
        });
      }

      case 'refresh': {
        return bot.editMessageText(menuText(), {
          chat_id: chatId, message_id: msgId, ...mainMenu,
        });
      }
    }
  } catch (err) {
    log('Callback error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
//  TEXT COMMANDS
// ─────────────────────────────────────────────────────────────
bot.onText(/^\/setqty\s+(\d+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const qty = Number(match[1]);
  if (!qty || qty < 1) return bot.sendMessage(msg.chat.id, '❌ Invalid number');
  setState('quantity', qty);
  bot.sendMessage(msg.chat.id, `✅ Quantity set to *${qty}*`);
});

bot.onText(/^\/qty$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `🔢 Quantity: *${getQty()}*`);
});

bot.onText(/^\/addchannel(?:\s+@?(\S+))?/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const username = match[1];
  if (!username) return bot.sendMessage(msg.chat.id, 'Usage: `/addchannel @channelname`');

  const clean = username.replace(/^@/, '').toLowerCase();
  try {
    const chat = await bot.getChat(`@${clean}`);
    addChannel(clean, chat.id, chat.title, msg.from.id);
    bot.sendMessage(msg.chat.id,
  `✅ Added ${chat.title} (@${clean})\n\n⚠️ Make bot admin in that channel.`
);
    log(`Channel added: @${clean} by ${msg.from.id}`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Could not resolve @${clean}: ${e.message}`);
  }
});

bot.onText(/^\/removechannel(?:\s+@?(\S+))?/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const username = match[1];
  if (!username) return bot.sendMessage(msg.chat.id, 'Usage: `/removechannel @channelname`');
  removeChannel(username);
  bot.sendMessage(msg.chat.id, `🗑️ Removed @${username.replace(/^@/,'')}`);
});

bot.onText(/^\/channels$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const rows = listChannels();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'No channels added yet.');
  const text = rows.map((c, i) => `${i + 1}. *${c.title || c.username}* — @${c.username}`).join('\n');
  bot.sendMessage(msg.chat.id, `📡 *Channels:*\n${text}`);
});

// ─────────────────────────────────────────────────────────────
//  CHANNEL POST → SMM ORDER
// ─────────────────────────────────────────────────────────────
bot.on('channel_post', async (msg) => {
  try {
    const username = msg.chat.username?.toLowerCase();
    if (!username) return;

    // Only DB-registered channels
    if (!getChannel(username)) return;

    // Dedup
    if (q.isDup.get(msg.message_id)) return;
    q.markDup.run(msg.message_id, Date.now());

    const link = `https://t.me/${username}/${msg.message_id}`;
    const quantity = getQty();

    log(`🚀 New post @${username}: ${link} (qty ${quantity})`);

    // Random delay 1-2 sec
    await sleep(1000 + Math.floor(Math.random() * 1000));

    try {
      const { data } = await axios.post(API_URL, {
        key: API_KEY, action: 'add', service: SERVICE_ID, link, quantity
      });

      if (data?.error) {
        log(`❌ SMM error: ${data.error}`);
        for (const id of ADMIN_IDS) bot.sendMessage(id, `❌ Order failed: ${data.error}`).catch(() => {});
      } else {
        log(`✅ Order placed: ${data.order} for ${link}`);
        db.prepare('INSERT INTO orders (message_id, order_id, status, created_at) VALUES (?, ?, ?, ?)')
          .run(msg.message_id, String(data.order), 'ok', Date.now());
      }
    } catch (err) {
      log(`❌ Request failed: ${err.message}`);
      db.prepare('INSERT INTO orders (message_id, order_id, status, created_at) VALUES (?, ?, ?, ?)')
        .run(msg.message_id, null, 'fail', Date.now());
      for (const id of ADMIN_IDS) bot.sendMessage(id, `❌ Order failed: ${err.message}`).catch(() => {});
    }
  } catch (err) {
    log('Handler error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
//  SHUTDOWN
// ─────────────────────────────────────────────────────────────
process.on('SIGINT',  () => { log('Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });

log('🤖 Bot started — DB backed, buttons enabled');
