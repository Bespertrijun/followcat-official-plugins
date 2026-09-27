plugin.registerAPI("/ping", function () { return "pong"; });
plugin.registerAPI("/syncspin", function () { while (true) {} });
plugin.on("should_download", async function (p) {
  if (p.mode === "await-null-spin") { await null; while (true) {} }
  if (p.mode === "await-http-spin") { await http.get("http://example.invalid/x"); while (true) {} }
  return true;
});
var ticks = 0;
plugin.registerAPI("/timer-spin", function () {
  setTimeout(function () { while (true) {} }, 0);
  setTimeout(function () { ticks++; }, 50);
  return true;
});
plugin.registerAPI("/ticks", function () { return ticks; });
