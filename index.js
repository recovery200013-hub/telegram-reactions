// ═══════════════════════════════════════════════════════════════
//  TELEGRAM SMM BOT — Multi-Panel + DB + Buttons
// ═══════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Database = require('better-sqlite3');

process.on('unhandledRejection', (e) => console.error('❌ Unhandled:', e?.message || e));
process.on('uncaughtException',  (e) => console.error('❌ Uncaught:',  e?.message || e));
const _origLog = console.log;
console.log = (...a) => _origLog(...a.map(x => (x && typeof x === 'object' && x.message) ? x.message : x));

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const DB_PATH   = process.env.DB_PATH || './bot.db';

// Multiple SMM panels with fallback (order matters — Panel 1 tried first)
const PANELS = [
  {
    name:    'VeerSMM',
    url:     process.env.API_URL_1 || 'https://veersmm.site/api/v2',
    key:     process.env.API_KEY_1 || process.env.API_KEY || '',
    service: process.env.SERVICE_ID_1 || '2300',
  },
  {
    name:    'Panel2',
    url:     process.env.API_URL_2 || '',
    key:     process.env.API_KEY_2 || '',
    service: process.env.SERVICE_ID_2 || '',
  },
].filter(p => p.url && p.key && p.service);

const DEFAULT_QTY = 10;

if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN');
  process.exit(1);
}
if (!PANELS.length) {
  console.error('❌ No SMM panel configured (API_URL_1 + API_KEY_1 required)');
  process.exit(1);
}

const isAdmin        = (id) => ADMIN_IDS.includes(id);
const cleanServiceId = (id) => String(id || '').replace(/^#/, '').trim();

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
    panel TEXT,
    status TEXT,
    created_at INTEGER
  );
`);

const q = {
  getState:      db.prepare('SELECT value FROM state WHERE key = ?'),
  setState:      db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  isDup:         db.prepare('SELECT 1 FROM processed WHERE message_id = ?'),
  markDup:       db.prepare('INSERT OR IGNORE INTO processed (message_id, processed_at) VALUES (?, ?)'),
  addChannel:    db.prepare('INSERT INTO channels (username, chat_id, title, added_by, added_at, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(username) DO UPDATE SET active = 1, title = excluded.title'),
  removeChannel: db.prepare('UPDATE channels SET active = 0 WHERE username = ?'),
  listChannels:  db.prepare('SELECT * FROM channels WHERE active = 1 ORDER BY added_at DESC'),
  getChannel:    db.prepare('SELECT * FROM channels WHERE username = ? AND active = 1'),
  insertOrder:   db.prepare('INSERT INTO orders (message_id, order_id, panel, status, created_at) VALUES (?, ?, ?, ?, ?)'),
  statsTotal:    db.prepare('SELECT COUNT(*) c FROM orders'),
  statsOk:       db.prepare("SELECT COUNT(*) c FROM orders WHERE status='ok'"),
  statsFail:     db.prepare("SELECT COUNT(*) c FROM orders WHERE status='fail'"),
};

const getState     = (k) => q.getState.get(k)?.value;
const setState     = (k, v) => q.setState.run(k, String(v));
const getQty       = () => Number(getState('quantity') || DEFAULT_QTY);
const getServiceId = () => cleanServiceId(getState('service_id') || PANELS[0].service);

const addChannel    = (u, id, t, by) => q.addChannel.run(u.replace(/^@/,'').toLowerCase(), id, t, by, Date.now());
const removeChannel = (u) => q.removeChannel.run(u.replace(/^@/,'').toLowerCase());
const listChannels  = () => q.listChannels.all();
const getChannel    = (u) => q.getChannel.get(u.replace(/^@/,'').toLowerCase());

// ─────────────────────────────────────────────────────────────
//  BOT INIT + HELPERS
// ─────────────────────────────────────────────────────────────
const bot   = new TelegramBot(BOT_TOKEN, { polling: true });
const log   = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ─────────────────────────────────────────────────────────────
//  ORDER PLACEMENT WITH FALLBACK
// ─────────────────────────────────────────────────────────────
async function placeOrderWithFallback(link, quantity, serviceOverride) {
  const errors = [];

  for (const panel of PANELS) {
    try {
      const serviceId = serviceOverride || cleanServiceId(panel.service);
      log(`🔄 Trying ${panel.name} (service ${serviceId})...`);

      const { data } = await axios.post(panel.url, {
        key: panel.key,
        action: 'add',
        service: serviceId,
        link,
        quantity,
      }, { timeout: 15000 });

      if (data?.error) throw new Error(data.error);
      if (!data?.order) throw new Error('No order ID returned');

      return { ok: true, panel: panel.name, orderId: data.order };
    } catch (err) {
      log(`⚠️ ${panel.name} failed: ${err.message}`);
      errors.push(`${panel.name}: ${err.message}`);
    }
  }

  return { ok: false, errors };
}

// ─────────────────────────────────────────────────────────────
//  INLINE KEYBOARD + MENU TEXT
// ─────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📊 Stats',     callback_data: 'stats'    }, { text: '💰 Balance',  callback_data: 'balance' }],
      [{ text: '📡 Channels',  callback_data: 'channels' }, { text: '🔢 Quantity', callback_data: 'qty'     }],
      [{ text: '⚙️ Service',   callback_data: 'service'  }, { text: '🔌 Panels',   callback_data: 'panels'  }],
      [{ text: '➕ Add Channel', callback_data: 'add_help' }, { text: '➖ Remove',   callback_data: 'remove_help' }],
      [{ text: '🔄 Refresh',   callback_data: 'refresh'  }],
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
    `🔢 Quantity: *${getQty()}*\n` +
    `⚙️ Service: *${getServiceId()}*\n` +
    `🔌 Panels: *${PANELS.length}*\n\n` +
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
//  CALLBACK QUERY HANDLER
// ─────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  if (!isAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Not admin', show_alert: true });
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
  const back = { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'refresh' }]] };

  try {
    switch (query.data) {
      case 'stats': {
        const total = q.statsTotal.get().c;
        const ok    = q.statsOk.get().c;
        const fail  = q.statsFail.get().c;
        return bot.editMessageText(
          `📊 *Stats*\n\nTotal: *${total}*\n✅ OK: *${ok}*\n❌ Fail: *${fail}*`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
      }

      case 'balance': {
        const lines = [];
        for (const p of PANELS) {
          try {
            const { data } = await axios.post(p.url, { key: p.key, action: 'balance' }, { timeout: 10000 });
            lines.push(`*${p.name}*: ${data.balance} ${data.currency || ''}`);
          } catch (e) {
            lines.push(`*${p.name}*: ❌ ${e.message}`);
          }
        }
        return bot.editMessageText(
          `💰 *Balances*\n\n${lines.join('\n')}`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
      }

      case 'channels': {
        const rows = listChannels();
        const text = rows.length
          ? `📡 *Active Channels*\n\n` + rows.map((c, i) => `${i + 1}. *${c.title || c.username}*\n   @${c.username}`).join('\n\n')
          : `📡 *Active Channels*\n\n_none_`;
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back,
        });
      }

      case 'qty': {
        return bot.editMessageText(
          `🔢 *Quantity*\n\n*${getQty()}*\n\nChange: \`/setqty 200\``,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
      }

      case 'service': {
        return bot.editMessageText(
          `⚙️ *Service ID*\n\nCurrent: *${getServiceId()}*\n\nChange: \`/setservice 2300\``,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
      }

      case 'panels': {
        const text = `🔌 *Configured Panels*\n\n` +
          PANELS.map((p, i) => `${i + 1}. *${p.name}* — service \`${cleanServiceId(p.service)}\``).join('\n');
        return bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back,
        });
      }

      case 'add_help': {
        return bot.editMessageText(
          `➕ *Add Channel*\n\n\`/addchannel @channelname\`\n\n⚠️ Bot admin hona chahiye.`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
      }

      case 'remove_help': {
        return bot.editMessageText(
          `➖ *Remove Channel*\n\n\`/removechannel @channelname\``,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: back }
        );
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

bot.onText(/^\/setservice\s+(\S+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const newId = cleanServiceId(match[1]);
  if (!newId) return bot.sendMessage(msg.chat.id, '❌ Invalid service ID');
  setState('service_id', newId);
  bot.sendMessage(msg.chat.id, `✅ Service ID set to *${newId}*`);
});

bot.onText(/^\/qty$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `🔢 Quantity: *${getQty()}*`);
});

bot.onText(/^\/service$/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `⚙️ Service ID: *${getServiceId()}*`);
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
      `✅ Added ${chat.title} (@${clean})\n\n⚠️ Make bot admin in that channel.`);
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
  const text = rows.map((c, i) => `${i + 1}. ${c.title || c.username} — @${c.username}`).join('\n');
  bot.sendMessage(msg.chat.id, `📡 Channels:\n${text}`);
});

// ─────────────────────────────────────────────────────────────
//  CHANNEL POST → SMM ORDER
// ─────────────────────────────────────────────────────────────
bot.on('channel_post', async (msg) => {
  try {
    const username = msg.chat.username?.toLowerCase();
    if (!username) return;
    if (!getChannel(username)) return;
    if (q.isDup.get(msg.message_id)) return;
    q.markDup.run(msg.message_id, Date.now());

    const link      = `https://t.me/${username}/${msg.message_id}`;
    const quantity  = getQty();
    const serviceId = getServiceId();

    log(`🚀 New post @${username}: ${link} (qty ${quantity}, svc ${serviceId})`);

    await sleep(1000 + Math.floor(Math.random() * 1000));

    const result = await placeOrderWithFallback(link, quantity, serviceId);

    if (result.ok) {
      log(`✅ Order placed on ${result.panel}: ${result.orderId}`);
      q.insertOrder.run(msg.message_id, String(result.orderId), result.panel, 'ok', Date.now());
    } else {
      log(`❌ All panels failed: ${result.errors.join(' | ')}`);
      q.insertOrder.run(msg.message_id, null, null, 'fail', Date.now());
      for (const id of ADMIN_IDS) {
        bot.sendMessage(id, `❌ Order failed for ${link}\n\n${result.errors.join('\n')}`).catch(() => {});
      }
    }
  } catch (err) {
    log('Handler error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
//  BACKGROUND TASKS
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    db.prepare(`
      DELETE FROM processed
      WHERE message_id NOT IN (
        SELECT message_id FROM processed ORDER BY processed_at DESC LIMIT 5000
      )
    `).run();
  } catch (e) { log('Cleanup:', e.message); }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
//  SHUTDOWN
// ─────────────────────────────────────────────────────────────
process.on('SIGINT',  () => { log('Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });

log(`🤖 Bot started — ${PANELS.length} panel(s), service ${getServiceId()}, qty ${getQty()}`);
