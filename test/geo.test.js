import test from "node:test";
import assert from "node:assert/strict";
import { toLaunchRegion, localeForCountry } from "../src/geo.js";

test("toLaunchRegion omits region entirely when no timezone is known", () => {
  // 探测失败时必须返回空对象：宁可沿用浏览器默认，也不要设一个错的时区。
  assert.deepEqual(toLaunchRegion(null), {});
  assert.deepEqual(toLaunchRegion({}), {});
  assert.deepEqual(toLaunchRegion({ locale: "en-US" }), {});
});

test("toLaunchRegion passes timezone through and keeps locale optional", () => {
  assert.deepEqual(toLaunchRegion({ timezone: "Asia/Seoul", locale: "ko-KR" }), {
    timezoneId: "Asia/Seoul",
    locale: "ko-KR",
  });
  // 查不到语言时不能塞 undefined，否则 Playwright 会收到显式的 locale 键
  const onlyTz = toLaunchRegion({ timezone: "Asia/Seoul", locale: null });
  assert.deepEqual(onlyTz, { timezoneId: "Asia/Seoul" });
  assert.equal("locale" in onlyTz, false);
});

test("localeForCountry maps known exits and declines to guess unknown ones", () => {
  assert.equal(localeForCountry("KR"), "ko-KR");
  assert.equal(localeForCountry("US"), "en-US");
  assert.equal(localeForCountry("JP"), "ja-JP");
  assert.equal(localeForCountry("ZZ"), null);
  assert.equal(localeForCountry(undefined), null);
});
