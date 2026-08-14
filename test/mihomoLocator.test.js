import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findMihomoExecutable,
  platformInstallDirectories,
  validateMihomoExecutable,
} from "../src/mihomoLocator.js";

test("cross-platform mihomo search includes macOS and Linux standard locations", () => {
  const mac = platformInstallDirectories({
    platform: "darwin",
    env: {},
    homeDir: "/Users/keeper",
  });
  assert.ok(mac.some((item) => item.replaceAll("\\", "/").includes("/Applications/Clash Verge.app/Contents/MacOS")));
  assert.ok(mac.some((item) => item.replaceAll("\\", "/").includes("/opt/homebrew/bin")));

  const linux = platformInstallDirectories({
    platform: "linux",
    env: {},
    homeDir: "/home/keeper",
  });
  assert.ok(linux.some((item) => item.replaceAll("\\", "/").includes("/usr/local/bin")));
  assert.ok(linux.some((item) => item.replaceAll("\\", "/").includes("/home/keeper/.local/bin")));
});

const MIHOMO_NAME = process.platform === "win32" ? "mihomo.exe" : "mihomo";
const ALPHA_NAME =
  process.platform === "win32" ? "verge-mihomo-alpha.exe" : "verge-mihomo-alpha";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-mihomo-"));
  const executable = (relativePath) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    return target;
  };
  return {
    root,
    executable,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("mihomo locator accepts a quoted configured executable path", () => {
  const fx = fixture();
  try {
    const executable = fx.executable(path.join("custom", MIHOMO_NAME));
    const found = findMihomoExecutable({
      configuredPath: `"${executable}"`,
      projectRoot: fx.root,
      env: {},
      registryInstallDirs: [],
    });

    assert.equal(found, executable);
  } finally {
    fx.cleanup();
  }
});

test("mihomo locator finds a user-level Clash Verge Rev core", () => {
  const fx = fixture();
  try {
    const localAppData = path.join(fx.root, "Local");
    const executable = fx.executable(
      path.join("Local", "Programs", "Clash Verge Rev", "resources", MIHOMO_NAME)
    );
    const found = findMihomoExecutable({
      projectRoot: fx.root,
      env: { LOCALAPPDATA: localAppData },
      registryInstallDirs: [],
    });

    assert.equal(found, executable);
  } finally {
    fx.cleanup();
  }
});

test("mihomo locator prioritizes the configured Clash Verge install directory", () => {
  const fx = fixture();
  try {
    const installDirectory = path.join(fx.root, "My Clash Verge");
    const executable = fx.executable(path.join("My Clash Verge", "resources", MIHOMO_NAME));
    fx.executable(path.join("bin", MIHOMO_NAME));
    const found = findMihomoExecutable({
      configuredInstallDir: `"${installDirectory}"`,
      projectRoot: fx.root,
      env: {},
      registryInstallDirs: [],
    });

    assert.equal(found, executable);
  } finally {
    fx.cleanup();
  }
});

test("mihomo executable validation accepts a real Mihomo version response", () => {
  const result = validateMihomoExecutable("mihomo", {
    runner: () => ({
      status: 0,
      stdout: "Mihomo Meta v1.19.21 windows amd64",
      stderr: "",
    }),
  });

  assert.equal(result.ok, true);
  assert.match(result.version, /Mihomo Meta/);
});

test("mihomo executable validation rejects an unrelated executable", () => {
  const result = validateMihomoExecutable("not-mihomo", {
    runner: () => ({
      status: 0,
      stdout: "Some other program 1.0",
      stderr: "",
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Mihomo/);
});

test("mihomo locator searches a custom registry installation directory", () => {
  const fx = fixture();
  try {
    const installDirectory = path.join(fx.root, "Portable Verge");
    const executable = fx.executable(
      path.join("Portable Verge", "resources", "core", ALPHA_NAME)
    );
    const found = findMihomoExecutable({
      projectRoot: fx.root,
      env: {},
      registryInstallDirs: [installDirectory],
    });

    assert.equal(found, executable);
  } finally {
    fx.cleanup();
  }
});
