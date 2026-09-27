var bootValue = config.get("ui_key"); // 入口脚本顶层读配置
plugin.registerAPI("/boot", function () { return bootValue; });
plugin.registerAPI("/set", function (req) { config.set("plugin_key", req.body); return true; });
plugin.registerAPI("/get", function () { return { plugin_key: config.get("plugin_key"), ui_key: config.get("ui_key") }; });
