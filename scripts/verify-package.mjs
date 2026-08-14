#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] ?? "");
const expectedVersion = process.argv[3] ?? null;
if (!process.argv[2] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("usage: node scripts/verify-package.mjs <staged-package-dir>");
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
];
const missing = requiredPatterns.filter((pattern) =>
  !relativeFiles.some((file) => pattern.test(file))
);
if (missing.length) {
  console.error("Release package is missing required runtime/licensing assets:");
  for (const pattern of missing) console.error(`  - ${pattern}`);
  process.exit(1);
}

const agentPackage = JSON.parse(fs.readFileSync(path.join(root, "agent", "package.json"), "utf8"));
const agentLock = JSON.parse(fs.readFileSync(path.join(root, "agent", "package-lock.json"), "utf8"));
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
