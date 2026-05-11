/**
 * memory/hiveMind.js — shared cross-agent task log.
 *
 * Every completed agent task gets a row here so any other agent (or the
 * dashboard) can answer "what did X just do?" without re-running the work.
 *
 * Stored in the hive_mind table:
 *   agent, task_summary, task_type, output_preview (first 200 chars),
 *   status, completed_at, triggered_by
 */
'use strict';

const { getDb } = require('./db');

const PREVIEW_LEN = 200;

/**
 * Record a completed task.
 *   agent:        'main' | 'comms' | 'ops' | 'content' | 'research' | 'system'
 *   summary:      short human-readable description of the task
 *   taskType:     'content' | 'research' | 'comms' | 'ops' | 'system' | …
 *   output:       full output text (will be truncated to PREVIEW_LEN)
 *   triggeredBy:  'user' | 'cron' | 'agent_delegation'
 *   status:       defaults to 'completed'
 */
function logTask({ agent, summary, taskType = null, output = '', triggeredBy = 'user', status = 'completed' } = {}) {
  if (!agent || !summary) {
    throw new Error('hiveMind.logTask: agent and summary are required');
  }
  const preview = String(output || '').slice(0, PREVIEW_LEN);
  const info = getDb()
    .prepare(
      `INSERT INTO hive_mind (agent, task_summary, task_type, output_preview, status, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(agent, summary, taskType, preview, status, triggeredBy);
  return info.lastInsertRowid;
}

/**
 * Recent tasks for a given agent. Used by other agents asking "what's X been
 * doing?" and by the Main agent when triaging.
 */
function recentByAgent(agent, limit = 20) {
  return getDb()
    .prepare(
      'SELECT * FROM hive_mind WHERE agent = ? ORDER BY completed_at DESC LIMIT ?'
    )
    .all(agent, limit);
}

/**
 * Cross-agent feed for the dashboard.
 */
function recent(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM hive_mind ORDER BY completed_at DESC LIMIT ?')
    .all(limit);
}

/**
 * Range query — used by the Sunday weekly digest cron.
 */
function recentSince(isoTimestamp, limit = 500) {
  return getDb()
    .prepare(
      'SELECT * FROM hive_mind WHERE completed_at >= ? ORDER BY completed_at DESC LIMIT ?'
    )
    .all(isoTimestamp, limit);
}

/**
 * Counts per agent for the dashboard's agent status panel.
 */
function countsByAgent() {
  return getDb()
    .prepare('SELECT agent, COUNT(*) AS c FROM hive_mind GROUP BY agent')
    .all();
}

module.exports = {
  logTask,
  recentByAgent,
  recent,
  recentSince,
  countsByAgent,
};
