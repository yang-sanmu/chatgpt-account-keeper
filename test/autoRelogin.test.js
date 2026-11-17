import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { MailCredentialStore } from "../src/persistence/mailCredentials.js";
import { AccountPlanStore } from "../src/persistence/accountPlans.js";
import { generateTotp, normalizeTotpSecret, totpSecondsRemaining } from "../src/totp.js";
import {
  decodeRfc2047,
  extractOpenAiOtp,
  isOpenAiAuthMessage,
  matchesRecipient,
  parseRawEmail,
} from "../src/mail/otpParser.js";
import { ImapFrameDecoder, ImapClient } from "../src/mail/imapClient.js";
import { SharedInboxCoordinator, SharedInboxRegistry, testImapConnection } from "../src/mail/sharedInbox.js";
import {
  autoReloginAccount,
  classifyHumanChallenge,
  classifyNetworkError,
  classifySignupFlow,
  shouldAttemptAutoRelogin,
} from "../src/autoRelogin.js";
import { SESSION_OK, SESSION_OUT, SESSION_REAUTH, SESSION_UNKNOWN } from "../src/health.js";
import { OperationRegistry } from "../src/application/operations.js";
import { createApplicationServices } from "../src/application/services.js";
import { composeBackground } from "../src/agent/composition.js";
import { resetLocksForTest } from "../src/locks.js";
import { assertMethodResultContract, assertOutgoingContract } from "../src/agent/contractValidator.js";

function createFakeImapSocket(responder) {
  const serverToClient = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      const text = chunk.toString("latin1");
      for (const line of text.split("\r\n").filter(Boolean)) {
        const spaceIdx = line.indexOf(" ");
        const tag = line.slice(0, spaceIdx);
        const cmd = line.slice(spaceIdx + 1);
        Promise.resolve(responder(tag, cmd, (payload) => serverToClient.push(payload))).then(() => cb(), cb);
      }
    },
  });
  queueMicrotask(() => {
    serverToClient.push("* OK IMAP4rev1 Service Ready\r\n");
  });
  return serverToClient;
}

test("totp: 校验 RFC 6238 标准向量与 otpauth URI 解析", () => {
  // RFC 6238 Test Vector: ASCII "12345678901234567890" -> Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(generateTotp(rfcSecret, { nowMs: 59_000, digits: 8 }), "94287082");
  assert.equal(normalizeTotpSecret("otpauth://totp/OpenAI:test@example.com?secret=jbsw y3dp-ehpk 3pxp&issuer=OpenAI"), "JBSWY3DPEHPK3PXP");
  assert.equal(totpSecondsRemaining(59_000, 30), 1);
  assert.throws(() => normalizeTotpSecret("INVALID!@#"), /非 Base32/);
});

test("otpParser: 解码 RFC 2047、quoted-printable HTML 与 iCloud/Cloudflare VERP 转发头", () => {
  const rawForwardIcloud = [
    "From: OpenAI <noreply@tm.openai.com>",
    "To: relay@qq.com",
    "Return-Path: <bounces+279124-d4a2-alice.example=icloud.com@spmailtechno.com>",
    "Subject: =?UTF-8?B?WW91ciBDaGF0R1BUIGNvZGUgaXMgNDgyOTAx?=",
    "Date: Mon, 16 Nov 2026 02:10:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Your ChatGPT verification code is <strong>482901</strong>.</p>",
    "--b1--",
    "",
  ].join("\r\n");

  const parsedIcloud = parseRawEmail(rawForwardIcloud);
  assert.equal(decodeRfc2047("=?UTF-8?B?WW91ciBDaGF0R1BUIGNvZGUgaXMgNDgyOTAx?="), "Your ChatGPT code is 482901");
  assert.equal(isOpenAiAuthMessage(parsedIcloud), true);
  assert.equal(matchesRecipient(parsedIcloud, "alice.example@icloud.com"), true);
  assert.equal(matchesRecipient(parsedIcloud, "other.user@icloud.com"), false);
  assert.equal(extractOpenAiOtp(parsedIcloud), "482901");

  const rawCloudflare = [
    "From: ChatGPT <noreply@email.openai.com>",
    "X-Original-To: cf-alias-01@example.com",
    "To: relay@qq.com",
    "Subject: Your log in code",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Enter this verification code: 739204",
  ].join("\r\n");
  const parsedCf = parseRawEmail(rawCloudflare);
  assert.equal(matchesRecipient(parsedCf, "cf-alias-01@example.com"), true);
  assert.equal(extractOpenAiOtp(parsedCf), "739204");

  const nonOtpAlert = parseRawEmail([
    "From: OpenAI <noreply@openai.com>",
    "To: cf-alias-01@example.com",
    "Subject: Your password was changed",
    "",
    "Just letting you know your password was changed at 101234 UTC.",
  ].join("\r\n"));
  assert.equal(isOpenAiAuthMessage(nonOtpAlert), false);

  const emailChangedAlert = parseRawEmail([
    "From: OpenAI <noreply@tm.openai.com>",
    "To: u@example.com",
    "Subject: Your ChatGPT email address was changed",
    "",
    "Reference 918273.",
  ].join("\r\n"));
  assert.equal(isOpenAiAuthMessage(emailChangedAlert), false);

  const vietnameseOtp = parseRawEmail([
    "From: ChatGPT <noreply@tm.openai.com>",
    "To: vn-user@example.com",
    "Subject: =?UTF-8?B?TcOjIMSRxINuZyBuaOG6rXAgQ2hhdEdQVCB04bqhbSB0aOG7nWkgY3VhIGLhuqFu?=",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Mã xác minh tạm thời của bạn là 482910.", "utf8").toString("base64"),
  ].join("\r\n"));
  assert.equal(isOpenAiAuthMessage(vietnameseOtp), true);
  assert.equal(extractOpenAiOtp(vietnameseOtp), "482910");
});

test("imapClient: 支持分片二进制字面量、文件夹探索与 SharedInbox 单飞轮询过滤", async (t) => {
  const frames = [];
  const decoder = new ImapFrameDecoder((frame) => frames.push(frame));
  decoder.push(Buffer.from("* 1 FETCH (UID 10 BODY[] {5}\r\nAB"));
  decoder.push(Buffer.from("\r\nCD)\r\n"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].literals[0].toString("latin1"), "AB\r\nC");

  const junkEmail = [
    "From: OpenAI <noreply@tm.openai.com>",
    "Return-Path: <bounces+10-aa-alias-one=icloud.com@relay.example>",
    "Subject: Your verification code is 654321",
    `Date: ${new Date().toUTCString()}`,
    "",
    "Code: 654321",
  ].join("\r\n");

  const inboxEmail = [
    "From: OpenAI <noreply@email.openai.com>",
    "X-Original-To: user@example.com",
    "Subject: ChatGPT verification code",
    `Date: ${new Date().toUTCString()}`,
    "",
    "Your verification code is 112233",
  ].join("\r\n");

  let examineFolder = "INBOX";
  const coordinator = new SharedInboxCoordinator(
    { host: "imap.example.com", port: 993, tls: true, user: "u@qq.com", password: "secret" },
    {
      pollIntervalMs: 40,
      idleGraceMs: 50,
      createClient: (opts) =>
        new ImapClient({
          ...opts,
          connectSocket: async () =>
            createFakeImapSocket((tag, cmd, send) => {
              if (cmd.startsWith("LOGIN ")) {
                send(`${tag} OK LOGIN completed\r\n`);
              } else if (cmd.startsWith("LIST ")) {
                send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
                send('* LIST (\\HasNoChildren \\Junk) "/" "Junk"\r\n');
                send(`${tag} OK LIST completed\r\n`);
              } else if (cmd.startsWith("EXAMINE ")) {
                examineFolder = cmd.includes('"Junk"') ? "Junk" : "INBOX";
                send("* 1 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 102]\r\n");
                send(`${tag} OK EXAMINE completed\r\n`);
              } else if (cmd.startsWith("UID SEARCH ")) {
                send("* SEARCH 101\r\n");
                send(`${tag} OK SEARCH completed\r\n`);
              } else if (cmd.startsWith("UID FETCH ")) {
                const raw = examineFolder === "Junk" ? junkEmail : inboxEmail;
                const len = Buffer.byteLength(raw, "latin1");
                const now = new Date();
                const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getUTCMonth()];
                const pad = (n) => String(n).padStart(2, "0");
                const imapDate = `${pad(now.getUTCDate())}-${mon}-${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} +0000`;
                send(`* 1 FETCH (UID 101 INTERNALDATE "${imapDate}" BODY[] {${len}}\r\n${raw})\r\n`);
                send(`${tag} OK FETCH completed\r\n`);
              } else if (cmd.startsWith("LOGOUT")) {
                send("* BYE\r\n");
                send(`${tag} OK LOGOUT\r\n`);
              } else {
                send(`${tag} OK\r\n`);
              }
            }),
        }),
    }
  );
  t.after(() => coordinator.dispose());

  const [codeA, codeB] = await Promise.all([
    coordinator.waitForOtp({ email: "alias-one@icloud.com", afterTs: Date.now() - 60_000, settleMs: 10 }),
    coordinator.waitForOtp({ email: "user@example.com", afterTs: Date.now() - 60_000, settleMs: 10 }),
  ]);
  assert.equal(codeA, "654321");
  assert.equal(codeB, "112233");

  // 验证瞬态 UID FETCH 失败后不跳过 highestUid，重连下轮仍可拿到该新邮件
  let transientDone = false;
  let maxUidNow = 101;
  const retryCoordinator = new SharedInboxCoordinator(
    { host: "imap.example.com", port: 993, tls: true, user: "u@qq.com", password: "secret" },
    {
      pollIntervalMs: 30,
      idleGraceMs: 50,
      createClient: (opts) =>
        new ImapClient({
          ...opts,
          connectSocket: async () =>
            createFakeImapSocket((tag, cmd, send) => {
              if (cmd.startsWith("LIST ")) {
                send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
                send(`${tag} OK LIST\r\n`);
              } else if (cmd.startsWith("EXAMINE ")) {
                send(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT ${maxUidNow + 1}]\r\n`);
                send(`${tag} OK EXAMINE\r\n`);
              } else if (cmd.startsWith("UID SEARCH ")) {
                send(`* SEARCH ${maxUidNow}\r\n`);
                send(`${tag} OK SEARCH\r\n`);
              } else if (cmd.startsWith("UID FETCH ")) {
                if (maxUidNow === 102 && !transientDone) {
                  transientDone = true;
                  send(`${tag} NO transient fetch failure\r\n`);
                  return;
                }
                const targetRaw = maxUidNow === 102
                  ? [
                      "From: OpenAI <noreply@email.openai.com>",
                      "To: recovered@example.com",
                      "Subject: Your OpenAI code is 445566",
                      `Date: ${new Date().toUTCString()}`,
                      "",
                      "Code: 445566",
                    ].join("\r\n")
                  : inboxEmail;
                const len = Buffer.byteLength(targetRaw, "latin1");
                send(`* 1 FETCH (UID ${maxUidNow} BODY[] {${len}}\r\n${targetRaw})\r\n`);
                send(`${tag} OK FETCH\r\n`);
              } else {
                send(`${tag} OK\r\n`);
              }
            }),
        }),
    }
  );
  t.after(() => retryCoordinator.dispose());
  await retryCoordinator.pollOnce();
  maxUidNow = 102;
  const recoveredCode = await retryCoordinator.waitForOtp({
    email: "recovered@example.com",
    afterTs: Date.now() - 60_000,
    settleMs: 10,
    timeoutMs: 1_500,
  });
  assert.equal(recoveredCode, "445566");

  // 验证错误授权码测试连接返回中文提示而非抛未捕获异常
  const failedTest = await testImapConnection(
    { host: "imap.example.com", port: 993, tls: true, user: "u@qq.com", password: "wrong" },
    {
      createClient: (opts) =>
        new ImapClient({
          ...opts,
          connectSocket: async () =>
            createFakeImapSocket((tag, cmd, send) => {
              if (cmd.startsWith("LOGIN ")) send(`${tag} NO Authentication failed\r\n`);
              else send(`${tag} OK\r\n`);
            }),
        }),
    }
  );
  assert.equal(failedTest.ok, false);
  assert.match(failedTest.message, /账号或授权码错误/);
});

test("persistence: Migration 16 兼容空白库导入且加密存储 IMAP 授权码与账号凭据", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-v16-"));
  const repo = await openKeeperRepository({
    filePath: path.join(dir, "keeper.db"),
    backupDirectory: path.join(dir, "backups"),
  });
  t.after(() => {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(repo.isEmptyForLegacyImport(), true);

  const creds = new MailCredentialStore(repo.db, "ipc-key-test");
  assert.deepEqual(creds.getSettings(), {
    imapHost: null,
    imapPort: 993,
    imapTls: true,
    imapUser: null,
    imapPasswordConfigured: false,
    autoReloginDefault: false,
    reloginHeadless: null,
  });

  const saved = creds.updateSettings({
    imapHost: "imap.qq.com",
    imapPort: 993,
    imapTls: true,
    imapUser: "sanmu@qq.com",
    imapPassword: "app-password-123",
    autoReloginDefault: true,
    reloginHeadless: false,
  });
  assert.equal(saved.imapPasswordConfigured, true);
  assert.equal("imapPassword" in saved, false);
  assert.equal(creds.getImapSecretConfig().password, "app-password-123");
  assert.equal(repo.isEmptyForLegacyImport(), false);

  repo.createAccount({ id: "acc-1", profileName: "prof-1", note: "n1", email: "u1@icloud.com" });
  const status1 = creds.setAccountCredentials("acc-1", {
    password: "pw!",
    totpSecret: "JBSWY3DPEHPK3PXP",
  });
  assert.deepEqual(status1, { hasPassword: true, hasTotpSecret: true });
  assert.deepEqual(creds.getAccountCredentials("acc-1"), {
    password: "pw!",
    totpSecret: "JBSWY3DPEHPK3PXP",
  });
  assert.throws(() => creds.setAccountCredentials("acc-1", { totpSecret: "not-base32!" }), /非 Base32/);

  creds.setAccountCredentials("acc-1", { password: null, totpSecret: "" });
  assert.deepEqual(creds.getCredentialStatus("acc-1"), { hasPassword: false, hasTotpSecret: false });
});

function createMockLoginPage(initialSteps) {
  let url = "about:blank";
  let screen = "blank";
  const values = new Map();
  let clearCalls = 0;

  const makeLocator = (selector) => ({
    first() {
      return this;
    },
    nth(idx) {
      return makeLocator(`${selector}[${idx}]`);
    },
    async count() {
      return screen === "otp-split" && selector.includes('maxlength="1"') ? 6 : 1;
    },
    async isVisible() {
      if (screen === "email" && selector.includes("email")) return true;
      if (screen === "password" && selector.includes("password")) return true;
      if (screen === "password" && selector.includes("one-time code")) return true;
      if ((screen === "otp-split" || screen === "otp-single") && selector.includes("code")) return true;
      if ((screen === "otp-split" || screen === "otp-single") && selector.includes("Resend")) return true;
      if (screen === "mfa" && selector.includes("code")) return true;
      if (["email", "password", "otp-split", "otp-single", "mfa"].includes(screen) && selector.includes("Continue")) {
        return !selector.includes("one-time code");
      }
      return false;
    },
    async isEnabled() {
      return true;
    },
    async inputValue() {
      return values.get(selector) ?? "";
    },
    async fill(val) {
      values.set(selector, val);
    },
    async click() {
      const result = await initialSteps.onAction(screen, selector, values, () => clearCalls);
      if (result?.url) url = result.url;
      if (result?.screen) screen = result.screen;
    },
    async press() {
      return this.click();
    },
  });

  return {
    getClearCalls: () => clearCalls,
    setClearCalls: (n) => { clearCalls = n; },
    url: () => url,
    frames: () => [],
    context: () => ({}),
    locator: (sel) => makeLocator(sel),
    async goto(target) {
      url = target;
      const result = await initialSteps.onGoto(target);
      if (result?.url) url = result.url;
      if (result?.screen) screen = result.screen;
    },
    async evaluate(fn) {
      if (screen === "otp-split" && fn.toString().includes("maxlength")) return 6;
      if (screen === "challenge") {
        return {
          title: "Just a moment...",
          text: "Verify you are human",
          hasAuthInput: false,
          hasChallengeUi: true,
        };
      }
      return {
        title: screen === "signup" ? "Check your inbox - OpenAI" : screen,
        text:
          screen === "deactivated"
            ? "Your account was deleted or deactivated."
            : screen === "signup"
              ? "Check your inbox Enter the verification code we just sent to u@icloud.com to create your account"
              : "",
        hasAuthInput: ["email", "password", "otp-split", "otp-single", "mfa", "signup"].includes(screen),
        hasChallengeUi: false,
      };
    },
  };
}

test("autoRelogin: shouldAttemptAutoRelogin 正确区分 401/out 与网络波动", () => {
  assert.equal(shouldAttemptAutoRelogin({ state: SESSION_OUT, lastCheckState: SESSION_OUT }), true);
  assert.equal(shouldAttemptAutoRelogin({ state: SESSION_REAUTH, lastCheckState: SESSION_REAUTH }), true);
  assert.equal(
    shouldAttemptAutoRelogin({
      state: SESSION_OK,
      lastCheckState: SESSION_UNKNOWN,
      lastCheckDetail: "鉴权接口返回 401，未能确认会话状态",
    }),
    true
  );
  assert.equal(
    shouldAttemptAutoRelogin({
      state: SESSION_OK,
      lastCheckState: SESSION_UNKNOWN,
      lastCheckDetail: "鉴权接口返回 403，未能确认会话状态",
    }),
    false
  );
  assert.equal(
    shouldAttemptAutoRelogin({ state: SESSION_OK, lastCheckState: SESSION_OK, tokenStatus: "saved" }),
    false
  );
});

test("autoRelogin: 拦截 Cloudflare 人机验证与停用账号，完成无密码一次性验证码及密码+TOTP 重登", async () => {
  // 1. Challenge 页必须立刻中止，绝不点击挑战
  const challengePage = createMockLoginPage({
    onGoto: () => ({ url: "https://auth.openai.com/cdn-cgi/challenge-platform", screen: "challenge" }),
    onAction: () => assert.fail("遇到挑战不得点击"),
  });
  await assert.rejects(
    autoReloginAccount(
      { id: "a1", email: "user@icloud.com" },
      {
        page: challengePage,
        clearSession: async () => {},
        mailCredentials: {
          getAccountCredentials: () => ({ password: null, totpSecret: null }),
          getImapSecretConfig: () => ({ host: "h", port: 993, tls: true, user: "u", password: "p" }),
        },
        sharedInboxRegistry: { getCoordinator: () => ({ waitForOtp: async () => "000000" }) },
      },
      { skipInitialCheck: true }
    ),
    /Cloudflare 人机验证/
  );

  // 2. 无密码 iCloud 转发账号走 one-time code -> 6 格 OTP -> refreshAccount
  let waitedEmail = null;
  let clearedCount = 0;
  let reloggedSaved = false;
  const otpPage = createMockLoginPage({
    onGoto: () => ({ url: "https://auth.openai.com/log-in", screen: "email" }),
    onAction: (screen, selector) => {
      if (screen === "email") return { url: "https://auth.openai.com/log-in/password", screen: "password" };
      if (screen === "password" && selector.includes("one-time code")) {
        return { url: "https://auth.openai.com/email-verification", screen: "otp-split" };
      }
      if (screen === "otp-split") {
        return { url: "https://chatgpt.com/", screen: "home" };
      }
      return {};
    },
  });

  const otpOutcome = await autoReloginAccount(
    { id: "a2", email: "alias@icloud.com" },
    {
      page: otpPage,
      clearSession: async () => { clearedCount += 1; },
      checkSession: async () => ({ state: SESSION_OK, email: "alias@icloud.com", accessToken: "jwt-123" }),
      refreshAccount: async (acc) => {
        reloggedSaved = acc.id === "a2";
        return { state: SESSION_OK, lastCheckState: SESSION_OK, tokenStatus: "saved", email: acc.email };
      },
      mailCredentials: {
        getAccountCredentials: () => ({ password: null, totpSecret: null }),
        getImapSecretConfig: () => ({ host: "h", port: 993, tls: true, user: "u", password: "p" }),
      },
      sharedInboxRegistry: {
        getCoordinator: () => ({
          waitForOtp: async ({ email }) => {
            waitedEmail = email;
            return "839201";
          },
        }),
      },
    },
    { skipInitialCheck: true, delayScale: 0.01 }
  );
  assert.equal(clearedCount, 1);
  assert.equal(waitedEmail, "alias@icloud.com");
  assert.equal(reloggedSaved, true);
  assert.equal(otpOutcome.status.tokenStatus, "saved");

  // 3. 密码 + TOTP 账号自动填密码并计算 RFC 6238 动态码
  let capturedTotp = null;
  const mfaPage = createMockLoginPage({
    onGoto: () => ({ url: "https://auth.openai.com/log-in", screen: "email" }),
    onAction: (screen, _sel, values) => {
      if (screen === "email") return { url: "https://auth.openai.com/log-in/password", screen: "password" };
      if (screen === "password") return { url: "https://auth.openai.com/mfa-challenge", screen: "mfa" };
      if (screen === "mfa") {
        capturedTotp = values.get('input[name="code"]');
        return { url: "https://chatgpt.com/", screen: "home" };
      }
      return {};
    },
  });
  const mfaOutcome = await autoReloginAccount(
    { id: "a3", email: "mfa@example.com" },
    {
      page: mfaPage,
      clearSession: async () => {},
      checkSession: async () => ({ state: SESSION_OK, email: "mfa@example.com", accessToken: "jwt-mfa" }),
      mailCredentials: {
        getAccountCredentials: () => ({ password: "pw-ok", totpSecret: "JBSWY3DPEHPK3PXP" }),
        getImapSecretConfig: () => null,
      },
    },
    { skipInitialCheck: true, delayScale: 0.01 }
  );
  assert.match(capturedTotp, /^\d{6}$/);
  assert.equal(mfaOutcome.status.state, SESSION_OK);

  // 4. 多语言 Cloudflare 挑战页（韩语等）与「误入新建账号流程」必须立即中止
  assert.match(
    classifyHumanChallenge({ title: "잠시만 기다리십시오…", text: "", url: "https://chatgpt.com/", hasAuthInput: false }) || "",
    /人机验证/
  );
  assert.match(
    classifySignupFlow({ url: "https://auth.openai.com/email-verification", text: "we just sent to x@icloud.com to create your account" }) || "",
    /新建账号流程/
  );

  let waitCalledAfterSignup = false;
  const signupPage = createMockLoginPage({
    onGoto: () => ({ url: "https://chatgpt.com/auth/login", screen: "email" }),
    onAction: (screen) => (screen === "email" ? { url: "https://auth.openai.com/email-verification", screen: "signup" } : {}),
  });
  await assert.rejects(
    autoReloginAccount(
      { id: "a4", email: "moved@icloud.com" },
      {
        page: signupPage,
        clearSession: async () => {},
        mailCredentials: {
          getAccountCredentials: () => ({ password: null, totpSecret: null }),
          getImapSecretConfig: () => ({ host: "h", port: 993, tls: true, user: "u", password: "p" }),
        },
        sharedInboxRegistry: {
          getCoordinator: () => ({
            waitForOtp: async () => {
              waitCalledAfterSignup = true;
              return "000000";
            },
          }),
        },
      },
      { skipInitialCheck: true, delayScale: 0.01 }
    ),
    /新建账号流程/
  );
  assert.equal(waitCalledAfterSignup, false);

  // 5. 首次 OTP_TIMEOUT 时自动点击 Resend email 并继续等待拿码成功
  let waitRound = 0;
  let resendClicked = false;
  const resendPage = createMockLoginPage({
    onGoto: () => ({ url: "https://auth.openai.com/log-in", screen: "email" }),
    onAction: (screen, selector) => {
      if (screen === "email") return { url: "https://auth.openai.com/email-verification", screen: "otp-single" };
      if (screen === "otp-single" && selector.includes("Resend")) {
        resendClicked = true;
        return {};
      }
      if (screen === "otp-single") return { url: "https://chatgpt.com/", screen: "home" };
      return {};
    },
  });
  const resendOutcome = await autoReloginAccount(
    { id: "a5", email: "slow@icloud.com" },
    {
      page: resendPage,
      clearSession: async () => {},
      checkSession: async () => ({ state: SESSION_OK, email: "slow@icloud.com", accessToken: "jwt-resend" }),
      mailCredentials: {
        getAccountCredentials: () => ({ password: null, totpSecret: null }),
        getImapSecretConfig: () => ({ host: "h", port: 993, tls: true, user: "u", password: "p" }),
      },
      sharedInboxRegistry: {
        getCoordinator: () => ({
          waitForOtp: async () => {
            waitRound += 1;
            if (waitRound === 1) {
              const err = new Error("timeout");
              err.code = "OTP_TIMEOUT";
              throw err;
            }
            return "918273";
          },
        }),
      },
    },
    { skipInitialCheck: true, delayScale: 0.01 }
  );
  assert.equal(resendClicked, true);
  assert.equal(waitRound, 2);
  assert.equal(resendOutcome.status.state, SESSION_OK);
});

test("services & composition: 巡检开启 autoRelogin 自动恢复 401，独立批量重登与凭据接口过 IPC 契约", async (t) => {
  resetLocksForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-svc-relogin-"));
  const repo = await openKeeperRepository({
    filePath: path.join(dir, "keeper.db"),
    backupDirectory: path.join(dir, "backups"),
  });
  let services = null;
  let background = null;
  t.after(async () => {
    services?.dispose();
    await background?.dispose();
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  repo.createAccount({ id: "acc-1", profileName: "prof-1", note: "401号", email: "a1@icloud.com", enabled: true });
  const accountPlans = new AccountPlanStore(repo.db, "ipc-secret-1");
  const mailCredentials = new MailCredentialStore(repo.db, "ipc-secret-1");

  const events = { published: [], publish(event, payload) { this.published.push({ event, payload }); } };
  const operations = new OperationRegistry({ events });
  const storeAdapter = {
    getAccount: (id) => repo.getAccount(id),
    getAccounts: () => repo.listAccounts(),
    updateAccount: (id, patch) => repo.updateAccount(id, patch),
    getGroups: () => [],
    getSettings: () => repo.getSettings(),
    effectiveProxyId: () => null,
  };

  let refreshCall = 0;
  let reloginCalls = 0;
  const fakeContext = {
    async pages() { return [{ isClosed: () => false }]; },
    async newPage() { return { isClosed: () => false }; },
    async close() {},
  };
  const fakeBroker = {
    running: true,
    generationId: "gen-1",
    newRunToken: () => `tok-${Math.random()}`,
    async start() {},
    async terminate() { return { ok: true }; },
    async waitForEmpty() { return { ok: true, count: 0, disposed: false }; },
    async dispose_() { return { ok: true }; },
    async forget() { return { ok: true }; },
    async dispose() {},
  };

  background = await composeBackground({
    operations,
    events,
    store: storeAdapter,
    log: { info() {}, warn() {}, error() {} },
    getProxyNodes: () => [],
    scheduler: {
      running: true,
      nextAtFromNow: (now = Date.now()) => now + 60_000,
      noteScheduled: () => {},
      noteCompleted: () => {},
    },
    runOnce: async () => ({ ok: true }),
    checkSelectors: async () => ({ ok: true }),
    refreshAccount: async (account) => {
      refreshCall += 1;
      return {
        state: "ok",
        lastCheckState: SESSION_UNKNOWN,
        lastCheckDetail: "鉴权接口返回 401，未能确认会话状态",
        tokenStatus: "unavailable",
        email: account.email,
      };
    },
    autoRelogin: async (account, runtime) => {
      reloginCalls += 1;
      runtime.accountPlans.saveToken(account.id, account.email, "header.payload.sig");
      return {
        ok: true,
        status: {
          state: SESSION_OK,
          lastCheckState: SESSION_OK,
          tokenStatus: "saved",
          email: account.email,
        },
      };
    },
    requireBroker: true,
    brokerFactory: () => fakeBroker,
    launchChrome: async (_account, opts) => ({
      context: fakeContext,
      page: { url: () => "about:blank" },
      rootPid: 4242,
      rootStartTime: 1700000000,
      runToken: opts.runToken,
    }),
    accountViewRuntime: () => services.runtime,
  });

  services = createApplicationServices({
    operations,
    events,
    runtime: {
      store: storeAdapter,
      ipcAuthToken: "ipc-secret-1",
      accountPlans,
      mailCredentials,
      proxies: { getNodes: () => [] },
      scheduler: { status: () => ({ running: false, accounts: {}, lastResults: {} }) },
      getOpenPages: () => ({}),
      getCachedStatus: () => ({ state: "ok", lastCheckState: SESSION_UNKNOWN, lastCheckDetail: "鉴权接口返回 401" }),
      enqueue: background.enqueue,
      testImapConnection: async () => ({ ok: true, folders: ["INBOX", "Junk"], inboxMessages: 12, message: "连接成功" }),
    },
  });

  const updatedMail = await services.invoke(
    "mail.updateSettings",
    { imapHost: "imap.qq.com", imapUser: "sanmu@qq.com", imapPassword: "auth-code", autoReloginDefault: true },
    { commandId: "cmd-mail-1" }
  );
  assertMethodResultContract("mail.updateSettings", updatedMail);
  assert.equal(updatedMail.imapPasswordConfigured, true);

  const testConn = await services.invoke("mail.testConnection", {});
  assertMethodResultContract("mail.testConnection", testConn);
  assert.equal(testConn.ok, true);

  const credAccount = await services.invoke(
    "accounts.setCredentials",
    { id: "acc-1", email: "new@icloud.com", password: "p1", totpSecret: "JBSWY3DPEHPK3PXP" },
    { commandId: "cmd-cred-1" }
  );
  assertMethodResultContract("accounts.setCredentials", credAccount);
  assert.equal(credAccount.hasPassword, true);
  assert.equal(credAccount.hasTotpSecret, true);
  assert.equal(credAccount.email, "new@icloud.com");

  const inspectOp = await services.invoke(
    "accounts.inspect",
    { ids: ["acc-1"], autoRelogin: true },
    { commandId: "cmd-insp-1" }
  );
  const settledInspect = await operations.waitForTerminal(inspectOp.id);
  assert.equal(settledInspect.state, "succeeded");
  assert.equal(settledInspect.result.succeeded, 1);
  assert.equal(refreshCall, 1);
  assert.equal(reloginCalls, 1);
  assert.equal(accountPlans.getToken("acc-1").token, "header.payload.sig");

  const reloginOp = await services.invoke(
    "accounts.relogin",
    { ids: ["acc-1"], force: true, headless: false },
    { commandId: "cmd-relog-1" }
  );
  assertMethodResultContract("accounts.relogin", reloginOp);
  const settledRelogin = await operations.waitForTerminal(reloginOp.id);
  assert.equal(settledRelogin.state, "succeeded");
  assert.equal(settledRelogin.result.succeeded, 1);
  assert.equal(reloginCalls, 2);

  for (const published of events.published) {
    assertOutgoingContract({
      event: published.event,
      seq: 1,
      instanceId: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
      revision: 1,
      occurredAt: new Date().toISOString(),
      payload: published.payload,
    });
  }
});

test("autoRelogin: 优先点击对话框/精确 Continue 按钮而非杂散 submit 按钮，且密码页/MFA 页水合不误报错", async () => {
  let step = 0;
  let straySubmitClicked = false;
  let exactContinueClicked = false;
  let mfaSubmitted = false;
  let mfaVerifyTicks = 0;
  let pwdHydrationTicks = 0;

  let currentUrl = "https://chatgpt.com/auth/login";
  const makeLocator = (selector) => ({
    first() {
      return this;
    },
    nth() {
      return this;
    },
    async count() {
      return 1;
    },
    async isVisible() {
      if (currentUrl.includes("/auth/login")) {
        if (selector.includes('type="email"')) return true;
        if (selector === 'button[type="submit"]:not([value="resend"]):not([name*="resend" i])') return true;
        if (selector === 'button:text-is("Continue")') return true;
        return false;
      }
      if (currentUrl.includes("/log-in/password")) {
        if (pwdHydrationTicks < 2) return false;
        return selector.includes("one-time code") || selector.includes('type="password"');
      }
      if (currentUrl.includes("/email-verification")) {
        return selector.includes('name="code"') || selector.includes('text-is("Continue")');
      }
      if (currentUrl.includes("/mfa")) {
        if (mfaSubmitted) return false;
        return selector.includes('name="code"') || selector.includes('text-is("Continue")');
      }
      return false;
    },
    async isEnabled() {
      return true;
    },
    async inputValue() {
      return "hydrating@icloud.com";
    },
    async fill() {},
    async focus() {},
    async click() {
      if (selector === 'button[type="submit"]:not([value="resend"]):not([name*="resend" i])') {
        straySubmitClicked = true;
        return;
      }
      if (currentUrl.includes("/auth/login") && selector === 'button:text-is("Continue")') {
        exactContinueClicked = true;
        currentUrl = "https://auth.openai.com/log-in/password";
        return;
      }
      if (currentUrl.includes("/log-in/password") && selector.includes("one-time code")) {
        currentUrl = "https://auth.openai.com/email-verification";
        return;
      }
      if (currentUrl.includes("/email-verification")) {
        currentUrl = "https://auth.openai.com/mfa";
        return;
      }
      if (currentUrl.includes("/mfa")) {
        mfaSubmitted = true;
        step = 1;
      }
    },
    async press() {
      return this.click();
    },
  });

  const fakePage = {
    url: () => currentUrl,
    frames: () => [],
    context: () => ({}),
    locator: (sel) => makeLocator(sel),
    async goto(target) {
      currentUrl = target;
    },
    async evaluate(fn) {
      if (fn.toString().includes("maxlength")) return 0;
      if (currentUrl.includes("/log-in/password") && pwdHydrationTicks < 2) {
        pwdHydrationTicks += 1;
        return { title: "Enter your password - OpenAI", text: "", hasAuthInput: false, hasChallengeUi: false, inputsSummary: [], buttonsSummary: [] };
      }
      if (currentUrl.includes("/mfa") && mfaSubmitted) {
        mfaVerifyTicks += 1;
        if (mfaVerifyTicks >= 2) {
          currentUrl = "https://chatgpt.com/";
        }
        return { title: "Verifying...", text: "", hasAuthInput: false, hasChallengeUi: false, inputsSummary: [], buttonsSummary: [] };
      }
      return {
        title: "OpenAI",
        text: "Continue",
        hasAuthInput: !currentUrl.endsWith("chatgpt.com/"),
        hasChallengeUi: false,
        inputsSummary: [],
        buttonsSummary: ["Continue"],
      };
    },
  };

  const result = await autoReloginAccount(
    { id: "acc-hydrate", email: "hydrating@icloud.com" },
    {
      page: fakePage,
      clearSession: async (_ctx, opts) => {
        currentUrl = opts.targetUrl;
      },
      checkSession: async () => ({
        state: SESSION_OK,
        accessToken: "hdr.payload.sig",
        email: "hydrating@icloud.com",
        name: "Hydrate",
      }),
      mailCredentials: {
        getAccountCredentials: () => ({ password: null, totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }),
        getImapSecretConfig: () => ({ host: "imap.qq.com", port: 993, tls: true, user: "u@qq.com", password: "pw" }),
      },
      sharedInboxRegistry: {
        getCoordinator: () => ({
          waitForOtp: async () => "654321",
        }),
      },
      accountPlans: {
        saveToken: () => {},
      },
    },
    { force: true, skipInitialCheck: true, delayScale: 0.01, timeoutMs: 10_000 }
  );

  assert.equal(result.ok, true);
  assert.equal(step, 1);
  assert.equal(exactContinueClicked, true);
  assert.equal(straySubmitClicked, false);
});

test("sharedInbox: 乱序 UID 建索引时通过滑窗回扫不漏抓晚出现的 earlier UID", async (t) => {
  let stage = 0;
  const coordinator = new SharedInboxCoordinator(
    { host: "imap.example.com", port: 993, tls: true, user: "u@qq.com", password: "secret" },
    {
      pollIntervalMs: 30,
      idleGraceMs: 50,
      createClient: (opts) =>
        new ImapClient({
          ...opts,
          connectSocket: async () =>
            createFakeImapSocket((tag, cmd, send) => {
              if (cmd.startsWith("LIST ")) {
                send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
                send(`${tag} OK LIST\r\n`);
              } else if (cmd.startsWith("EXAMINE ")) {
                // UID 103 在 poll #1 率先出现，UID 102（同批并发更早生成的 UID）在 poll #3 才被索引可见，此时 UIDNEXT 仍为 104
                send(`* 2 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT ${stage === 0 ? 102 : 104}]\r\n`);
                send(`${tag} OK EXAMINE\r\n`);
              } else if (cmd.startsWith("UID SEARCH ")) {
                stage += 1;
                if (stage === 1) send("* SEARCH 101\r\n");
                else if (stage === 2) send("* SEARCH 101 103\r\n");
                else send("* SEARCH 101 102 103\r\n");
                send(`${tag} OK SEARCH\r\n`);
              } else if (cmd.startsWith("UID FETCH ")) {
                const reqUids = (cmd.match(/\b10[123]\b/g) || []).map(Number);
                for (const uid of reqUids) {
                  const raw =
                    uid === 102
                      ? [
                          "From: OpenAI <noreply@tm.openai.com>",
                          "To: delayed-index@icloud.com",
                          "Subject: Your ChatGPT code is 778899",
                          `Date: ${new Date().toUTCString()}`,
                          "",
                          "Code: 778899",
                        ].join("\r\n")
                      : [
                          "From: OpenAI <noreply@tm.openai.com>",
                          "To: other@icloud.com",
                          `Subject: Your ChatGPT code is 11111${uid % 10}`,
                          `Date: ${new Date().toUTCString()}`,
                          "",
                          `Code: 11111${uid % 10}`,
                        ].join("\r\n");
                  const len = Buffer.byteLength(raw, "latin1");
                  send(`* 1 FETCH (UID ${uid} BODY[] {${len}}\r\n${raw})\r\n`);
                }
                send(`${tag} OK FETCH\r\n`);
              } else if (cmd.startsWith("LOGOUT")) {
                send("* BYE\r\n");
                send(`${tag} OK LOGOUT\r\n`);
              } else {
                send(`${tag} OK\r\n`);
              }
            }),
        }),
    }
  );
  t.after(() => coordinator.dispose());

  // stage=1 初始化仅看到 UID 101
  await coordinator.pollOnce();
  const code = await coordinator.waitForOtp({
    email: "delayed-index@icloud.com",
    afterTs: Date.now() - 60_000,
    settleMs: 10,
    timeoutMs: 1_500,
  });
  assert.equal(code, "778899");
});

test("autoRelogin: 遇到 chrome-error 代理断连页只重载一次并快速报出明确网络错误", async () => {
  assert.match(
    classifyNetworkError({
      url: "chrome-error://chromewebdata/",
      text: "This site can’t be reached ERR_CONNECTION_CLOSED",
    }),
    /ERR_CONNECTION_CLOSED/
  );
  assert.equal(
    classifyNetworkError({ url: "https://chatgpt.com/auth/login", text: "Continue" }),
    null
  );

  let gotoCount = 0;
  const stages = [];
  const fakePage = {
    url: () => "chrome-error://chromewebdata/",
    frames: () => [],
    context: () => ({}),
    locator: () => ({
      first() { return this; },
      async isVisible() { return false; },
    }),
    async goto() {
      gotoCount += 1;
    },
    async evaluate() {
      return {
        title: "chatgpt.com",
        text: "このサイトにアクセスできません ERR_CONNECTION_CLOSED 再読み込み 詳細",
        hasAuthInput: false,
        hasChallengeUi: false,
        inputsSummary: [],
        buttonsSummary: ["再読み込み", "詳細"],
      };
    },
  };

  await assert.rejects(
    () =>
      autoReloginAccount(
        { id: "acc-net-err", email: "neterr@icloud.com" },
        {
          page: fakePage,
          clearSession: async () => {},
          mailCredentials: {
            getAccountCredentials: () => ({ password: null, totpSecret: null }),
            getImapSecretConfig: () => ({ host: "imap.qq.com", port: 993, tls: true, user: "u@qq.com", password: "pw" }),
          },
          sharedInboxRegistry: { getCoordinator: () => ({ waitForOtp: async () => "000000" }) },
          setStage: (stage, message) => stages.push({ stage, message }),
        },
        { force: true, skipInitialCheck: true, delayScale: 0.01, timeoutMs: 30_000 }
      ),
    /无法连接登录页（ERR_CONNECTION_CLOSED）/
  );

  assert.equal(gotoCount, 2);
  assert.equal(stages.some((s) => s.stage === "loading_login"), true);
});

test("autoRelogin: 非强制模式预检遇到 chrome-error 时直接报网络错误且不清空原有会话", async () => {
  let clearCalls = 0;
  let gotoUrl = null;
  const fakePage = {
    url: () => "chrome-error://chromewebdata/",
    frames: () => [],
    context: () => ({}),
    async goto(url) {
      gotoUrl = url;
    },
    async evaluate() {
      return {
        title: "chatgpt.com",
        text: "ERR_CONNECTION_CLOSED",
        hasAuthInput: false,
        hasChallengeUi: false,
        inputsSummary: [],
        buttonsSummary: [],
      };
    },
  };

  await assert.rejects(
    () =>
      autoReloginAccount(
        { id: "acc-precheck-net", email: "pre@icloud.com" },
        {
          page: fakePage,
          clearSession: async () => {
            clearCalls += 1;
          },
          mailCredentials: {
            getAccountCredentials: () => ({ password: null, totpSecret: null }),
            getImapSecretConfig: () => ({ host: "imap.qq.com", port: 993, tls: true, user: "u@qq.com", password: "pw" }),
          },
          sharedInboxRegistry: { getCoordinator: () => ({ waitForOtp: async () => "000000" }) },
        },
        { force: false, skipInitialCheck: false, delayScale: 0.01 }
      ),
    /无法连接登录页（ERR_CONNECTION_CLOSED）/
  );

  assert.equal(gotoUrl, "https://chatgpt.com/");
  assert.equal(clearCalls, 0);
});

test("imapClient: AbortSignal 中止在途命令时会关闭底层 socket 防止响应串包", async () => {
  const socket = createFakeImapSocket((tag, cmd, push) => {
    if (cmd.startsWith("LOGIN")) {
      push(`${tag} OK LOGIN completed\r\n`);
    }
    // NOOP 故意不回包，模拟服务端阻塞期间触发取消。
  });
  const client = new ImapClient({
    host: "imap.example.com",
    port: 993,
    tls: false,
    connectSocket: async () => socket,
    commandTimeoutMs: 5_000,
  });

  await client.connect();
  await client.login("u@qq.com", "pw");
  assert.equal(client.isOpen, true);

  const controller = new AbortController();
  const pending = client.runCommand("NOOP", { signal: controller.signal });
  // 等待 NOOP 真正进入在途等待态后再触发取消。
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assert.rejects(() => pending, /操作已取消/);
  assert.equal(client.isOpen, false);
  assert.equal(socket.destroyed, true);
});

test("persistence: listCredentialStatusMap 在密钥不匹配时按无法解密返回 false", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-creds-key-"));
  let repo = await openKeeperRepository({
    filePath: path.join(dir, "keeper.db"),
    backupDirectory: path.join(dir, "backups"),
  });
  t.after(() => {
    repo?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  repo.createAccount({ id: "acc-k1", profileName: "prof-k1", email: "k1@icloud.com" });
  const writer = new MailCredentialStore(repo.db, "ipc-key-alpha");
  writer.setAccountCredentials("acc-k1", {
    password: "secret-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
  });

  const readerWithWrongKey = new MailCredentialStore(repo.db, "ipc-key-beta");
  assert.deepEqual(readerWithWrongKey.getCredentialStatus("acc-k1"), {
    hasPassword: false,
    hasTotpSecret: false,
  });
  assert.deepEqual(readerWithWrongKey.listCredentialStatusMap().get("acc-k1"), {
    hasPassword: false,
    hasTotpSecret: false,
  });
});

test("persistence + operations: account-relogin 批次跨大量子任务淘汰保留，且误标成功的 relogin-item 会被规范化为失败", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-relogin-ops-"));
  const dbPath = path.join(dir, "keeper.db");
  const backupDirectory = path.join(dir, "backups");
  let repo = await openKeeperRepository({ filePath: dbPath, backupDirectory });
  t.after(() => {
    repo?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const batchResult = { total: 1, succeeded: 0, failures: [{ id: "acc-401", detail: "节点断开" }] };
  repo.saveOperation({
    id: "batch-relogin-1",
    kind: "account-relogin",
    resourceId: null,
    state: "succeeded",
    startedAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:01:00.000Z",
    finishedAt: "2026-11-16T00:01:00.000Z",
    result: batchResult,
  });
  repo.saveOperation({
    id: "relogin-item-stale",
    kind: "account-relogin-item",
    resourceId: "acc-401",
    state: "succeeded",
    startedAt: "2026-11-16T02:00:00.000Z",
    updatedAt: "2026-11-16T02:01:00.000Z",
    finishedAt: "2026-11-16T02:01:00.000Z",
    result: { state: "ok", lastCheckState: "unknown", lastCheckDetail: "未获取到会话", tokenStatus: "unavailable" },
  });

  for (let index = 0; index < 120; index += 1) {
    const ts = new Date(Date.parse("2026-11-16T01:00:00.000Z") + index * 1000).toISOString();
    repo.saveOperation({
      id: `filler-check-${index}`,
      kind: "account-status-refresh",
      resourceId: "acc-filler",
      state: "succeeded",
      startedAt: ts,
      updatedAt: ts,
      finishedAt: ts,
      result: { state: "ok" },
    });
  }

  repo.pruneOperations({ keep: 50 });
  repo.close();
  repo = await openKeeperRepository({ filePath: dbPath, backupDirectory });

  const registry = new OperationRegistry({ store: createSqliteRuntimeAdapters(repo).operations });
  registry.restore();

  const latestBatches = registry.listLatestAccountChecks();
  const reloginBatch = latestBatches.find((op) => op.id === "batch-relogin-1");
  assert.equal(reloginBatch?.kind, "account-relogin");
  assert.deepEqual(reloginBatch?.result, batchResult);

  const normalizedItem = registry.get("relogin-item-stale");
  assert.equal(normalizedItem?.state, "failed");
  assert.match(normalizedItem?.message ?? "", /未获取到 accessToken：未获取到会话/);
});
