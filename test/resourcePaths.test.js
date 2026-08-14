import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 随程序分发的只读资源（config/selectors.json）在安装布局下的解析。
 *
 * 之前 4 处调用用 readJson 从 DATA_ROOT 读它。CLI 模式下 DATA_ROOT 恰好等于源码
 * 根目录，所以整套测试都过；但安装后的 Agent 把 DATA_ROOT 指向
 * %LOCALAPPDATA%\...\data，于是"打开网页"和"登录"直接 ENOENT 失败。
 *
 * 这些测试必须在真正分离的布局下跑 —— 这正是原来缺失的覆盖。
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

function withInstalledLayout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-resource-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataRoot };
}

/** paths.js 在导入时读环境变量，所以每个用例都要拿一份新的模块实例。 */
async function loadPaths(dataRoot) {
  const previous = process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT;
  process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT = dataRoot;
  try {
    const url = new URL(pathToFileURL(path.join(REPOSITORY_ROOT, "src", "paths.js")));
    url.searchParams.set("resource-test", String(Math.random()).slice(2));
    return await import(url.href);
  } finally {
    if (previous === undefined) delete process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT;
    else process.env.GPT_ACCOUNT_KEEPER_DATA_ROOT = previous;
  }
}

test("数据目录与安装目录分离时仍能读到随版本分发的 selectors", async (t) => {
  const { dataRoot } = withInstalledLayout(t);
  const paths = await loadPaths(dataRoot);

  // 数据目录里没有这个文件，必须回落到安装目录的默认值。
  assert.equal(fs.existsSync(path.join(dataRoot, "config", "selectors.json")), false);
  const selectors = paths.readResourceJson("config/selectors.json");
  assert.equal(typeof selectors.url, "string");
  assert.ok(selectors.url.length > 0);

  // 同一个路径用 readJson 读会失败：这正是打开网页/登录报 ENOENT 的原因。
  assert.throws(() => paths.readJson("config/selectors.json"), (error) => error.code === "ENOENT");
});

test("数据目录中的用户覆盖优先于安装目录的默认值", async (t) => {
  const { dataRoot } = withInstalledLayout(t);
  const paths = await loadPaths(dataRoot);
  const configRoot = path.join(dataRoot, "config");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "selectors.json"),
    JSON.stringify({ url: "https://example.invalid/custom" }),
    "utf8"
  );

  assert.equal(
    paths.readResourceJson("config/selectors.json").url,
    "https://example.invalid/custom"
  );
});

test("CLI 布局下（数据目录即源码根）解析结果与安装布局一致", async () => {
  const paths = await loadPaths(REPOSITORY_ROOT);
  const viaResource = paths.readResourceJson("config/selectors.json");
  const viaJson = paths.readJson("config/selectors.json");
  assert.deepEqual(viaResource, viaJson);
});

test("损坏的用户覆盖会明确报错，而不是静默退回默认值", async (t) => {
  const { dataRoot } = withInstalledLayout(t);
  const paths = await loadPaths(dataRoot);
  const configRoot = path.join(dataRoot, "config");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, "selectors.json"), "{ 半行 JSON", "utf8");

  // 静默回落会让用户以为自己的覆盖生效了，实际用的是另一份配置。
  assert.throws(() => paths.readResourceJson("config/selectors.json"), SyntaxError);
});

test("需要 selectors 的模块都不再从数据目录直接读它", () => {
  // 回归护栏：任何一处退回 readJson("config/selectors.json") 都会让安装版
  // 的登录与打开网页再次 ENOENT。
  for (const relative of ["src/openPage.js", "src/login.js", "src/loginProvider.js", "src/scheduler.js"]) {
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
    assert.ok(
      source.includes('readResourceJson("config/selectors.json")'),
      `${relative} 必须使用 readResourceJson 解析 selectors`
    );
    assert.ok(
      !source.includes('readJson("config/selectors.json")'),
      `${relative} 不能从数据目录直接读 selectors`
    );
  }
});
