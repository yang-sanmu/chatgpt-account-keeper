#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows Authenticode is optional. Updater signatures are checked separately
// when collecting assets; macOS and Linux retain their existing signing gates.
export function verifyPlatformSigning(directory) {
  const present = name => fs.statSync(path.join(directory, name), { throwIfNoEntry: false })?.isFile()
    && fs.readFileSync(path.join(directory, name), "utf8").trim().length > 0;
  if (!present("SIGNED-win-x64.txt") && !present("UNSIGNED-win-x64.txt")) {
    throw new Error("Missing Windows signing status marker");
  }
  for (const rid of ["osx-arm64", "osx-x64", "linux-x64"]) {
    if (!present(`SIGNED-${rid}.txt`) || present(`UNSIGNED-${rid}.txt`)) {
      throw new Error(`Platform signing is required for ${rid}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: node scripts/verify-platform-signing.mjs <assets-directory>");
  verifyPlatformSigning(path.resolve(process.argv[2]));
  console.log("Platform signing gate passed (Windows Authenticode optional; updater signatures still required).");
}
