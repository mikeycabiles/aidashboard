-- =============================================================================
-- AI-Led MarketingOS — SQLite Schema
-- All memory tiers, hive mind, task queue, sessions, conversation log,
-- and pinned context live here. Single-file DB for portability.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- MEMORIES — three-tier memory store (pinned / insight / general)
-- importance drives the decay loop; general memories expire, pinned never do.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,               -- 'global', 'main', 'comms', 'ops', 'content', 'research'
  tier TEXT NOT NULL,                -- 'pinned', 'insight', 'general'
  content TEXT NOT NULL,
  source TEXT,                       -- 'user', 'gemini', 'agent', 'system'
  importance REAL DEFAULT 0.5,       -- 0.0 to 1.0 — drives decay logic
  access_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,               -- NULL = never expires (pinned/insight)
  tags TEXT                          -- JSON array of tags for filtering
);
CREATE INDEX IF NOT EXISTS idx_memories_agent_tier ON memories(agent, tier);
CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

-- -----------------------------------------------------------------------------
-- HIVE MIND — cross-agent task log so any agent can see what others did
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hive_mind (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  task_type TEXT,                    -- 'content', 'research', 'comms', 'ops', 'system'
  output_preview TEXT,               -- First 200 chars of output
  status TEXT DEFAULT 'completed',
  completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  triggered_by TEXT                  -- 'user', 'cron', 'agent_delegation'
);
CREATE INDEX IF NOT EXISTS idx_hive_agent ON hive_mind(agent);
CREATE INDEX IF NOT EXISTS idx_hive_completed_at ON hive_mind(completed_at);

-- -----------------------------------------------------------------------------
-- TASK QUEUE — kanban-backed task store (queued / live / completed / cancelled)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  assigned_agent TEXT,               -- 'main', 'comms', 'ops', 'content', 'research', 'unassigned'
  priority TEXT DEFAULT 'medium',    -- 'low', 'medium', 'high', 'critical'
  status TEXT DEFAULT 'queued',      -- 'queued', 'live', 'completed', 'cancelled'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_date DATETIME,
  completed_at DATETIME,
  source TEXT DEFAULT 'user',        -- 'user', 'cron', 'agent', 'dashboard'
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent);

-- -----------------------------------------------------------------------------
-- SESSIONS — Telegram chat security: allowlist + PIN verification
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL UNIQUE,
  pin_verified INTEGER DEFAULT 0,    -- 0 = false, 1 = true
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- CONVERSATION LOG — raw conversation feed consumed by Gemini washing machine
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  agent TEXT,
  role TEXT NOT NULL,                -- 'user' or 'assistant'
  content TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_by_washer INTEGER DEFAULT 0  -- 0 = not yet processed, 1 = processed
);
CREATE INDEX IF NOT EXISTS idx_convlog_processed ON conversation_log(processed_by_washer);
CREATE INDEX IF NOT EXISTS idx_convlog_timestamp ON conversation_log(timestamp);

-- -----------------------------------------------------------------------------
-- PINNED CONTEXT — global facts injected into every agent's context window
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pinned_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
