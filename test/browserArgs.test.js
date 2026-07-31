import test from "node:test";
import assert from "node:assert/strict";
import {
  baseLaunchArgs,
  applyWebrtcPolicy,
  WEBRTC_NO_LEAK_FLAG,
} from "../src/browser.js";

test("走代理的浏览器必须堵住 WebRTC 泄露", () => {
  // 实测：不加这个开关时，走韩国节点的浏览器会通过 WebRTC 漏出系统 Clash
  // 的美国出口 IP，同一会话出现两个国家的 IP。
  const args = applyWebrtcPolicy(baseLaunchArgs(true), true);
  assert.ok(args.args.includes(WEBRTC_NO_LEAK_FLAG));
});

test("未走代理时不改动 WebRTC 行为", () => {
  // 未绑节点的账号 HTTP 与 WebRTC 都走系统网络，本来就一致，无需干预。
  const args = applyWebrtcPolicy(baseLaunchArgs(true), false);
  assert.equal(args.args.includes(WEBRTC_NO_LEAK_FLAG), false);
});

test("重复调用不会累积重复开关", () => {
  let args = baseLaunchArgs(true);
  args = applyWebrtcPolicy(args, true);
  args = applyWebrtcPolicy(args, true);
  const hits = args.args.filter((a) => a === WEBRTC_NO_LEAK_FLAG);
  assert.equal(hits.length, 1);
});

test("基础启动参数保留既有的反自动化开关", () => {
  const args = baseLaunchArgs(false);
  assert.equal(args.headless, false);
  assert.ok(args.args.includes("--disable-blink-features=AutomationControlled"));
});
