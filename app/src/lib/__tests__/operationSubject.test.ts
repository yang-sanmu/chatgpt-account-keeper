// 任务的「谁 + 做什么」解析。
//
// 任务页与总览的最近任务共用这一份。resourceId 的含义随 kind 变化（账号 id / Profile 目录名 /
// 节点 id / 无），解析错的表现是列表里出现一串裸 id，而那对用户没有任何意义。

import { describe, expect, it } from "vitest";
import { resolveOperationSubject } from "../operation-subject";
import { makeOperation } from "@/test/harness";
import type { ProxyNode } from "@/ipc/types";

const KNOWN_ACCOUNTS: Record<string, string> = {
  "acc-1": "ba***7@i***d.com",
};

const lookup = {
  account: (id: string | null | undefined) => {
    if (!id) return { label: "—", known: false };
    const label = KNOWN_ACCOUNTS[id];
    return label ? { label, known: true } : { label: "4f4a1b…9d0e", known: false };
  },
  nodes: [
    {
      id: "node-1",
      name: "香港 01",
      server: "hk1.example.com",
      port: 443,
    } as ProxyNode,
    {
      id: "node-unnamed",
      name: "",
      server: "jp1.example.com",
      port: 8443,
    } as ProxyNode,
  ] as readonly ProxyNode[],
};

describe("账号类任务", () => {
  it("显示邮箱与动作，而不是 id", () => {
    const subject = resolveOperationSubject(
      makeOperation({ kind: "account-run", resourceId: "acc-1" }),
      lookup
    );
    expect(subject).toEqual({
      title: "ba***7@i***d.com",
      action: "立即运行",
      deletedAccount: false,
    });
  });

  it("账号已删除时明确说出来，而不是显示一个看起来正常的短 id", () => {
    // 历史任务比账号活得久。裸短 id 会被误读成一个仍然存在的账号。
    const subject = resolveOperationSubject(
      makeOperation({ kind: "account-status-refresh", resourceId: "acc-gone" }),
      lookup
    );
    expect(subject.deletedAccount).toBe(true);
    expect(subject.title).toContain("已删除账号");
  });

  it("没有 resourceId 不算已删除账号", () => {
    // 「查不到」和「本来就不针对某个账号」是两件事，混起来会凭空报告一次删除。
    const subject = resolveOperationSubject(
      makeOperation({ kind: "account-run", resourceId: null }),
      lookup
    );
    expect(subject.deletedAccount).toBe(false);
  });
});

describe("其它资源类型", () => {
  it("Profile 类直接用目录名，它本身可读", () => {
    expect(
      resolveOperationSubject(
        makeOperation({ kind: "profile-cache-clean", resourceId: "profile-4f4a1b" }),
        lookup
      )
    ).toEqual({ title: "profile-4f4a1b", action: "清理缓存", deletedAccount: false });
  });

  it("代理类显示节点名", () => {
    expect(
      resolveOperationSubject(
        makeOperation({ kind: "proxy-node-test", resourceId: "node-1" }),
        lookup
      ).title
    ).toBe("香港 01");
  });

  it("节点没有名字时回退到 server:port", () => {
    expect(
      resolveOperationSubject(
        makeOperation({ kind: "proxy-node-test", resourceId: "node-unnamed" }),
        lookup
      ).title
    ).toBe("jp1.example.com:8443");
  });

  it("节点已被订阅刷新掉时回退到短 id，不显示空标签", () => {
    const subject = resolveOperationSubject(
      makeOperation({ kind: "proxy-node-test", resourceId: "node-vanished-0123456789" }),
      lookup
    );
    expect(subject.title).toContain("…");
    expect(subject.title.length).toBeGreaterThan(0);
  });

  it("全局任务显示「全局」而不是空白", () => {
    expect(
      resolveOperationSubject(makeOperation({ kind: "profile-scan" }), lookup)
    ).toEqual({ title: "全局", action: "扫描 Profile", deletedAccount: false });

    expect(
      resolveOperationSubject(makeOperation({ kind: "proxy-test-all" }), lookup).title
    ).toBe("全局");
  });
});

describe("未知的任务类型", () => {
  it("原样显示 kind，不塌缩成「未知任务」", () => {
    // Agent 新增一个 kind 时，显示那个 slug 仍然能让人查到它是什么；统一显示「未知」
    // 会把新增任务和真正的异常混在一起。
    const subject = resolveOperationSubject(
      makeOperation({ kind: "brand-new-kind", resourceId: null }),
      lookup
    );
    expect(subject.action).toBe("brand-new-kind");
    expect(subject.title).toBe("全局");
  });

  it("未知 kind 带 resourceId 时按账号处理", () => {
    const subject = resolveOperationSubject(
      makeOperation({ kind: "brand-new-kind", resourceId: "acc-1" }),
      lookup
    );
    expect(subject.title).toBe("ba***7@i***d.com");
  });
});
