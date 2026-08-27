// 格式化函数的边界。
//
// 这些函数的输入全部来自另一个进程，null / 空串 / 非法时间戳是常态而不是异常。测试的重点
// 是「取不到值时显示什么」——把 "Invalid Date" 或 "null" 铺给用户是真实发生过的问题。

import { describe, expect, it } from "vitest";
import {
  displayEmail,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelative,
  maskEmail,
  shortId,
} from "../format";

describe("邮箱脱敏与显示开关", () => {
  it("默认脱敏保留可辨识的头尾", () => {
    expect(maskEmail("basketball7@icloud.com")).toBe("ba***7@i***d.com");
  });

  it("未登录（null / 空串 / 空白）统一显示未登录", () => {
    expect(maskEmail(null)).toBe("未登录");
    expect(maskEmail(undefined)).toBe("未登录");
    expect(maskEmail("")).toBe("未登录");
    expect(maskEmail("   ")).toBe("未登录");
  });

  it("极短的用户名与域名也不会越界", () => {
    expect(maskEmail("a@b.co")).toBe("a***@b***.co");
    expect(maskEmail("ab@cd.io")).toBe("a***@c***.io");
  });

  it("没有 @ 的非法值不抛错", () => {
    expect(maskEmail("not-an-email")).toBe("no***il");
    expect(maskEmail("abc")).toBe("abc");
  });

  it("没有点的域名同样被遮蔽", () => {
    expect(maskEmail("user@localhost")).toBe("us***r@l***t");
  });

  it("开关决定明文还是脱敏，但未登录不受开关影响", () => {
    expect(displayEmail("basketball7@icloud.com", true)).toBe("basketball7@icloud.com");
    expect(displayEmail("basketball7@icloud.com", false)).toBe("ba***7@i***d.com");
    expect(displayEmail(null, true)).toBe("未登录");
    expect(displayEmail(null, false)).toBe("未登录");
  });
});

describe("时间格式化", () => {
  it("空值显示为未安排 / 占位符，而不是 Invalid Date", () => {
    expect(formatRelative(null)).toBe("未安排");
    expect(formatRelative(undefined)).toBe("未安排");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDate(null)).toBe("—");
  });

  it("非法时间戳原样返回，不显示 Invalid Date", () => {
    expect(formatRelative("这不是时间")).toBe("这不是时间");
    expect(formatDateTime("这不是时间")).toBe("这不是时间");
    expect(formatDate("这不是时间")).toBe("这不是时间");
  });

  it("相对时间区分过去与将来", () => {
    const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

    expect(formatRelative(inTwoHours)).toMatch(/后$/);
    expect(formatRelative(twoHoursAgo)).toMatch(/前$/);
  });

  it("一分钟内的差值不显示 0 分钟", () => {
    expect(formatRelative(new Date(Date.now() + 5_000).toISOString())).toBe("即将开始");
    expect(formatRelative(new Date(Date.now() - 5_000).toISOString())).toBe("刚刚");
  });

  it("跨天的相对时间带上小时数", () => {
    const later = new Date(Date.now() + (3 * 86_400_000 + 5 * 3600_000)).toISOString();
    expect(formatRelative(later)).toBe("3 天 5 小时后");
  });

  it("绝对时间补零到固定宽度", () => {
    expect(formatDateTime("2026-03-05T07:08:00")).toBe("2026-03-05 07:08");
    expect(formatDate("2026-03-05T07:08:00")).toBe("2026-03-05");
  });
});

describe("字节与时长", () => {
  it("0 与非法值都是 0 B，不是 NaN", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("按量级切换单位，字节不带小数", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2.6 * 1024 ** 3)).toBe("2.6 GB");
  });

  it("超过 10 的数值省掉小数位，避免列宽跳动", () => {
    expect(formatBytes(14.28 * 1024 ** 2)).toBe("14 MB");
  });

  it("时长的空值与非法值显示占位符", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("时长按量级切换单位", () => {
    expect(formatDuration(45)).toBe("45 秒");
    expect(formatDuration(200)).toBe("3 分 20 秒");
    expect(formatDuration(120)).toBe("2 分");
    expect(formatDuration(3900)).toBe("1 小时 5 分");
  });
});

describe("ID 缩短", () => {
  it("保留头尾以便与日志比对", () => {
    expect(shortId("4f4a1b2c3d4e5f6a7b8c9d0e")).toBe("4f4a1b…9d0e");
  });

  it("短到不需要缩的原样返回", () => {
    expect(shortId("abc123")).toBe("abc123");
  });

  it("空值显示占位符", () => {
    expect(shortId(null)).toBe("—");
    expect(shortId("")).toBe("—");
  });
});
