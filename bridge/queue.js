/**
 * bridge/queue.js — single-consumer FIFO message queue.
 *
 * Why this exists: every inbound message must be routed to a Claude Code
 * session via the Agent SDK. Those sessions are not threadsafe — kicking off
 * two simultaneously for the same agent risks context corruption and rate
 * limits. So we serialize: one in-flight job at a time.
 *
 * Design:
 *   - In-memory array (FIFO). Lost on crash — acceptable for chat messages.
 *     If we ever need durability, swap the backing store for a SQLite table.
 *   - A single async worker loop processes jobs sequentially.
 *   - Anyone (Telegram, cron, dashboard) calls enqueue() with a job that
 *     resolves to a string reply or null. The worker invokes the handler and
 *     awaits its return before pulling the next job.
 *   - Depth is exposed via depth() for the dashboard's queue indicator.
 *   - EventEmitter surfaces lifecycle events ("enqueued", "started",
 *     "completed", "errored") so the dashboard can stream updates without
 *     polling the DB.
 */
'use strict';

const { EventEmitter } = require('events');

class MessageQueue extends EventEmitter {
  constructor() {
    super();
    this._jobs = [];
    this._processing = false;
    this._currentJob = null;
  }

  /**
   * Add a job to the back of the queue. `job` shape:
   *   {
   *     id: string,                    // unique, for tracing
   *     source: 'telegram' | 'cron' | 'dashboard',
   *     chatId?: string,
   *     payload: any,                  // anything the handler needs
   *     handler: async (job) => string|null   // the work to perform
   *   }
   * The worker kicks off automatically — callers never await this.
   */
  enqueue(job) {
    if (!job || typeof job.handler !== 'function') {
      throw new TypeError('queue.enqueue: job.handler must be an async function');
    }
    if (!job.id) job.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!job.enqueuedAt) job.enqueuedAt = new Date().toISOString();

    this._jobs.push(job);
    this.emit('enqueued', { id: job.id, depth: this.depth(), source: job.source });
    // Kick the worker. If already processing, this is a no-op.
    setImmediate(() => this._drain());
    return job.id;
  }

  /**
   * Internal: drain loop. Pulls jobs one at a time and awaits each handler.
   * Catches every error so a single bad handler can't kill the worker.
   */
  async _drain() {
    if (this._processing) return;
    this._processing = true;

    while (this._jobs.length > 0) {
      const job = this._jobs.shift();
      this._currentJob = job;
      this.emit('started', { id: job.id, depth: this.depth(), source: job.source });

      try {
        const result = await job.handler(job);
        this.emit('completed', { id: job.id, depth: this.depth(), result });
      } catch (err) {
        // Never throw out of the worker — log and keep going.
        console.error(`[queue] job ${job.id} errored:`, err);
        this.emit('errored', { id: job.id, depth: this.depth(), error: err.message });
      }

      this._currentJob = null;
    }

    this._processing = false;
  }

  /** Current queue depth (jobs waiting, excluding the one in flight). */
  depth() {
    return this._jobs.length;
  }

  /** True if a job is currently being processed. */
  isBusy() {
    return this._processing;
  }

  /** Snapshot of the in-flight job (for the dashboard). */
  current() {
    return this._currentJob ? { id: this._currentJob.id, source: this._currentJob.source } : null;
  }

  /**
   * Snapshot of waiting jobs (no handler fn, just metadata) — safe to send to
   * the dashboard over websocket.
   */
  snapshot() {
    return this._jobs.map((j) => ({
      id: j.id,
      source: j.source,
      chatId: j.chatId,
      enqueuedAt: j.enqueuedAt,
    }));
  }
}

// Singleton — every module imports the same queue instance.
const queue = new MessageQueue();

module.exports = queue;
module.exports.MessageQueue = MessageQueue;
