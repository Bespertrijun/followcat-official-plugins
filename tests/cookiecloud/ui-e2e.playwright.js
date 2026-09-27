// cookiecloud 设置页端到端（Playwright + devrt，手动跑，不进 CI）：验证 ui/index.html 与 ui/state.js 的接线——
// I2（加载失败前不能保存）、I3（轮询停了之后保存 → 复位并继续轮询）、I6（非法间隔、停用 / 连续失败停止轮询、
// 勾选站 hosts 交集提示）。状态机本身的单元测试见 tests/cookiecloud/ui-state.test.js。
//
// 运行（在仓库根）：
//   pip install -r requirements.txt            # 或 PYTHONPATH 指向装好 fastapi / uvicorn 的目录
//   npm i -D playwright && npx playwright install chromium   # 或 PLAYWRIGHT_MODULE=/path/to/node_modules/playwright
//   node tests/cookiecloud/ui-e2e.playwright.js
//
// 可选环境变量：
//   DEVRT_PORT（默认 9471）、CC_PORT（假 CookieCloud 服务端，默认 9472）、SHOTS（截图目录，默认 /tmp/cookiecloud-ui-e2e）、
//   PYTHON（默认 python3）、PLAYWRIGHT_MODULE（playwright 包路径，默认 require('playwright')）
//
// 脚本自己起一个假 CookieCloud 服务端（返回 tests/cookiecloud/vectors.json 里的 legacy 密文，可加延迟让同步一直
// running）和一个 `devrt/server.py cookiecloud --allow-http`，跑完都关掉。
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DEVRT_PORT = Number(process.env.DEVRT_PORT) || 9471;
const CC_PORT = Number(process.env.CC_PORT) || 9472;
const SHOTS = process.env.SHOTS || '/tmp/cookiecloud-ui-e2e';
const BASE = 'http://127.0.0.1:' + DEVRT_PORT;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf-8'));

// ─── 假 CookieCloud ───────────────────────────────────────────────────────────
let ccDelayMs = 0;
function startFakeCC() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith('/get/')) { res.writeHead(404); res.end(); return; }
    setTimeout(() => {
      if (decodeURIComponent(u.pathname.slice(5)) !== V.uuid) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ encrypted: V.vectors.legacy.encrypted, crypto_type: 'legacy' }));
    }, ccDelayMs);
  });
  return new Promise((resolve) => srv.listen(CC_PORT, '127.0.0.1', () => resolve(srv)));
}

// ─── devrt ───────────────────────────────────────────────────────────────────
function startDevrt() {
  const proc = spawn(process.env.PYTHON || 'python3',
    [path.join(ROOT, 'devrt', 'server.py'), 'cookiecloud', '--allow-http', '--port', String(DEVRT_PORT)],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20000;
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(BASE + '/api/state', (res) => { res.resume(); resolve(proc); })
        .on('error', () => {
          if (Date.now() > deadline || proc.exitCode !== null) { proc.kill(); reject(new Error('devrt did not start:\n' + out)); return; }
          setTimeout(poll, 200);
        });
    })();
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function seedConfig() {
  await postJSON(BASE + '/api/config', {
    entries: { host: 'http://127.0.0.1:' + CC_PORT, cloud_uuid: V.uuid, cloud_pwd: V.password,
      sites: JSON.stringify(['mock-hhan']), sync_douban: 'false', sync_interval_min: '' },
    secrets: ['cloud_uuid', 'cloud_pwd'],
  });
}

// ─── 页面工具 ─────────────────────────────────────────────────────────────────
async function openPage(browser, setupRoutes) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  const counters = { status: 0 };
  page.on('request', (r) => { if (/\/api\/sandbox\/api\/status/.test(r.url())) counters.status++; });
  if (setupRoutes) await setupRoutes(page, counters);
  await page.goto(BASE + '/');
  await page.waitForSelector('#plugin-iframe');
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) { frame = page.frame({ url: /plugin-ui/ }); if (!frame) await page.waitForTimeout(100); }
  await frame.waitForSelector('#save-btn');
  return { page, frame, counters };
}

async function ui(frame) {
  return frame.evaluate(() => ({
    save: document.getElementById('save-btn').disabled,
    sync: document.getElementById('sync-btn').disabled,
    toast: document.getElementById('toast').textContent,
    loadError: document.getElementById('load-error').textContent,
    pollStopped: document.getElementById('poll-stopped').textContent,
    running: document.getElementById('st-running').textContent,
    overlap: document.getElementById('overlap-warn').textContent,
  }));
}

async function waitFor(frame, pred, what, timeoutMs) {
  const end = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < end) {
    last = await ui(frame);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for: ' + what + '\nlast ui state: ' + JSON.stringify(last));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

const failEnvelope = (msg) => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 50000, data: null, message: msg }) });

// ─── 场景 ─────────────────────────────────────────────────────────────────────
const scenarios = {
  async 'I2：初始加载失败 → 保存 / 立即同步禁用；点重试加载成功后可用'(browser) {
    let failStatus = true;
    const { page, frame } = await openPage(browser, async (p) => {
      await p.route('**/api/sandbox/api/status*', (route) => (failStatus ? route.fulfill(failEnvelope('db timeout')) : route.continue()));
    });
    const s1 = await waitFor(frame, (s) => /加载设置失败/.test(s.loadError), 'load error');
    assert.equal(s1.save, true);
    assert.equal(s1.sync, true);
    await shot(page, 'cc-i2-01-load-failed');
    failStatus = false;
    await frame.click('#load-retry');
    const s2 = await waitFor(frame, (s) => !s.save && !s.sync, 'buttons enabled after retry');
    assert.equal(s2.loadError, '');
    await shot(page, 'cc-i2-02-retry-ok');
    await page.close();
  },

  async 'I3 补漏：同步中轮询因连续失败停止 → 点保存（/reschedule 拿到 running 状态）→ 提示清掉、轮询自己恢复'(browser) {
    // 插件 http 每请求 10s 上限，真同步撑不了这么久：/status、/reschedule 的回应里把 running 钉成 true，
    // 只验页面接线（状态机本身见 ui-state.test.js）
    let failPolls = false;
    let forceRunning = false;
    const pinRunning = async (route) => {
      const res = await route.fetch();
      const env = await res.json();
      if (forceRunning && env && env.data) { env.data.running = true; env.data.started_at = env.data.started_at || new Date().toISOString(); }
      route.fulfill({ response: res, json: env });
    };
    const { page, frame, counters } = await openPage(browser, async (p) => {
      await p.route('**/api/sandbox/api/status*', (route) => (failPolls ? route.fulfill(failEnvelope('db timeout')) : pinRunning(route)));
      await p.route('**/api/sandbox/api/reschedule*', pinRunning);
    });
    await waitFor(frame, (s) => !s.sync, 'loaded');
    forceRunning = true;
    await frame.click('#sync-btn');
    await waitFor(frame, (s) => /同步中/.test(s.running), 'running');
    failPolls = true;
    await waitFor(frame, (s) => /连续 3 次读取同步状态失败/.test(s.pollStopped), 'polling stopped after 3 failures', 20000);
    await shot(page, 'cc-i3-01-poll-stopped-while-running');
    const atStop = counters.status;
    await page.waitForTimeout(3000);
    assert.equal(counters.status, atStop, 'no polling while stopped');
    await shot(page, 'cc-i3-01b-still-stopped-3s-later');
    failPolls = false;
    await frame.click('#save-btn');
    const s = await waitFor(frame, (x) => x.pollStopped === '' && /已保存/.test(x.toast), 'banner cleared after save');
    assert.match(s.running, /同步中/);
    const afterSave = counters.status;
    await page.waitForTimeout(4500);
    assert.ok(counters.status >= afterSave + 2, 'polling resumed on its own (' + afterSave + ' → ' + counters.status + ')');
    await shot(page, 'cc-i3-02-polling-resumed-after-save');
    forceRunning = false;
    await waitFor(frame, (x) => /同步完成|同步结束/.test(x.toast), 'sync finished toast', 20000);
    await shot(page, 'cc-i3-03-finished');
    await page.close();
  },

  async 'I6：插件已停用（not running）→ 立即停止轮询；重试成功后恢复'(browser) {
    ccDelayMs = 6000;
    let disabled = false;
    const { page, frame } = await openPage(browser, async (p) => {
      await p.route('**/api/sandbox/api/status*', (route) => (disabled ? route.fulfill(failEnvelope('plugin cookiecloud not running')) : route.continue()));
    });
    await waitFor(frame, (s) => !s.sync, 'loaded');
    await frame.click('#sync-btn');
    await waitFor(frame, (s) => /同步中/.test(s.running), 'running');
    disabled = true;
    await waitFor(frame, (s) => /插件已停用/.test(s.pollStopped), 'stopped because plugin not running');
    await shot(page, 'cc-i6-01-plugin-disabled');
    disabled = false;
    await frame.click('#poll-retry');
    await waitFor(frame, (s) => s.pollStopped === '', 'retry clears the banner');
    ccDelayMs = 0;
    await page.close();
  },

  async 'I6：同步间隔填了非数字（badInput）→ 报错且不写配置'(browser) {
    const puts = [];
    const { page, frame } = await openPage(browser, async (p) => {
      await p.route('**/api/sandbox/config', (route) => { if (route.request().method() === 'PUT') puts.push(route.request().postData()); route.continue(); });
    });
    await waitFor(frame, (s) => !s.save && /空闲/.test(s.running), 'loaded and idle', 20000);
    await frame.fill('#interval', '');
    // Chromium 的 type=number 直接吞掉字母；"1e" 这种半截数字才会进 badInput（value 读出来是 ""）
    await frame.type('#interval', '1e');
    await frame.click('#save-btn');
    const s = await waitFor(frame, (x) => /不是数字/.test(x.toast), 'bad input rejected');
    assert.match(s.toast, /同步间隔要填不小于 0 的整数分钟（现在填的不是数字）/);
    assert.equal(puts.length, 0, 'nothing written');
    await shot(page, 'cc-i6-02-bad-interval');
    await page.close();
  },

  async 'I6：两个勾选站 RSS 域名有交集 → 提示；取消一个 → 提示消失'(browser) {
    const { page, frame } = await openPage(browser, async (p) => {
      await p.route('**/api/sandbox/api/sites*', async (route) => {
        const res = await route.fetch();
        const env = await res.json();
        env.data.sites.push({ id: 'dup-hhan', name: '憨憨（第二行）', adapter: 'hhan', enabled: true, auth_kind: 'cookie',
          has_cookie: false, has_apikey: false, hosts: ['hhanclub.top'] });
        route.fulfill({ response: res, json: env });
      });
    });
    await waitFor(frame, (s) => !s.save, 'loaded');
    await frame.check('#site-dup-hhan');
    const s = await waitFor(frame, (x) => /RSS 域名相同/.test(x.overlap), 'overlap warning');
    assert.match(s.overlap, /hhanclub\.top/);
    await shot(page, 'cc-i6-03-hosts-overlap');
    await frame.uncheck('#site-dup-hhan');
    await waitFor(frame, (x) => x.overlap === '', 'overlap warning cleared');
    await page.close();
  },
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const cc = await startFakeCC();
  const devrt = await startDevrt();
  let failed = 0;
  const browser = await chromium.launch();
  try {
    await seedConfig();
    for (const [name, fn] of Object.entries(scenarios)) {
      try {
        await fn(browser);
        console.log('PASS ' + name);
      } catch (e) {
        failed++;
        console.log('FAIL ' + name + '\n  ' + String(e && e.stack || e).split('\n').join('\n  '));
      }
    }
  } finally {
    await browser.close();
    devrt.kill();
    cc.close();
  }
  console.log(failed ? failed + ' scenario(s) failed' : 'all scenarios passed; screenshots in ' + SHOTS);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
