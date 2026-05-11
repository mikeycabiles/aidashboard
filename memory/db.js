/**
 * memory/db.js — SQLite connection singleton + schema initializer.
 *
 * Why a singleton: better-sqlite3 is synchronous and connection-per-call would
 * thrash the FS. One connection, reused everywhere, is the right primitive.
 *
 * Run `node memory/db.js --init` to (re)create the schema and pre-populate
 * pinned context. Safe to run repeatedly — uses CREATE TABLE IF NOT EXISTS
 * and INSERT OR IGNORE.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Resolve DB path from env, defaulting to ./data/marketing-os.db.
// Always resolve relative to repo root so cron/PM2 invocations from other cwds
// still find the file.
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(
  REPO_ROOT,
  process.env.SQLITE_DB_PATH || './data/marketing-os.db'
);

// Ensure parent directory exists before opening the DB.
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let _db = null;

/**
 * Get (or lazily open) the shared DB connection.
 * WAL mode lets the dashboard read while the bridge writes without locking.
 */
function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/**
 * Initialize schema from schema.sql and seed pinned_context.
 * Idempotent — safe to call on every boot.
 */
function initSchema() {
  const db = getDb();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
  seedPinnedContext();
  return db;
}

/**
 * Pinned context — the foundational facts every agent gets injected.
 * Edit this list to update the system's "always true" knowledge.
 * INSERT OR IGNORE keeps it idempotent without clobbering user updates.
 */
const PINNED_CONTEXT_SEED = [
  ['owner_name', 'Mikey Cabiles'],
  ['owner_location', 'Kittanning, PA (relocating to Tampa, FL by end of 2026)'],
  ['business_name', 'Mikey Cabiles AI Marketing OS (one-person consulting + digital products)'],
  ['personal_brand_url', 'mikeycabiles.com'],
  ['newsletter', "Mikey's Memos on Beehiiv"],
  ['brand_tagline', 'Always grateful, never content'],
  ['brand_positioning', 'The Ambitious Underdog'],
  ['target_audience', 'Stuck Achievers — ambitious, capable, feel behind'],
  ['client_1', 'Jim Leslie / Home Service Freedom — full-time role, content system + Meta ads'],
  ['client_2', 'Honey Dudes — freelance, home services Elyria OH, Decks Doors Fences Gutters'],
  ['meta_ads_benchmark', '13x ROAS, $210 CPR — GBP Domination Workshop for Jim Leslie'],
  ['active_products', 'Personal Brand System (ship first), Creator Intelligence Vault, Meta Ads Intelligence System'],
  ['camera_primary', 'Sony A7CII with Sony 24mm f2.8G and Viltrox 20mm f2.8 Air'],
  ['editing_software', 'DaVinci Resolve on Dell G7 7700 Windows'],
  ['competitor_watch', 'AgentRise (agentrise.io)'],
  ['brand_colors', 'Bright Rose #E0596F, Burnished Gold #BF9B45'],
  ['typography', 'Fraunces 900 (display), Outfit (body)']
];

function seedPinnedContext() {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO pinned_context (key, value) VALUES (?, ?)'
  );
  const tx = db.transaction((rows) => {
    for (const [key, value] of rows) stmt.run(key, value);
  });
  tx(PINNED_CONTEXT_SEED);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, initSchema, seedPinnedContext, closeDb, DB_PATH };

// CLI entry point: `node memory/db.js --init`
if (require.main === module) {
  if (process.argv.includes('--init')) {
    initSchema();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    const pinnedCount = db.prepare('SELECT COUNT(*) AS c FROM pinned_context').get().c;
    console.log(`[db] initialized at ${DB_PATH}`);
    console.log(`[db] tables: ${tables.join(', ')}`);
    console.log(`[db] pinned_context rows: ${pinnedCount}`);
    closeDb();
  } else {
    console.log('Usage: node memory/db.js --init');
  }
}
