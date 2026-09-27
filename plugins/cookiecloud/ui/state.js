// cookiecloud 设置页的状态机（纯函数，不碰 DOM / FC）。index.html 用它决定按钮、轮询与提示；
// tests/cookiecloud/ui-state.test.js 直接 require 它做单元测试。
//
// 轮询规则（I2 / I3 / I6）：
//   - 初始加载成功之前「保存」「立即同步」都禁用（加载失败时表单是空的，保存会拿空值覆盖已有配置）。
//   - 只要状态是 running 就每 2 秒查一次 /status，直到 running=false。
//   - 读状态失败：插件已停用（"not running"）或连续 3 次失败 → 停止轮询，给提示与「重试」。
//   - 任何一次成功拿到状态（轮询、保存后的 /reschedule、立即同步后的 /status、初次加载、点重试）都把
//     「停止轮询」复位（清掉提示、失败计数归零），状态是 running 就接着轮询。
(function (root) {
  "use strict";

  var POLL_MS = 2000;
  var POLL_MAX_FAILS = 3;
  var INTERVAL_MAX_MIN = 35791;

  function initialPoll() {
    return { fails: 0, stopped: false, watching: false };
  }

  // 成功拿到一次状态 st
  //   poll: 新的轮询状态；schedule: 要不要排下一次轮询；clearStopped: 要不要清掉「已停止刷新」提示；
  //   finished: 看着的一次同步刚结束时给的结果提示 {kind, msg}，否则 null
  function onStatus(poll, st) {
    var running = !!(st && st.running);
    var next = { fails: 0, stopped: false, watching: poll.watching };
    var out = { poll: next, schedule: false, clearStopped: !!poll.stopped, finished: null };
    if (running) {
      next.watching = true;
      out.schedule = true;
    } else if (poll.watching) {
      next.watching = false;
      out.finished = st && st.last_error
        ? { kind: "err", msg: "同步结束，有问题，见下方" }
        : { kind: "ok", msg: "同步完成" };
    }
    return out;
  }

  // 轮询读状态失败（msg = 错误文案）
  //   stop: 非 null 时停止轮询并显示这句提示（带「重试」）；否则 schedule=true 继续轮询，toast 给一句提示
  function onStatusError(poll, msg) {
    var next = { fails: poll.fails + 1, stopped: poll.stopped, watching: poll.watching };
    msg = String(msg);
    if (/not running/i.test(msg)) {
      next.stopped = true;
      return { poll: next, stop: "插件已停用，已停止刷新同步状态。重新启用插件后点「重试」。", schedule: false, toast: null };
    }
    if (next.fails >= POLL_MAX_FAILS) {
      next.stopped = true;
      return { poll: next, stop: "连续 " + next.fails + " 次读取同步状态失败，已停止自动刷新：" + msg, schedule: false, toast: null };
    }
    return { poll: next, stop: null, schedule: true, toast: "读取状态失败：" + msg };
  }

  // 点了「立即同步」且 /sync 成功：之后要看着这次同步（之前停掉的轮询也恢复）
  function onSyncTriggered(poll) {
    return { fails: 0, stopped: false, watching: true };
  }

  // 点「重试」
  function onRetry(poll) {
    return { fails: 0, stopped: false, watching: poll.watching };
  }

  // 排下一次轮询前的闸：已经排了 / 已停止 → 不排
  function shouldSchedule(poll, timerPending) {
    return !timerPending && !poll.stopped;
  }

  // ui: {loaded, saving, syncing, running}
  function buttons(ui) {
    return {
      saveDisabled: !ui.loaded || !!ui.saving,
      syncDisabled: !ui.loaded || !!ui.syncing || !!ui.running
    };
  }

  // 同步间隔输入框 → {ok, value} / {ok:false, msg}。
  // type=number 里填了非数字（如 "abc"、"1e"）时浏览器给的 value 是 ""：必须看 badInput，别当成「留空 = 关闭」
  function readInterval(raw, badInput) {
    if (badInput) return { ok: false, msg: "同步间隔要填不小于 0 的整数分钟（现在填的不是数字）" };
    var s = String(raw === null || raw === undefined ? "" : raw).trim();
    if (s === "") return { ok: true, value: "" };
    if (!/^\d+$/.test(s)) return { ok: false, msg: "同步间隔要填不小于 0 的整数分钟" };
    if (parseInt(s, 10) > INTERVAL_MAX_MIN) return { ok: false, msg: "同步间隔最多 " + INTERVAL_MAX_MIN + " 分钟（约 24 天）" };
    return { ok: true, value: String(parseInt(s, 10)) };
  }

  // 两个勾选的站 RSS 域名有交集 → 同一批 cookie 会写进两个站。返回 [{a, b, shared: [host]}]
  function overlapPairs(sites, selected) {
    var picked = (sites || []).filter(function (s) { return selected && selected[s.id]; });
    var pairs = [];
    for (var i = 0; i < picked.length; i++) {
      for (var j = i + 1; j < picked.length; j++) {
        var a = picked[i].hosts || [], b = picked[j].hosts || [];
        var shared = a.filter(function (h) { return b.indexOf(h) >= 0; });
        if (shared.length) pairs.push({ a: picked[i].name, b: picked[j].name, shared: shared });
      }
    }
    return pairs;
  }

  var api = {
    POLL_MS: POLL_MS,
    POLL_MAX_FAILS: POLL_MAX_FAILS,
    initialPoll: initialPoll,
    onStatus: onStatus,
    onStatusError: onStatusError,
    onSyncTriggered: onSyncTriggered,
    onRetry: onRetry,
    shouldSchedule: shouldSchedule,
    buttons: buttons,
    readInterval: readInterval,
    overlapPairs: overlapPairs
  };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.CCState = api;
})(this);
