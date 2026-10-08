import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openWindowsProcessObserver } from "./helpers/windowsProcessObserver.js";

test("process handles distinguish live and exited children and closing the observer does not kill them",
  { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
    const children = [];
    let observer;
    t.after(async () => {
      try { await observer?.close(); }
      finally {
        for (const item of children) if (item.child.exitCode === null) item.child.kill();
        await Promise.all(children.map(item => item.exited));
      }
    });
    for (let index = 0; index < 2; index++) {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.once('data',()=>process.exit(23))"],
        { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      const exited = new Promise(resolve => {
        child.once("error", error => resolve({ error }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child.stdin.on("error", () => {});
      children.push({ child, exited });
    }
    observer = await openWindowsProcessObserver(children.map(item => item.child.pid));
    assert.deepEqual(observer.initial.map(item => item.state), ["running", "running"]);
    children[0].child.stdin.end("exit\n");
    assert.equal((await children[0].exited).code, 23);
    const snapshot = await observer.snapshot();
    assert.deepEqual(snapshot.map(item => item.state), ["exited", "running"]);
    assert.equal(snapshot[0].exitCode, 23);
    assert.deepEqual(snapshot.map(item => item.creationFileTime), observer.initial.map(item => item.creationFileTime));
    await observer.close();
    // Still responds after observer closure: releasing a process handle must not
    // terminate its target or be confused with releasing a kill-on-close Job.
    children[1].child.stdin.end("exit\n");
    assert.equal((await children[1].exited).code, 23);
    await assert.rejects(observer.snapshot(), /unavailable/u);
  });

test("observer setup failures cannot be interpreted as process exit", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  await assert.rejects(openWindowsProcessObserver([0]), /Invalid/u);
  await assert.rejects(openWindowsProcessObserver([process.pid, process.pid]), /Invalid/u);
  // This high, unavailable ID exercises helper lookup failure, not JS validation.
  await assert.rejects(openWindowsProcessObserver([0x7fffffff]), /observation failed|without a response/u);
});
