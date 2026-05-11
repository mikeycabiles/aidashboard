/**
 * bridge/router.js — two-tier message classifier.
 *
 *   Tier 1 (free): explicit prefix detection. If the message starts with
 *                  @main / @comms / @ops / @content / @research, route it
 *                  there immediately and strip the prefix. Zero API calls.
 *
 *   Tier 2 (cheap): Gemini Flash classifier. For prefix-less messages, ask
 *                   Gemini to pick the right agent. Uses the cheapest model
 *                   available (gemini-2.0-flash-lite by default). Falls back
 *                   to 'main' on any error so the system never silently drops.
 *
 * Every routing decision returns { agent, stripped, source }, where source is
 * 'prefix', 'gemini', or 'fallback' — useful for dashboard analytics.
 */
'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const VALID_AGENTS = new Set(['main', 'comms', 'ops', 'content', 'research']);
const PREFIX_RE = /^@(main|comms|ops|content|research)\b\s*/i;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_CLASSIFIER_MODEL =
  process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.0-flash-lite';

let _classifierModel = null;
function getClassifier() {
  if (_classifierModel) return _classifierModel;
  if (!GEMINI_API_KEY) return null;
  const genai = new GoogleGenerativeAI(GEMINI_API_KEY);
  _classifierModel = genai.getGenerativeModel({ model: GEMINI_CLASSIFIER_MODEL });
  return _classifierModel;
}

const CLASSIFIER_PROMPT = (message) => `Given this message, which agent is best suited to handle it?

Agents: main, comms, ops, content, research

Definitions:
- comms: writing, scripts, outreach, newsletters, YouTube, client communication
- ops: scheduling, business tracking, finances, client project status, logistics
- content: social media creative, Meta ads, thumbnails, video analysis, brand creative
- research: market research, competitor intelligence, deep dives, data retrieval
- main: anything else, or tasks that require delegation across multiple agents

Message: "${message.replace(/"/g, '\\"')}"

Reply with ONLY the agent name. No explanation.`;

/**
 * Tier-1 check. Returns { agent, stripped } if a prefix matched, else null.
 */
function detectPrefix(message) {
  const m = PREFIX_RE.exec(message);
  if (!m) return null;
  return {
    agent: m[1].toLowerCase(),
    stripped: message.slice(m[0].length).trim(),
  };
}

/**
 * Tier-2 classifier. Calls Gemini, parses the response, validates against the
 * known agent set. Returns 'main' on any failure — we'd rather route to the
 * triage agent than drop the message.
 */
async function classifyWithGemini(message) {
  const model = getClassifier();
  if (!model) {
    console.warn('[router] GEMINI_API_KEY not set — defaulting to main.');
    return 'main';
  }

  try {
    const result = await model.generateContent(CLASSIFIER_PROMPT(message));
    const raw = (result.response.text() || '').trim().toLowerCase();
    // Tolerate the model returning extra words like "agent: comms" or "comms."
    const candidate = raw.replace(/[^a-z]/g, '').slice(0, 16);
    for (const a of VALID_AGENTS) {
      if (candidate.includes(a)) return a;
    }
    console.warn(`[router] Gemini returned unparseable agent "${raw}" — defaulting to main.`);
    return 'main';
  } catch (err) {
    console.warn('[router] Gemini classifier failed:', err.message, '— defaulting to main.');
    return 'main';
  }
}

/**
 * Public API. Always resolves; never throws.
 */
async function route(message) {
  const text = String(message || '').trim();

  const prefix = detectPrefix(text);
  if (prefix) {
    return { agent: prefix.agent, stripped: prefix.stripped, source: 'prefix' };
  }

  // Empty body → main handles it (likely a stray /command or whitespace).
  if (!text) return { agent: 'main', stripped: text, source: 'fallback' };

  const agent = await classifyWithGemini(text);
  return { agent, stripped: text, source: 'gemini' };
}

module.exports = {
  route,
  detectPrefix,
  classifyWithGemini,
  VALID_AGENTS,
};
