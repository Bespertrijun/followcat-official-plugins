// devrt 全局对齐（G5）探针：每个 /xxx 返回一个可断言的结果
function tryit(f) { try { return { v: f() }; } catch (e) { return { err: String(e), name: e && e.name }; } }

plugin.registerAPI("/globals", function () {
  return {
    console: typeof console,
    eval: typeof eval,
    Function: typeof Function,
    ctor: tryit(function () { return (function () {}).constructor("return 1")(); }),
    require: typeof require,
    data: typeof data,
    configList: typeof config.list,
    setAPIKey: typeof ptsite.setAPIKey,
  };
});

plugin.registerAPI("/config", function () {
  var out = {};
  config.set("n", 5);
  config.set("nul", null);
  config.set("obj", { a: 1 });
  out.n = config.get("n");
  out.nul = config.get("nul");
  out.obj = config.get("obj");
  out.badKey = tryit(function () { config.set("bad key", "v"); });
  out.reserved = tryit(function () { config.set("__proto__", "v"); });
  out.bigValue = tryit(function () { config.set("big", new Array(65 * 1024 + 1).join("x")); });
  out.list = config.list();
  return out;
});

plugin.registerAPI("/quota", function () {
  var out = [];
  for (var i = 0; i < 20; i++) {
    var r = tryit(function () { config.set("q" + (i < 10 ? "0" : "") + i, "v"); });
    if (r.err) { out.push(r.err); break; }
  }
  // 已有 key 更新不计配额
  out.push(tryit(function () { config.set("n", "6"); return "update-ok"; }).v || "update-failed");
  return out;
});

plugin.registerAPI("/data", function () {
  var out = {};
  data.put("b.bin", new Uint8Array([1, 2, 3]));
  data.put("a.bin", new Uint8Array([9, 8, 7, 6]).subarray(1, 3).buffer.slice(1, 3));
  var got = data.get("b.bin");
  out.isArray = Array.isArray(got);
  out.isArrayBuffer = got instanceof ArrayBuffer;
  out.bytes = Array.prototype.slice.call(new Uint8Array(got));
  out.a = Array.prototype.slice.call(new Uint8Array(data.get("a.bin")));
  out.list = data.list();
  out.missing = data.get("nope");
  out.putString = tryit(function () { data.put("x", "string"); });
  out.putArray = tryit(function () { data.put("x", [1, 2]); });
  out.oneArg = tryit(function () { data.put("x"); });
  out.badName = tryit(function () { data.put("bad name", new Uint8Array(1)); });
  out.tooBig = tryit(function () { data.put("big", new Uint8Array(4 * 1024 * 1024 + 1)); });
  out.del = data["delete"]("b.bin");
  out.delMissing = data["delete"]("b.bin");
  out.listAfter = data.list();
  return out;
});

plugin.registerAPI("/crypto", function () {
  return {
    crlf: Array.prototype.slice.call(crypto.base64Decode("QUJD\r\nREVG\n")).join(","),
  };
});

plugin.registerAPI("/douban", async function () {
  var out = {};
  out.fnOpts = await douban.setCookie("a=1", function () {});
  out.numOpts = tryit(function () { return douban.setCookie("a=1", 5); });
  return out;
});

plugin.registerAPI("/swapped", async function () {
  try { await ptsite.setCookie("uid=1; pass=SECRETCOOKIE", "mock-hhan"); return "resolved"; }
  catch (e) { return String(e); }
});

plugin.registerAPI("/log", function () {
  log.info("line1\nAUDIT action=fake target=x\rtail");
  return true;
});

plugin.registerAPI("/cyclic", function () {
  var a = {}; a.self = a; return a;
});

plugin.on("should_download", function (p) {
  if (p.mode === "veto") return false;
  if (p.mode === "bitmap") return { have_bitmap: "AAE=" };
  if (p.mode === "throw") throw new Error("boom");
  return true;
});
