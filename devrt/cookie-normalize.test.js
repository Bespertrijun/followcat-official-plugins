// node --test devrt/cookie-normalize.test.js
// JS 参考实现跑与主仓 Go normalizeCookie 同一组向量（docs/plugins/cookie-normalize-vectors.json）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeCookie } = require('./cookie-normalize');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'plugins', 'cookie-normalize-vectors.json'), 'utf-8'));

test('shared vectors', () => {
  assert.ok(vectors.length >= 10);
  for (const v of vectors) {
    assert.equal(normalizeCookie(v.in), v.out, v.name);
  }
});

test('fingerprint = sha256(normalize(x))，写法不同的同一 cookie 指纹相同', () => {
  const fp = (s) => crypto.createHash('sha256').update(normalizeCookie(s), 'utf8').digest('hex');
  assert.equal(fp('uid=1; pass=abc'), fp(' pass=abc;uid=1; '));
});

test('默认 sort() 在 V8 上与契约不一致（这就是必须用 compareCodePoints 的原因）', () => {
  const v = vectors.find((x) => x.name === 'code point order not utf-16 order');
  const naive = v.in.split(';').map((p) => p.trim()).filter(Boolean).sort().join('; ');
  assert.notEqual(naive, v.out);
});
