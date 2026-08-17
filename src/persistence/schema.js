import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 3;

const SCHEMA_V1 = String.raw`
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_receipts_expires ON command_receipts(expires_at);

CREATE TABLE IF NOT EXISTS app_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  interval_minutes INTEGER NOT NULL DEFAULT 180 CHECK (interval_minutes > 0),
  jitter_minutes INTEGER NOT NULL DEFAULT 30 CHECK (jitter_minutes >= 0),
  headless INTEGER NOT NULL DEFAULT 1 CHECK (headless IN (0, 1)),
  status_check_minutes INTEGER NOT NULL DEFAULT 15 CHECK (status_check_minutes > 0),
  status_check_on_startup INTEGER NOT NULL DEFAULT 1 CHECK (status_check_on_startup IN (0, 1)),
  open_page_timeout_minutes INTEGER NOT NULL DEFAULT 0 CHECK (open_page_timeout_minutes >= 0),
  profile_auto_clean_enabled INTEGER NOT NULL DEFAULT 1 CHECK (profile_auto_clean_enabled IN (0, 1)),
  scheduler_enabled INTEGER NOT NULL DEFAULT 0 CHECK (scheduler_enabled IN (0, 1)),
  legacy_extra_json TEXT
);
INSERT OR IGNORE INTO app_settings(singleton_id) VALUES (1);

CREATE TABLE IF NOT EXISTS proxy_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  subscription_url TEXT,
  subscription_updated_at TEXT,
  mihomo_path TEXT,
  clash_verge_dir TEXT,
  legacy_extra_json TEXT
);
INSERT OR IGNORE INTO proxy_settings(singleton_id) VALUES (1);

CREATE TABLE IF NOT EXISTS proxy_nodes (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
  legacy_extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_order ON proxy_nodes(sort_order);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  proxy_id TEXT REFERENCES proxy_nodes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  timezone TEXT,
  locale TEXT,
  timezone_manual INTEGER NOT NULL DEFAULT 0 CHECK (timezone_manual IN (0, 1)),
  legacy_extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_groups_order ON groups(sort_order);

CREATE TABLE IF NOT EXISTS conversation_sets (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  topic TEXT NOT NULL,
  min_rounds INTEGER NOT NULL CHECK (min_rounds >= 0),
  max_rounds INTEGER NOT NULL CHECK (max_rounds >= min_rounds),
  legacy_extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_sets_order ON conversation_sets(sort_order);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  profile_name TEXT NOT NULL UNIQUE,
  group_id TEXT REFERENCES groups(id) ON UPDATE CASCADE ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  email TEXT,
  gpt_name TEXT,
  switch_rule TEXT NOT NULL DEFAULT 'random' CHECK (switch_rule IN ('random', 'sequential')),
  min_windows INTEGER NOT NULL DEFAULT 1 CHECK (min_windows > 0),
  max_windows INTEGER NOT NULL DEFAULT 3 CHECK (max_windows >= min_windows),
  rotation_current_set TEXT,
  rotation_windows_done INTEGER NOT NULL DEFAULT 0 CHECK (rotation_windows_done >= 0),
  rotation_windows_target INTEGER NOT NULL DEFAULT 0 CHECK (rotation_windows_target >= 0),
  legacy_extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_order ON accounts(sort_order);
CREATE INDEX IF NOT EXISTS idx_accounts_group ON accounts(group_id);

CREATE TABLE IF NOT EXISTS account_status (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  state TEXT,
  email TEXT,
  detail TEXT,
  checked_at TEXT,
  last_check_state TEXT,
  last_check_detail TEXT,
  confirmed_state TEXT,
  confirmed_at TEXT,
  consecutive_unknowns INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_unknowns >= 0),
  unknown_since TEXT,
  stale INTEGER NOT NULL DEFAULT 1 CHECK (stale IN (0, 1)),
  legacy_extra_json TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  next_at TEXT,
  last_at TEXT,
  last_result_state TEXT,
  last_result_json TEXT
);

CREATE TABLE IF NOT EXISTS run_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  source TEXT NOT NULL DEFAULT 'legacy',
  finished_at TEXT,
  ok INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  prompt TEXT,
  reply TEXT,
  error TEXT,
  payload_json TEXT NOT NULL,
  legacy_file TEXT,
  legacy_line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_history_account_time ON run_history(account_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS profile_maintenance_state (
  profile_name TEXT PRIMARY KEY,
  last_scanned_at TEXT,
  last_cleaned_at TEXT,
  size_bytes INTEGER,
  cache_bytes INTEGER,
  state_json TEXT
);

CREATE TABLE IF NOT EXISTS profile_fs_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  state TEXT NOT NULL,
  source_path TEXT,
  target_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_fs_operations_state ON profile_fs_operations(state);

CREATE TABLE IF NOT EXISTS migration_imports (
  id TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL UNIQUE,
  source_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  manifest_json TEXT NOT NULL,
  counts_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  app_version TEXT
);

CREATE TABLE IF NOT EXISTS migration_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL REFERENCES migration_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_path TEXT,
  line_number INTEGER,
  raw_text TEXT,
  error TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_rejects_import ON migration_rejects(migration_id);

INSERT OR IGNORE INTO app_settings(singleton_id) VALUES (1);
INSERT OR IGNORE INTO proxy_settings(singleton_id) VALUES (1);
`;

// Operation 之前只存在内存里：Agent 重启后所有任务结果和错误详情一起消失，
// 而"活动任务/错误中心"恰恰是用户排查失败的唯一入口。这里让它落库。
const SCHEMA_V2 = String.raw`
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_id TEXT,
  state TEXT NOT NULL,
  stage TEXT,
  message TEXT,
  progress REAL,
  blocks_update INTEGER NOT NULL DEFAULT 1 CHECK (blocks_update IN (0, 1)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  result_json TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_started ON operations(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state);
`;

// 早期原生端迁移把旧网页自动生成的 topic_xxxxxxxx 原样写进了主键，随后只能在
// 各页面临时隐藏它。这里一次性修正已经完成过旧版导入的数据库；新导入则由迁移
// 计划在写库前完成同样的映射。候选序号会避开已有人工标识和重复主题。
const SCHEMA_V3 = String.raw`
CREATE TEMP TABLE _legacy_conversation_id_map (
  legacy_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);

WITH RECURSIVE
generated AS (
  SELECT
    id AS legacy_id,
    CASE WHEN trim(topic) <> '' THEN trim(topic) ELSE '未命名会话' END AS base,
    row_number() OVER (
      PARTITION BY CASE WHEN trim(topic) <> '' THEN trim(topic) ELSE '未命名会话' END
      ORDER BY sort_order, id
    ) AS ordinal
  FROM conversation_sets
  WHERE EXISTS (SELECT 1 FROM migration_imports WHERE state = 'completed')
    AND length(id) = 14
    AND lower(substr(id, 1, 6)) = 'topic_'
    AND substr(id, 7) NOT GLOB '*[^A-Za-z0-9]*'
),
candidate_numbers(number) AS (
  VALUES (1)
  UNION ALL
  SELECT number + 1
  FROM candidate_numbers
  WHERE number <= (SELECT count(*) FROM conversation_sets)
),
candidate_names AS (
  SELECT
    bases.base,
    candidate_numbers.number,
    CASE
      WHEN candidate_numbers.number = 1 THEN bases.base
      ELSE bases.base || ' (' || candidate_numbers.number || ')'
    END AS candidate
  FROM (SELECT DISTINCT base FROM generated) AS bases
  CROSS JOIN candidate_numbers
),
available AS (
  SELECT
    base,
    candidate,
    row_number() OVER (PARTITION BY base ORDER BY number) AS ordinal
  FROM candidate_names
  WHERE NOT EXISTS (
    SELECT 1
    FROM conversation_sets AS existing
    WHERE existing.id = candidate_names.candidate
      AND NOT (
        length(existing.id) = 14
        AND lower(substr(existing.id, 1, 6)) = 'topic_'
        AND substr(existing.id, 7) NOT GLOB '*[^A-Za-z0-9]*'
      )
  )
    AND (
      candidate_names.candidate = candidate_names.base
      OR NOT EXISTS (
        SELECT 1
        FROM generated AS reserved
        WHERE reserved.base = candidate_names.candidate
      )
    )
)
INSERT INTO _legacy_conversation_id_map(legacy_id, new_id)
SELECT generated.legacy_id, available.candidate
FROM generated
JOIN available USING (base, ordinal);

UPDATE accounts
SET rotation_current_set = (
  SELECT new_id
  FROM _legacy_conversation_id_map
  WHERE legacy_id = accounts.rotation_current_set
)
WHERE length(rotation_current_set) = 14
  AND lower(substr(rotation_current_set, 1, 6)) = 'topic_'
  AND substr(rotation_current_set, 7) NOT GLOB '*[^A-Za-z0-9]*'
  AND EXISTS (SELECT 1 FROM migration_imports WHERE state = 'completed');

UPDATE scheduler_state
SET last_result_json = json_set(
  last_result_json,
  '$.setName',
  COALESCE(
    (
      SELECT new_id
      FROM _legacy_conversation_id_map
      WHERE legacy_id = json_extract(scheduler_state.last_result_json, '$.setName')
    ),
    CASE
      WHEN trim(COALESCE(json_extract(last_result_json, '$.topic'), '')) <> ''
        THEN trim(json_extract(last_result_json, '$.topic'))
      ELSE '未命名会话'
    END
  )
)
WHERE json_valid(last_result_json)
  AND length(json_extract(last_result_json, '$.setName')) = 14
  AND lower(substr(json_extract(last_result_json, '$.setName'), 1, 6)) = 'topic_'
  AND substr(json_extract(last_result_json, '$.setName'), 7) NOT GLOB '*[^A-Za-z0-9]*'
  AND EXISTS (SELECT 1 FROM migration_imports WHERE state = 'completed');

UPDATE run_history
SET payload_json = json_set(
  payload_json,
  '$.setName',
  COALESCE(
    (
      SELECT new_id
      FROM _legacy_conversation_id_map
      WHERE legacy_id = json_extract(run_history.payload_json, '$.setName')
    ),
    CASE
      WHEN trim(COALESCE(json_extract(payload_json, '$.topic'), '')) <> ''
        THEN trim(json_extract(payload_json, '$.topic'))
      ELSE '未命名会话'
    END
  )
)
WHERE source = 'legacy'
  AND json_valid(payload_json)
  AND length(json_extract(payload_json, '$.setName')) = 14
  AND lower(substr(json_extract(payload_json, '$.setName'), 1, 6)) = 'topic_'
  AND substr(json_extract(payload_json, '$.setName'), 7) NOT GLOB '*[^A-Za-z0-9]*'
  AND EXISTS (SELECT 1 FROM migration_imports WHERE state = 'completed');

CREATE TEMP TABLE _legacy_conversation_rows AS
SELECT
  mapping.new_id AS id,
  conversation_sets.sort_order,
  conversation_sets.topic,
  conversation_sets.min_rounds,
  conversation_sets.max_rounds,
  conversation_sets.legacy_extra_json
FROM conversation_sets
JOIN _legacy_conversation_id_map AS mapping ON mapping.legacy_id = conversation_sets.id;

DELETE FROM conversation_sets
WHERE id IN (SELECT legacy_id FROM _legacy_conversation_id_map);

INSERT INTO conversation_sets(id, sort_order, topic, min_rounds, max_rounds, legacy_extra_json)
SELECT id, sort_order, topic, min_rounds, max_rounds, legacy_extra_json
FROM _legacy_conversation_rows;

DROP TABLE _legacy_conversation_rows;
DROP TABLE _legacy_conversation_id_map;
`;

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial-agent-schema",
    sql: SCHEMA_V1,
    checksum: createHash("sha256").update(SCHEMA_V1).digest("hex"),
  }),
  Object.freeze({
    version: 2,
    name: "durable-operations",
    sql: SCHEMA_V2,
    checksum: createHash("sha256").update(SCHEMA_V2).digest("hex"),
  }),
  Object.freeze({
    version: 3,
    name: "normalize-legacy-conversation-ids",
    sql: SCHEMA_V3,
    checksum: createHash("sha256").update(SCHEMA_V3).digest("hex"),
  }),
]);

export const MIGRATION_LEDGER_SQL = String.raw`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT
);
`;
