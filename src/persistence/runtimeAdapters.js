import { randomBytes } from "node:crypto";

function publicStatusMap(repository) {
  return Object.fromEntries(
    repository.listStatuses().map(({ accountId, ...status }) => [accountId, status])
  );
}

function nextId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export class SqliteReceiptStore {
  constructor(repository) {
    this.repository = repository;
  }

  async get(commandId, method = "ipc") {
    return this.repository.getCommandReceipt(commandId, method)?.response ?? null;
  }

  async put(commandId, value, options = {}) {
    this.repository.recordCommandReceipt(commandId, options.method ?? "ipc", value, {
      ttlMs: options.ttlMs,
    });
  }

  async delete(commandId) {
    return this.repository.db
      .prepare("DELETE FROM command_receipts WHERE command_id = ?")
      .run(commandId).changes > 0;
  }
}

export function createSqliteRuntimeAdapters(repository) {
  if (!repository) throw new TypeError("repository is required");

  const store = {
    getAccounts: () => repository.listAccounts(),
    getAccount: (id) => repository.getAccount(id),
    saveAccounts(accounts) {
      const incoming = new Map(accounts.map((account) => [account.id, account]));
      repository.transaction(() => {
        for (const current of repository.listAccounts()) {
          if (!incoming.has(current.id)) repository.removeAccount(current.id);
        }
        for (const account of accounts) {
          const current = repository.getAccount(account.id);
          if (current) {
            const {
              id: _id,
              profileName: _profileName,
              profileDir: _profileDir,
              ...patch
            } = account;
            repository.updateAccount(account.id, patch);
          }
          else repository.createAccount({
            ...account,
            profileName: account.profileName ?? account.id,
          });
        }
      });
      return repository.listAccounts();
    },
    addAccount(options = {}) {
      const id = nextId("acc");
      return repository.createAccount({
        id,
        profileName: id,
        note: options.note ?? "",
        groupId: options.groupId ?? null,
        enabled: true,
        switchRule: options.switchRule ?? "random",
        minWindows: options.minWindows ?? 1,
        maxWindows: options.maxWindows ?? 3,
        rotation: { currentSet: null, windowsDone: 0, windowsTarget: 0 },
      });
    },
    updateAccount: (id, patch) => repository.updateAccount(id, patch),
    removeAccount: (id) => repository.removeAccount(id),
    getGroups: () => repository.listGroups(),
    getGroup: (id) => repository.getGroup(id),
    effectiveProxyId(account) {
      return account?.groupId ? repository.getGroup(account.groupId)?.proxyId ?? null : null;
    },
    addGroup(name, proxyId = null, extra = {}) {
      return repository.saveGroup({
        id: nextId("grp"),
        name,
        proxyId: proxyId || null,
        timezone: extra.timezone || null,
        locale: extra.locale || null,
      });
    },
    updateGroup(id, patch = {}) {
      const current = repository.getGroup(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      if (Object.hasOwn(patch, "timezone")) next.tzManual = !!patch.timezone;
      if (
        Object.hasOwn(patch, "proxyId") &&
        patch.proxyId !== current.proxyId &&
        !current.tzManual &&
        !Object.hasOwn(patch, "timezone")
      ) {
        next.timezone = null;
        next.locale = null;
      }
      return repository.saveGroup(next);
    },
    saveDetectedRegion(id, region = {}) {
      const current = repository.getGroup(id);
      if (!current || current.tzManual) return null;
      return repository.saveGroup({
        ...current,
        timezone: region.timezone || current.timezone,
        locale: region.locale || current.locale,
      });
    },
    removeGroup: (id) => repository.removeGroup(id),
    getConversations: () => repository.getConversationSetsObject(),
    saveConversationSet: (name, set) => repository.saveConversationSet(name, set),
    removeConversationSet: (name) => repository.removeConversationSet(name),
    getSettings: () => repository.getSettings(),
    saveSettings: (patch) => repository.updateSettings(patch),
  };

  const history = {
    recordConversation(accountId, entry) {
      return repository.appendHistory(accountId, entry);
    },
    readHistory(accountId, limit = 50) {
      return repository.queryHistory({ accountId, limit }).map((entry) => {
        const payload = entry.payload ?? {};
        // 早于本次修复写入的行，payload 里没有 time；finished_at 列一直是对的，
        // 用它兜底，避免这些历史记录显示成"未知时间"。
        return payload.time ? payload : { ...payload, time: entry.finishedAt ?? null };
      });
    },
    listHistoryAccounts() {
      return repository.listHistoryAccounts();
    },
  };

  const status = {
    readPersistedStatuses: () => publicStatusMap(repository),
    writePersistedStatuses: (statuses) => repository.replaceStatuses(statuses),
  };

  const proxy = {
    readProxyStore() {
      const state = repository.getProxyState({ includeSecrets: true });
      return {
        subscription: state.subscription?.url ? state.subscription : null,
        nodes: state.nodes,
        mihomoPath: state.mihomoPath,
        clashVergeDir: state.clashVergeDir,
      };
    },
    writeProxyStore(value) {
      repository.updateProxySettings({
        subscription: value.subscription ?? null,
        mihomoPath: value.mihomoPath ?? null,
        clashVergeDir: value.clashVergeDir ?? null,
      });
      repository.replaceProxyNodes(value.nodes ?? []);
      return value;
    },
  };

  const scheduler = {
    load: () => repository.getSchedulerState(),
    setEnabled: (enabled) => repository.setSchedulerEnabled(enabled),
    saveAccount: (accountId, state) => repository.updateSchedulerAccount(accountId, state),
  };

  const operations = {
    save: (operation) => repository.saveOperation(operation),
    list: (options) => repository.listOperations(options),
    listLatestAccountRuns: () => repository.listLatestAccountRuns(),
    cancelUnfinished: () => repository.cancelUnfinishedOperations(),
    prune: () => repository.pruneOperations(),
  };

  return {
    store,
    history,
    status,
    proxy,
    scheduler,
    operations,
    receiptStore: new SqliteReceiptStore(repository),
  };
}
