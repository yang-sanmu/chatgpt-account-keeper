// 把一个 Operation 解析成「谁 + 做什么」。
//
// 任务页和总览的最近任务都要这一份逻辑。分成两份写过一次，代价是其中一处漏掉了已删除账号
// 的处理 —— 同一个任务在两个页面上显示成不同的东西。

import { describeOperation } from "./operation-labels";
import { shortId } from "./format";
import type { Operation, ProxyNode } from "@/ipc/types";

export interface OperationSubject {
  /// 主标签：账号邮箱 / Profile 目录名 / 节点名 / 「全局」。
  title: string;
  /// 动作的中文名。
  action: string;
  /// 这条任务指向一个已经被删除的账号。历史任务会比账号活得久。
  deletedAccount: boolean;
}

export function resolveOperationSubject(
  operation: Operation,
  lookup: {
    account: (id: string | null | undefined) => { label: string; known: boolean };
    nodes: readonly ProxyNode[];
  }
): OperationSubject {
  const { action, resource } = describeOperation(
    operation.kind,
    operation.resourceId !== null
  );
  const resourceId = operation.resourceId;

  if (resource === "global") {
    return { title: "全局", action, deletedAccount: false };
  }

  if (resource === "account") {
    const { label, known } = lookup.account(resourceId);
    // 只在确实有 id 却查不到时才说「已删除」。没有 id 是另一种情况（任务不针对某个账号），
    // 把两者混在一起会让界面凭空报告一个不存在的删除。
    if (!known && resourceId) {
      return { title: `已删除账号（${label}）`, action, deletedAccount: true };
    }
    return { title: label, action, deletedAccount: false };
  }

  if (resource === "profile") {
    // resourceId 就是 Profile 目录名，本身可读。
    return { title: resourceId ?? "—", action, deletedAccount: false };
  }

  // proxy：节点可能已被订阅刷新掉，那时只剩 id。
  const node = resourceId ? lookup.nodes.find((item) => item.id === resourceId) : undefined;
  if (node) {
    const fallback = node.server ? `${node.server}:${node.port ?? "?"}` : shortId(resourceId);
    return { title: node.name || fallback, action, deletedAccount: false };
  }
  return { title: resourceId ? shortId(resourceId) : "—", action, deletedAccount: false };
}
