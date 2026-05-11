/**
 * bridge/index.js — Telegram ⇄ Agent SDK gateway.
 *
 * Flow per inbound message:
 *   1. Receive message via long-polling (TelegramBot in polling mode).
 *   2. security.evaluate() decides: drop, prompt for PIN, accept PIN, or pass.
 *   3. Verified messages enqueue a job that:
 *        a. Logs the user turn to conversation_log
 *        b. Hands the message to router.route() (Phase 3) to pick an agent
 *        c. Calls agentSdk.sendMessage() on that agent
 *        d. Logs the assistant turn to conversation_log
 *        e. Replies to Telegram with the agent's output
 *
 * Router and agent modules are loaded lazily (require inside the handler) so
 * Phase 2 boots cleanly before Phase 3 lands. Until the router exists, the
 * bridge falls back to echoing the message — enough to verify auth + queue.
 */
'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

const { initSchema, getDb } = require('../memory/db');
const security = require('./security');
const queue = require('./queue');
const agentSdk = require('./agentSdk');

// ---------------------------------------------------------------------------
// Boot: ensure schema exists, open file logger, instantiate Telegram bot.
// ---------------------------------------------------------------------------
initSchema();

const LOG_PATH = path.join(__dirname, '..', 'logs', 'bridge.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function log(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_PATH, line);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  log('FATAL', 'TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.on('polling_error', (err) => log('ERR', 'polling_error', err.code || '', err.message || err));

log('INFO', 'bridge booted; awaiting Telegram messages.');

// ---------------------------------------------------------------------------
// Conversation logging helpers — every turn gets persisted so the washing
// machine has raw input.
// ---------------------------------------------------------------------------
function logTurn(chatId, agent, role, content) {
  try {
    getDb()
      .prepare(
        'INSERT INTO conversation_log (chat_id, agent, role, content) VALUES (?, ?, ?, ?)'
      )
      .run(String(chatId), agent, role, content);
  } catch (e) {
    log('ERR', 'conversation_log insert failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Lazy router resolution. In Phase 2 the router file doesn't exist yet, so we
// fall back to a stub that echoes which agent *would* be picked based on the
// prefix. Phase 3 will drop in the real implementation transparently.
// ---------------------------------------------------------------------------
function getRouter() {
  try {
    return require('./router');
  } catch (e) {
    return {
      async route(message) {
        const prefixMatch = /^@(main|comms|ops|content|research)\b/i.exec(message);
        const agent = prefixMatch ? prefixMatch[1].toLowerCase() : 'main';
        return {
          agent,
          stripped: prefixMatch ? message.slice(prefixMatch[0].length).trim() : message,
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Lazy agent system-prompt resolution. Phase 3 will add agents/*.js. Until
// then we use a minimal placeholder so the bridge can round-trip end-to-end.
// ---------------------------------------------------------------------------
function getAgentSystemPrompt(agent) {
  try {
    const mod = require(`../agents/${agent}`);
    return mod.systemPrompt || mod.SYSTEM_PROMPT || null;
  } catch (e) {
    return `You are the ${agent} agent in Mikey Cabiles' AI-Led MarketingOS. (Phase 3 will replace this stub.)`;
  }
}

// ---------------------------------------------------------------------------
// Job handler — what actually runs per message after security passes.
// ---------------------------------------------------------------------------
async function processMessageJob(job) {
  const { chatId, text } = job.payload;
  const router = getRouter();
  const { agent, stripped } = await router.route(text);

  log('INFO', `routing chat=${chatId} → agent=${agent}`);
  logTurn(chatId, agent, 'user', stripped);

  let reply;
  try {
    const systemPrompt = getAgentSystemPrompt(agent);
    reply = await agentSdk.sendMessage(agent, stripped, { systemPrompt });
  } catch (err) {
    log('ERR', `agent ${agent} failed:`, err.message);
    reply = `⚠️ ${agent} agent error: ${err.message}`;
  }

  logTurn(chatId, agent, 'assistant', reply);
  await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' }).catch(async (e) => {
    // Markdown parse failures are common — retry plain.
    log('WARN', 'markdown send failed, retrying plain:', e.message);
    await bot.sendMessage(chatId, reply);
  });
  return reply;
}

// ---------------------------------------------------------------------------
// Telegram message dispatcher.
// ---------------------------------------------------------------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // 1) Authorize.
  const verdict = security.evaluate(chatId, text);

  if (verdict.action === 'drop') {
    log('INFO', `dropped unauthorized chat_id=${chatId}`);
    return;
  }

  if (verdict.action === 'pin_required') {
    return bot.sendMessage(
      chatId,
      '🔒 AI-Led MarketingOS\nEnter your session PIN to continue.'
    );
  }

  if (verdict.action === 'pin_incorrect') {
    log('WARN', `bad PIN attempt chat_id=${chatId}`);
    return bot.sendMessage(chatId, 'Access denied.');
  }

  if (verdict.action === 'pin_correct') {
    return bot.sendMessage(
      chatId,
      '✅ Session unlocked. Talk to me normally, or prefix with `@comms`, `@ops`, `@content`, or `@research` to target a specific agent.'
    );
  }

  // 2) Slash commands handled inline (no agent round-trip needed).
  if (text === '/logout') {
    security.clearSession(chatId);
    return bot.sendMessage(chatId, 'Session locked. Enter PIN to resume.');
  }
  if (text === '/queue') {
    return bot.sendMessage(
      chatId,
      `Queue depth: ${queue.depth()} | busy: ${queue.isBusy() ? 'yes' : 'no'}`
    );
  }
  if (text === '/start' || text === '/help') {
    return bot.sendMessage(
      chatId,
      [
        '*AI-Led MarketingOS*',
        '',
        'Prefix your message to target an agent:',
        '`@comms` — scripts, outreach, newsletter, YouTube',
        '`@ops`   — clients, finances, scheduling, logistics',
        '`@content` — social, ads, thumbnails, brand creative',
        '`@research` — competitor intel, deep dives',
        '`@main`  — default; routes for you',
        '',
        'Commands: /queue · /logout',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
  }

  // 3) Enqueue for processing.
  queue.enqueue({
    source: 'telegram',
    chatId: String(chatId),
    payload: { chatId, text },
    handler: processMessageJob,
  });
});

// Surface queue lifecycle into the log so we can audit serialization.
queue.on('enqueued', (e) => log('QUEUE', `enqueued ${e.id} (depth=${e.depth})`));
queue.on('started', (e) => log('QUEUE', `started ${e.id}`));
queue.on('completed', (e) => log('QUEUE', `completed ${e.id} (depth=${e.depth})`));
queue.on('errored', (e) => log('QUEUE', `errored ${e.id}: ${e.error}`));

// Graceful shutdown — let any in-flight job finish.
function shutdown(signal) {
  log('INFO', `received ${signal}, shutting down…`);
  bot.stopPolling().finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Expose internals for tests.
module.exports = { bot, queue, security };
