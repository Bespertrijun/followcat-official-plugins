// devrt 第二轮对齐（R1 / R3 / R4、data.put、should_download 裁决、log 格式）探针
"use strict";
function tryit(f) { try { return { v: f() }; } catch (e) { return { err: String(e), name: e && e.name }; } }

// ── R1：同一组用例，测试进程用 Node 原生 JSON 算期望值，这里用插件看到的（带保护的）JSON 算实际值 ──
function jsonCases(J) {
  function S(v, r, sp) { try { return J.stringify(v, r, sp); } catch (e) { return "THROW " + e.name; } }
  function P(t, r) { try { return J.stringify(J.parse(t, r)); } catch (e) { return "THROW " + e.name; } }
  var date = new Date(0);
  var withToJSON = { a: 1, toJSON: function (k) { return { key: k, x: [1, 2] }; } };
  var nested = { b: { z: 1, a: 2, keep: { a: 3, drop: 4 } }, a: [{ a: 1, b: 2 }, 3], c: "x" };
  var arrReplacer = ["a", "b", 1, "a", "keep"];
  var getterCalls = 0;
  var g = {}; Object.defineProperty(g, "p", { enumerable: true, get: function () { getterCalls++; return getterCalls; } });
  return [
    S({ b: 2, a: [1, "x", null, true, undefined, function () {}], u: undefined, d: date, n: NaN, i: -0 }),
    S(nested, arrReplacer),
    S(nested, arrReplacer, 2),
    S([nested, { a: { a: { b: 1 } } }], ["a"]),
    S(nested, function (k, v) { return typeof v === "number" ? v * 10 : v; }),
    S(nested, function (k, v) { return k === "keep" ? undefined : v; }, "\t"),
    S(withToJSON), S([withToJSON], null, 1), S({ w: withToJSON }, ["w", "key"]),
    S("str \"q\""), S(42), S(undefined), S(function () {}), S(null), S(Symbol("s")),
    S({ s: Symbol("x"), [Symbol("k")]: 1, 2: "two", 1: "one" }),
    S(new Map([[1, 2]])), S(new Uint8Array([1, 2])), S(Object.create({ inherited: 1 })),
    S(g), S({ o: g }, ["o", "p"]), "getterCalls=" + getterCalls,
    S({ a: 1 }, null, 20), S({ a: [1, { b: 2 }] }, null, "--"), S([], null, 2), S({}, null, 2),
    S(new Boolean(false)), S(new String("s")), S(new Number(3)),
    S({ a: 1 }, [new String("a"), new Number(1), {}, null]),
    P('{"a":[1,2,{"b":"[[[{{{"}],"c":"\\"]]"}'),
    P('[1,2,3]', function (k, v) { return typeof v === "number" ? v + 1 : v; }),
    P('{"x":{"y":1}}', function (k, v) { return k === "y" ? undefined : v; }),
    P(' "s" '), P("tru"), P('{"a":1,}'), P(""), P(123), P(null), P("[\"\\\\\"]"),
  ];
}

plugin.registerAPI("/json-cases", function () { return jsonCases(JSON); });

function nest(n, open, close) { var s = ""; for (var i = 0; i < n; i++) s += open; for (var j = 0; j < n; j++) s += close; return s; }

plugin.registerAPI("/json-limits", function () {
  var out = {};
  out.parse1000 = tryit(function () { return JSON.parse(nest(1000, "[", "]")).length; });
  out.parse1001 = tryit(function () { return JSON.parse(nest(1001, "[", "]")); });
  out.parseMixed1001 = tryit(function () { var s = ""; for (var i = 0; i < 1001; i++) s += (i % 2 ? '{"k":' : "["); return JSON.parse(s); });
  out.parseInString = tryit(function () { return JSON.parse('"' + nest(5000, "[", "]") + '"').length; });
  out.parseHuge = tryit(function () { return JSON.parse(nest(2000000, "[", "]")); });
  var deep = []; for (var i = 0; i < 999; i++) deep = [deep];
  out.stringify1000 = tryit(function () { return JSON.stringify(deep).length; });
  var deeper = [deep];
  out.stringify1001 = tryit(function () { return JSON.stringify(deeper); });
  var dag = [1]; for (var k = 0; k < 25; k++) dag = [dag, dag];
  out.stringifyDag = tryit(function () { return JSON.stringify(dag); });
  var cyc = {}; cyc.self = cyc;
  out.stringifyCycle = tryit(function () { return JSON.stringify(cyc); });
  // 值数按宿主口径：根 1 个 + 每个元素 1 个。999999 个元素 = 正好 100 万个值（可以），100 万个元素 = 超 1 个
  var big = new Array(999999); for (var m = 0; m < big.length; m++) big[m] = 0;
  out.stringifyAtLimit = tryit(function () { return JSON.stringify(big).length > 0; });
  big.push(0);
  out.stringifyOverLimit = tryit(function () { return JSON.stringify(big); });
  return out;
});

// ── R3：payload / req / facade 返回都是插件自己的普通对象，可增删字段（"use strict" 下也不抛） ──
function plainCheck(x) {
  var r = { proto: Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === Array.prototype,
            instanceofObject: x instanceof Object };
  try { x.__added = 1; r.added = x.__added === 1; } catch (e) { r.added = "throw " + e; }
  try { var first = Object.keys(x)[0]; delete x[first]; r.deleted = !(first in x); } catch (e) { r.deleted = "throw " + e; }
  return r;
}
var seenPayload = null;
plugin.on("on_download_done", function (p) { seenPayload = plainCheck(p); });
plugin.registerAPI("/payload", function () { return seenPayload; });
plugin.registerAPI("/req", function (req) { return plainCheck(req); });
plugin.registerAPI("/facades", async function () {
  var out = {
    ptList: plainCheck(ptsite.list()), ptItem: plainCheck(ptsite.list()[0]), ptGet: plainCheck(ptsite.get("mock-hhan")),
    registry: plainCheck(ptsite.registry()), meta: plainCheck(ptsite.getCookieMeta("mock-hhan")),
    douban: plainCheck(douban.getCookie()), task: plainCheck(task.get(1)), tasks: plainCheck(task.list()),
    anime: plainCheck(anime.get(1)), flows: plainCheck(ruleflow.list()),
  };
  var resp = await http.get("http://example.invalid/x");
  out.http = plainCheck(resp);
  out.headers = plainCheck(resp.headers);
  // 每次调用各一份：改了上一份不影响下一份
  var a = ptsite.list(); a[0].name = "changed";
  out.fresh = ptsite.list()[0].name !== "changed";
  return out;
});

// ── R4：config.delete ──
plugin.registerAPI("/cfgdel", function () {
  var out = {};
  config.set("k1", "v");
  out.first = config["delete"]("k1");
  out.again = config["delete"]("k1");
  out.after = config.get("k1");
  out.badKey = tryit(function () { return config["delete"]("bad key"); });
  out.undef = tryit(function () { return config["delete"](); });
  config.set("k2", "v2");
  out.list = config.list();
  return out;
});

// ── data.put：data.get 回的字节数组可以写回；数组字面量不行；名字按 String(v) ──
plugin.registerAPI("/dataput", function () {
  var out = {};
  data.put("a", new Uint8Array([1, 2, 200]));
  out.roundtrip = tryit(function () { var g = data.get("a"); g[0] = 9; data.put("b", g); return Array.prototype.slice.call(data.get("b")); });
  out.literal = tryit(function () { data.put("c", [1, 2, 3]); });
  out.int16 = tryit(function () { data.put("c", new Int16Array([1])); });
  out.obj = tryit(function () { data.put("c", { a: 1 }); });
  out.nul = tryit(function () { data.put("c", null); });
  out.undefName = tryit(function () { data.put(undefined, new Uint8Array([7])); return data.get("undefined"); });
  out.numName = tryit(function () { data.put(42, new Uint8Array([8])); return data.get("42"); });
  out.list = data.list();
  return out;
});

// ── log 格式贴近宿主 fmt.Sprint ──
plugin.registerAPI("/logfmt", function () {
  log.info("LOGFMT", { b: 2, a: { c: [1, 2] } }, [1, "a", null, true], null, undefined, 5, 0.1 + 0.2, 123456789.5, 1e21, 1e-7,
    NaN, Infinity, -Infinity, -0, new Error("boom"), new Uint8Array([1, 2]), Symbol("q"), true, [], {}, new Map([[1, 2]]), "s p");
  return true;
});

// ── should_download：按导出后的值裁决 ──
plugin.on("should_download", function (p) {
  switch (p.mode) {
    case "toJSON-false": return { toJSON: function () { return false; } };
    case "boxed-false": return new Boolean(false);
    case "cyclic": var c = {}; c.self = c; return c;
    case "bitmap-empty": return { have_bitmap: "" };
    case "bitmap-bad": return { have_bitmap: "!!!" };
    case "bitmap-zero-bytes": return { have_bitmap: "====" };
    case "bitmap-array": return [{ have_bitmap: "AAE=" }];
    case "bitmap-toJSON": return { toJSON: function () { return { have_bitmap: "AAE=" }; } };
    case "false-string": return "false";
    case "mutate": p.flow_id = "changed"; delete p.media; return p.__nope === undefined;
  }
  return true;
});

// ── 返回值导出上限（同宿主 exportJSON）──
function nested(n) { var d = []; for (var i = 1; i < n; i++) d = [d]; return d; }
plugin.registerAPI("/export-1000", function () { return nested(1000); });
plugin.registerAPI("/export-1001", function () { return nested(1001); });
plugin.registerAPI("/export-bigint", function () { return { v: BigInt(1) }; });
