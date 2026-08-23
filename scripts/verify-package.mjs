#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] ?? "");
const expectedVersion = process.argv[3] ?? null;
const expectedRid = process.argv[4] ?? null;
const supportedRids = new Set(["win-x64", "linux-x64", "osx-arm64", "osx-x64"]);
const nativePrebuildByRid = {
  "win-x64": "win32-x64.node",
  "linux-x64": "linux-x64.node",
  "osx-arm64": "darwin-arm64.node",
  "osx-x64": "darwin-x64.node",
};
if (!process.argv[2] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("usage: node scripts/verify-package.mjs <staged-package-dir> [version] [rid]");
  process.exit(2);
}
if (expectedRid && !supportedRids.has(expectedRid)) {
  console.error(`Unsupported release RID: ${expectedRid}`);
  process.exit(2);
}

const forbidden = [
  /(^|\/)\.local-browsers(\/|$)/i,
  /(^|\/)ms-playwright(\/|$)/i,
  /(^|\/)(?:chromium|chromium_headless_shell|firefox|webkit)-\d+(\/|$)/i,
  /(^|\/)chrome-(?:win|linux|mac)(\/|$)/i,
  /(^|\/)public\/(?:index\.html|app\.js|style\.css)$/i,
  /^agent\/node_modules\/express(\/|$)/i,
  /^agent\/src\/(?:server|cli)\.js$/i,
  /\.pdb$/i,
];

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) files.push(absolute);
  }
}
walk(root);

const relativeFiles = files
  .map((file) => path.relative(root, file).split(path.sep).join("/"))
  .filter((file) => file !== "SHA256SUMS");
const violations = relativeFiles.filter((file) =>
  forbidden.some((pattern) => pattern.test(file))
);
if (violations.length) {
  console.error("Release package contains forbidden browser/web-panel/development assets:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

const hasPrivateNode = relativeFiles.some((file) =>
  /^agent\/runtime\/node(?:\.exe)?$/i.test(file)
);
if (!hasPrivateNode) {
  console.error("Release package does not contain the private Node runtime.");
  process.exit(1);
}

const requiredPatterns = [
  /^GptAccountKeeper\.Desktop(?:\.exe)?$/i,
  /^agent\/src\/agent\/launcher\.js$/i,
  /^agent\/package\.json$/i,
  /^agent\/package-lock\.json$/i,
  /^agent\/contracts\/ipc-v1\.schema\.json$/i,
  /^agent\/contracts\/ipc-v1\.methods\.schema\.json$/i,
  // 站点选择器是登录、打开网页和自动对话共同的硬依赖。缺了它安装版会在
  // 用户点"打开网页"时以 ENOENT 失败，而打包步骤本身完全不报错。
  /^agent\/config\/selectors\.json$/i,
  /^agent\/bin\/mihomo(?:\.exe)?$/i,
  /^licenses\/mihomo-GPL-3\.0\.txt$/i,
  /^licenses\/Node\.js-LICENSE\.txt$/i,
  /^licenses\/runtime-versions\.json$/i,
  /^licenses\/LICENSE$/i,
  /^licenses\/THIRD_PARTY_NOTICES\.md$/i,
  /^licenses\/PRIVACY\.md$/i,
  /^licenses\/SOURCE\.md$/i,
];
const missing = requiredPatterns.filter((pattern) =>
  !relativeFiles.some((file) => pattern.test(file))
);
if (missing.length) {
  console.error("Release package is missing required runtime/licensing assets:");
  for (const pattern of missing) console.error(`  - ${pattern}`);
  process.exit(1);
}

if (expectedRid) {
  const windows = expectedRid === "win-x64";
  const platformFiles = [
    windows ? "GptAccountKeeper.Desktop.exe" : "GptAccountKeeper.Desktop",
    windows ? "agent/runtime/node.exe" : "agent/runtime/node",
    windows ? "agent/bin/mihomo.exe" : "agent/bin/mihomo",
    // Windows 上 broker 缺失会让 Agent 在接受 IPC 前 fail-closed，等于整个安装不可用。
    ...(windows ? ["agent/bin/chrome-launcher.exe"] : []),
  ];
  const missingPlatformFiles = platformFiles.filter((file) => !relativeFiles.includes(file));
  if (missingPlatformFiles.length) {
    console.error(`Release package does not match ${expectedRid}:`);
    for (const file of missingPlatformFiles) console.error(`  - ${file}`);
    process.exit(1);
  }
  // Windows cannot represent Unix executable mode bits. Unix release jobs run
  // this verifier on their native runner, where a missing +x is meaningful.
  if (!windows && process.platform !== "win32") {
    const notExecutable = platformFiles.filter(
      (file) => (fs.statSync(path.join(root, ...file.split("/"))).mode & 0o111) === 0
    );
    if (notExecutable.length) {
      console.error(`Release package contains non-executable ${expectedRid} binaries:`);
      for (const file of notExecutable) console.error(`  - ${file}`);
      process.exit(1);
    }
  }

  const runtimeManifest = JSON.parse(
    fs.readFileSync(path.join(root, "licenses", "runtime-versions.json"), "utf8")
  );
  if (!runtimeManifest.node?.runtimes?.[expectedRid] || !runtimeManifest.mihomo?.runtimes?.[expectedRid]) {
    console.error(`runtime-versions.json does not pin Node and mihomo for ${expectedRid}.`);
    process.exit(1);
  }

  const nativePrebuilds = relativeFiles.filter((file) =>
    /^agent\/node_modules\/better-sqlite3\/prebuilds\/[^/]+\.node$/i.test(file)
  );
  const expectedPrebuild =
    `agent/node_modules/better-sqlite3/prebuilds/${nativePrebuildByRid[expectedRid]}`;
  if (
    nativePrebuilds.length > 0 &&
    (nativePrebuilds.length !== 1 || nativePrebuilds[0] !== expectedPrebuild)
  ) {
    console.error(`Release package contains incorrect better-sqlite3 prebuilds for ${expectedRid}:`);
    for (const file of nativePrebuilds) console.error(`  - ${file}`);
    process.exit(1);
  }
}

const agentPackage = JSON.parse(fs.readFileSync(path.join(root, "agent", "package.json"), "utf8"));
const agentLock = JSON.parse(fs.readFileSync(path.join(root, "agent", "package-lock.json"), "utf8"));
if (
  agentPackage.license !== "AGPL-3.0-only" ||
  agentLock.packages?.[""]?.license !== "AGPL-3.0-only"
) {
  console.error("Release Agent metadata must declare AGPL-3.0-only.");
  process.exit(1);
}
if (
  expectedVersion &&
  (agentPackage.version !== expectedVersion ||
    agentLock.version !== expectedVersion ||
    agentLock.packages?.[""]?.version !== expectedVersion)
) {
  console.error(
    `Release version mismatch: expected ${expectedVersion}, ` +
      `package=${agentPackage.version}, lock=${agentLock.version}, ` +
      `lockRoot=${agentLock.packages?.[""]?.version}`
  );
  process.exit(1);
}

const manifest = relativeFiles
  .sort((a, b) => a.localeCompare(b))
  .map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const hash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    return `${hash}  ${relative}`;
  })
  .join("\n");

fs.writeFileSync(path.join(root, "SHA256SUMS"), `${manifest}\n`, "utf8");
console.log(`Verified ${relativeFiles.length} files; no bundled browser or legacy web panel found.`);
