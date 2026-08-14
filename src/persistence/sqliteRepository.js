import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { MIGRATION_LEDGER_SQL, MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

const require = createRequire(import.meta.url);
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

function repositoryError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bool(value, fallback = false) {
  return value == null ? (fallback ? 1 : 0) : value ? 1 : 0;
}

function accountFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sortOrder: row.sort_order,
    note: row.note,
    profileName: row.profile_name,
    profileDir: `profiles/${row.profile_name}`,
    groupId: row.group_id,
    enabled: !!row.enabled,
    email: row.email,
    gptName: row.gpt_name,
    switchRule: row.switch_rule,
    minWindows: row.min_windows,
    maxWindows: row.max_windows,
    rotation: {
      currentSet: row.rotation_current_set,
      windowsDone: row.rotation_windows_done,
      windowsTarget: row.rotation_windows_target,
    },
  };
}

function groupFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sortOrder: row.sort_order,
    name: row.name,
    proxyId: row.proxy_id,
    timezone: row.timezone,
    locale: row.locale,
    tzManual: !!row.timezone_manual,
  };
}

function statusFromRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    state: row.state,
    email: row.email,
    detail: row.detail,
    checkedAt: row.checked_at,
    lastCheckState: row.last_check_state,
    lastCheckDetail: row.last_check_detail,
    confirmedState: row.confirmed_state,
    confirmedAt: row.confirmed_at,
    consecutiveUnknowns: row.consecutive_unknowns,
    unknownSince: row.unknown_since,
    stale: !!row.stale,
  };
}

function loadDriver() {
  try {
    const loaded = require("better-sqlite3");
    return loaded.default ?? loaded;
  } catch (error) {
    throw repositoryError(
      "SQLITE_DRIVER_MISSING",
      "缺少 better-sqlite3；发行包必须携带与私有 Node ABI/RID 匹配的预编译模块",
      error
    );
  }
}

function ensureAbsoluteDatabasePath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw repositoryError("INVALID_DATABASE_PATH", "SQLite 数据库路径必须是绝对路径");
  }
  if (path.resolve(filePath) === path.parse(path.resolve(filePath)).root) {
    throw repositoryError("INVALID_DATABASE_PATH", "SQLite 数据库路径不能是文件系统根目录");
  }
  return path.resolve(filePath);
}

function backupFileName(version, now) {
  return `keeper-v${version}-${iso(now).replaceAll(":", "-")}.db`;
}

export class KeeperRepository {
  constructor(database, { clock = () => new Date(), appVersion = null } = {}) {
    if (!database) throw new TypeError("database is required");
    this.db = database;
    this.clock = clock;
    this.appVersion = appVersion;
    this.closed = false;
  }

  configure() {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
  }

  getSchemaVersion() {
    return Number(this.db.pragma("user_version", { simple: true }) || 0);
  }

  applyMigrations() {
    const current = this.getSchemaVersion();
    if (current > SCHEMA_VERSION) {
      throw repositoryError(
        "DATABASE_TOO_NEW",
        `数据库版本 ${current} 高于当前 Agent 支持的 ${SCHEMA_VERSION}`
      );
    }
    this.db.exec(MIGRATION_LEDGER_SQL);
    const findLedger = this.db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = ?"
    );
    const recordLedger = this.db.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)"
    );

    for (const migration of MIGRATIONS) {
      const recorded = findLedger.get(migration.version);
      if (recorded && recorded.checksum !== migration.checksum) {
        throw repositoryError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `数据库迁移 ${migration.version} 的校验和与程序不一致`
        );
      }
      if (migration.version <= current) {
        if (!recorded) {
          throw repositoryError(
            "MIGRATION_LEDGER_MISSING",
            `数据库声明为版本 ${current}，但缺少迁移 ${migration.version} 的账本记录`
          );
        }
        continue;
      }
      const transaction = this.db.transaction(() => {
        this.db.exec(migration.sql);
        recordLedger.run(
          migration.version,
          migration.name,
          migration.checksum,
          iso(this.clock()),
          this.appVersion
        );
        this.db.pragma(`user_version = ${migration.version}`);
      });
      transaction();
    }
  }

  async backupTo(destination) {
    if (typeof this.db.backup !== "function") {
      throw repositoryError("BACKUP_UNSUPPORTED", "SQLite 驱动不支持在线备份");
    }
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.db.backup(target);
    try {
      fs.chmodSync(target, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    return target;
  }

  checkpoint() {
    return this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  integrityCheck() {
    const quick = this.db.pragma("quick_check");
    const foreignKeys = this.db.pragma("foreign_key_check");
    const quickOk = Array.isArray(quick) && quick.length === 1 && Object.values(quick[0])[0] === "ok";
    return Object.freeze({ quickOk, quick, foreignKeys, ok: quickOk && foreignKeys.length === 0 });
  }

  transaction(work) {
    return this.db.transaction(work)();
  }

  purgeExpiredCommandReceipts(at = this.clock()) {
    return this.db
      .prepare("DELETE FROM command_receipts WHERE expires_at <= ?")
      .run(iso(at)).changes;
  }

  getCommandReceipt(commandId, method, at = this.clock()) {
    const row = this.db
      .prepare(
        "SELECT command_id, method, response_json, created_at, expires_at FROM command_receipts WHERE command_id = ?"
      )
      .get(commandId);
    if (!row) return null;
    if (row.expires_at <= iso(at)) {
      this.db.prepare("DELETE FROM command_receipts WHERE command_id = ?").run(commandId);
      return null;
    }
    if (row.method !== method) {
      throw repositoryError(
        "COMMAND_ID_REUSED",
        `commandId ${commandId} 已用于其他方法，不能复用`
      );
    }
    let response;
    try {
      response = JSON.parse(row.response_json);
    } catch (error) {
      throw repositoryError("CORRUPT_COMMAND_RECEIPT", "命令回执 JSON 已损坏", error);
    }
    return Object.freeze({
      commandId: row.command_id,
      method: row.method,
      response,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }

  recordCommandReceipt(
    commandId,
    method,
    response,
    { createdAt = this.clock(), ttlMs = DEFAULT_RECEIPT_TTL_MS } = {}
  ) {
    if (!commandId || !method) throw new TypeError("commandId and method are required");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
    const created = new Date(createdAt);
    const expires = new Date(created.getTime() + ttlMs);
    try {
      this.db
        .prepare(
          "INSERT INTO command_receipts(command_id, method, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(commandId, method, JSON.stringify(response), iso(created), iso(expires));
    } catch (error) {
      if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) {
        const existing = this.getCommandReceipt(commandId, method, created);
        if (existing) return existing;
      }
      throw error;
    }
    return this.getCommandReceipt(commandId, method, created);
  }

  // ---------- operations ----------

  /**
   * 写入/更新一条 Operation。Agent 重启后任务结果和稳定错误码仍可查询，
   * 这是"错误中心"能跨重启工作的前提。
   */
  saveOperation(operation) {
    if (!operation?.id) throw new TypeError("operation.id is required");
    this.db
      .prepare(
        `INSERT INTO operations(
           id, kind, resource_id, state, stage, message, progress, blocks_update,
           started_at, updated_at, finished_at, result_json, error_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state, stage=excluded.stage, message=excluded.message,
           progress=excluded.progress, blocks_update=excluded.blocks_update,
           updated_at=excluded.updated_at, finished_at=excluded.finished_at,
           result_json=excluded.result_json, error_json=excluded.error_json`
      )
      .run(
        operation.id,
        operation.kind,
        operation.resourceId ?? null,
        operation.state,
        operation.stage ?? null,
        operation.message ?? null,
        operation.progress == null ? null : Number(operation.progress),
        bool(operation.blocksUpdate !== false),
        operation.startedAt,
        operation.updatedAt,
        operation.finishedAt ?? null,
        operation.result == null ? null : JSON.stringify(operation.result),
        operation.error == null ? null : JSON.stringify(operation.error)
      );
    return operation;
  }

  listOperations({ limit = 200, includeTerminal = true } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = includeTerminal
      ? this.db
          .prepare("SELECT * FROM operations ORDER BY started_at DESC, rowid DESC LIMIT ?")
          .all(safeLimit)
      : this.db
          .prepare(
            `SELECT * FROM operations
              WHERE state NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')
              ORDER BY started_at DESC, rowid DESC LIMIT ?`
          )
          .all(safeLimit);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      resourceId: row.resource_id,
      state: row.state,
      stage: row.stage,
      message: row.message,
      progress: row.progress,
      blocksUpdate: !!row.blocks_update,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      result: row.result_json == null ? null : parseJson(row.result_json, null),
      error: row.error_json == null ? null : parseJson(row.error_json, null),
    }));
  }

  /**
   * 关掉的 Agent 留下的 running/queued 任务永远不会再推进：标记为
   * interrupted-cancelled，否则重启后"活动任务"里会挂着一堆假的运行中任务。
   */
  cancelUnfinishedOperations({ message = "Agent 重启，任务已中断" } = {}) {
    const now = iso(this.clock());
    return this.db
      .prepare(
        `UPDATE operations
            SET state='cancelled', message=?, updated_at=?, finished_at=?
          WHERE state NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')`
      )
      .run(message, now, now).changes;
  }

  pruneOperations({ keep = 500 } = {}) {
    const safeKeep = Math.max(50, Math.min(5000, Number(keep) || 500));
    return this.db
      .prepare(
        `DELETE FROM operations WHERE id NOT IN (
           SELECT id FROM operations ORDER BY started_at DESC, rowid DESC LIMIT ?
         )`
      )
      .run(safeKeep).changes;
  }

  getCompletedMigration(sourceFingerprint) {
    return (
      this.db
        .prepare(
          "SELECT id, source_fingerprint AS sourceFingerprint, completed_at AS completedAt, counts_json AS countsJson FROM migration_imports WHERE source_fingerprint = ? AND state = 'completed'"
        )
        .get(sourceFingerprint) ?? null
    );
  }

  isEmptyForLegacyImport() {
    const tables = ["accounts", "groups", "proxy_nodes", "conversation_sets", "run_history"];
    return tables.every((table) => this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count === 0);
  }

  importLegacyPlan(plan, { migrationId, appVersion = this.appVersion } = {}) {
    if (!plan?.sourceFingerprint || !plan?.data || !Array.isArray(plan?.manifest?.entries)) {
      throw repositoryError("INVALID_MIGRATION_PLAN", "旧版迁移计划不完整");
    }
    const id = migrationId || `legacy-${plan.sourceFingerprint.slice(0, 20)}`;
    const completed = this.getCompletedMigration(plan.sourceFingerprint);
    if (completed) return Object.freeze({ alreadyImported: true, migrationId: completed.id });
    if (!this.isEmptyForLegacyImport()) {
      throw repositoryError("DATABASE_NOT_EMPTY", "目标数据库已有业务数据，不能导入另一份旧数据");
    }

    const data = plan.data;
    const startedAt = iso(this.clock());
    const counts = {
      accounts: data.accounts.length,
      groups: data.groups.length,
      conversationSets: data.conversationSets.length,
      proxyNodes: data.proxyNodes.length,
      statuses: data.statuses.length,
      histories: data.histories.length,
      rejects: data.rejects.length,
    };

    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO migration_imports(id, source_fingerprint, source_root, state, manifest_json, counts_json, started_at, app_version) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)"
        )
        .run(
          id,
          plan.sourceFingerprint,
          plan.sourceRoot,
          JSON.stringify(plan.manifest),
          JSON.stringify(counts),
          startedAt,
          appVersion
        );

      const settings = data.settings;
      this.db.prepare("DELETE FROM app_settings WHERE singleton_id = 1").run();
      this.db
        .prepare(
          `INSERT INTO app_settings(
             singleton_id, interval_minutes, jitter_minutes, headless,
             status_check_minutes, status_check_on_startup, open_page_timeout_minutes,
             profile_auto_clean_enabled, scheduler_enabled, legacy_extra_json
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             interval_minutes=excluded.interval_minutes,
             jitter_minutes=excluded.jitter_minutes,
             headless=excluded.headless,
             status_check_minutes=excluded.status_check_minutes,
             status_check_on_startup=excluded.status_check_on_startup,
             open_page_timeout_minutes=excluded.open_page_timeout_minutes,
             profile_auto_clean_enabled=excluded.profile_auto_clean_enabled,
             scheduler_enabled=0,
             legacy_extra_json=excluded.legacy_extra_json`
        )
        .run(
          settings.intervalMinutes,
          settings.jitterMinutes,
          bool(settings.headless, true),
          settings.statusCheckMinutes,
          bool(settings.statusCheckOnStartup, true),
          settings.openPageTimeoutMinutes,
          bool(settings.profileAutoCleanEnabled, true),
          json(settings.legacyExtra)
        );

      const proxySettings = data.proxySettings;
      this.db.prepare("DELETE FROM proxy_settings WHERE singleton_id = 1").run();
      this.db
        .prepare(
          `INSERT INTO proxy_settings(
             singleton_id, subscription_url, subscription_updated_at, mihomo_path,
             clash_verge_dir, legacy_extra_json
           ) VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             subscription_url=excluded.subscription_url,
             subscription_updated_at=excluded.subscription_updated_at,
             mihomo_path=excluded.mihomo_path,
             clash_verge_dir=excluded.clash_verge_dir,
             legacy_extra_json=excluded.legacy_extra_json`
        )
        .run(
          proxySettings.subscriptionUrl,
          proxySettings.subscriptionUpdatedAt,
          proxySettings.mihomoPath,
          proxySettings.clashVergeDir,
          json(proxySettings.legacyExtra)
        );

      const insertProxy = this.db.prepare(
        "INSERT INTO proxy_nodes(id, sort_order, name, raw_json, enabled, missing, legacy_extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      data.proxyNodes.forEach((node, index) =>
        insertProxy.run(
          node.id,
          node.sortOrder ?? index,
          node.name,
          JSON.stringify(node.raw ?? {}),
          bool(node.enabled, true),
          bool(node.missing),
          json(node.legacyExtra)
        )
      );

      const insertGroup = this.db.prepare(
        "INSERT INTO groups(id, sort_order, name, proxy_id, timezone, locale, timezone_manual, legacy_extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      data.groups.forEach((group, index) =>
        insertGroup.run(
          group.id,
          group.sortOrder ?? index,
          group.name,
          group.proxyId,
          group.timezone,
          group.locale,
          bool(group.timezoneManual),
          json(group.legacyExtra)
        )
      );

      const insertConversation = this.db.prepare(
        "INSERT INTO conversation_sets(id, sort_order, topic, min_rounds, max_rounds, legacy_extra_json) VALUES (?, ?, ?, ?, ?, ?)"
      );
      data.conversationSets.forEach((set, index) =>
        insertConversation.run(
          set.id,
          set.sortOrder ?? index,
          set.topic,
          set.minRounds,
          set.maxRounds,
          json(set.legacyExtra)
        )
      );

      const insertAccount = this.db.prepare(
        `INSERT INTO accounts(
           id, sort_order, note, profile_name, group_id, enabled, email, gpt_name,
           switch_rule, min_windows, max_windows, rotation_current_set,
           rotation_windows_done, rotation_windows_target, legacy_extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertScheduler = this.db.prepare(
        "INSERT INTO scheduler_state(account_id, next_at, last_at, last_result_state, last_result_json) VALUES (?, NULL, NULL, NULL, NULL)"
      );
      data.accounts.forEach((account, index) => {
        insertAccount.run(
          account.id,
          account.sortOrder ?? index,
          account.note ?? "",
          account.profileName,
          account.groupId,
          bool(account.enabled, true),
          account.email,
          account.gptName,
          account.switchRule,
          account.minWindows,
          account.maxWindows,
          account.rotation?.currentSet ?? null,
          account.rotation?.windowsDone ?? 0,
          account.rotation?.windowsTarget ?? 0,
          json(account.legacyExtra)
        );
        insertScheduler.run(account.id);
      });

      const insertStatus = this.db.prepare(
        `INSERT INTO account_status(
           account_id, state, email, detail, checked_at, last_check_state,
           last_check_detail, confirmed_state, confirmed_at, consecutive_unknowns,
           unknown_since, stale, legacy_extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      );
      data.statuses.forEach((status) =>
        insertStatus.run(
          status.accountId,
          status.state,
          status.email,
          status.detail,
          status.checkedAt,
          status.lastCheckState,
          status.lastCheckDetail,
          status.confirmedState,
          status.confirmedAt,
          status.consecutiveUnknowns ?? 0,
          status.unknownSince,
          json(status.legacyExtra)
        )
      );

      const insertHistory = this.db.prepare(
        `INSERT INTO run_history(
           account_id, source, finished_at, ok, prompt, reply, error,
           payload_json, legacy_file, legacy_line
         ) VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.histories.forEach((entry) =>
        insertHistory.run(
          entry.accountId,
          entry.finishedAt,
          entry.ok == null ? null : bool(entry.ok),
          entry.prompt,
          entry.reply,
          entry.error,
          JSON.stringify(entry.payload),
          entry.legacyFile,
          entry.legacyLine
        )
      );

      const insertReject = this.db.prepare(
        "INSERT INTO migration_rejects(migration_id, kind, source_path, line_number, raw_text, error) VALUES (?, ?, ?, ?, ?, ?)"
      );
      data.rejects.forEach((reject) =>
        insertReject.run(
          id,
          reject.kind,
          reject.sourcePath,
          reject.lineNumber,
          reject.rawText,
          reject.error
        )
      );

      this.db
        .prepare(
          "UPDATE migration_imports SET state = 'completed', completed_at = ?, counts_json = ? WHERE id = ?"
        )
        .run(iso(this.clock()), JSON.stringify(counts), id);
    });
    return Object.freeze({ alreadyImported: false, migrationId: id, counts });
  }

  // -------------------------------------------------------------------------
  // Synchronous application repository API. Only the Agent should call these;
  // the Desktop accesses them through IPC application services.

  listAccounts() {
    return this.db.prepare("SELECT * FROM accounts ORDER BY sort_order, id").all().map(accountFromRow);
  }

  getAccount(id) {
    return accountFromRow(this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id));
  }

  createAccount(account) {
    if (!account?.id || !account?.profileName) {
      throw repositoryError("VALIDATION_FAILED", "账号 id 和 profileName 不能为空");
    }
    if (
      account.profileName === "." ||
      account.profileName === ".." ||
      /[\\/\0]/.test(account.profileName)
    ) {
      throw repositoryError("VALIDATION_FAILED", "profileName 必须是安全的单级目录名");
    }
    const minWindows = Number.isFinite(account.minWindows) && account.minWindows > 0 ? account.minWindows : 1;
    const maxWindows =
      Number.isFinite(account.maxWindows) && account.maxWindows >= minWindows
        ? account.maxWindows
        : Math.max(3, minWindows);
    const sortOrder =
      account.sortOrder ??
      this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM accounts").get().next;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO accounts(
             id, sort_order, note, profile_name, group_id, enabled, email, gpt_name,
             switch_rule, min_windows, max_windows, rotation_current_set,
             rotation_windows_done, rotation_windows_target, legacy_extra_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          account.id,
          sortOrder,
          account.note ?? "",
          account.profileName,
          account.groupId ?? null,
          bool(account.enabled, true),
          account.email ?? null,
          account.gptName ?? null,
          account.switchRule === "sequential" ? "sequential" : "random",
          minWindows,
          maxWindows,
          account.rotation?.currentSet ?? null,
          account.rotation?.windowsDone ?? 0,
          account.rotation?.windowsTarget ?? 0,
          json(account.legacyExtra)
        );
      this.db
        .prepare("INSERT INTO scheduler_state(account_id) VALUES (?)")
        .run(account.id);
    });
    return this.getAccount(account.id);
  }

  updateAccount(id, patch = {}) {
    const allowed = new Set([
      "note",
      "groupId",
      "enabled",
      "switchRule",
      "minWindows",
      "maxWindows",
      "email",
      "gptName",
      "rotation",
      "sortOrder",
    ]);
    const unknown = Object.keys(patch).find((key) => !allowed.has(key));
    if (unknown) throw repositoryError("VALIDATION_FAILED", `不允许更新账号字段：${unknown}`);
    const current = this.getAccount(id);
    if (!current) return null;
    const next = { ...current, ...patch, rotation: { ...current.rotation, ...(patch.rotation ?? {}) } };
    if (!Number.isFinite(next.minWindows) || next.minWindows < 1) {
      throw repositoryError("VALIDATION_FAILED", "minWindows 必须大于 0");
    }
    if (!Number.isFinite(next.maxWindows) || next.maxWindows < next.minWindows) {
      throw repositoryError("VALIDATION_FAILED", "maxWindows 不能小于 minWindows");
    }
    if (!new Set(["random", "sequential"]).has(next.switchRule)) {
      throw repositoryError("VALIDATION_FAILED", "switchRule 不受支持");
    }
    this.db
      .prepare(
        `UPDATE accounts SET
           sort_order = ?, note = ?, group_id = ?, enabled = ?, email = ?, gpt_name = ?,
           switch_rule = ?, min_windows = ?, max_windows = ?, rotation_current_set = ?,
           rotation_windows_done = ?, rotation_windows_target = ?
         WHERE id = ?`
      )
      .run(
        next.sortOrder,
        next.note ?? "",
        next.groupId ?? null,
        bool(next.enabled),
        next.email ?? null,
        next.gptName ?? null,
        next.switchRule,
        next.minWindows,
        next.maxWindows,
        next.rotation.currentSet ?? null,
        next.rotation.windowsDone ?? 0,
        next.rotation.windowsTarget ?? 0,
        id
      );
    return this.getAccount(id);
  }

  removeAccount(id) {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  listGroups() {
    return this.db.prepare("SELECT * FROM groups ORDER BY sort_order, id").all().map(groupFromRow);
  }

  getGroup(id) {
    return groupFromRow(this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id));
  }

  saveGroup(group) {
    if (!group?.id || !String(group.name ?? "").trim()) {
      throw repositoryError("VALIDATION_FAILED", "分组 id 和名称不能为空");
    }
    const sortOrder =
      group.sortOrder ??
      this.getGroup(group.id)?.sortOrder ??
      this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM groups").get().next;
    this.db
      .prepare(
        `INSERT INTO groups(
           id, sort_order, name, proxy_id, timezone, locale, timezone_manual, legacy_extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sort_order=excluded.sort_order, name=excluded.name, proxy_id=excluded.proxy_id,
           timezone=excluded.timezone, locale=excluded.locale,
           timezone_manual=excluded.timezone_manual`
      )
      .run(
        group.id,
        sortOrder,
        String(group.name).trim(),
        group.proxyId ?? null,
        group.timezone ?? null,
        group.locale ?? null,
        bool(group.tzManual),
        json(group.legacyExtra)
      );
    return this.getGroup(group.id);
  }

  removeGroup(id) {
    return this.db.prepare("DELETE FROM groups WHERE id = ?").run(id).changes > 0;
  }

  listConversationSets() {
    return this.db
      .prepare("SELECT * FROM conversation_sets ORDER BY sort_order, id")
      .all()
      .map((row) => ({
        id: row.id,
        sortOrder: row.sort_order,
        topic: row.topic,
        minRounds: row.min_rounds,
        maxRounds: row.max_rounds,
      }));
  }

  getConversationSetsObject() {
    return Object.fromEntries(
      this.listConversationSets().map(({ id, topic, minRounds, maxRounds }) => [
        id,
        { topic, minRounds, maxRounds },
      ])
    );
  }

  saveConversationSet(id, set) {
    if (!id || typeof set?.topic !== "string") {
      throw repositoryError("VALIDATION_FAILED", "会话集 id/topic 不能为空");
    }
    const minRounds = Number.isFinite(set.minRounds) && set.minRounds >= 0 ? set.minRounds : 2;
    const maxRounds =
      Number.isFinite(set.maxRounds) && set.maxRounds >= minRounds
        ? set.maxRounds
        : Math.max(8, minRounds);
    const current = this.db.prepare("SELECT sort_order FROM conversation_sets WHERE id = ?").get(id);
    const sortOrder =
      set.sortOrder ??
      current?.sort_order ??
      this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM conversation_sets").get().next;
    this.db
      .prepare(
        `INSERT INTO conversation_sets(id, sort_order, topic, min_rounds, max_rounds, legacy_extra_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, topic=excluded.topic,
           min_rounds=excluded.min_rounds, max_rounds=excluded.max_rounds`
      )
      .run(id, sortOrder, set.topic, minRounds, maxRounds, json(set.legacyExtra));
    return this.listConversationSets().find((entry) => entry.id === id) ?? null;
  }

  removeConversationSet(id) {
    return this.db.prepare("DELETE FROM conversation_sets WHERE id = ?").run(id).changes > 0;
  }

  getSettings() {
    const row = this.db.prepare("SELECT * FROM app_settings WHERE singleton_id = 1").get();
    if (!row) throw repositoryError("DATABASE_INTEGRITY_FAILED", "缺少 app_settings 单例行");
    return {
      intervalMinutes: row.interval_minutes,
      jitterMinutes: row.jitter_minutes,
      headless: !!row.headless,
      statusCheckMinutes: row.status_check_minutes,
      statusCheckOnStartup: !!row.status_check_on_startup,
      openPageTimeoutMinutes: row.open_page_timeout_minutes,
      profileAutoCleanEnabled: !!row.profile_auto_clean_enabled,
      schedulerEnabled: !!row.scheduler_enabled,
    };
  }

  updateSettings(patch = {}) {
    const allowed = new Set([
      "intervalMinutes",
      "jitterMinutes",
      "headless",
      "statusCheckMinutes",
      "statusCheckOnStartup",
      "openPageTimeoutMinutes",
      "profileAutoCleanEnabled",
      "schedulerEnabled",
    ]);
    const unknown = Object.keys(patch).find((key) => !allowed.has(key));
    if (unknown) throw repositoryError("VALIDATION_FAILED", `未知设置字段：${unknown}`);
    const next = { ...this.getSettings(), ...patch };
    for (const [key, minimum] of [
      ["intervalMinutes", 1],
      ["jitterMinutes", 0],
      ["statusCheckMinutes", 1],
      ["openPageTimeoutMinutes", 0],
    ]) {
      if (!Number.isFinite(next[key]) || next[key] < minimum) {
        throw repositoryError("VALIDATION_FAILED", `${key} 必须是不小于 ${minimum} 的有限数值`);
      }
    }
    this.db
      .prepare(
        `UPDATE app_settings SET
           interval_minutes=?, jitter_minutes=?, headless=?, status_check_minutes=?,
           status_check_on_startup=?, open_page_timeout_minutes=?,
           profile_auto_clean_enabled=?, scheduler_enabled=? WHERE singleton_id=1`
      )
      .run(
        next.intervalMinutes,
        next.jitterMinutes,
        bool(next.headless),
        next.statusCheckMinutes,
        bool(next.statusCheckOnStartup),
        next.openPageTimeoutMinutes,
        bool(next.profileAutoCleanEnabled),
        bool(next.schedulerEnabled)
      );
    return this.getSettings();
  }

  listStatuses() {
    return this.db.prepare("SELECT * FROM account_status ORDER BY account_id").all().map(statusFromRow);
  }

  getStatus(accountId) {
    return statusFromRow(
      this.db.prepare("SELECT * FROM account_status WHERE account_id = ?").get(accountId)
    );
  }

  upsertStatus(accountId, status = {}) {
    if (!this.getAccount(accountId)) return null;
    const current = this.getStatus(accountId) ?? {
      state: null,
      email: null,
      detail: null,
      checkedAt: null,
      lastCheckState: null,
      lastCheckDetail: null,
      confirmedState: null,
      confirmedAt: null,
      consecutiveUnknowns: 0,
      unknownSince: null,
      stale: true,
    };
    const next = { ...current, ...status };
    this.db
      .prepare(
        `INSERT INTO account_status(
           account_id, state, email, detail, checked_at, last_check_state,
           last_check_detail, confirmed_state, confirmed_at, consecutive_unknowns,
           unknown_since, stale, legacy_extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(account_id) DO UPDATE SET
           state=excluded.state, email=excluded.email, detail=excluded.detail,
           checked_at=excluded.checked_at, last_check_state=excluded.last_check_state,
           last_check_detail=excluded.last_check_detail, confirmed_state=excluded.confirmed_state,
           confirmed_at=excluded.confirmed_at, consecutive_unknowns=excluded.consecutive_unknowns,
           unknown_since=excluded.unknown_since, stale=excluded.stale`
      )
      .run(
        accountId,
        next.state,
        next.email,
        next.detail,
        next.checkedAt,
        next.lastCheckState,
        next.lastCheckDetail,
        next.confirmedState,
        next.confirmedAt,
        next.consecutiveUnknowns ?? 0,
        next.unknownSince,
        bool(next.stale)
      );
    return this.getStatus(accountId);
  }

  replaceStatuses(statuses = {}) {
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      throw repositoryError("VALIDATION_FAILED", "statuses 必须是账号状态对象");
    }
    this.transaction(() => {
      const ids = new Set(Object.keys(statuses));
      for (const [accountId, status] of Object.entries(statuses)) {
        this.upsertStatus(accountId, status);
      }
      const remove = this.db.prepare("DELETE FROM account_status WHERE account_id = ?");
      for (const row of this.db.prepare("SELECT account_id FROM account_status").all()) {
        if (!ids.has(row.account_id)) remove.run(row.account_id);
      }
    });
    return this.listStatuses();
  }

  queryHistory({ accountId = null, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 50));
    const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
    const rows = accountId
      ? this.db
          .prepare("SELECT * FROM run_history WHERE account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?")
          .all(accountId, safeLimit, safeOffset)
      : this.db
          .prepare("SELECT * FROM run_history ORDER BY id DESC LIMIT ? OFFSET ?")
          .all(safeLimit, safeOffset);
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      source: row.source,
      finishedAt: row.finished_at,
      ok: row.ok == null ? null : !!row.ok,
      prompt: row.prompt,
      reply: row.reply,
      error: row.error,
      payload: parseJson(row.payload_json, {}),
      legacyFile: row.legacy_file,
      legacyLine: row.legacy_line,
    }));
  }

  listHistoryAccounts() {
    return this.db
      .prepare(
        `SELECT h.account_id,
                COUNT(*) AS entry_count,
                MAX(COALESCE(h.finished_at, '')) AS last_at,
                CASE WHEN a.id IS NULL THEN 1 ELSE 0 END AS deleted,
                a.note,
                a.email,
                a.gpt_name
           FROM run_history h
           LEFT JOIN accounts a ON a.id = h.account_id
          WHERE h.account_id IS NOT NULL AND h.account_id <> ''
          GROUP BY h.account_id, a.id, a.note, a.email, a.gpt_name
          ORDER BY last_at DESC, h.account_id ASC`
      )
      .all()
      .map((row) => ({
        accountId: row.account_id,
        entryCount: Number(row.entry_count),
        lastAt: row.last_at || null,
        deleted: !!row.deleted,
        note: row.note ?? null,
        email: row.email ?? null,
        gptName: row.gpt_name ?? null,
      }));
  }

  appendHistory(accountId, entry, { source = "agent" } = {}) {
    const finishedAt = entry.finishedAt ?? entry.time ?? iso(this.clock());
    // payload 必须带上时间戳。runOnce 的结果里没有 time —— JSON 后端在写入时补了
    // 一个，SQLite 后端却直接 stringify 原始对象，于是历史列表全部显示"未知时间"。
    // 两条后端要产出同样的形状。
    const payload = { time: finishedAt, ...entry };
    const result = this.db
      .prepare(
        `INSERT INTO run_history(
           account_id, source, finished_at, ok, prompt, reply, error, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        accountId ?? null,
        source,
        finishedAt,
        entry.ok == null ? null : bool(entry.ok),
        entry.prompt ?? null,
        entry.reply ?? null,
        entry.error ?? entry.reason ?? null,
        JSON.stringify(payload)
      );
    return this.queryHistory({ limit: 1 }).find((item) => item.id === Number(result.lastInsertRowid)) ?? null;
  }

  getSchedulerState() {
    const settings = this.getSettings();
    const accounts = Object.fromEntries(
      this.db
        .prepare("SELECT * FROM scheduler_state ORDER BY account_id")
        .all()
        .map((row) => [
          row.account_id,
          {
            nextAt: row.next_at,
            lastAt: row.last_at,
            lastResultState: row.last_result_state,
            lastResult: parseJson(row.last_result_json),
          },
        ])
    );
    return { enabled: settings.schedulerEnabled, accounts };
  }

  updateSchedulerAccount(accountId, patch = {}) {
    if (!this.getAccount(accountId)) return null;
    const current = this.db.prepare("SELECT * FROM scheduler_state WHERE account_id = ?").get(accountId) ?? {};
    const next = {
      nextAt: patch.nextAt !== undefined ? patch.nextAt : current.next_at ?? null,
      lastAt: patch.lastAt !== undefined ? patch.lastAt : current.last_at ?? null,
      lastResultState:
        patch.lastResultState !== undefined ? patch.lastResultState : current.last_result_state ?? null,
      lastResult: patch.lastResult !== undefined ? patch.lastResult : parseJson(current.last_result_json),
    };
    this.db
      .prepare(
        `INSERT INTO scheduler_state(account_id, next_at, last_at, last_result_state, last_result_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET next_at=excluded.next_at, last_at=excluded.last_at,
           last_result_state=excluded.last_result_state, last_result_json=excluded.last_result_json`
      )
      .run(accountId, next.nextAt, next.lastAt, next.lastResultState, json(next.lastResult));
    return this.getSchedulerState().accounts[accountId];
  }

  setSchedulerEnabled(enabled) {
    return this.updateSettings({ schedulerEnabled: !!enabled }).schedulerEnabled;
  }

  getProxyState({ includeSecrets = false } = {}) {
    const settings = this.db.prepare("SELECT * FROM proxy_settings WHERE singleton_id = 1").get();
    const rows = this.db.prepare("SELECT * FROM proxy_nodes ORDER BY sort_order, id").all();
    let subscriptionHost = null;
    if (settings.subscription_url) {
      try {
        subscriptionHost = new URL(settings.subscription_url).host;
      } catch {
        subscriptionHost = null;
      }
    }
    return {
      subscription: includeSecrets
        ? { url: settings.subscription_url, updatedAt: settings.subscription_updated_at }
        : {
            configured: !!settings.subscription_url,
            host: subscriptionHost,
            updatedAt: settings.subscription_updated_at,
          },
      mihomoPath: includeSecrets ? settings.mihomo_path : null,
      clashVergeDir: settings.clash_verge_dir,
      nodes: rows.map((row) => {
        const raw = parseJson(row.raw_json, {});
        return {
          id: row.id,
          sortOrder: row.sort_order,
          name: row.name,
          enabled: !!row.enabled,
          missing: !!row.missing,
          ...(includeSecrets
            ? { raw }
            : { type: raw.type ?? null, server: raw.server ?? null, port: raw.port ?? null }),
        };
      }),
    };
  }

  updateProxySettings(patch = {}) {
    const current = this.getProxyState({ includeSecrets: true });
    const subscription = patch.subscription ?? current.subscription;
    const mihomoPath = patch.mihomoPath !== undefined ? patch.mihomoPath : current.mihomoPath;
    const clashVergeDir =
      patch.clashVergeDir !== undefined ? patch.clashVergeDir : current.clashVergeDir;
    this.db
      .prepare(
        `UPDATE proxy_settings SET subscription_url=?, subscription_updated_at=?,
         mihomo_path=?, clash_verge_dir=? WHERE singleton_id=1`
      )
      .run(
        subscription?.url ?? null,
        subscription?.updatedAt ?? null,
        mihomoPath ?? null,
        clashVergeDir ?? null
      );
    return this.getProxyState();
  }

  replaceProxyNodes(nodes) {
    if (!Array.isArray(nodes)) throw repositoryError("VALIDATION_FAILED", "nodes 必须是数组");
    const ids = new Set();
    for (const node of nodes) {
      if (!node?.id || ids.has(node.id)) {
        throw repositoryError("VALIDATION_FAILED", "代理节点 id 不能为空或重复");
      }
      ids.add(node.id);
    }
    this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO proxy_nodes(id, sort_order, name, raw_json, enabled, missing, legacy_extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, name=excluded.name,
           raw_json=excluded.raw_json, enabled=excluded.enabled, missing=excluded.missing`
      );
      nodes.forEach((node, index) =>
        upsert.run(
          node.id,
          node.sortOrder ?? index,
          node.name ?? node.id,
          JSON.stringify(node.raw ?? {}),
          bool(node.enabled, true),
          bool(node.missing),
          json(node.legacyExtra)
        )
      );
      const existing = this.db.prepare("SELECT id FROM proxy_nodes").all();
      const references = this.db.prepare("SELECT COUNT(*) AS count FROM groups WHERE proxy_id = ?");
      const markMissing = this.db.prepare(
        "UPDATE proxy_nodes SET enabled=0, missing=1, raw_json='{}' WHERE id=?"
      );
      const remove = this.db.prepare("DELETE FROM proxy_nodes WHERE id=?");
      for (const row of existing) {
        if (ids.has(row.id)) continue;
        if (references.get(row.id).count > 0) markMissing.run(row.id);
        else remove.run(row.id);
      }
    });
    return this.getProxyState();
  }

  setProxyNodeEnabled(id, enabled) {
    const result = this.db
      .prepare("UPDATE proxy_nodes SET enabled=? WHERE id=?")
      .run(bool(enabled), id);
    return result.changes ? this.getProxyState().nodes.find((node) => node.id === id) ?? null : null;
  }

  listProfileMaintenance() {
    return this.db
      .prepare("SELECT * FROM profile_maintenance_state ORDER BY profile_name")
      .all()
      .map((row) => ({
        profileName: row.profile_name,
        lastScannedAt: row.last_scanned_at,
        lastCleanedAt: row.last_cleaned_at,
        sizeBytes: row.size_bytes,
        cacheBytes: row.cache_bytes,
        state: parseJson(row.state_json),
      }));
  }

  upsertProfileMaintenance(profileName, state = {}) {
    this.db
      .prepare(
        `INSERT INTO profile_maintenance_state(
           profile_name, last_scanned_at, last_cleaned_at, size_bytes, cache_bytes, state_json
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_name) DO UPDATE SET
           last_scanned_at=excluded.last_scanned_at,
           last_cleaned_at=excluded.last_cleaned_at,
           size_bytes=excluded.size_bytes,
           cache_bytes=excluded.cache_bytes,
           state_json=excluded.state_json`
      )
      .run(
        profileName,
        state.lastScannedAt ?? null,
        state.lastCleanedAt ?? null,
        state.sizeBytes ?? null,
        state.cacheBytes ?? null,
        json(state.state)
      );
    return this.listProfileMaintenance().find((item) => item.profileName === profileName) ?? null;
  }

  listProfileFileOperations({ activeOnly = false } = {}) {
    const rows = activeOnly
      ? this.db
          .prepare(
            "SELECT * FROM profile_fs_operations WHERE state NOT IN ('succeeded','failed','cancelled') ORDER BY created_at"
          )
          .all()
      : this.db.prepare("SELECT * FROM profile_fs_operations ORDER BY created_at DESC").all();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      profileName: row.profile_name,
      state: row.state,
      sourcePath: row.source_path,
      targetPath: row.target_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: parseJson(row.error_json),
    }));
  }

  saveProfileFileOperation(operation) {
    if (!operation?.id || !operation?.kind || !operation?.profileName || !operation?.state) {
      throw repositoryError("VALIDATION_FAILED", "Profile 文件操作缺少必要字段");
    }
    const current = this.db.prepare("SELECT created_at FROM profile_fs_operations WHERE id=?").get(operation.id);
    const now = iso(this.clock());
    this.db
      .prepare(
        `INSERT INTO profile_fs_operations(
           id, kind, profile_name, state, source_path, target_path, created_at, updated_at, error_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, profile_name=excluded.profile_name,
           state=excluded.state, source_path=excluded.source_path,
           target_path=excluded.target_path, updated_at=excluded.updated_at,
           error_json=excluded.error_json`
      )
      .run(
        operation.id,
        operation.kind,
        operation.profileName,
        operation.state,
        operation.sourcePath ?? null,
        operation.targetPath ?? null,
        current?.created_at ?? operation.createdAt ?? now,
        operation.updatedAt ?? now,
        json(operation.error)
      );
    return this.listProfileFileOperations().find((item) => item.id === operation.id) ?? null;
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

function removeOldBackups(backupDirectory, keep, fsImpl = fs) {
  if (!fsImpl.existsSync(backupDirectory)) return;
  const candidates = fsImpl
    .readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^keeper-v\d+-.*\.db$/.test(entry.name))
    .map((entry) => {
      const file = path.join(backupDirectory, entry.name);
      return { file, mtimeMs: fsImpl.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(keep)) fsImpl.unlinkSync(candidate.file);
}

/**
 * Open/configure/migrate the database. Driver injection keeps pure tests and
 * migration planning independent of the native better-sqlite3 addon.
 */
export async function openKeeperRepository({
  filePath,
  Database = null,
  backupDirectory = null,
  backupRetention = 3,
  clock = () => new Date(),
  appVersion = null,
  fsImpl = fs,
} = {}) {
  const resolved = ensureAbsoluteDatabasePath(filePath);
  fsImpl.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const existedWithData = fsImpl.existsSync(resolved) && fsImpl.statSync(resolved).size > 0;
  const Driver = Database || loadDriver();
  const database = new Driver(resolved);
  const repository = new KeeperRepository(database, { clock, appVersion });
  try {
    repository.configure();
    const version = repository.getSchemaVersion();
    if (version > SCHEMA_VERSION) {
      throw repositoryError(
        "DATABASE_TOO_NEW",
        `数据库版本 ${version} 高于当前 Agent 支持的 ${SCHEMA_VERSION}`
      );
    }
    if (existedWithData && version < SCHEMA_VERSION && backupDirectory) {
      const backupPath = path.join(
        path.resolve(backupDirectory),
        backupFileName(version, clock())
      );
      await repository.backupTo(backupPath);
      removeOldBackups(path.resolve(backupDirectory), backupRetention, fsImpl);
    }
    repository.applyMigrations();
    const check = repository.integrityCheck();
    if (!check.ok) {
      throw repositoryError("DATABASE_INTEGRITY_FAILED", "SQLite 完整性检查失败");
    }
    try {
      fsImpl.chmodSync(resolved, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    return repository;
  } catch (error) {
    repository.close();
    throw error;
  }
}

export { DEFAULT_RECEIPT_TTL_MS };
