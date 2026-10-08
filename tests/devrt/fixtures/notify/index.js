// devrt notify.send stub fixture (tests/devrt/sandbox.test.js)

function settle(p) {
  return p.then(function (r) { return { resolved: r }; },
    function (e) { return { rejected: e.message, name: e.name, isError: e instanceof Error }; });
}

// Same argument table as the host's TestNotify_TypeErrors
var typeCases = {
  "": function () { return notify.send(); },
  "undefined": function () { return notify.send(undefined); },
  "null": function () { return notify.send(null); },
  "string": function () { return notify.send("title"); },
  "number": function () { return notify.send(42); },
  "function": function () { return notify.send(function () {}); },
  "array": function () { return notify.send([{ title: "x" }]); },
  "title number": function () { return notify.send({ title: 1 }); },
  "title object": function () { return notify.send({ title: {} }); },
  "title function": function () { return notify.send({ title: function () {} }); },
  "body number": function () { return notify.send({ title: "t", body: 2 }); },
  "image array": function () { return notify.send({ title: "t", image: [] }); },
  "buttons string": function () { return notify.send({ title: "t", buttons: "x" }); },
  "buttons object": function () { return notify.send({ title: "t", buttons: {} }); },
  "rows then flat": function () { return notify.send({ title: "t", buttons: [[{ label: "a", url: "https://a.example/" }], { label: "b", url: "https://b.example/" }] }); },
  "flat then row": function () { return notify.send({ title: "t", buttons: [{ label: "b", url: "https://b.example/" }, [{ label: "a", url: "https://a.example/" }]] }); },
  "button number": function () { return notify.send({ title: "t", buttons: [1] }); },
  "row button number": function () { return notify.send({ title: "t", buttons: [[1]] }); },
  "label number": function () { return notify.send({ title: "t", buttons: [{ label: 2, url: "u" }] }); },
  "url number": function () { return notify.send({ title: "t", buttons: [{ label: "a", url: 3 }] }); },
  "action boolean": function () { return notify.send({ title: "t", buttons: [{ label: "a", action: true }] }); },
  "title cyclic": function () { var o = {}; o.self = o; return notify.send({ title: o }); },
  "title bigint": function () { return notify.send({ title: BigInt(1) }); },
  "boxed string title ok": function () { return notify.send({ title: new String("t") }); },
};

plugin.registerAPI("/typeerrors", function () {
  var out = {};
  Object.keys(typeCases).forEach(function (k) {
    try {
      var p = typeCases[k]();
      p.then(undefined, function () {});
      out[k] = "no throw";
    } catch (e) {
      out[k] = (e instanceof TypeError ? "TypeError: " : "other: ") + e.message;
    }
  });
  return out;
});

// body: JSON array of messages → each one's outcome ("" = accepted, else the reject reason)
plugin.registerAPI("/vectors", async function (req) {
  var msgs = JSON.parse(req.body);
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    try {
      await notify.send(msgs[i]);
      out.push("");
    } catch (e) {
      out.push(e.message);
    }
  }
  return out;
});

plugin.registerAPI("/send", function (req) { return settle(notify.send(JSON.parse(req.body))); });

// The Promise is already settled when send returns: a reaction queued right away runs before a later microtask
plugin.registerAPI("/sync-settle", async function () {
  var seen = [];
  var a = notify.send({ title: "a" });
  var b = notify.send({ title: "" });
  var c = notify.send({ title: "c" });
  [a, b, c].forEach(function (p, i) { p.then(function () { seen.push(i + ":ok"); }, function () { seen.push(i + ":rej"); }); });
  await null;
  return seen;
});

// should_download: sending inside the veto hook (awaited or not, resolved or rejected) never changes its verdict
plugin.on("should_download", async function (p) {
  if (p.mode === "await-reject-veto") { try { await notify.send({ title: "" }); } catch (e) {} return false; }
  if (p.mode === "unawaited-reject-veto") { notify.send({ title: "" }); return false; }
  if (p.mode === "await-ok-allow") { await notify.send({ title: "t" }); return true; }
  return true;
});
