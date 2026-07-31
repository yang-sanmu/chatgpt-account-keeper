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

// 国家码 -> 浏览器语言。只列常见出口地区，查不到就不设 locale
// （不设 = 用浏览器默认，比瞎猜一个更安全）。
const LOCALE_BY_COUNTRY = {
  US: "en-US",
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
};

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
              locale: LOCALE_BY_COUNTRY[data.countryCode] ?? null,
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
  return LOCALE_BY_COUNTRY[countryCode] ?? null;
}

/**
 * 解析某账号应该用的 { timezoneId, locale }。
 * 优先用分组上已配置/已探测的值；没有就现探测一次并落盘。
 * 未绑定节点的账号返回空对象（跟随本机，本来就一致）。
 */
export async function resolveRegionForAccount(account) {
  const groupId = account?.groupId;
  if (!groupId) return {};
  const group = getGroup(groupId);
  if (!group?.proxyId) return {};

  // 分组上已有值（手动设的或之前探测过的）直接用，不再发请求。
  if (group.timezone) return toLaunchRegion(group);

  const proxy = proxyForAccount(account);
  if (!proxy) return {};

  const key = group.proxyId;
  if (cache.has(key)) return toLaunchRegion(cache.get(key));

  if (!inflight.has(key)) {
    inflight.set(
      key,
      lookupThroughProxy(proxy.server).finally(() => inflight.delete(key))
    );
  }
  const found = await inflight.get(key);
  cache.set(key, found);

  if (!found) {
    log.warn(`分组「${group.name}」的节点出口归属探测失败，浏览器沿用本机时区`);
    return {};
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
  cache.clear();
}
