/**
 * memory/memoryManager.js — CRUD for the three-tier memory store.
 *
 * Tiers:
 *   pinned  — permanent. Never expires. Highest priority for context injection.
 *   insight — Gemini-inferred preferences / behavioral patterns. No expiry, but
 *             lower importance than pinned. Tracked separately so the user can
 *             audit them.
 *   general — short-term context. Expires after 14 days by default. Decays
 *             toward 0 importance if not accessed; deleted below 0.1.
 *
 * The washing machine writes here. The bridge / agents read from here at
 * session-spawn time to build the context block injected after the agent's
 * system prompt.
 */
'use strict';

const { getDb } = require('./db');

const VALID_TIERS = new Set(['pinned', 'insight', 'general']);
const DEFAULT_GENERAL_TTL_DAYS = 14;
const DECAY_THRESHOLD = 0.1; // below this, general memories are deleted

/**
 * Insert a new memory. agent='global' makes it visible to all agents.
 *   tier:       'pinned' | 'insight' | 'general'
 *   content:    one-sentence fact (the washing-machine prompt enforces this)
 *   importance: 0.0–1.0; higher = survives decay longer
 *   tags:       array of strings; stored as JSON
 *   ttlDays:    only used for tier='general'; overrides DEFAULT_GENERAL_TTL_DAYS
 */
function addMemory({
  agent = 'global',
  tier,
  content,
  source = 'system',
  importance = 0.5,
  tags = [],
  ttlDays,
} = {}) {
  if (!VALID_TIERS.has(tier)) throw new Error(`memoryManager: invalid tier "${tier}"`);
  if (!content || typeof content !== 'string') {
    throw new Error('memoryManager: content must be a non-empty string');
  }

  let expiresAt = null;
  if (tier === 'general') {
    const days = Number.isFinite(ttlDays) ? ttlDays : DEFAULT_GENERAL_TTL_DAYS;
    const d = new Date();
    d.setDate(d.getDate() + days);
    expiresAt = d.toISOString();
  }

  const info = getDb()
    .prepare(
      `INSERT INTO memories (agent, tier, content, source, importance, tags, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(agent, tier, content, source, importance, JSON.stringify(tags), expiresAt);
  return info.lastInsertRowid;
}

/**
 * Get memories for an agent. Includes 'global' rows. Optionally filter by tier.
 * Touches last_accessed and access_count so decay can favor frequently-read items.
 */
function getMemoriesForAgent(agent, { tier, limit = 100 } = {}) {
  const db = getDb();
  const params = [agent];
  let sql =
    'SELECT * FROM memories WHERE (agent = ? OR agent = \'global\')' +
    ' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)';
  if (tier) {
    if (!VALID_TIERS.has(tier)) throw new Error(`invalid tier "${tier}"`);
    sql += ' AND tier = ?';
    params.push(tier);
  }
  sql += ' ORDER BY importance DESC, last_accessed DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);

  // Touch access for decay accounting. Single statement, batched in a tx.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memories
         SET last_accessed = CURRENT_TIMESTAMP,
             access_count  = access_count + 1
       WHERE id IN (${placeholders})`
    ).run(...ids);
  }

  // Parse tags JSON for callers.
  return rows.map((r) => ({ ...r, tags: r.tags ? safeJson(r.tags) : [] }));
}

function getPinnedContext() {
  return getDb().prepare('SELECT key, value FROM pinned_context ORDER BY key').all();
}

function upsertPinnedContext(key, value) {
  getDb()
    .prepare(
      `INSERT INTO pinned_context (key, value, last_updated)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, last_updated = CURRENT_TIMESTAMP`
    )
    .run(key, value);
}

function deleteMemory(id) {
  return getDb().prepare('DELETE FROM memories WHERE id = ?').run(id).changes;
}

/**
 * Decay pass. Run nightly (cron). Two operations:
 *   1. Expire: delete general memories whose expires_at has passed.
 *   2. Decay:  for general memories not accessed in 7+ days, reduce importance
 *              by 0.1. If importance drops below DECAY_THRESHOLD, delete.
 * Pinned and insight tiers are not touched.
 *
 * Returns { expired, decayed, deleted } counts for logging.
 */
function runDecayPass() {
  const db = getDb();
  const expired = db
    .prepare(
      `DELETE FROM memories
        WHERE tier = 'general'
          AND expires_at IS NOT NULL
          AND expires_at <= CURRENT_TIMESTAMP`
    )
    .run().changes;

  // Decay step.
  const decayed = db
    .prepare(
      `UPDATE memories
          SET importance = importance - 0.1
        WHERE tier = 'general'
          AND last_accessed <= datetime('now', '-7 days')
          AND importance > 0`
    )
    .run().changes;

  const deleted = db
    .prepare(
      `DELETE FROM memories
        WHERE tier = 'general'
          AND importance < ?`
    )
    .run(DECAY_THRESHOLD).changes;

  return { expired, decayed, deleted };
}

function countsByTier() {
  const rows = getDb()
    .prepare('SELECT tier, COUNT(*) AS c FROM memories GROUP BY tier')
    .all();
  const out = { pinned: 0, insight: 0, general: 0 };
  for (const r of rows) out[r.tier] = r.c;
  return out;
}

function importanceDistribution() {
  // Buckets the dashboard renders as a bar chart.
  return getDb()
    .prepare(
      `SELECT
          SUM(CASE WHEN importance >= 0.75 THEN 1 ELSE 0 END) AS high,
          SUM(CASE WHEN importance >= 0.5 AND importance < 0.75 THEN 1 ELSE 0 END) AS medium,
          SUM(CASE WHEN importance < 0.5 THEN 1 ELSE 0 END) AS low,
          SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= datetime('now', '+3 days') THEN 1 ELSE 0 END) AS expiring
        FROM memories`
    )
    .get();
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return []; }
}

module.exports = {
  addMemory,
  getMemoriesForAgent,
  getPinnedContext,
  upsertPinnedContext,
  deleteMemory,
  runDecayPass,
  countsByTier,
  importanceDistribution,
  VALID_TIERS,
  DECAY_THRESHOLD,
};
