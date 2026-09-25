// Cookie 归一化契约 —— 参考实现（devrt 宿主模拟层用它算 getCookieMeta 的 sha256）
//
// 下面两个函数与 docs/plugins/sdk.md「Cookie 归一化契约」代码块、以及主仓
// internal/plugin/cookie_normalize_ref_test.go 的 cookieNormalizeRefJS 逐字一致；
// 测试向量见 docs/plugins/cookie-normalize-vectors.json（与主仓 pkg/crypto/testdata 同一份）。
// 跑向量：node --test devrt/cookie-normalize.test.js

'use strict';

function normalizeCookie(s) {
  var parts = String(s).split(";");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
    if (p !== "") out.push(p);
  }
  out.sort(compareCodePoints);
  return out.join("; ");
}

// 按 Unicode 码点比较（== UTF-8 字节序）。不能用默认 sort()：它按 UTF-16 码元比较，
// 对 BMP 之外的字符（emoji 等）与 U+E000–U+FFFF 之间的顺序和宿主不一致。
function compareCodePoints(a, b) {
  var i = 0, j = 0;
  while (i < a.length && j < b.length) {
    var ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

module.exports = { normalizeCookie, compareCodePoints };
