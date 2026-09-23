// cookiecloud —— FollowCat CookieCloud 同步插件
//
// 从用户自托管的 CookieCloud server 周期/手动拉取浏览器同步过来的 cookies
// → 解密（CryptoJS.AES + OpenSSL EVP_BytesToKey + MD5）
// → 按 site_map 把每个 domain 的 cookies 写入 site_cookie_<site_id>（host KV）
//
// === 配置 key（在管理页 → 插件 → 详情 → 配置写入） ===
//
//   host             CookieCloud server 根 URL（如 https://cc.example.com）
//   cloud_uuid       CookieCloud 用户 UUID（is_secret=true，由管理页设置）
//   cloud_pwd        CookieCloud 端到端密码（is_secret=true，由管理页设置）
//   site_map         JSON 字符串：{"hhan.example.com":"hhan", ...}
//   last_synced_at   RFC3339 时间，最近成功同步时间（UI 展示用）
//   last_error       最近一次失败原因
//   synced_count     历史成功同步次数
//
// === 自定义 API ===
//
//   POST /api/plugins/<id>/api/sync          手动触发一次同步
//   GET  /api/plugins/<id>/api/status        当前状态
//   POST /api/plugins/<id>/api/save-config   批量写入 host/cloud_uuid/cloud_pwd/site_map
//   POST /api/plugins/<id>/api/test-decrypt  自检 CryptoJS-mini（用固定向量）
//
// === 设计要点 ===
//
//   1. 内嵌 CryptoJS-mini（MD5 + AES-CBC + EVP_BytesToKey-MD5 + base64 + PKCS7）
//   2. 写 host KV 通过 hostkv.setSiteCookie facade（v1 主仓 PR 提供），
//      若 facade 暂未注入则降级为「干跑」并在状态里说明
//   3. 所有外部 IO 都包 try/catch，状态写入 config 便于 UI 展示

// ====== CryptoJS-mini（内嵌子集） =====================================
//
// 抄自 crypto-js@4.2.0（MIT），仅保留：
//   core, enc-base64, md5, cipher-core, aes, mode-cbc, pad-pkcs7, kdf-openssl
// 已去除模块包装，整体 IIFE。算法对照 cipher.go 的 BytesToKeyAES256CBCMD5。

var CryptoJS = (function () {
    var C = {};
    var C_lib = C.lib = {};

    // ---- WordArray ------------------------------------------------------
    // 32-bit big-endian word 数组；len 是字节数。
    var WordArray = C_lib.WordArray = (function () {
        function W(words, sigBytes) {
            words = this.words = words || [];
            this.sigBytes = sigBytes !== undefined ? sigBytes : words.length * 4;
        }
        W.prototype.concat = function (wordArray) {
            var thisWords = this.words;
            var thatWords = wordArray.words;
            var thisSigBytes = this.sigBytes;
            var thatSigBytes = wordArray.sigBytes;
            this.clamp();
            if (thisSigBytes % 4) {
                for (var i = 0; i < thatSigBytes; i++) {
                    var thatByte = (thatWords[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
                    thisWords[(thisSigBytes + i) >>> 2] |= thatByte << (24 - ((thisSigBytes + i) % 4) * 8);
                }
            } else {
                for (var j = 0; j < thatSigBytes; j += 4) {
                    thisWords[(thisSigBytes + j) >>> 2] = thatWords[j >>> 2];
                }
            }
            this.sigBytes = thisSigBytes + thatSigBytes;
            return this;
        };
        W.prototype.clamp = function () {
            var words = this.words;
            var sigBytes = this.sigBytes;
            words[sigBytes >>> 2] &= 0xffffffff << (32 - (sigBytes % 4) * 8);
            words.length = Math.ceil(sigBytes / 4);
        };
        W.prototype.clone = function () {
            return new W(this.words.slice(0), this.sigBytes);
        };
        W.create = function (words, sigBytes) { return new W(words, sigBytes); };
        return W;
    })();

    // ---- enc.Latin1 / enc.Utf8 / enc.Hex / enc.Base64 -------------------
    var C_enc = C.enc = {};

    var Latin1 = C_enc.Latin1 = {
        stringify: function (wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var out = [];
            for (var i = 0; i < sigBytes; i++) {
                var b = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
                out.push(String.fromCharCode(b));
            }
            return out.join('');
        },
        parse: function (latin1Str) {
            var len = latin1Str.length;
            var words = [];
            for (var i = 0; i < len; i++) {
                words[i >>> 2] |= (latin1Str.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
            }
            return WordArray.create(words, len);
        }
    };

    C_enc.Utf8 = {
        stringify: function (wordArray) {
            // 拿到 latin1，再 decodeURIComponent(escape(...)) 还原 UTF-8
            try {
                return decodeURIComponent(escape(Latin1.stringify(wordArray)));
            } catch (e) {
                throw new Error('Malformed UTF-8 data');
            }
        },
        parse: function (utf8Str) {
            return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
        }
    };

    C_enc.Hex = {
        stringify: function (wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var hexChars = [];
            for (var i = 0; i < sigBytes; i++) {
                var b = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
                hexChars.push((b >>> 4).toString(16));
                hexChars.push((b & 0x0f).toString(16));
            }
            return hexChars.join('');
        },
        parse: function (hexStr) {
            var len = hexStr.length;
            var words = [];
            for (var i = 0; i < len; i += 2) {
                words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << (24 - (i % 8) * 4);
            }
            return WordArray.create(words, len / 2);
        }
    };

    var B64_MAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64_REV = (function () {
        var m = {};
        for (var i = 0; i < B64_MAP.length; i++) m[B64_MAP.charAt(i)] = i;
        return m;
    })();

    C_enc.Base64 = {
        stringify: function (wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            wordArray.clamp();
            var out = [];
            for (var i = 0; i < sigBytes; i += 3) {
                var b1 = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
                var b2 = (words[(i + 1) >>> 2] >>> (24 - ((i + 1) % 4) * 8)) & 0xff;
                var b3 = (words[(i + 2) >>> 2] >>> (24 - ((i + 2) % 4) * 8)) & 0xff;
                var triplet = (b1 << 16) | (b2 << 8) | b3;
                for (var j = 0; (j < 4) && (i * 8 + j * 6 < sigBytes * 8); j++) {
                    out.push(B64_MAP.charAt((triplet >>> (6 * (3 - j))) & 0x3f));
                }
            }
            while (out.length % 4) out.push('=');
            return out.join('');
        },
        parse: function (base64Str) {
            var len = base64Str.length;
            // strip padding
            var paddingChar = base64Str.charAt(len - 1);
            if (paddingChar === '=') {
                len--;
                if (base64Str.charAt(len - 1) === '=') len--;
            }
            // 反查 — 仍要遍历整个有效区间
            var words = [];
            var nBytes = 0;
            for (var i = 0; i < len; i++) {
                if ((i % 4) === 0) continue; // 每 4 chars 一组在下面整体处理
            }
            // 一次扫一组
            words = [];
            nBytes = 0;
            for (var k = 0; k < len; k++) {
                var c = base64Str.charAt(k);
                var v = B64_REV[c];
                if (v === undefined) continue;
                var bitsCombined = v << (18 - 6 * (k % 4));
                words[nBytes >>> 2] |= bitsCombined << (24 - (nBytes % 4) * 8 - 16); // placeholder
            }
            // 上面那段太绕。重写为按 4 chars 一组：
            words = [];
            var byteIndex = 0;
            for (var p = 0; p + 1 < len; p += 4) {
                var n0 = B64_REV[base64Str.charAt(p)];
                var n1 = B64_REV[base64Str.charAt(p + 1)];
                var n2 = (p + 2 < len) ? B64_REV[base64Str.charAt(p + 2)] : 0;
                var n3 = (p + 3 < len) ? B64_REV[base64Str.charAt(p + 3)] : 0;
                if (n0 === undefined || n1 === undefined) continue;
                var t = (n0 << 18) | (n1 << 12) | ((n2 || 0) << 6) | (n3 || 0);
                var bb = [(t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff];
                var avail = (p + 2 >= len) ? 1 : (p + 3 >= len ? 2 : 3);
                for (var bi = 0; bi < avail; bi++) {
                    words[byteIndex >>> 2] |= bb[bi] << (24 - (byteIndex % 4) * 8);
                    byteIndex++;
                }
            }
            return WordArray.create(words, byteIndex);
        }
    };

    // ---- MD5 ------------------------------------------------------------
    // 标准 MD5（RFC 1321）— 直接抄 crypto-js 的 word-based 实现
    var T = [];
    (function () {
        for (var i = 0; i < 64; i++) {
            T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
        }
    })();

    function md5_FF(a, b, c, d, x, s, t) {
        var n = a + ((b & c) | (~b & d)) + (x >>> 0) + t;
        return ((n << s) | (n >>> (32 - s))) + b;
    }
    function md5_GG(a, b, c, d, x, s, t) {
        var n = a + ((b & d) | (c & ~d)) + (x >>> 0) + t;
        return ((n << s) | (n >>> (32 - s))) + b;
    }
    function md5_HH(a, b, c, d, x, s, t) {
        var n = a + (b ^ c ^ d) + (x >>> 0) + t;
        return ((n << s) | (n >>> (32 - s))) + b;
    }
    function md5_II(a, b, c, d, x, s, t) {
        var n = a + (c ^ (b | ~d)) + (x >>> 0) + t;
        return ((n << s) | (n >>> (32 - s))) + b;
    }

    function md5Compute(words, sigBytes) {
        // 给 words 末端 padding（追加 0x80 + 0... + 8B little-endian 长度）
        var nBitsTotal = sigBytes * 8;
        var nBitsLeft = sigBytes * 8;
        // 先把 sigBytes 字节后塞 0x80
        words[nBitsLeft >>> 5] |= 0x80 << (24 - (nBitsLeft % 32));
        // 每 block = 16 words = 64 字节；总长度（低 32 位 / 高 32 位）放在最后两个 word
        var nWordsPlusPad = Math.ceil((nBitsLeft + 1 + 64) / 512) * 16;
        // MD5 长度字段：低位字节序（little-endian），写在 [nWordsPlusPad-2] 高位 / [nWordsPlusPad-1] 低位
        // crypto-js 是把它存为 swapped 32-bit 值
        var nBitsTotalH = Math.floor(nBitsTotal / 0x100000000);
        var nBitsTotalL = nBitsTotal >>> 0;
        words[nWordsPlusPad - 2] = ( ((nBitsTotalL << 8) | (nBitsTotalL >>> 24)) & 0x00ff00ff )
                                 | ( ((nBitsTotalL << 24) | (nBitsTotalL >>> 8)) & 0xff00ff00 );
        words[nWordsPlusPad - 1] = ( ((nBitsTotalH << 8) | (nBitsTotalH >>> 24)) & 0x00ff00ff )
                                 | ( ((nBitsTotalH << 24) | (nBitsTotalH >>> 8)) & 0xff00ff00 );

        var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
        for (var off = 0; off < nWordsPlusPad; off += 16) {
            // crypto-js 把 big-endian word 转成 little-endian 后做 MD5
            var M = [];
            for (var i = 0; i < 16; i++) {
                var w = words[off + i] | 0;
                M[i] = ( ((w << 8) | (w >>> 24)) & 0x00ff00ff )
                     | ( ((w << 24) | (w >>> 8)) & 0xff00ff00 );
            }
            var aa = a, bb = b, cc = c, dd = d;

            // round 1
            a = md5_FF(a, b, c, d, M[0],  7,  T[0]);
            d = md5_FF(d, a, b, c, M[1],  12, T[1]);
            c = md5_FF(c, d, a, b, M[2],  17, T[2]);
            b = md5_FF(b, c, d, a, M[3],  22, T[3]);
            a = md5_FF(a, b, c, d, M[4],  7,  T[4]);
            d = md5_FF(d, a, b, c, M[5],  12, T[5]);
            c = md5_FF(c, d, a, b, M[6],  17, T[6]);
            b = md5_FF(b, c, d, a, M[7],  22, T[7]);
            a = md5_FF(a, b, c, d, M[8],  7,  T[8]);
            d = md5_FF(d, a, b, c, M[9],  12, T[9]);
            c = md5_FF(c, d, a, b, M[10], 17, T[10]);
            b = md5_FF(b, c, d, a, M[11], 22, T[11]);
            a = md5_FF(a, b, c, d, M[12], 7,  T[12]);
            d = md5_FF(d, a, b, c, M[13], 12, T[13]);
            c = md5_FF(c, d, a, b, M[14], 17, T[14]);
            b = md5_FF(b, c, d, a, M[15], 22, T[15]);

            // round 2
            a = md5_GG(a, b, c, d, M[1],  5,  T[16]);
            d = md5_GG(d, a, b, c, M[6],  9,  T[17]);
            c = md5_GG(c, d, a, b, M[11], 14, T[18]);
            b = md5_GG(b, c, d, a, M[0],  20, T[19]);
            a = md5_GG(a, b, c, d, M[5],  5,  T[20]);
            d = md5_GG(d, a, b, c, M[10], 9,  T[21]);
            c = md5_GG(c, d, a, b, M[15], 14, T[22]);
            b = md5_GG(b, c, d, a, M[4],  20, T[23]);
            a = md5_GG(a, b, c, d, M[9],  5,  T[24]);
            d = md5_GG(d, a, b, c, M[14], 9,  T[25]);
            c = md5_GG(c, d, a, b, M[3],  14, T[26]);
            b = md5_GG(b, c, d, a, M[8],  20, T[27]);
            a = md5_GG(a, b, c, d, M[13], 5,  T[28]);
            d = md5_GG(d, a, b, c, M[2],  9,  T[29]);
            c = md5_GG(c, d, a, b, M[7],  14, T[30]);
            b = md5_GG(b, c, d, a, M[12], 20, T[31]);

            // round 3
            a = md5_HH(a, b, c, d, M[5],  4,  T[32]);
            d = md5_HH(d, a, b, c, M[8],  11, T[33]);
            c = md5_HH(c, d, a, b, M[11], 16, T[34]);
            b = md5_HH(b, c, d, a, M[14], 23, T[35]);
            a = md5_HH(a, b, c, d, M[1],  4,  T[36]);
            d = md5_HH(d, a, b, c, M[4],  11, T[37]);
            c = md5_HH(c, d, a, b, M[7],  16, T[38]);
            b = md5_HH(b, c, d, a, M[10], 23, T[39]);
            a = md5_HH(a, b, c, d, M[13], 4,  T[40]);
            d = md5_HH(d, a, b, c, M[0],  11, T[41]);
            c = md5_HH(c, d, a, b, M[3],  16, T[42]);
            b = md5_HH(b, c, d, a, M[6],  23, T[43]);
            a = md5_HH(a, b, c, d, M[9],  4,  T[44]);
            d = md5_HH(d, a, b, c, M[12], 11, T[45]);
            c = md5_HH(c, d, a, b, M[15], 16, T[46]);
            b = md5_HH(b, c, d, a, M[2],  23, T[47]);

            // round 4
            a = md5_II(a, b, c, d, M[0],  6,  T[48]);
            d = md5_II(d, a, b, c, M[7],  10, T[49]);
            c = md5_II(c, d, a, b, M[14], 15, T[50]);
            b = md5_II(b, c, d, a, M[5],  21, T[51]);
            a = md5_II(a, b, c, d, M[12], 6,  T[52]);
            d = md5_II(d, a, b, c, M[3],  10, T[53]);
            c = md5_II(c, d, a, b, M[10], 15, T[54]);
            b = md5_II(b, c, d, a, M[1],  21, T[55]);
            a = md5_II(a, b, c, d, M[8],  6,  T[56]);
            d = md5_II(d, a, b, c, M[15], 10, T[57]);
            c = md5_II(c, d, a, b, M[6],  15, T[58]);
            b = md5_II(b, c, d, a, M[13], 21, T[59]);
            a = md5_II(a, b, c, d, M[4],  6,  T[60]);
            d = md5_II(d, a, b, c, M[11], 10, T[61]);
            c = md5_II(c, d, a, b, M[2],  15, T[62]);
            b = md5_II(b, c, d, a, M[9],  21, T[63]);

            a = (a + aa) | 0;
            b = (b + bb) | 0;
            c = (c + cc) | 0;
            d = (d + dd) | 0;
        }

        // 输出：a,b,c,d 每个 32-bit 转 little-endian 字节序
        function swap(w) {
            return ( ((w << 8) | (w >>> 24)) & 0x00ff00ff )
                 | ( ((w << 24) | (w >>> 8)) & 0xff00ff00 );
        }
        return WordArray.create([swap(a), swap(b), swap(c), swap(d)], 16);
    }

    function md5Of(input) {
        // input 可以是 string 或 WordArray
        var wa;
        if (typeof input === 'string') {
            wa = C_enc.Utf8.parse(input);
        } else {
            wa = input.clone();
        }
        return md5Compute(wa.words.slice(0), wa.sigBytes);
    }

    // 同 crypto-js：CryptoJS.MD5(msg) 返回 WordArray，可 .toString() 取 hex
    C.MD5 = function (input) {
        var wa = md5Of(input);
        wa.toString = function () { return C_enc.Hex.stringify(wa); };
        return wa;
    };

    // ---- AES-CBC --------------------------------------------------------
    // 基于 AES SBox + 4-table T-box 实现，PKCS7 解 pad

    var SBOX = [];
    var INV_SBOX = [];
    var SUB_MIX_0 = [];
    var SUB_MIX_1 = [];
    var SUB_MIX_2 = [];
    var SUB_MIX_3 = [];
    var INV_SUB_MIX_0 = [];
    var INV_SUB_MIX_1 = [];
    var INV_SUB_MIX_2 = [];
    var INV_SUB_MIX_3 = [];
    (function () {
        var d = [];
        for (var i = 0; i < 256; i++) {
            d[i] = i < 128 ? (i << 1) : ((i << 1) ^ 0x11b);
        }
        var x = 0, xi = 0;
        for (var j = 0; j < 256; j++) {
            var sx = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4);
            sx = (sx >>> 8) ^ (sx & 0xff) ^ 0x63;
            SBOX[x] = sx;
            INV_SBOX[sx] = x;

            var x2 = d[x];
            var x4 = d[x2];
            var x8 = d[x4];
            var t = (d[sx] * 0x101) ^ (sx * 0x1010100);
            SUB_MIX_0[x] = ((t << 24) | (t >>> 8)) >>> 0;
            SUB_MIX_1[x] = ((t << 16) | (t >>> 16)) >>> 0;
            SUB_MIX_2[x] = ((t << 8) | (t >>> 24)) >>> 0;
            SUB_MIX_3[x] = t >>> 0;
            var t2 = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100);
            INV_SUB_MIX_0[sx] = ((t2 << 24) | (t2 >>> 8)) >>> 0;
            INV_SUB_MIX_1[sx] = ((t2 << 16) | (t2 >>> 16)) >>> 0;
            INV_SUB_MIX_2[sx] = ((t2 << 8) | (t2 >>> 24)) >>> 0;
            INV_SUB_MIX_3[sx] = t2 >>> 0;

            if (!x) {
                x = xi = 1;
            } else {
                x = x2 ^ d[d[d[x8 ^ x2]]];
                xi ^= d[d[xi]];
            }
        }
    })();

    var RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

    function aesKeySchedule(keyWords, keySize) {
        // keySize 是 32-bit word 数：4=128b, 6=192b, 8=256b
        var ksRows = (keySize + 6 + 1) * 4;
        var keySchedule = [];
        for (var i = 0; i < ksRows; i++) {
            if (i < keySize) {
                keySchedule[i] = keyWords[i] | 0;
            } else {
                var t = keySchedule[i - 1];
                if (!(i % keySize)) {
                    t = (t << 8) | (t >>> 24);
                    t = (SBOX[(t >>> 24) & 0xff] << 24) |
                        (SBOX[(t >>> 16) & 0xff] << 16) |
                        (SBOX[(t >>> 8) & 0xff] << 8) |
                        SBOX[t & 0xff];
                    t ^= RCON[(i / keySize) | 0] << 24;
                } else if (keySize > 6 && i % keySize === 4) {
                    t = (SBOX[(t >>> 24) & 0xff] << 24) |
                        (SBOX[(t >>> 16) & 0xff] << 16) |
                        (SBOX[(t >>> 8) & 0xff] << 8) |
                        SBOX[t & 0xff];
                }
                keySchedule[i] = (keySchedule[i - keySize] ^ t) | 0;
            }
        }
        // 反向 key schedule（用于解密）
        var invKeySchedule = [];
        for (var ii = 0; ii < ksRows; ii++) {
            var idx = ksRows - ii;
            var u;
            if (ii % 4) {
                u = keySchedule[idx];
            } else {
                u = keySchedule[idx - 4];
            }
            if (ii < 4 || idx <= 4) {
                invKeySchedule[ii] = u;
            } else {
                invKeySchedule[ii] = INV_SUB_MIX_0[SBOX[(u >>> 24) & 0xff]] ^
                                     INV_SUB_MIX_1[SBOX[(u >>> 16) & 0xff]] ^
                                     INV_SUB_MIX_2[SBOX[(u >>> 8) & 0xff]] ^
                                     INV_SUB_MIX_3[SBOX[u & 0xff]];
            }
        }
        return { keySchedule: keySchedule, invKeySchedule: invKeySchedule, nRounds: keySize + 6 };
    }

    function aesDecryptBlock(words, offset, ks) {
        var invKeySchedule = ks.invKeySchedule;
        var nRounds = ks.nRounds;

        var s0 = words[offset]     ^ invKeySchedule[0];
        var s1 = words[offset + 3] ^ invKeySchedule[1];
        var s2 = words[offset + 2] ^ invKeySchedule[2];
        var s3 = words[offset + 1] ^ invKeySchedule[3];

        var ksRow = 4;
        for (var round = 1; round < nRounds; round++) {
            var t0 = INV_SUB_MIX_0[(s0 >>> 24) & 0xff] ^
                     INV_SUB_MIX_1[(s1 >>> 16) & 0xff] ^
                     INV_SUB_MIX_2[(s2 >>> 8) & 0xff] ^
                     INV_SUB_MIX_3[s3 & 0xff] ^
                     invKeySchedule[ksRow++];
            var t1 = INV_SUB_MIX_0[(s1 >>> 24) & 0xff] ^
                     INV_SUB_MIX_1[(s2 >>> 16) & 0xff] ^
                     INV_SUB_MIX_2[(s3 >>> 8) & 0xff] ^
                     INV_SUB_MIX_3[s0 & 0xff] ^
                     invKeySchedule[ksRow++];
            var t2 = INV_SUB_MIX_0[(s2 >>> 24) & 0xff] ^
                     INV_SUB_MIX_1[(s3 >>> 16) & 0xff] ^
                     INV_SUB_MIX_2[(s0 >>> 8) & 0xff] ^
                     INV_SUB_MIX_3[s1 & 0xff] ^
                     invKeySchedule[ksRow++];
            var t3 = INV_SUB_MIX_0[(s3 >>> 24) & 0xff] ^
                     INV_SUB_MIX_1[(s0 >>> 16) & 0xff] ^
                     INV_SUB_MIX_2[(s1 >>> 8) & 0xff] ^
                     INV_SUB_MIX_3[s2 & 0xff] ^
                     invKeySchedule[ksRow++];
            s0 = t0; s1 = t1; s2 = t2; s3 = t3;
        }

        // final round
        var f0 = ((INV_SBOX[(s0 >>> 24) & 0xff] << 24) |
                  (INV_SBOX[(s1 >>> 16) & 0xff] << 16) |
                  (INV_SBOX[(s2 >>> 8) & 0xff] << 8) |
                  INV_SBOX[s3 & 0xff]) ^ invKeySchedule[ksRow++];
        var f1 = ((INV_SBOX[(s1 >>> 24) & 0xff] << 24) |
                  (INV_SBOX[(s2 >>> 16) & 0xff] << 16) |
                  (INV_SBOX[(s3 >>> 8) & 0xff] << 8) |
                  INV_SBOX[s0 & 0xff]) ^ invKeySchedule[ksRow++];
        var f2 = ((INV_SBOX[(s2 >>> 24) & 0xff] << 24) |
                  (INV_SBOX[(s3 >>> 16) & 0xff] << 16) |
                  (INV_SBOX[(s0 >>> 8) & 0xff] << 8) |
                  INV_SBOX[s1 & 0xff]) ^ invKeySchedule[ksRow++];
        var f3 = ((INV_SBOX[(s3 >>> 24) & 0xff] << 24) |
                  (INV_SBOX[(s0 >>> 16) & 0xff] << 16) |
                  (INV_SBOX[(s1 >>> 8) & 0xff] << 8) |
                  INV_SBOX[s2 & 0xff]) ^ invKeySchedule[ksRow++];

        words[offset]     = f0 | 0;
        words[offset + 1] = f3 | 0;
        words[offset + 2] = f2 | 0;
        words[offset + 3] = f1 | 0;
    }

    // CBC 解密 + PKCS7 strip
    function aesCbcDecrypt(ciphertextWA, keyWA, ivWA) {
        // keyWA.sigBytes 必须是 16/24/32
        var keySize = keyWA.sigBytes / 4;
        if (keySize !== 4 && keySize !== 6 && keySize !== 8) {
            throw new Error('AES key length must be 16/24/32 bytes');
        }
        var ks = aesKeySchedule(keyWA.words, keySize);

        var inWords = ciphertextWA.words.slice(0);
        var sigBytes = ciphertextWA.sigBytes;
        if (sigBytes % 16) throw new Error('ciphertext not block-aligned');
        var nBlocks = sigBytes / 16;

        var prevIv = [ivWA.words[0] | 0, ivWA.words[1] | 0, ivWA.words[2] | 0, ivWA.words[3] | 0];

        var outWords = [];
        for (var b = 0; b < nBlocks; b++) {
            var off = b * 4;
            var c0 = inWords[off] | 0, c1 = inWords[off + 1] | 0, c2 = inWords[off + 2] | 0, c3 = inWords[off + 3] | 0;
            // decrypt block in place into a temp
            var blk = [c0, c1, c2, c3];
            aesDecryptBlock(blk, 0, ks);
            outWords[off]     = blk[0] ^ prevIv[0];
            outWords[off + 1] = blk[1] ^ prevIv[1];
            outWords[off + 2] = blk[2] ^ prevIv[2];
            outWords[off + 3] = blk[3] ^ prevIv[3];
            prevIv = [c0, c1, c2, c3];
        }

        // PKCS7 strip
        var rawWA = WordArray.create(outWords, sigBytes);
        var lastByte = (rawWA.words[(sigBytes - 1) >>> 2] >>> (24 - ((sigBytes - 1) % 4) * 8)) & 0xff;
        if (lastByte === 0 || lastByte > 16) {
            throw new Error('Invalid PKCS7 padding (password may be incorrect)');
        }
        rawWA.sigBytes = sigBytes - lastByte;
        rawWA.clamp();
        return rawWA;
    }

    // ---- OpenSSL EVP_BytesToKey + AES.decrypt(b64String, password) -----
    //
    // 输入 base64 字符串（"Salted__" + 8B salt + ciphertext）+ password 字符串
    // 输出 plaintext WordArray，可 .toString(C.enc.Utf8)

    function evpBytesToKey(passwordBytes, saltBytes, keyLen, ivLen) {
        // MD5(password || salt) 反复迭代，concat 到长度足够
        var totalLen = keyLen + ivLen;
        var derived = [];
        var lastBlock = null;
        while (derived.length < totalLen) {
            var input;
            if (lastBlock) {
                input = lastBlock.concat(passwordBytes).concat(saltBytes);
            } else {
                input = passwordBytes.concat(saltBytes);
            }
            // 使用 byte 数组 → 转 WordArray → MD5
            var bytesToWA = bytesToWordArray(input);
            var md5wa = md5Of(bytesToWA);
            lastBlock = wordArrayToBytes(md5wa);
            for (var i = 0; i < lastBlock.length; i++) {
                derived.push(lastBlock[i]);
            }
        }
        var keyBytes = derived.slice(0, keyLen);
        var ivBytes = derived.slice(keyLen, keyLen + ivLen);
        return { key: keyBytes, iv: ivBytes };
    }

    function bytesToWordArray(bytes) {
        var words = [];
        for (var i = 0; i < bytes.length; i++) {
            words[i >>> 2] |= (bytes[i] & 0xff) << (24 - (i % 4) * 8);
        }
        return WordArray.create(words, bytes.length);
    }
    function wordArrayToBytes(wa) {
        var out = [];
        for (var i = 0; i < wa.sigBytes; i++) {
            out.push((wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff);
        }
        return out;
    }
    function strToBytes(s) {
        // 与 OpenSSL/CryptoJS 行为一致：UTF-8 编码后再当字节
        var utf = unescape(encodeURIComponent(s));
        var out = [];
        for (var i = 0; i < utf.length; i++) out.push(utf.charCodeAt(i) & 0xff);
        return out;
    }

    C.AES = {
        // 参数：base64 ciphertext 字符串（含 Salted__ 前缀）+ password 字符串
        decrypt: function (base64Ciphertext, password) {
            var raw = wordArrayToBytes(C_enc.Base64.parse(base64Ciphertext));
            if (raw.length < 17 || (raw.length % 16) !== 0) {
                throw new Error('Invalid ciphertext length');
            }
            // Salted__ 前缀检查
            var sig = String.fromCharCode(raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7]);
            if (sig !== 'Salted__') {
                throw new Error('Missing Salted__ header');
            }
            var salt = raw.slice(8, 16);
            var ciphertext = raw.slice(16);

            var derived = evpBytesToKey(strToBytes(password), salt, 32, 16);
            var keyWA = bytesToWordArray(derived.key);
            var ivWA = bytesToWordArray(derived.iv);
            var cipherWA = bytesToWordArray(ciphertext);

            var plainWA = aesCbcDecrypt(cipherWA, keyWA, ivWA);
            // 让 .toString(C.enc.Utf8) 工作
            plainWA.toString = function (encoder) {
                if (!encoder) encoder = C_enc.Hex;
                return encoder.stringify(plainWA);
            };
            return plainWA;
        }
    };

    C.enc = C_enc;
    return C;
})();

// ====== 业务工具 ======================================================

function isString(v) { return typeof v === 'string'; }
function nonEmpty(v) { return isString(v) && v.length > 0; }

function safeJsonParse(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function getStatus() {
    return {
        configured: nonEmpty(config.get('host')) &&
                    nonEmpty(config.get('cloud_uuid')) &&
                    nonEmpty(config.get('cloud_pwd')),
        host: config.get('host') || '',
        site_map: config.get('site_map') || '',
        last_synced_at: config.get('last_synced_at') || '',
        last_error: config.get('last_error') || '',
        synced_count: parseInt(config.get('synced_count') || '0', 10) || 0,
        hostkv_available: typeof hostkv === 'object' && hostkv && typeof hostkv.setSiteCookie === 'function'
    };
}

function rememberError(msg) {
    try {
        config.set('last_error', String(msg || ''));
    } catch (e) { /* ignore */ }
}

function clearError() {
    try { config.set('last_error', ''); } catch (e) { /* ignore */ }
}

function bumpSyncedCount() {
    var n = parseInt(config.get('synced_count') || '0', 10);
    if (isNaN(n)) n = 0;
    try { config.set('synced_count', String(n + 1)); } catch (e) { /* ignore */ }
}

// ====== 主流程：syncOnce ==============================================

async function syncOnce() {
    var host = config.get('host');
    var uuid = config.get('cloud_uuid');
    var pwd  = config.get('cloud_pwd');
    var siteMapRaw = config.get('site_map') || '{}';

    if (!nonEmpty(host) || !nonEmpty(uuid) || !nonEmpty(pwd)) {
        return { ok: false, error: 'missing config: host/cloud_uuid/cloud_pwd' };
    }

    var siteMap = safeJsonParse(siteMapRaw, {});
    if (siteMap === null || typeof siteMap !== 'object') {
        return { ok: false, error: 'site_map JSON invalid' };
    }

    // 拼 URL：host 可能带 / 后缀
    var url = host.replace(/\/+$/, '') + '/get/' + encodeURIComponent(uuid);

    var resp;
    try {
        resp = await http.get(url, { 'Accept': 'application/json' });
    } catch (e) {
        return { ok: false, error: 'http get failed: ' + (e && e.message ? e.message : e) };
    }

    if (!resp || typeof resp.status !== 'number') {
        return { ok: false, error: 'http get returned malformed response' };
    }
    if (resp.status !== 200) {
        return { ok: false, error: 'server returned status ' + resp.status };
    }

    var payload = safeJsonParse(resp.body, null);
    if (!payload || typeof payload !== 'object' || !nonEmpty(payload.encrypted)) {
        return { ok: false, error: 'server response missing encrypted field' };
    }

    // 派生 password = MD5(uuid + "-" + pwd) hex 前 16 位
    var derivedPwd;
    try {
        derivedPwd = CryptoJS.MD5(uuid + '-' + pwd).toString().substring(0, 16);
    } catch (e) {
        return { ok: false, error: 'md5 derive failed: ' + (e && e.message ? e.message : e) };
    }

    var plaintext;
    try {
        var wa = CryptoJS.AES.decrypt(payload.encrypted, derivedPwd);
        plaintext = wa.toString(CryptoJS.enc.Utf8);
    } catch (e) {
        return { ok: false, error: 'decrypt failed: ' + (e && e.message ? e.message : e) };
    }

    var data = safeJsonParse(plaintext, null);
    if (!data || typeof data !== 'object' || !data.cookie_data || typeof data.cookie_data !== 'object') {
        return { ok: false, error: 'decrypted payload missing cookie_data' };
    }

    // 把每个 domain 的 cookies 拼成 "k=v; k2=v2; ..." 写到 host KV
    var hostkvAvailable = (typeof hostkv === 'object' && hostkv && typeof hostkv.setSiteCookie === 'function');
    var written = 0;
    var skipped = 0;
    var domainsMissing = [];

    for (var domain in siteMap) {
        if (!siteMap.hasOwnProperty(domain)) continue;
        var siteID = siteMap[domain];
        if (!nonEmpty(siteID)) { skipped++; continue; }

        var cookies = data.cookie_data[domain];
        if (!cookies || cookies.length === 0) {
            domainsMissing.push(domain);
            skipped++;
            continue;
        }

        var parts = [];
        for (var i = 0; i < cookies.length; i++) {
            var ck = cookies[i];
            if (ck && nonEmpty(ck.name)) {
                parts.push(ck.name + '=' + (ck.value || ''));
            }
        }
        var cookieStr = parts.join('; ');

        if (hostkvAvailable) {
            try {
                hostkv.setSiteCookie(siteID, cookieStr);
                written++;
            } catch (e) {
                log.warn('hostkv.setSiteCookie failed for site_id=' + siteID + ': ' + (e && e.message ? e.message : e));
                skipped++;
            }
        } else {
            // host 暂未注入 facade（预期 v1 主仓 PR 提供）：dry-run，仅日志
            log.warn('hostkv facade unavailable; dry-run for site_id=' + siteID + ' cookies_len=' + cookieStr.length);
            skipped++;
        }
    }

    try { config.set('last_synced_at', new Date().toISOString()); } catch (e) { /* ignore */ }
    clearError();
    bumpSyncedCount();

    return {
        ok: true,
        written: written,
        skipped: skipped,
        domains_missing: domainsMissing,
        hostkv_available: hostkvAvailable
    };
}

// ====== 自检：CryptoJS-mini test vector =================================
//
// 不依赖外部网络。固定 password / plaintext，加密结果由参考实现
// （crypto-js@4.2.0 + 同 password "secret"）预先算好；这里仅校验解密能还原原文。

function testDecrypt() {
    var checks = [];

    // 1. MD5 known vector: MD5("hello") = 5d41402abc4b2a76b9719d911017c592
    var md5Hex = CryptoJS.MD5('hello').toString();
    checks.push({
        name: 'md5(hello)',
        ok: md5Hex === '5d41402abc4b2a76b9719d911017c592',
        got: md5Hex
    });

    // 2. AES decrypt round-trip: 这个向量由参考 crypto-js@4.2.0 预先生成
    //    plaintext = "hello world"
    //    password = "secret"
    //    CryptoJS.AES.encrypt("hello world", "secret").toString()
    //    → 一个固定 base64（含 Salted__）。下面值由参考实现产出。
    var b64 = 'U2FsdGVkX1+vupppZksvRZ6ekvz9IexIvTRvnfa4lCc=';
    var plain = '';
    var aesOk = false;
    try {
        var wa = CryptoJS.AES.decrypt(b64, 'secret');
        plain = wa.toString(CryptoJS.enc.Utf8);
        aesOk = (plain === 'hello world');
    } catch (e) {
        plain = 'error: ' + (e && e.message ? e.message : e);
    }
    checks.push({ name: 'aes decrypt(hello world)', ok: aesOk, got: plain });

    var allOk = true;
    for (var i = 0; i < checks.length; i++) if (!checks[i].ok) { allOk = false; break; }

    return { ok: allOk, checks: checks };
}

// ====== API 注册 =======================================================

plugin.registerAPI('/sync', async function (req) {
    var result;
    try {
        result = await syncOnce();
    } catch (e) {
        result = { ok: false, error: 'sync exception: ' + (e && e.message ? e.message : e) };
    }
    if (!result.ok) {
        rememberError(result.error);
        log.error('cookiecloud sync failed: ' + result.error);
    } else {
        log.info('cookiecloud sync ok: written=' + result.written + ' skipped=' + result.skipped);
    }
    return result;
});

plugin.registerAPI('/status', function (req) {
    return getStatus();
});

plugin.registerAPI('/save-config', function (req) {
    // req.body 是 string（JSON）或 object（依 host 实现而异）
    var body = req && req.body;
    var obj = null;
    if (body && typeof body === 'object') {
        obj = body;
    } else if (isString(body) && body.length > 0) {
        obj = safeJsonParse(body, null);
    }
    if (!obj || typeof obj !== 'object') {
        return { ok: false, error: 'body must be a JSON object' };
    }

    var allowed = ['host', 'cloud_uuid', 'cloud_pwd', 'site_map'];
    var written = [];
    for (var i = 0; i < allowed.length; i++) {
        var k = allowed[i];
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            var v = obj[k];
            if (v === null || v === undefined) v = '';
            if (typeof v !== 'string') v = String(v);
            try {
                config.set(k, v);
                written.push(k);
            } catch (e) {
                return { ok: false, error: 'config.set failed for ' + k + ': ' + (e && e.message ? e.message : e), written: written };
            }
        }
    }
    return { ok: true, written: written };
});

plugin.registerAPI('/test-decrypt', function (req) {
    try {
        return testDecrypt();
    } catch (e) {
        return { ok: false, error: 'test-decrypt exception: ' + (e && e.message ? e.message : e) };
    }
});

log.info('cookiecloud plugin loaded');
