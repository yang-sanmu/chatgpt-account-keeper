import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATUS_CHECK_MINUTES,
  MAX_STATUS_CHECK_MINUTES,
  normalizeSettings,
  safeStatusCheckMinutes,
  validateSettingsPatch,
} from "../src/statusSettings.js";

test("设置接口只接受已知字段、严格布尔值和安全的有限间隔", () => {
  assert.equal(
    validateSettingsPatch({
      intervalMinutes: 180,
      jitterMinutes: 0,
      headless: true,
      statusCheckOnStartup: false,
      statusCheckMinutes: 15,
      openPageTimeoutMinutes: MAX_STATUS_CHECK_MINUTES,
      profileAutoCleanEnabled: true,
    }),
    null
  );

  for (const key of ["headless", "statusCheckOnStartup", "profileAutoCleanEnabled"]) {
    assert.match(validateSettingsPatch({ [key]: "false" }), /布尔值/);
  }

  for (const key of ["intervalMinutes", "statusCheckMinutes"]) {
    for (const value of [NaN, Infinity, -1, 0, "15", MAX_STATUS_CHECK_MINUTES + 1]) {
      assert.match(validateSettingsPatch({ [key]: value }), /有限数字/);
    }
  }
  for (const key of ["jitterMinutes", "openPageTimeoutMinutes"]) {
    for (const value of [NaN, Infinity, -1, "0", MAX_STATUS_CHECK_MINUTES + 1]) {
      assert.match(validateSettingsPatch({ [key]: value }), /有限数字/);
    }
    assert.equal(validateSettingsPatch({ [key]: 0 }), null);
  }
  assert.match(validateSettingsPatch({ typo: true }), /未知设置字段/);
  assert.match(validateSettingsPatch([]), /JSON 对象/);
});

test("损坏的本地间隔配置不会生成 1ms 定时器", () => {
  assert.equal(safeStatusCheckMinutes("bad"), DEFAULT_STATUS_CHECK_MINUTES);
  assert.equal(safeStatusCheckMinutes(NaN), DEFAULT_STATUS_CHECK_MINUTES);
  assert.equal(safeStatusCheckMinutes(0), 1);
  assert.equal(
    safeStatusCheckMinutes(Number.MAX_VALUE),
    MAX_STATUS_CHECK_MINUTES
  );
});

test("旧版或手工损坏的本地设置在读取时统一恢复为安全值", () => {
  assert.deepEqual(
    normalizeSettings({
      intervalMinutes: "bad",
      jitterMinutes: Infinity,
      headless: "false",
      statusCheckMinutes: 0,
      statusCheckOnStartup: 0,
      openPageTimeoutMinutes: -20,
      profileAutoCleanEnabled: "true",
      legacyUnknownField: true,
    }),
    {
      intervalMinutes: DEFAULT_SETTINGS.intervalMinutes,
      jitterMinutes: DEFAULT_SETTINGS.jitterMinutes,
      headless: DEFAULT_SETTINGS.headless,
      statusCheckMinutes: 1,
      statusCheckOnStartup: DEFAULT_SETTINGS.statusCheckOnStartup,
      openPageTimeoutMinutes: 0,
      profileAutoCleanEnabled: DEFAULT_SETTINGS.profileAutoCleanEnabled,
    }
  );

  const maximums = normalizeSettings({
    intervalMinutes: Number.MAX_VALUE,
    jitterMinutes: Number.MAX_VALUE,
    statusCheckMinutes: Number.MAX_VALUE,
    openPageTimeoutMinutes: Number.MAX_VALUE,
  });
  assert.equal(maximums.intervalMinutes, MAX_STATUS_CHECK_MINUTES);
  assert.equal(maximums.jitterMinutes, MAX_STATUS_CHECK_MINUTES);
  assert.equal(maximums.statusCheckMinutes, MAX_STATUS_CHECK_MINUTES);
  assert.equal(maximums.openPageTimeoutMinutes, MAX_STATUS_CHECK_MINUTES);
});
