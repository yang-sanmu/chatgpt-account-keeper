import http from "node:http";
import { getGroup, saveDetectedRegion } from "./store.js";
import { proxyForAccount } from "./proxyManager.js";
import * as log from "./logger.js";

/**
 * 按节点出口 IP 探测该分组应该用的时区/语言。
 *
 * 为什么需要：浏览器时区来自本机（东八区），而账号的出口 IP 在境外。
 * 「韩国 IP + 东八区时区」这种不一致是风控的常见加分项，实测你的韩国节点
 * 出口在 Asia/Seoul，本机却是 Asia/Shanghai。
 *
 * 探测请求**经节点自身发出**，所以查到的是节点出口的归属，
 * 也不会把你本机 IP 暴露给探测服务。
 */

// 探测结果缓存：proxyId -> { timezone, locale }。节点归属不会频繁变，
// 每次开浏览器都查一遍既慢又容易被限流。
const cache = new Map();
// 同一节点的并发探测合并成一次，避免同组多账号同时启动时打出多个请求。
const inflight = new Map();
// 节点刷新会推进代次；刷新前发出的旧请求即使稍后返回，也不得重新写缓存/分组。
let cacheGeneration = 0;

// 国家码 -> 浏览器语言偏好覆盖。未列出的合法地区由 localeForCountry 使用
// ICU/CLDR 推导；只有无效/未知地区才不设 locale，避免凭空猜测。
const LOCALE_BY_COUNTRY = {
  US: "en-US",
  CN: "zh-CN",
  KR: "ko-KR",
  JP: "ja-JP",
  GB: "en-GB",
  DE: "de-DE",
  FR: "fr-FR",
  NL: "nl-NL",
  SG: "en-SG",
  TW: "zh-TW",
  HK: "zh-HK",
  CA: "en-CA",
  AU: "en-AU",
  IN: "en-IN",
  RU: "ru-RU",
  BR: "pt-BR",
  TR: "tr-TR",
  TH: "th-TH",
  PH: "en-PH",
  VN: "vi-VN",
  ID: "id-ID",
  MY: "ms-MY",
  NZ: "en-NZ",
  MX: "es-MX",
  AR: "es-AR",
  CL: "es-CL",
  CO: "es-CO",
  PE: "es-PE",
  ZA: "en-ZA",
  ES: "es-ES",
  IT: "it-IT",
  PT: "pt-PT",
  AT: "de-AT",
  CH: "de-CH",
  BE: "nl-BE",
  IE: "en-IE",
  PL: "pl-PL",
  CZ: "cs-CZ",
  RO: "ro-RO",
  HU: "hu-HU",
  GR: "el-GR",
  SE: "sv-SE",
  NO: "nb-NO",
  DK: "da-DK",
  FI: "fi-FI",
  UA: "uk-UA",
  IL: "he-IL",
  AE: "ar-AE",
  SA: "ar-SA",
  QA: "ar-QA",
  KW: "ar-KW",
  OM: "ar-OM",
  BH: "ar-BH",
  JO: "ar-JO",
  EG: "ar-EG",
  MA: "ar-MA",
  PK: "ur-PK",
  BD: "bn-BD",
  LK: "en-LK",
  NP: "ne-NP",
  KH: "km-KH",
  LA: "lo-LA",
  MM: "my-MM",
  KZ: "kk-KZ",
  UZ: "uz-UZ",
  NG: "en-NG",
  KE: "en-KE",
  GH: "en-GH",
};

// 旧分组可能已经保存了 timezone，却因为当时国家表不完整而没有 locale。
// 先对不含歧义的 IANA 时区做本地回填，避免仅为语言重复访问出口探测服务。
const LOCALE_BY_TIMEZONE = {
  "Asia/Manila": "en-PH",
  "Asia/Ho_Chi_Minh": "vi-VN",
  "Asia/Saigon": "vi-VN",
  "Asia/Bangkok": "th-TH",
  "Asia/Jakarta": "id-ID",
  "Asia/Pontianak": "id-ID",
  "Asia/Makassar": "id-ID",
  "Asia/Jayapura": "id-ID",
  "Asia/Kuala_Lumpur": "ms-MY",
  "Asia/Kuching": "ms-MY",
  "Asia/Kolkata": "en-IN",
  "Asia/Calcutta": "en-IN",
  "Asia/Kathmandu": "ne-NP",
  "Asia/Katmandu": "ne-NP",
  "Asia/Colombo": "en-LK",
  "Asia/Karachi": "ur-PK",
  "Asia/Dhaka": "bn-BD",
  "Asia/Dacca": "bn-BD",
  "Asia/Phnom_Penh": "km-KH",
  "Asia/Vientiane": "lo-LA",
  "Asia/Yangon": "my-MM",
  "Asia/Rangoon": "my-MM",
  "Asia/Tashkent": "uz-UZ",
  "Asia/Samarkand": "uz-UZ",
  "Asia/Almaty": "kk-KZ",
  "Asia/Qostanay": "kk-KZ",
  "America/Sao_Paulo": "pt-BR",
  "Pacific/Auckland": "en-NZ",
  "Pacific/Chatham": "en-NZ",
  "Africa/Johannesburg": "en-ZA",
  "Africa/Lagos": "en-NG",
  "Africa/Nairobi": "en-KE",
  "Africa/Accra": "en-GH",
};

const LOCALE_BY_TIMEZONE_PREFIX = [
  ["Australia/", "en-AU"],
  ["Brazil/", "pt-BR"],
  ["Mexico/", "es-MX"],
  ["America/Argentina/", "es-AR"],
  ["Chile/", "es-CL"],
];

/**
 * 查某个代理端口的出口归属。失败返回 null——探测是尽力而为，
 * 查不到就让浏览器用默认时区，不能因此阻断登录。
 *
 * 直接用 http 模块走代理：Node 的 fetch 不支持 http 代理，而 mihomo 开的是
 * 标准 HTTP 代理端口，对明文 http 目标只要把绝对 URL 放进请求行即可，
 * 不需要额外依赖。
 */
function lookupThroughProxy(server) {
  const target = "http://ip-api.com/json/?fields=status,countryCode,timezone";
  let proxyUrl;
  try {
    proxyUrl = new URL(server);
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const req = http.request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port,
        method: "GET",
        path: target, // 走代理时请求行要用绝对 URL
        headers: { Host: "ip-api.com", Connection: "close" },
        timeout: 12000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.status !== "success" || !data.timezone) return resolve(null);
            resolve({
              timezone: data.timezone,
              locale: localeForCountry(data.countryCode),
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * 把探测/配置结果转成 Playwright 的启动参数形状。
 * 纯函数，便于单测：没有 timezone 就返回空对象（沿用浏览器默认）。
 */
export function toLaunchRegion(region) {
  if (!region?.timezone) return {};
  return {
    timezoneId: region.timezone,
    ...(region.locale ? { locale: region.locale } : {}),
  };
}

/**
 * 国家码 -> 浏览器语言。查不到返回 null（不设 locale 比瞎猜安全）。
 */
export function localeForCountry(countryCode) {
  const normalized = String(countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  const configured = LOCALE_BY_COUNTRY[normalized];
  if (configured) return configured;

  // ICU/CLDR 能从合法地区推导当地最可能语言。显式表保留业务偏好覆盖（例如
  // 菲律宾使用 en-PH 而非 fil-PH）；未列出的冷门出口也不再错误继承 zh-CN。
  // maximize 可能把未知代码退回 en-US，只有推导后的地区仍等于输入时才采用。
  try {
    const likely = new Intl.Locale(`und-${normalized}`).maximize();
    if (likely.region !== normalized || likely.language === "und") return null;
    return `${likely.language}-${normalized}`;
  } catch {
    return null;
  }
}

export function localeForTimezone(timezone) {
  const normalized = String(timezone ?? "").trim();
  if (!normalized) return null;
  const exact = LOCALE_BY_TIMEZONE[normalized];
  if (exact) return exact;
  return (
    LOCALE_BY_TIMEZONE_PREFIX.find(([prefix]) =>
      normalized.startsWith(prefix)
    )?.[1] ?? null
  );
}

/**
 * 解析某账号应该用的 { timezoneId, locale }。
 * 优先用分组上已配置/已探测的值；没有就现探测一次并落盘。
 * 未绑定节点的账号返回空对象（跟随本机，本来就一致）。
 */
export async function resolveRegionForAccount(account, dependencies = {}) {
  const groupId = account?.groupId;
  if (!groupId) return {};
  const group = getGroup(groupId);
  if (!group?.proxyId) return {};

  // 分组上已有完整值（手动设的或之前探测过的）直接用，不再发请求。旧数据只有
  // timezone、没有 locale 时，先从无歧义的 IANA 时区回填。
  if (group.timezone) {
    const locale = group.locale || localeForTimezone(group.timezone);
    if (locale && !group.locale) {
      saveDetectedRegion(groupId, { locale });
    }
    if (locale) return toLaunchRegion({ ...group, locale });
    // 不在本地时区表里的冷门出口继续向下探测一次国家码；探测失败仍保留
    // 已知时区，不会因为缺语言阻断浏览器。
  }

  const resolveProxy = dependencies.proxyForAccount ?? proxyForAccount;
  const lookup = dependencies.lookupThroughProxy ?? lookupThroughProxy;
  const proxy = resolveProxy(account);
  if (!proxy) return group.timezone ? toLaunchRegion(group) : {};

  const key = group.proxyId;
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (!group.timezone) return toLaunchRegion(cached);
    if (cached?.locale) {
      saveDetectedRegion(groupId, { locale: cached.locale });
    }
    return toLaunchRegion({
      ...group,
      locale: group.locale || cached?.locale || null,
    });
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = { generation: cacheGeneration, promise: null };
    pending.promise = Promise.resolve()
      .then(() => lookup(proxy.server))
      .finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  const found = await pending.promise;

  if (pending.generation !== cacheGeneration) {
    const current = getGroup(groupId);
    if (!current?.timezone) return {};
    return toLaunchRegion({
      ...current,
      locale: current.locale || localeForTimezone(current.timezone),
    });
  }

  if (!found) {
    log.warn(
      group.timezone
        ? `分组「${group.name}」的节点出口语言探测失败，保留时区 ${group.timezone}`
        : `分组「${group.name}」的节点出口归属探测失败，浏览器沿用本机时区`
    );
    return group.timezone ? toLaunchRegion(group) : {};
  }

  // 只缓存成功结果。代理瞬断、探测服务限流等失败是暂态，缓存 null 会让该
  // 节点在整个 Agent 生命周期内都不再重试，长期留下出口与浏览器地区不一致。
  cache.set(key, found);

  if (group.timezone) {
    if (found.locale) saveDetectedRegion(groupId, { locale: found.locale });
    log.info(
      `分组「${group.name}」按节点出口补齐语言 ${found.locale || "未知"}`
    );
    return toLaunchRegion({ ...group, locale: found.locale });
  }

  saveDetectedRegion(groupId, found);
  log.info(
    `分组「${group.name}」按节点出口探测到时区 ${found.timezone}` +
      (found.locale ? `，语言 ${found.locale}` : "")
  );
  return toLaunchRegion(found);
}

// 节点换了/订阅刷新后清缓存，避免继续用旧归属。
export function clearRegionCache() {
  cacheGeneration += 1;
  cache.clear();
  inflight.clear();
}
