// node --test tests/cookiecloud/ui-state.test.js
// cookiecloud 设置页状态机（plugins/cookiecloud/ui/state.js，页面里是 window.CCState）：
// I2（加载成功前不能保存 / 同步）、I3（running 就一直轮询；任何一次成功拿到状态都复位「停止轮询」）、
// I6（非法间隔报错、停用 / 连续出错停止轮询、勾选站 hosts 交集提示）。
// 页面接线的端到端验证见 tests/cookiecloud/ui-e2e.playwright.js（需要 devrt + Playwright，手动跑）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../plugins/cookiecloud/ui/state.js');

const RUNNING = { running: true };
const IDLE = { running: false, last_error: '' };

// ─── I2：按钮 ────────────────────────────────────────────────────────────────

test('I2：初始加载成功之前「保存」「立即同步」都禁用', () => {
  assert.deepEqual(S.buttons({ loaded: false, saving: false, syncing: false, running: false }), { saveDisabled: true, syncDisabled: true });
  assert.deepEqual(S.buttons({ loaded: true, saving: false, syncing: false, running: false }), { saveDisabled: false, syncDisabled: false });
});

test('I2：保存中禁用保存；触发同步中 / 正在同步禁用立即同步（保存不受 running 影响）', () => {
  assert.equal(S.buttons({ loaded: true, saving: true, syncing: false, running: false }).saveDisabled, true);
  assert.equal(S.buttons({ loaded: true, saving: false, syncing: true, running: false }).syncDisabled, true);
  const r = S.buttons({ loaded: true, saving: false, syncing: false, running: true });
  assert.equal(r.syncDisabled, true);
  assert.equal(r.saveDisabled, false);
});

// ─── I3：轮询 ────────────────────────────────────────────────────────────────

test('I3：状态是 running 就排下一次轮询，结束时给一句结果提示', () => {
  let p = S.initialPoll();
  let r = S.onStatus(p, RUNNING);
  assert.equal(r.schedule, true);
  assert.equal(r.finished, null);
  p = r.poll;
  r = S.onStatus(p, RUNNING);
  assert.equal(r.schedule, true, 'keeps polling while running');
  p = r.poll;
  r = S.onStatus(p, IDLE);
  assert.equal(r.schedule, false);
  assert.deepEqual(r.finished, { kind: 'ok', msg: '同步完成' });
  r = S.onStatus(r.poll, IDLE);
  assert.equal(r.finished, null, 'the result toast is given once');
});

test('I3：结束时有 last_error → 错误提示', () => {
  const r = S.onStatus({ fails: 0, stopped: false, watching: true }, { running: false, last_error: 'x' });
  assert.equal(r.finished.kind, 'err');
});

test('I3 补漏：轮询已停止（连续失败）后，任何一次成功拿到状态（如保存后的 /reschedule）→ 复位并按 running 继续轮询', () => {
  let p = S.initialPoll();
  p = S.onStatus(p, RUNNING).poll;
  for (let i = 0; i < S.POLL_MAX_FAILS; i++) p = S.onStatusError(p, 'Request failed with status code 500').poll;
  assert.equal(p.stopped, true);
  assert.equal(S.shouldSchedule(p, false), false, 'stopped: no more polling');
  const r = S.onStatus(p, RUNNING); // 保存成功后 /reschedule 返回的状态
  assert.equal(r.clearStopped, true, 'the "polling stopped" banner is cleared');
  assert.deepEqual(r.poll, { fails: 0, stopped: false, watching: true });
  assert.equal(r.schedule, true);
  assert.equal(S.shouldSchedule(r.poll, false), true, 'polling actually resumes');
});

test('I3 补漏：停止后成功拿到的状态不是 running → 只复位（清提示、计数归零），不再轮询', () => {
  const r = S.onStatus({ fails: 3, stopped: true, watching: false }, IDLE);
  assert.equal(r.clearStopped, true);
  assert.deepEqual(r.poll, { fails: 0, stopped: false, watching: false });
  assert.equal(r.schedule, false);
});

test('I3：成功一次就把失败计数归零（2 次失败 + 1 次成功 + 2 次失败 不停止）', () => {
  let p = S.onStatus(S.initialPoll(), RUNNING).poll;
  p = S.onStatusError(p, 'e').poll;
  p = S.onStatusError(p, 'e').poll;
  p = S.onStatus(p, RUNNING).poll;
  let r = S.onStatusError(p, 'e');
  r = S.onStatusError(r.poll, 'e');
  assert.equal(r.stop, null);
  assert.equal(r.schedule, true);
});

test('I3：/sync 触发成功 → 恢复轮询并看着这次同步', () => {
  const p = S.onSyncTriggered({ fails: 3, stopped: true, watching: false });
  assert.deepEqual(p, { fails: 0, stopped: false, watching: true });
  assert.equal(S.shouldSchedule(p, false), true);
  assert.equal(S.shouldSchedule(p, true), false, 'never two timers');
});

// ─── I6：停止轮询 / 重试 ─────────────────────────────────────────────────────

test('I6：读状态失败 1、2 次继续轮询并提示；第 3 次停止并给「重试」', () => {
  let p = S.onStatus(S.initialPoll(), RUNNING).poll;
  let r = S.onStatusError(p, 'Network Error');
  assert.equal(r.stop, null);
  assert.equal(r.schedule, true);
  assert.equal(r.toast, '读取状态失败：Network Error');
  r = S.onStatusError(r.poll, 'Network Error');
  assert.equal(r.schedule, true);
  r = S.onStatusError(r.poll, 'Network Error');
  assert.equal(r.schedule, false);
  assert.match(r.stop, /^连续 3 次读取同步状态失败，已停止自动刷新：Network Error$/);
  assert.equal(r.poll.stopped, true);
});

test('I6：插件已停用（plugin not running）→ 立即停止轮询', () => {
  const r = S.onStatusError(S.initialPoll(), 'plugin 0123 not running');
  assert.equal(r.schedule, false);
  assert.match(r.stop, /插件已停用/);
  assert.equal(r.poll.stopped, true);
});

test('I6：点「重试」→ 复位失败计数与停止标记', () => {
  const p = S.onRetry({ fails: 3, stopped: true, watching: true });
  assert.deepEqual(p, { fails: 0, stopped: false, watching: true });
});

// ─── I6：同步间隔 ────────────────────────────────────────────────────────────

test('I6：同步间隔——badInput（填了 abc / 1e / -）报错而不是当成关闭', () => {
  assert.equal(S.readInterval('', true).ok, false);
  assert.match(S.readInterval('', true).msg, /不是数字/);
  assert.deepEqual(S.readInterval('', false), { ok: true, value: '' });
  assert.deepEqual(S.readInterval('  ', false), { ok: true, value: '' });
  assert.deepEqual(S.readInterval('045', false), { ok: true, value: '45' });
  assert.deepEqual(S.readInterval('0', false), { ok: true, value: '0' });
  assert.equal(S.readInterval('1.5', false).ok, false);
  assert.equal(S.readInterval('-3', false).ok, false);
  assert.deepEqual(S.readInterval('35791', false), { ok: true, value: '35791' });
  assert.match(S.readInterval('35792', false).msg, /最多 35791 分钟/);
});

// ─── I6：hosts 交集 ─────────────────────────────────────────────────────────

test('I6：两个已勾选站的 hosts 有交集 → 提示；没勾选的不算', () => {
  const sites = [
    { id: 'a', name: 'A', hosts: ['x.com', 'y.com'] },
    { id: 'b', name: 'B', hosts: ['y.com'] },
    { id: 'c', name: 'C', hosts: ['x.com'] },
    { id: 'd', name: 'D', hosts: [] },
  ];
  assert.deepEqual(S.overlapPairs(sites, { a: true, b: true }), [{ a: 'A', b: 'B', shared: ['y.com'] }]);
  assert.deepEqual(S.overlapPairs(sites, { a: true, b: true, c: true }), [
    { a: 'A', b: 'B', shared: ['y.com'] }, { a: 'A', b: 'C', shared: ['x.com'] }]);
  assert.deepEqual(S.overlapPairs(sites, { b: true, c: true, d: true }), []);
  assert.deepEqual(S.overlapPairs(sites, {}), []);
});
