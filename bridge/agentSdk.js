/**
 * bridge/agentSdk.js — wrapper around the Anthropic Agent SDK.
 *
 * Purpose: spawn (or reuse) a Claude Code session for a given agent role,
 * send it a user message with the agent's system prompt + injected context,
 * and return the assistant's reply as a string.
 *
 * Why a wrapper: the rest of the system shouldn't know whether we're calling
 * the official SDK, shelling out to `claude-code` directly, or stubbing for
 * tests. This module is the only place that talks to Anthropic.
 *
 * Session lifecycle:
 *   - We keep one logical "session" per agent (main, comms, ops, content,
 *     research). Each session preserves Claude's conversation memory within
 *     itself, so the agent has thread continuity.
 *   - Sessions are spawned lazily on first message and torn down via
 *     resetSession() if you want to start fresh (e.g. after a system prompt
 *     change or an Obsidian context refresh).
 *
 * NOTE: The Anthropic Agent SDK surface is still maturing. This wrapper is
 * structured so the integration point — sendToClaude() — is a single function
 * to swap when the canonical API stabilizes. Today it uses the @anthropic-ai/sdk
 * Messages API as a portable baseline. When you wire up the actual Agent SDK
 * (spawning real Claude Code terminal sessions), only sendToClaude() changes.
 */
'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('[agentSdk] WARNING: ANTHROPIC_API_KEY not set — sendMessage() will fail.');
}

// Model selection. The Agent SDK / Claude Code subscription handles primary
// execution; this Messages-API path is the bridge fallback and is intentionally
// set to the latest Sonnet for cost efficiency.
const BRIDGE_MODEL = process.env.BRIDGE_MODEL || 'claude-sonnet-4-6';
const BRIDGE_MAX_TOKENS = parseInt(process.env.BRIDGE_MAX_TOKENS || '4096', 10);

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

/**
 * In-memory session store. Key = agent name. Value = { systemPrompt, history }.
 * `history` is an array of {role, content} entries in Anthropic Messages format.
 *
 * Trimming: we cap history at MAX_TURNS to keep token usage bounded. Older
 * turns are dropped FIFO. The Memory Washing Machine extracts long-term facts
 * before they fall off the end.
 */
const MAX_TURNS = parseInt(process.env.BRIDGE_MAX_TURNS || '40', 10);
const sessions = new Map();

/**
 * Start (or reset) a session for an agent. `systemPrompt` is the agent's
 * directives + any injected Obsidian context + pinned facts.
 */
function spawnSession(agent, systemPrompt) {
  sessions.set(agent, { systemPrompt, history: [] });
  return sessions.get(agent);
}

/**
 * Update the system prompt for an existing session without dropping history.
 * Useful when Obsidian context changes mid-session.
 */
function updateSystemPrompt(agent, systemPrompt) {
  const s = sessions.get(agent);
  if (!s) return spawnSession(agent, systemPrompt);
  s.systemPrompt = systemPrompt;
  return s;
}

function resetSession(agent) {
  sessions.delete(agent);
}

function hasSession(agent) {
  return sessions.has(agent);
}

/**
 * Core call. Sends a user message to the agent's session and returns the
 * assistant's reply text. Trims history if it overflows MAX_TURNS.
 */
async function sendMessage(agent, userMessage, opts = {}) {
  if (!client) {
    throw new Error('Anthropic client not initialized — set ANTHROPIC_API_KEY.');
  }
  if (!sessions.has(agent)) {
    if (!opts.systemPrompt) {
      throw new Error(`No session for "${agent}" and no systemPrompt provided to bootstrap one.`);
    }
    spawnSession(agent, opts.systemPrompt);
  }
  const session = sessions.get(agent);
  if (opts.systemPrompt && opts.systemPrompt !== session.systemPrompt) {
    session.systemPrompt = opts.systemPrompt;
  }

  session.history.push({ role: 'user', content: userMessage });

  // Trim oldest turns if over cap. Always trim in pairs to keep user/assistant
  // alignment — Anthropic rejects histories that don't alternate cleanly.
  while (session.history.length > MAX_TURNS) {
    session.history.shift();
    if (session.history.length > 0 && session.history[0].role !== 'user') {
      session.history.shift();
    }
  }

  const response = await client.messages.create({
    model: opts.model || BRIDGE_MODEL,
    max_tokens: opts.maxTokens || BRIDGE_MAX_TOKENS,
    system: session.systemPrompt,
    messages: session.history,
  });

  // Concatenate all text blocks from the response.
  const reply = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  session.history.push({ role: 'assistant', content: reply });
  return reply;
}

module.exports = {
  spawnSession,
  updateSystemPrompt,
  resetSession,
  hasSession,
  sendMessage,
  BRIDGE_MODEL,
};
