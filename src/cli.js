#!/usr/bin/env node
import { loginAccount } from "./login.js";
import { runOnce, scheduler } from "./scheduler.js";
import {
  getAccounts,
  getAccount,
  getGroups,
  displayName,
  migrateAccountProxyToGroup,
} from "./store.js";
import { recordConversation } from "./logger.js";
import * as log from "./logger.js";

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
  }
  return flags;
}

const HELP = `
GPT 账号会话工具

用法:
  node src/cli.js login <accountId>       手动登录某账号（打开有头浏览器）
  node src/cli.js once <accountId>        让某账号立即跑一次会话
  node src/cli.js once-all                所有启用账号各跑一次
  node src/cli.js run                     启动常驻定时调度
  node src/cli.js list                    列出配置的账号

选项:
  --headless=false    显示浏览器窗口（调试用；once/run 默认无头）
  --force             login: 明确清除旧 Session 后重新登录
  --interval=180      run: 每轮间隔分钟数
  --jitter=30         run: 随机抖动分钟数
`;

async function main() {
  // 旧版本把代理存在账号上，先安全迁移到分组，避免出口变化。
  migrateAccountProxyToGroup();
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const headless = flags.headless === "false" ? false : true;

  switch (cmd) {
    case "login": {
      const id = positional[0];
      if (!id) return console.log("用法: login <accountId>");
      await loginAccount(id, { force: flags.force === true });
      break;
    }
    case "once": {
      const id = positional[0];
      if (!id) return console.log("用法: once <accountId>");
      const acc = getAccount(id);
      if (!acc) return log.error(`找不到账号 ${id}`);
      const res = await runOnce(acc, { headless });
      recordConversation(acc.id, res);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "once-all": {
      for (const acc of getAccounts().filter((a) => a.enabled)) {
        const res = await runOnce(acc, { headless });
        recordConversation(acc.id, res);
        log.info(`${acc.id}: ${res.ok ? "成功" : "失败 - " + res.reason}`);
      }
      break;
    }
    case "run": {
      scheduler.start();
      await new Promise(() => {}); // 保持进程存活
      break;
    }
    case "list": {
      const groups = new Map(getGroups().map((g) => [g.id, g]));
      for (const a of getAccounts()) {
        const g = a.groupId ? groups.get(a.groupId) : null;
        const parts = [displayName(a)];
        if (a.groupId) parts.push(`组:${g?.name ?? a.groupId}`);
        // 代理绑在分组上，账号的出口由所属分组决定
        if (g?.proxyId) parts.push("代理:分组已绑定");
        console.log(
          `${a.enabled ? "[✓]" : "[ ]"} ${a.id}  ${parts.join("  ")}  -> ${a.profileDir}`
        );
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  log.error(String(e.stack || e));
  process.exit(1);
});
