// dashboard-stats —— headless 插件示例：仅注册自定义 API，不订阅 hook
//
// 自定义 API：
//   GET /api/plugins/<id>/api/summary —— 返回任务总数、运行中、已完成
//
// 权限：api.anime.read（预留，便于后续扩展 anime 维度统计）+ api.task.read

plugin.registerAPI("/summary", function (req) {
    var tasks = task.list(); // PluginTaskView[]
    var running = 0;
    var done = 0;
    if (tasks && tasks.length) {
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].status === "running") {
                running++;
            } else if (tasks[i].status === "done") {
                done++;
            }
        }
    }
    return {
        total_tasks: tasks ? tasks.length : 0,
        running_tasks: running,
        completed_tasks: done,
        timestamp: new Date().toISOString()
    };
});
