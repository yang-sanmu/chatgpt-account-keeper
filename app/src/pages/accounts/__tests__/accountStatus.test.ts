// 账号状态的显示映射与健康度分档。
//
// 这一组钉的是「界面用的状态名必须和 Agent 真正发的一致」。Agent 只发四个值
// （src/health.js：ok / reauth / out / unknown），而界面曾按 needs_login / waf 判断 ——
// 那两个名字 Agent 从来不发，后果是「需要登录」筛选永远筛不出东西、总览的健康度里
// 真正掉线的账号全落进「其它」。这种错不会报任何异常，只会静默显示 0。

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATES,
  describeAccountStatus,
  healthBucketOf,
  HEALTH_LABELS,
  statusNeedsAttention,
} from "../account-status";

describe("Agent 实际发的四个状态都要有中文名", () => {
  it("四个状态各自映射到中文与色点，没有一个漏成原始 slug", () => {
    for (const state of ACCOUNT_STATES) {
      const display = describeAccountStatus(state, { stale: false, enabled: true });
      expect(display.label, `${state} 没有中文名`).not.toBe(state);
      expect(display.label.length).toBeGreaterThan(0);
    }
  });

  it("reauth 与 out 用不同的色点：一个可修复，一个真的掉了", () => {
    const reauth = describeAccountStatus("reauth", { stale: false, enabled: true });
    const out = describeAccountStatus("out", { stale: false, enabled: true });
    expect(reauth.dot).not.toBe(out.dot);
  });

  it("未知的新状态原样显示，不塌缩成「未知」", () => {
    // Agent 加了新状态时，显示那个 slug 仍能让人查到它是什么；塌缩会让它与真正的
    // unknown 无法区分。
    const display = describeAccountStatus("brand-new-state", { stale: false, enabled: true });
    expect(display.label).toBe("brand-new-state");
  });

  it("已停用优先于巡检状态", () => {
    // 一个停用的账号不参与调度，只显示「正常」会让用户以为它在跑。
    const display = describeAccountStatus("ok", { stale: false, enabled: false });
    expect(display.label).toContain("已停用");
    expect(display.dot).toBe("disabled");
  });

  it("待复核追加在状态后面而不是替换它", () => {
    const display = describeAccountStatus("ok", { stale: true, enabled: true });
    expect(display.label).toContain("正常");
    expect(display.label).toContain("待复核");
  });
});

describe("需要用户处理的状态", () => {
  it("reauth 与 out 需要处理，ok 与 unknown 不需要", () => {
    expect(statusNeedsAttention("reauth")).toBe(true);
    expect(statusNeedsAttention("out")).toBe(true);
    expect(statusNeedsAttention("ok")).toBe(false);
    // unknown 是「没测出来」，不是「坏了」。让它触发强制重登按钮会诱导用户去清一个
    // 其实健康的会话 —— 网络抖一下的代价不该是重登。
    expect(statusNeedsAttention("unknown")).toBe(false);
  });
});

describe("健康度分档", () => {
  it("四个状态各自成档，停用单独一档", () => {
    expect(healthBucketOf({ enabled: true, status: "ok" })).toBe("ok");
    expect(healthBucketOf({ enabled: true, status: "reauth" })).toBe("reauth");
    expect(healthBucketOf({ enabled: true, status: "out" })).toBe("out");
    expect(healthBucketOf({ enabled: true, status: "unknown" })).toBe("unknown");
    expect(healthBucketOf({ enabled: false, status: "ok" })).toBe("disabled");
  });

  it("停用优先：停用的账号不按巡检状态计入", () => {
    expect(healthBucketOf({ enabled: false, status: "reauth" })).toBe("disabled");
  });

  it("未知的新状态计入 unknown 档，不会凭空多出一档", () => {
    expect(healthBucketOf({ enabled: true, status: "brand-new" })).toBe("unknown");
  });

  it("每个档位都有中文名", () => {
    for (const bucket of ["ok", "reauth", "out", "unknown", "disabled"] as const) {
      expect(HEALTH_LABELS[bucket].length).toBeGreaterThan(0);
    }
  });
});

describe("loggedIn 布尔量的降级映射", () => {
  it("normalizeAccount 把 loggedIn=false 映射成 out，不合成 needs_login", async () => {
    // Agent 只发 ok/reauth/out/unknown。合成一个第五个名字会让它绕过所有查表：
    // 没有中文名、筛选不到、健康度统计里落进 unknown。
    const { normalizeAccount } = await import("@/ipc/bridge");

    expect(normalizeAccount({ id: "a", loggedIn: false }).status).toBe("out");
    expect(normalizeAccount({ id: "a", loggedIn: true }).status).toBe("ok");
  });

  it("显式 state 优先于 loggedIn", async () => {
    const { normalizeAccount } = await import("@/ipc/bridge");
    expect(normalizeAccount({ id: "a", state: "reauth", loggedIn: false }).status).toBe("reauth");
  });

  it("映射出的每个值都能查到中文名", async () => {
    const { normalizeAccount } = await import("@/ipc/bridge");
    for (const loggedIn of [true, false]) {
      const status = normalizeAccount({ id: "a", loggedIn }).status;
      const display = describeAccountStatus(status, { stale: false, enabled: true });
      expect(display.label, `${status} 没有中文名`).not.toBe(status);
    }
  });
});
