/**
 * bridge/security.js — Telegram chat allowlist + per-session PIN gate.
 *
 * Threat model:
 *   - The bot token is on the open internet; anyone who finds it can DM the bot.
 *   - First defense: silently drop anyone not in ALLOWED_CHAT_IDS (no response →
 *     no oracle for brute force, no fingerprint).
 *   - Second defense: even authorized chat IDs must enter SESSION_PIN once per
 *     session before any agent traffic is allowed. PIN mismatch returns a flat
 *     "Access denied." with no retry counter — keeps brute force expensive without
 *     us needing to track lockout state.
 *
 * Session state lives in the `sessions` table so PIN-verified state survives a
 * bridge restart. Cleared on demand via clearSession().
 */
'use strict';

require('dotenv').config();
const { getDb } = require('../memory/db');

// Parse comma-separated allowlist into a Set for O(1) lookup. Trim each entry
// to forgive trailing spaces in .env files.
const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const SESSION_PIN = (process.env.SESSION_PIN || '').trim();

// Sanity check at boot — fail loud rather than silently allow everyone.
if (ALLOWED_CHAT_IDS.size === 0) {
  console.warn('[security] WARNING: ALLOWED_CHAT_IDS is empty — all messages will be dropped.');
}
if (!SESSION_PIN) {
  console.warn('[security] WARNING: SESSION_PIN is not set — no session can ever verify.');
}

/**
 * Is this chat ID on the allowlist? Unauthorized IDs should be silently dropped
 * by the caller — do NOT respond, since any response confirms the bot exists.
 */
function isAllowed(chatId) {
  return ALLOWED_CHAT_IDS.has(String(chatId));
}

/**
 * Get-or-create a session row for this chat. Updates last_active on every call
 * so we can reason about idle sessions later (e.g. auto-lock after N hours).
 */
function getOrCreateSession(chatId) {
  const db = getDb();
  const id = String(chatId);
  let row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(id);
  if (!row) {
    db.prepare('INSERT INTO sessions (chat_id) VALUES (?)').run(id);
    row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(id);
  } else {
    db.prepare('UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE chat_id = ?').run(id);
  }
  return row;
}

function isPinVerified(chatId) {
  const row = getOrCreateSession(chatId);
  return row.pin_verified === 1;
}

/**
 * Compare the candidate PIN against SESSION_PIN. Returns true on match and
 * marks the session verified. No retry counter by design — we don't want to
 * give brute-forcers any signal about progress.
 */
function verifyPin(chatId, candidate) {
  if (!SESSION_PIN) return false;
  const ok = String(candidate).trim() === SESSION_PIN;
  if (ok) {
    getDb()
      .prepare('UPDATE sessions SET pin_verified = 1, last_active = CURRENT_TIMESTAMP WHERE chat_id = ?')
      .run(String(chatId));
  }
  return ok;
}

/**
 * Reset session to unverified (useful for /logout commands or manual revoke).
 */
function clearSession(chatId) {
  getDb()
    .prepare('UPDATE sessions SET pin_verified = 0 WHERE chat_id = ?')
    .run(String(chatId));
}

/**
 * Top-level guard called by the bridge for every inbound Telegram message.
 * Returns one of:
 *   { action: 'drop' }                 — unauthorized chat ID, send nothing
 *   { action: 'pin_required' }         — authorized but unverified; prompt for PIN
 *   { action: 'pin_correct' }          — they just unlocked; reply with welcome
 *   { action: 'pin_incorrect' }        — wrong PIN; reply "Access denied."
 *   { action: 'pass' }                 — verified; forward to queue
 */
function evaluate(chatId, messageText) {
  if (!isAllowed(chatId)) return { action: 'drop' };

  if (isPinVerified(chatId)) return { action: 'pass' };

  // Unverified: treat the message body as a PIN attempt.
  // First-ever message from this chat ID gets a pin_required prompt instead of
  // a denial, so the user knows what to do. The session row is created by
  // isPinVerified() above so the `started_at` timestamp marks first contact.
  const session = getOrCreateSession(chatId);
  const isFirstMessage =
    new Date() - new Date(session.started_at) < 2000; // within 2s of session row creation
  if (isFirstMessage && !messageText) {
    return { action: 'pin_required' };
  }

  if (verifyPin(chatId, messageText)) return { action: 'pin_correct' };
  // If the message looks like normal text (not a PIN), still prompt rather than
  // confusingly say "Access denied." — but if it looks like an attempted PIN
  // (short numeric), deny. Heuristic: ≤8 chars and digits-only.
  const looksLikePin = /^\d{1,8}$/.test(String(messageText).trim());
  return { action: looksLikePin ? 'pin_incorrect' : 'pin_required' };
}

module.exports = {
  isAllowed,
  isPinVerified,
  verifyPin,
  clearSession,
  evaluate,
  ALLOWED_CHAT_IDS,
};
