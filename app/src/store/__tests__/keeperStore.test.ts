// store 层回归测试。
//
// 每个 describe 对应一个已经发生过的用户可见缺陷。用 Agent 的真实 payload 形状驱动真实
// store（只桩 Tauri 的 invoke / listen），所以窄化、合并、筛选都真实执行。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeAccount,
  makeBootstrap,
  makeOperation,
  makeProfileInfo,
  makeProfileScan,
  tauri,
} from "@/test/harness";
import type { Operation } from "@/ipc/types";
import { __resetKeeperStoreForTests, useKeeperStore } from "../keeperStore";
import { selectVisibleAccounts } from "../accountModel";

const store = () => useKeeperStore.getState();

/// 让挂起的 microtask 队列跑完。store 的动作大量使用 await，事件驱动的断言需要它。
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await store().bootstrapApp();
  await flush();
});

describe("全量快照与增量事件的闭环", () => {
  it("bootstrap 填充账号、分组、会话与调度状态", () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
        groups: [{ id: "g1", name: "香港", proxyId: null, timezone: null, locale: null }],
        conversations: { daily: { topic: "技术", minRounds: 1, maxRounds: 3 } },
        scheduler: { running: true, enabled: true, accounts: {}, lastResults: {} },
      })
    );

    expect(store().accountIds).toEqual(["acc-1", "acc-2"]);
    expect(store().groups).toHaveLength(1);
    expect(store().conversations.daily?.topic).toBe("技术");
    expect(store().scheduler.running).toBe(true);
  });

  it("group.changed 的新增、更新与 {id, removed} 删除都正确落地", () => {
    tauri.emitBootstrap(makeBootstrap());

    tauri.emitAgentEvent("group.changed", {
      id: "g1",
      name: "香港",
      proxyId: null,
      timezone: null,
      locale: null,
    });
    expect(store().groups.map((g) => g.name)).toEqual(["香港"]);

    tauri.emitAgentEvent("group.changed", {
      id: "g1",
      name: "香港（改名）",
      proxyId: "node-1",
      timezone: "Asia/Hong_Kong",
      locale: "zh-HK",
    });
    expect(store().groups).toHaveLength(1);
    expect(store().groups[0]?.name).toBe("香港（改名）");
    expect(store().groups[0]?.proxyId).toBe("node-1");

    tauri.emitAgentEvent("group.changed", { id: "g1", removed: true });
    expect(store().groups).toEqual([]);
  });

  it("conversation.changed 的 {name, set} 与 {name, removed} 都正确落地", () => {
    tauri.emitAgentEvent("conversation.changed", {
      name: "daily",
      set: { topic: "Rust 异步", minRounds: 2, maxRounds: 5 },
    });
    expect(store().conversations.daily).toEqual({
      topic: "Rust 异步",
      minRounds: 2,
      maxRounds: 5,
    });

    tauri.emitAgentEvent("conversation.changed", { name: "daily", removed: true });
    expect(store().conversations.daily).toBeUndefined();
  });

  it("scheduler.accountChanged 把排期投影到账号卡片，并区分显式 null 与字段缺失", () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1", lastRunOk: true, lastRunAt: "2026-08-01T00:00:00Z" })],
      })
    );

    tauri.emitAgentEvent("scheduler.accountChanged", {
      accountId: "acc-1",
      nextAt: "2026-09-01T10:00:00Z",
      busy: true,
    });

    // nextAt 给了就更新；lastResult 没提到，lastRunOk 必须保持原值。
    expect(store().accounts["acc-1"]?.effective.nextRunAt).toBe("2026-09-01T10:00:00Z");
    expect(store().accounts["acc-1"]?.effective.lastRunOk).toBe(true);
    expect(store().scheduler.accounts["acc-1"]?.busy).toBe(true);

    // lastResult 显式为 null 表示清空。
    tauri.emitAgentEvent("scheduler.accountChanged", {
      accountId: "acc-1",
      lastResult: null,
    });
    expect(store().accounts["acc-1"]?.effective.lastRunOk).toBeNull();
  });

  it("scheduler.changed 之后同步托盘状态", () => {
    tauri.emitAgentEvent("scheduler.changed", {
      running: true,
      enabled: true,
      accounts: {},
      lastResults: {},
    });

    expect(store().scheduler.running).toBe(true);
    expect(
      tauri.calls.some(
        (call) => call.command === "set_scheduler_tray_state" && call.args?.running === true
      )
    ).toBe(true);
  });

  it("scheduler.accountChanged 显式清空结果时同步清掉调度视图中的旧错误", () => {
    tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount()] }));
    tauri.emitAgentEvent("scheduler.accountChanged", {
      accountId: "acc-1",
      nextAt: "2026-09-01T10:00:00Z",
      lastAt: "2026-08-31T10:00:00Z",
      lastResult: { ok: false, reason: "旧的端口超时" },
    });

    tauri.emitAgentEvent("scheduler.accountChanged", {
      accountId: "acc-1",
      nextAt: null,
      lastAt: null,
      lastResult: null,
    });

    expect(store().scheduler.accounts["acc-1"]).toMatchObject({
      nextRunAt: null,
      lastRunAt: null,
      lastRunOk: null,
      reason: null,
    });
    expect(store().accounts["acc-1"]?.effective.lastRunReason).toBeNull();
  });

  it("增量事件不破坏筛选与勾选状态", () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [
          makeAccount({ id: "acc-1", status: "reauth" }),
          makeAccount({ id: "acc-2", status: "reauth" }),
          makeAccount({ id: "acc-3", status: "reauth" }),
        ],
      })
    );

    store().selectAccounts(["acc-1", "acc-2", "acc-3"]);
    store().setAccountFilter({ status: "reauth" });

    tauri.emitAgentEvent("accountStatus.changed", { id: "acc-1", status: "ok" });

    // 勾选保持。
    expect(store().selectedAccountIds.size).toBe(3);
    // 而那张卡在「仅需登录」筛选下消失。
    const visible = selectVisibleAccounts(
      store().accounts,
      store().accountIds,
      store().accountFilter
    );
    expect(visible.map((record) => record.effective.id)).toEqual(["acc-2", "acc-3"]);
  });

  it("bootstrap 清掉已不存在账号的勾选，保留仍存在的", () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
      })
    );
    store().selectAccounts(["acc-1", "acc-2"]);

    tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount({ id: "acc-1" })] }));

    expect([...store().selectedAccountIds]).toEqual(["acc-1"]);
  });

  it("account.removed 同时清掉勾选", () => {
    tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount({ id: "acc-1" })] }));
    store().selectAccounts(["acc-1"]);

    tauri.emitAgentEvent("account.removed", { id: "acc-1" });

    expect(store().accountIds).toEqual([]);
    expect(store().selectedAccountIds.size).toBe(0);
  });

  it("openPage.changed 用 open 字段更新 pageOpen", () => {
    tauri.emitBootstrap(
      makeBootstrap({ accounts: [makeAccount({ id: "acc-1", pageOpen: false })] })
    );
    tauri.emitAgentEvent("openPage.changed", { id: "acc-1", open: true });
    expect(store().accounts["acc-1"]?.effective.pageOpen).toBe(true);
  });
});

describe("测速结果回填到节点行", () => {
  const nodes = [
    {
      id: "node-1",
      name: "香港 01",
      server: "hk1.example.com",
      port: 443,
      type: "vmess",
      enabled: true,
      latencyMs: null,
      latencyOk: null,
      latencyMessage: null,
      latencyTestedAt: null,
    },
    {
      id: "node-2",
      name: "日本 01",
      server: "jp1.example.com",
      port: 443,
      type: "vmess",
      enabled: true,
      latencyMs: null,
      latencyOk: null,
      latencyMessage: null,
      latencyTestedAt: null,
    },
  ];

  beforeEach(() => {
    tauri.emitBootstrap(
      makeBootstrap({
        proxies: {
          nodes,
          status: {
            running: true,
            basePort: 7890,
            basePortShifted: false,
            nodeCount: 2,
            routedNodeCount: 2,
            subscription: null,
            clashVergeDir: null,
            mihomo: { path: "mihomo.exe", found: true },
          },
          subscription: null,
          runtime: null,
        },
      })
    );
  });

  it("成功的测速把延迟写回那一行", () => {
    tauri.emitAgentEvent("proxyNode.tested", {
      id: "node-1",
      ok: true,
      delay: 186,
      message: null,
      testedAt: "2026-08-27T10:00:00Z",
    });

    const node = store().proxies.nodes.find((item) => item.id === "node-1");
    expect(node?.latencyMs).toBe(186);
    expect(node?.latencyOk).toBe(true);
    expect(node?.latencyTestedAt).toBe("2026-08-27T10:00:00Z");
    // 另一行不受影响。
    expect(store().proxies.nodes.find((item) => item.id === "node-2")?.latencyMs).toBeNull();
  });

  it("失败的测速把原因写回那一行，而不是留一个空延迟", () => {
    tauri.emitAgentEvent("proxyNode.tested", {
      id: "node-1",
      ok: false,
      delay: null,
      message: "连接超时",
      testedAt: "2026-08-27T10:00:00Z",
    });

    const node = store().proxies.nodes.find((item) => item.id === "node-1");
    expect(node?.latencyOk).toBe(false);
    expect(node?.latencyMessage).toBe("连接超时");
    expect(node?.latencyMs).toBeNull();
  });

  it("未知节点的测速事件不会新增一行", () => {
    tauri.emitAgentEvent("proxyNode.tested", {
      id: "node-not-in-list",
      ok: true,
      delay: 100,
      message: null,
      testedAt: "2026-08-27T10:00:00Z",
    });

    expect(store().proxies.nodes).toHaveLength(2);
  });
});

describe("runOperation 的终态语义", () => {
  it("提交后保持 pending，直到终态 succeeded 才 resolve", async () => {
    tauri.onMethod("proxies.testAll", () => makeOperation({ id: "op-A", state: "queued" }));

    let settled = false;
    const promise = store()
      .runOperation("proxies.testAll", {})
      .then((operation) => {
        settled = true;
        return operation;
      });

    await flush();
    expect(settled).toBe(false);

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-A", state: "succeeded", result: { tested: 2 } })
    );

    const resolved = await promise;
    expect(resolved.state).toBe("succeeded");
    expect(resolved.result).toEqual({ tested: 2 });
  });

  it("终态 failed 时抛出带稳定错误码的错误", async () => {
    tauri.onMethod("proxies.testAll", () => makeOperation({ id: "op-B", state: "running" }));

    const promise = store().runOperation("proxies.testAll", {});
    await flush();

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-B",
        state: "failed",
        error: { code: "PROXY_UNAVAILABLE", message: "节点不可用", retryable: true },
      })
    );

    await expect(promise).rejects.toMatchObject({ code: "PROXY_UNAVAILABLE" });
  });

  it("缺 id 或非对象的响应立即抛错，不返回假数据", async () => {
    tauri.onMethod("proxies.testAll", () => ({ notAnId: true }));
    await expect(store().runOperation("proxies.testAll", {})).rejects.toThrow(
      /未返回有效的 Operation 描述符/
    );

    tauri.onMethod("proxies.testAll", () => null);
    await expect(store().runOperation("proxies.testAll", {})).rejects.toThrow(
      /未返回有效的 Operation 描述符/
    );
  });

  it("未知 state 立即失败，不留悬挂的 waiter", async () => {
    tauri.onMethod("proxies.testAll", () =>
      makeOperation({ id: "op-C", state: "bizarre" as Operation["state"] })
    );
    await expect(store().runOperation("proxies.testAll", {})).rejects.toThrow(
      /处于未知状态/
    );
  });

  it("终态早于响应到达的竞态能正确完成", async () => {
    // Agent 很快就做完了：operation.changed 的终态在 agent_call 返回之前就到了。
    tauri.onMethod("profiles.cleanCache", () => {
      tauri.emitAgentEvent(
        "operation.changed",
        makeOperation({
          id: "op-D",
          kind: "profile-clean",
          state: "succeeded",
          result: { profilesCleaned: 3 },
        })
      );
      return makeOperation({ id: "op-D", kind: "profile-clean", state: "queued" });
    });

    const operation = await store().runOperation("profiles.cleanCache", { scope: "all" });
    expect(operation.state).toBe("succeeded");
    expect(operation.result).toEqual({ profilesCleaned: 3 });
  });

  it("非终态的中间事件不会让 promise 提前 settle", async () => {
    tauri.onMethod("proxies.testAll", () => makeOperation({ id: "op-E", state: "queued" }));

    let settled = false;
    const promise = store()
      .runOperation("proxies.testAll", {})
      .then(() => {
        settled = true;
      });
    await flush();

    tauri.emitAgentEvent("operation.changed", makeOperation({ id: "op-E", state: "running" }));
    await flush();
    expect(settled).toBe(false);

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-E", state: "succeeded" })
    );
    await promise;
    expect(settled).toBe(true);
  });
});

describe("批量操作", () => {
  beforeEach(() => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [
          makeAccount({ id: "acc-1", enabled: false }),
          makeAccount({ id: "acc-2", enabled: false }),
          makeAccount({ id: "acc-3", enabled: false }),
        ],
      })
    );
  });

  it("批量立即运行串行执行，不会同时拉起多个 Chrome", async () => {
    const active: string[] = [];
    let maxConcurrent = 0;

    tauri.onMethod("accounts.runNow", async (params) => {
      active.push(String(params.id));
      maxConcurrent = Math.max(maxConcurrent, active.length);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.pop();
      return null;
    });

    await store().bulkRunNow(["acc-1", "acc-2", "acc-3"]);

    expect(maxConcurrent).toBe(1);
    expect(
      tauri.methodSequence().filter((method) => method === "accounts.runNow")
    ).toHaveLength(3);
  });

  it("部分失败时不报成功，并说出失败数量与首个错误码", async () => {
    const { notify } = await import("@/lib/notify");
    const errorSpy = vi.spyOn(notify, "error");
    const successSpy = vi.spyOn(notify, "success");

    tauri.onMethod("accounts.refreshStatus", (params) => {
      if (params.id === "acc-2") {
        return Promise.reject({ code: "RESOURCE_BUSY", message: "忙", retryable: true });
      }
      return null;
    });

    await store().bulkRefreshStatus(["acc-1", "acc-2", "acc-3"]);

    expect(successSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "批量刷新状态部分失败",
      expect.stringContaining("失败 1 个")
    );
    expect(errorSpy.mock.calls[0]?.[1]).toContain("RESOURCE_BUSY");
  });

  it("批量启用把结果应用到卡片上", async () => {
    tauri.onMethod("accounts.update", (params) => {
      const patch = params.patch as { enabled?: boolean };
      return makeAccount({ id: String(params.id), enabled: patch.enabled ?? false });
    });

    await store().bulkSetEnabled(["acc-1", "acc-2"], true);

    expect(store().accounts["acc-1"]?.effective.enabled).toBe(true);
    expect(store().accounts["acc-2"]?.effective.enabled).toBe(true);
    // 没被操作的那个保持原状。
    expect(store().accounts["acc-3"]?.effective.enabled).toBe(false);
  });

  it("批量启用失败的那一项不会被标成已启用", async () => {
    tauri.onMethod("accounts.update", (params) => {
      if (params.id === "acc-2") {
        return Promise.reject({ code: "NOT_FOUND", message: "账号不存在", retryable: false });
      }
      const patch = params.patch as { enabled?: boolean };
      return makeAccount({ id: String(params.id), enabled: patch.enabled ?? false });
    });

    await store().bulkSetEnabled(["acc-1", "acc-2"], true);

    expect(store().accounts["acc-1"]?.effective.enabled).toBe(true);
    expect(store().accounts["acc-2"]?.effective.enabled).toBe(false);
  });

  it("批量删除只移除成功的那些，失败的留在列表里", async () => {
    tauri.onMethod("accounts.remove", (params) => {
      if (params.id === "acc-2") {
        return Promise.reject({ code: "PROFILE_IN_USE", message: "占用中", retryable: true });
      }
      return null;
    });

    await store().bulkRemove(["acc-1", "acc-2", "acc-3"], "archive");

    expect(store().accountIds).toEqual(["acc-2"]);
  });
});

describe("Profile 扫描", () => {
  it("扫描结果来自 operation.changed，而不是 profiles.scan 的返回值", async () => {
    // profiles.scan 是操作类方法，返回的只是一个操作描述符。
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );

    await store().requestProfileScan();
    expect(store().profileScanning).toBe(true);
    expect(store().profileScan).toBeNull();

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-scan",
        kind: "profile-scan",
        state: "succeeded",
        result: makeProfileScan({
          profiles: [makeProfileInfo({ name: "p1" })],
          totals: { profiles: 1, linked: 1 },
        }),
      })
    );

    expect(store().profileScanning).toBe(false);
    expect(store().profileScan?.profiles).toHaveLength(1);
    expect(store().profileScan?.totals.profiles).toBe(1);
  });

  it("扫描失败也要退出扫描中状态，不能永远转圈", async () => {
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );
    await store().requestProfileScan();

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-scan",
        kind: "profile-scan",
        state: "failed",
        error: { code: "INTERNAL", message: "读目录失败", retryable: false },
      })
    );

    expect(store().profileScanning).toBe(false);
    expect(store().profileScanFailed).toBe(true);
    // 关键：profileScan 仍是 null，界面据此显示「扫描失败」而不是「暂无 Profile」。
    expect(store().profileScan).toBeNull();
  });

  it("提交被拒后标记失败，让页面停止自动重试", async () => {
    tauri.failMethod("profiles.scan", {
      code: "AGENT_NOT_CONNECTED",
      message: "尚未连接",
      retryable: true,
    });

    await store().requestProfileScan();

    expect(store().profileScanning).toBe(false);
    expect(store().profileScanFailed).toBe(true);
  });

  it("连接恢复（收到 bootstrap）后清掉失败标记，自动扫描可以重新触发", async () => {
    tauri.failMethod("profiles.scan", { code: "AGENT_NOT_CONNECTED", message: "", retryable: true });
    await store().requestProfileScan();
    expect(store().profileScanFailed).toBe(true);

    tauri.emitBootstrap(makeBootstrap());
    expect(store().profileScanFailed).toBe(false);
  });

  it("其它 Profile 操作成功后自动重新扫描", async () => {
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-clean", kind: "profile-clean", state: "succeeded" })
    );
    await flush();

    expect(tauri.methodSequence()).toContain("profiles.scan");
  });

  it("profile.changed 与 operation.changed 同时到达只触发一次后续扫描", async () => {
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );

    tauri.emitAgentEvent("profile.changed", { name: "p1" });
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({ id: "op-clean", kind: "profile-clean", state: "succeeded" })
    );
    await flush();

    expect(
      tauri.methodSequence().filter((method) => method === "profiles.scan")
    ).toHaveLength(1);
  });

  it("伪造的扫描结果不被当成有效数据", async () => {
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );
    await store().requestProfileScan();

    // 旧字段名（sizeBytes / isOrphan）加上缺失的 totals。
    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-scan",
        kind: "profile-scan",
        state: "succeeded",
        result: {
          profiles: [{ name: "p1", sizeBytes: 100, isOrphan: false }],
          orphans: [],
        },
      })
    );

    expect(store().profileScan).toBeNull();
  });

  it("totals 缺字段的扫描结果同样被拒", async () => {
    tauri.onMethod("profiles.scan", () =>
      makeOperation({ id: "op-scan", kind: "profile-scan", state: "queued" })
    );
    await store().requestProfileScan();

    tauri.emitAgentEvent(
      "operation.changed",
      makeOperation({
        id: "op-scan",
        kind: "profile-scan",
        state: "succeeded",
        result: {
          profiles: [makeProfileInfo()],
          orphans: [],
          totals: { profiles: 1 },
        },
      })
    );

    expect(store().profileScan).toBeNull();
  });
});

describe("账号编辑经由 store", () => {
  beforeEach(() => {
    tauri.emitBootstrap(
      makeBootstrap({ accounts: [makeAccount({ id: "acc-1", note: "原始" })] })
    );
  });

  it("保存成功后转为干净", async () => {
    tauri.onMethod("accounts.update", (params) => {
      const patch = params.patch as { note?: string };
      return makeAccount({ id: "acc-1", note: patch.note ?? "" });
    });

    store().editAccount("acc-1", { note: "新备注" });
    expect(store().accounts["acc-1"]?.dirtyFields.size).toBe(1);

    await store().saveAccount("acc-1", { note: "新备注" });

    expect(store().accounts["acc-1"]?.effective.note).toBe("新备注");
    expect(store().accounts["acc-1"]?.dirtyFields.size).toBe(0);
  });

  it("保存失败后草稿保留，用户不丢输入", async () => {
    tauri.failMethod("accounts.update", {
      code: "AGENT_DRAINING",
      message: "正在排空",
      retryable: true,
    });

    store().editAccount("acc-1", { note: "没保存成功" });
    await expect(store().saveAccount("acc-1", { note: "没保存成功" })).rejects.toBeTruthy();

    expect(store().accounts["acc-1"]?.effective.note).toBe("没保存成功");
    expect(store().accounts["acc-1"]?.inFlight).toBeNull();
  });

  it("创建账号后直接拉起登录", async () => {
    tauri.onMethod("accounts.create", () => makeAccount({ id: "acc-new", email: null }));
    tauri.onMethod("browser.startLogin", () =>
      makeOperation({ id: "op-login", kind: "login", state: "waiting_user" })
    );

    const created = await store().createAccount({ note: "新号" });

    expect(created?.id).toBe("acc-new");
    expect(tauri.methodSequence()).toContain("browser.startLogin");
    expect(store().login?.accountId).toBe("acc-new");
  });
});

describe("邮箱显示开关", () => {
  it("默认全部隐藏，可一键全部展示", () => {
    expect(store().emailsRevealed).toBe(false);
    store().setEmailsRevealed(true);
    expect(store().emailsRevealed).toBe(true);
  });
});

describe("窗口关闭行为", () => {
  it("closeBehavior 为 ask 时弹出确认框", async () => {
    await store().updateDesktopSettings({ closeBehavior: "ask" });
    tauri.emitCloseRequested();
    expect(store().closeDialogOpen).toBe(true);
  });

  it("closeBehavior 为 minimizeToTray 时直接隐藏，不弹框", async () => {
    await store().updateDesktopSettings({ closeBehavior: "minimizeToTray" });
    tauri.emitCloseRequested();
    await flush();

    expect(store().closeDialogOpen).toBe(false);
    expect(tauri.calls.some((call) => call.command === "hide_to_tray")).toBe(true);
  });

  it("closeBehavior 为 exitAll 时直接退出，不弹框", async () => {
    await store().updateDesktopSettings({ closeBehavior: "exitAll" });
    tauri.emitCloseRequested();
    await flush();

    expect(store().closeDialogOpen).toBe(false);
    expect(tauri.calls.some((call) => call.command === "exit_all")).toBe(true);
  });

  it("在确认框里选「记住」会写回设置", async () => {
    await store().updateDesktopSettings({ closeBehavior: "ask" });
    tauri.emitCloseRequested();
    await store().minimizeToTray(true);
    await flush();

    expect(store().desktopSettings.closeBehavior).toBe("minimizeToTray");
  });
});

describe("托盘动作复用页面逻辑", () => {
  it("四个托盘动作各自触发对应的 IPC", async () => {
    await store().updateDesktopSettings({ autoStartScheduler: true });
    tauri.emitTrayAction("scheduler-start");
    await flush();
    expect(tauri.methodSequence()).toContain("scheduler.start");

    tauri.emitTrayAction("scheduler-stop");
    await flush();
    expect(tauri.methodSequence()).toContain("scheduler.stop");

    tauri.emitTrayAction("check-update");
    await flush();
    expect(tauri.calls.some((call) => call.command === "check_update")).toBe(true);

    tauri.emitTrayAction("exit-all");
    await flush();
    expect(tauri.calls.some((call) => call.command === "exit_all")).toBe(true);
  });
});

describe("排空与队列", () => {
  it("agent.draining 事件置起排空标记", () => {
    tauri.emitAgentEvent("agent.draining", { draining: true });
    expect(store().draining).toBe(true);
  });

  it("queue.changed 更新队列快照", () => {
    tauri.emitAgentEvent("queue.changed", {
      queuedTotal: 3,
      waiting: { queued: 3 },
      running: 1,
      closing: 0,
      workSlots: { used: 1, limit: 4 },
      chromeSlots: { used: 1, limit: 2 },
    });

    expect(store().queue?.queuedTotal).toBe(3);
    expect(store().queue?.workSlots.limit).toBe(4);
  });
});
