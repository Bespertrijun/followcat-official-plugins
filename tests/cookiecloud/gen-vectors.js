// 用 CookieCloud 官方算法生成两种 crypto_type 的密文向量（输出 vectors.json）。
//
// cookieEncrypt / cookieDecrypt 逐行移植自浏览器扩展 ext/utils/functions.ts 的 cookie_encrypt /
// cookie_decrypt（easychen/CookieCloud），用的是同一个 crypto-js 包。仓库不依赖 crypto-js：重新生成时
// 把它装在仓库外，例如
//   npm install --prefix /tmp/cc-vec crypto-js@4.2.0
//   NODE_PATH=/tmp/cc-vec/node_modules node tests/cookiecloud/gen-vectors.js
'use strict';

const fs = require('fs');
const path = require('path');
const CryptoJS = require('crypto-js');
const { BROWSER_COOKIES, groupByKeywords } = require('./fixtures');

function cookieEncrypt(uuid, data, password, cryptoType) {
  const hash = CryptoJS.MD5(uuid + '-' + password).toString();
  const theKey = hash.substring(0, 16);
  if (cryptoType === 'aes-128-cbc-fixed') {
    const fixedIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
    const options = { iv: fixedIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 };
    const encrypted = CryptoJS.AES.encrypt(data, CryptoJS.enc.Utf8.parse(theKey), options);
    return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  }
  return CryptoJS.AES.encrypt(data, theKey).toString();
}

function cookieDecrypt(uuid, encrypted, password, cryptoType) {
  const hash = CryptoJS.MD5(uuid + '-' + password).toString();
  const theKey = hash.substring(0, 16);
  if (cryptoType === 'aes-128-cbc-fixed') {
    const fixedIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
    const options = { iv: fixedIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 };
    return JSON.parse(CryptoJS.AES.decrypt(encrypted, CryptoJS.enc.Utf8.parse(theKey), options).toString(CryptoJS.enc.Utf8));
  }
  return JSON.parse(CryptoJS.AES.decrypt(encrypted, theKey).toString(CryptoJS.enc.Utf8));
}

const uuid = 'fc-test-uuid-2026';
const password = 'p@ss-密码-😀';
// 与扩展 upload_cookie 同形：{cookie_data, local_storage_data, update_time}
const plaintext = JSON.stringify({
  cookie_data: groupByKeywords(BROWSER_COOKIES, ['hhanclub', 'ourbits', 'douban', 'example']),
  local_storage_data: {},
  update_time: '2026-09-25T00:00:00.000Z',
});

const out = { uuid, password, plaintext, vectors: {} };
for (const type of ['legacy', 'aes-128-cbc-fixed']) {
  const encrypted = cookieEncrypt(uuid, plaintext, password, type);
  // 自检：官方解密能还原
  if (JSON.stringify(cookieDecrypt(uuid, encrypted, password, type)) !== plaintext) throw new Error('self-check failed: ' + type);
  out.vectors[type] = { encrypted, crypto_type: type };
}
fs.writeFileSync(path.join(__dirname, 'vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote vectors.json');
