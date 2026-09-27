// cookiecloud 测试夹具：一组浏览器 cookie（chrome.cookies.getAll 的形状）+ 官方扩展两种分组方式的移植。
//
// groupByKeywords / groupByRawDomain 逐行移植自 CookieCloud 浏览器扩展 ext/utils/functions.ts 的
// get_cookie_by_domains（easychen/CookieCloud）：填了「同步域名关键词」时按关键词分组（cookie.domain 包含
// 关键词即归入该组，同一条 cookie 可进多组）；没填时按 cookie 的原始 domain 分组（同一站被拆成
// ".x.com" / "www.x.com" 多组），可选黑名单。
'use strict';

const FAR_FUTURE = 4102444800; // 2100-01-01（秒）
const PAST = 1000000000;       // 2001-09-09（秒）

function ck(name, value, domain, extra) {
  return Object.assign({
    name, value, domain,
    hostOnly: !domain.startsWith('.'),
    path: '/', secure: true, httpOnly: false, sameSite: 'unspecified',
    session: false, expirationDate: FAR_FUTURE, storeId: '0',
  }, extra || {});
}

// 两个 PT 站 + 豆瓣 + 无关站点；含中文 / emoji 值、host-only、过期、子域、同名不同 path
const BROWSER_COOKIES = [
  ck('c_secure_uid', '10086', '.hhanclub.top'),
  ck('c_secure_pass', 'hhan-pass-中文值', '.hhanclub.top'),
  ck('cf_clearance', 'cf-token', 'hhanclub.top'),                  // host-only：只给 hhanclub.top
  ck('old_session', 'expired', '.hhanclub.top', { expirationDate: PAST }), // 已过期：跳过
  ck('sess', 'session-cookie', '.hhanclub.top', { session: true, expirationDate: undefined }),
  ck('tracker_only', 'tk', 'tracker.hhanclub.top'),                // host-only 子域
  ck('uid', '42', '.ourbits.club'),
  ck('pref', 'a', '.ourbits.club', { path: '/' }),
  ck('pref', 'b', '.ourbits.club', { path: '/torrents' }),        // 同名不同 path：两条都要
  ck('dbcl2', '"123456:abc😀"', '.douban.com'),
  ck('ck', 'Xy12', '.douban.com'),
  ck('bid', 'bid-www', 'www.douban.com'),                           // host-only www：不给 m.douban.com
  ck('frodo', 'mobile', 'm.douban.com'),                            // host-only m：给
  ck('other', 'zzz', '.example.com'),
];

function groupByKeywords(cookies, domains) {
  const ret = {};
  for (const domain of domains) {
    ret[domain] = [];
    for (const cookie of cookies) {
      if (cookie.domain && cookie.domain.includes(domain)) ret[domain].push(cookie);
    }
  }
  return ret;
}

function groupByRawDomain(cookies, blacklist) {
  const ret = {};
  for (const cookie of cookies) {
    if (!cookie.domain) continue;
    let inBlacklist = false;
    for (const black of blacklist || []) {
      if (cookie.domain.includes(black)) inBlacklist = true;
    }
    if (!inBlacklist) {
      if (!ret[cookie.domain]) ret[cookie.domain] = [];
      ret[cookie.domain].push(cookie);
    }
  }
  return ret;
}

module.exports = { BROWSER_COOKIES, groupByKeywords, groupByRawDomain, FAR_FUTURE, PAST };
