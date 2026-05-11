/**
 * memory/washingMachine.js — Gemini-powered memory classifier.
 *
 * What it does:
 *   1. Pull every unprocessed row from conversation_log (processed_by_washer=0).
 *   2. Pull the current pinned_context so Gemini doesn't re-add duplicates.
 *   3. Ask Gemini 1.5 Flash to classify extracted facts into pinned/insight/general.
 *   4. Insert the resulting memories.
 *   5. Mark the processed log rows so they're never reprocessed.
 *
 * Triggered every 30 minutes by cron, or manually via `runWashingCycle()`.
 *
 * The Gemini prompt is the verbatim template from the spec — easy to audit and
 * tune. Output is forced to a strict JSON schema; we parse defensively and
 * never throw out of the cycle if the model returns junk.
 */
'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getDb } = require('./db');
const memoryManager = require('./memoryManager');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WASHER_MODEL = process.env.GEMINI_WASHER_MODEL || 'gemini-1.5-flash';

let _model = null;
function getModel() {
  if (_model) return _model;
  if (!GEMINI_API_KEY) return null;
  const genai = new GoogleGenerativeAI(GEMINI_API_KEY);
  _model = genai.getGenerativeModel({
    model: WASHER_MODEL,
    generationConfig: { responseMimeType: 'application/json' },
  });
  return _model;
}

const PROMPT_TEMPLATE = ({ pinnedContext, conversationLog }) => `You are a memory classification AI for Mikey Cabiles' personal operating system.

Analyze the following conversation log and extract any facts, preferences, or context worth saving.

For each extracted item, classify it as:
- "pinned": A fundamental, permanent fact (name, client name, tool, price, hard deadline, core preference that will never change)
- "insight": A learned preference or behavioral pattern worth remembering but not absolute
- "general": Useful short-term context that will likely become irrelevant within 2 weeks

Return ONLY valid JSON in this exact format:
{
  "memories": [
    {
      "tier": "pinned" | "insight" | "general",
      "content": "One clear sentence describing the fact or preference",
      "importance": 0.0 to 1.0,
      "tags": ["tag1", "tag2"]
    }
  ]
}

Do not include anything already in the pinned_context table (provided below).
Do not hallucinate. Only extract what is explicitly said or clearly implied.

EXISTING PINNED CONTEXT:
${pinnedContext}

CONVERSATION LOG TO ANALYZE:
${conversationLog}`;

/**
 * Format helpers — keep prompt construction readable.
 */
function formatPinnedContextForPrompt() {
  const rows = memoryManager.getPinnedContext();
  return rows.map((r) => `- ${r.key}: ${r.value}`).join('\n') || '(none)';
}

function formatConversationForPrompt(rows) {
  return rows
    .map((r) => `[${r.timestamp}] (${r.agent || '?'}) ${r.role}: ${r.content}`)
    .join('\n');
}

/**
 * Get unprocessed conversation log rows. Caps at `limit` to keep prompt size
 * bounded; remaining rows are picked up on the next cycle.
 */
function fetchUnprocessed(limit = 200) {
  return getDb()
    .prepare(
      `SELECT id, chat_id, agent, role, content, timestamp
         FROM conversation_log
        WHERE processed_by_washer = 0
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(limit);
}

function markProcessed(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `UPDATE conversation_log SET processed_by_washer = 1 WHERE id IN (${placeholders})`
    )
    .run(...ids).changes;
}

/**
 * Defensive JSON parse — Gemini sometimes wraps output in markdown fences
 * despite responseMimeType, so strip them if present.
 */
function parseMemoriesJson(raw) {
  const text = String(raw || '').trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.memories)) return [];
    return parsed.memories.filter(
      (m) => m && memoryManager.VALID_TIERS.has(m.tier) && typeof m.content === 'string' && m.content.trim()
    );
  } catch (e) {
    console.warn('[washer] failed to parse Gemini JSON:', e.message);
    return [];
  }
}

/**
 * Run a single classification of an arbitrary block of conversation text.
 * Exposed so tests can drive the classifier without touching the DB.
 */
async function classify(conversationText) {
  const model = getModel();
  if (!model) {
    console.warn('[washer] GEMINI_API_KEY not set — skipping.');
    return [];
  }
  const prompt = PROMPT_TEMPLATE({
    pinnedContext: formatPinnedContextForPrompt(),
    conversationLog: conversationText,
  });
  const result = await model.generateContent(prompt);
  return parseMemoriesJson(result.response.text());
}

/**
 * Main entry point. Runs the full read → classify → insert → mark cycle.
 * Returns { processed, extracted, inserted } for logging.
 */
async function runWashingCycle({ limit = 200 } = {}) {
  const rows = fetchUnprocessed(limit);
  if (rows.length === 0) {
    return { processed: 0, extracted: 0, inserted: 0 };
  }

  let memories = [];
  try {
    memories = await classify(formatConversationForPrompt(rows));
  } catch (err) {
    console.error('[washer] classifier error:', err.message);
    // Don't mark rows processed on error — try again next cycle.
    return { processed: 0, extracted: 0, inserted: 0, error: err.message };
  }

  let inserted = 0;
  for (const m of memories) {
    try {
      memoryManager.addMemory({
        agent: 'global',
        tier: m.tier,
        content: m.content.trim(),
        source: 'gemini',
        importance: clamp(m.importance, 0, 1, 0.5),
        tags: Array.isArray(m.tags) ? m.tags : [],
      });
      inserted++;
    } catch (e) {
      console.warn('[washer] insert failed:', e.message);
    }
  }

  markProcessed(rows.map((r) => r.id));
  return { processed: rows.length, extracted: memories.length, inserted };
}

function clamp(n, min, max, fallback) {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, x));
}

module.exports = {
  classify,
  runWashingCycle,
  fetchUnprocessed,
  markProcessed,
  parseMemoriesJson,
};

// CLI: `node memory/washingMachine.js` — run a single cycle manually.
if (require.main === module) {
  runWashingCycle()
    .then((r) => {
      console.log('[washer] cycle result:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[washer] fatal:', e);
      process.exit(1);
    });
}
