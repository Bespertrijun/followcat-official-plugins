// The interaction hooks need api.notify.send: plugin.on throws without it (host hookToPerm)
var errors = {};
["on_notify_action", "on_bot_command"].forEach(function (h) {
  try { plugin.on(h, function () { return "x"; }); errors[h] = null; } catch (e) { errors[h] = e.message; }
});
plugin.registerAPI("/errors", function () { return errors; });
