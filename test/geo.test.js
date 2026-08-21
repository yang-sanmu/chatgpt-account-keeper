import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRegionCache,
  localeForCountry,
  localeForTimezone,
  resolveRegionForAccount,
  toLaunchRegion,
} from "../src/geo.js";
import { configureStoreBackend } from "../src/store.js";

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

test("localeForCountry covers common and less-common proxy exits", () => {
  const expected = {
    KR: "ko-KR",
    US: "en-US",
    JP: "ja-JP",
    TH: "th-TH",
    BR: "pt-BR",
    PH: "en-PH",
    VN: "vi-VN",
    AU: "en-AU",
    ID: "id-ID",
    MY: "ms-MY",
    NZ: "en-NZ",
    ZA: "en-ZA",
    AE: "ar-AE",
    IS: "is-IS",
    GL: "kl-GL",
    FJ: "en-FJ",
    MN: "mn-MN",
    BT: "dz-BT",
  };
  for (const [country, locale] of Object.entries(expected)) {
    assert.equal(localeForCountry(country), locale, country);
  }
  assert.equal(localeForCountry("ph"), "en-PH");
  assert.equal(localeForCountry("ZZ"), null);
  assert.equal(localeForCountry("USA"), null);
  assert.equal(localeForCountry(undefined), null);
});

test("localeForTimezone backfills unambiguous legacy timezone-only groups", () => {
  const expected = {
    "Asia/Manila": "en-PH",
    "Asia/Ho_Chi_Minh": "vi-VN",
    "Asia/Bangkok": "th-TH",
    "America/Sao_Paulo": "pt-BR",
    "Australia/Sydney": "en-AU",
    "Australia/Eucla": "en-AU",
    "Pacific/Auckland": "en-NZ",
    "Asia/Kathmandu": "ne-NP",
    "Asia/Calcutta": "en-IN",
    "Africa/Johannesburg": "en-ZA",
  };
  for (const [timezone, locale] of Object.entries(expected)) {
    assert.equal(localeForTimezone(timezone), locale, timezone);
  }
  assert.equal(localeForTimezone("America/Unknown"), null);
  assert.equal(localeForTimezone(undefined), null);
});

test("existing timezone-only group receives locale without another IP lookup", async (t) => {
  const saved = [];
  const restore = configureStoreBackend({
    getGroup: () => ({
      id: "g-ph",
      name: "菲律宾",
      proxyId: "proxy-ph",
      timezone: "Asia/Manila",
      locale: null,
    }),
    saveDetectedRegion: (id, region) => saved.push([id, region]),
  });
  t.after(restore);

  const region = await resolveRegionForAccount({ id: "a-ph", groupId: "g-ph" });
  assert.deepEqual(region, {
    timezoneId: "Asia/Manila",
    locale: "en-PH",
  });
  assert.deepEqual(saved, [
    ["g-ph", { timezone: undefined, locale: "en-PH" }],
  ]);
});

test("known cold-region timezone survives when its proxy is unavailable", async (t) => {
  const restore = configureStoreBackend({
    getGroup: () => ({
      id: "g-gl",
      name: "格陵兰",
      proxyId: "missing-proxy",
      timezone: "America/Nuuk",
      locale: null,
    }),
  });
  t.after(restore);

  const region = await resolveRegionForAccount({ id: "a-gl", groupId: "g-gl" });
  assert.deepEqual(region, { timezoneId: "America/Nuuk" });
});

test("temporary exit lookup failures are not cached", async (t) => {
  clearRegionCache();
  t.after(clearRegionCache);
  const saved = [];
  const restore = configureStoreBackend({
    getGroup: () => ({
      id: "g-retry",
      name: "临时失败节点",
      proxyId: "proxy-retry",
      timezone: null,
      locale: null,
    }),
    saveDetectedRegion: (id, region) => saved.push([id, region]),
  });
  t.after(restore);
  let attempt = 0;
  const lookupThroughProxy = t.mock.fn(async () => {
    attempt += 1;
    return attempt === 1
      ? null
      : { timezone: "Atlantic/Reykjavik", locale: "is-IS" };
  });
  const dependencies = {
    proxyForAccount: () => ({ server: "http://127.0.0.1:29999" }),
    lookupThroughProxy,
  };

  assert.deepEqual(
    await resolveRegionForAccount(
      { id: "a-retry", groupId: "g-retry" },
      dependencies
    ),
    {}
  );
  assert.deepEqual(
    await resolveRegionForAccount(
      { id: "a-retry", groupId: "g-retry" },
      dependencies
    ),
    { timezoneId: "Atlantic/Reykjavik", locale: "is-IS" }
  );
  assert.equal(lookupThroughProxy.mock.callCount(), 2);
  assert.deepEqual(saved, [
    [
      "g-retry",
      { timezone: "Atlantic/Reykjavik", locale: "is-IS" },
    ],
  ]);
});

test("lookup results from before a node refresh cannot overwrite the new region", async (t) => {
  clearRegionCache();
  t.after(clearRegionCache);
  const saved = [];
  const restore = configureStoreBackend({
    getGroup: () => ({
      id: "g-race",
      name: "切换中节点",
      proxyId: "proxy-race",
      timezone: null,
      locale: null,
    }),
    saveDetectedRegion: (id, region) => saved.push([id, region]),
  });
  t.after(restore);

  let releaseOld;
  const oldResult = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let attempt = 0;
  const lookupThroughProxy = t.mock.fn(async () => {
    attempt += 1;
    if (attempt === 1) return oldResult;
    return { timezone: "Asia/Tokyo", locale: "ja-JP" };
  });
  const account = { id: "a-race", groupId: "g-race" };
  const dependencies = {
    proxyForAccount: () => ({ server: "http://127.0.0.1:29998" }),
    lookupThroughProxy,
  };

  const staleLaunch = resolveRegionForAccount(account, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  clearRegionCache();
  const freshLaunch = await resolveRegionForAccount(account, dependencies);
  releaseOld({ timezone: "America/Los_Angeles", locale: "en-US" });

  assert.deepEqual(freshLaunch, {
    timezoneId: "Asia/Tokyo",
    locale: "ja-JP",
  });
  assert.deepEqual(await staleLaunch, {});
  assert.deepEqual(
    await resolveRegionForAccount(account, dependencies),
    freshLaunch,
    "旧请求完成后不得覆盖新代次的成功缓存"
  );
  assert.equal(lookupThroughProxy.mock.callCount(), 2);
  assert.deepEqual(saved, [
    ["g-race", { timezone: "Asia/Tokyo", locale: "ja-JP" }],
  ]);
});
