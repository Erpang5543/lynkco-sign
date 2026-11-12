/***************************************************************
 * 领克 App - 自动签到脚本
 * 适用: Quantumult X / Loon
 *
 * 依赖: 先运行 lynkco-cookie.js 抓到 refreshToken (见该文件头部说明)
 *
 * 配置 (Quantumult X):
 *   [task_local]
 *   0 8 * * * lynkco-checkin.js, tag=领克签到, enabled=true
 *
 * 配置 (Loon):
 *   [Script]
 *   cron "0 8 * * *" script-path=lynkco-checkin.js, tag=领克签到, enabled=true
 *
 * 功能:
 *   1) 多账号支持 (cookie 脚本抓几个就算几个)
 *   2) refreshToken 自动轮换续期, 不踢 App 登录
 *   3) 每日签到 + 连续天数/补签卡/能量查询
 *   4) 原生通知返回结果
 ***************************************************************/

/* ==================== 常量 ==================== */

const API_HOST = "https://app-api-gw-toc.lynkco.com";
const OAUTH_HOST = "https://app-services.lynkco.com.cn";

const APP_CODE = "3fa3314998bd4195a9fe2df3e85e6a12";

// 网关消费者密钥: 内置值可能随 App 版本升级失效,
// lynkco-cookie.js 抓到新值时会写入存储, 这里自动覆盖
const DEFAULT_CA_KEY = "204644386";
let caKey = DEFAULT_CA_KEY;
const CA_KEY_STORE = "lynkco_ca_key";

const CA_SECRET = "QCl7udM3PB9cOIOwquwPglikFQnzJRsX";

const APP_VERSION = "4.2.0";
const APP_BUILD = "40200106";

const EP_SIGN = "/up/api/v1/user/sign";
const EP_SIGN_SECURED = "/up/api/v1/user/sign/upgrade/secured"; // 4.2.x 实际签到接口
const EP_SIGN_ALT = "/up/api/v1/user/sign/sign/Info"; // 新版 App 实际路径
const EP_SIGN_DAY = "/up/api/v1/user/sign/day/info"; // 今日签到状态, 用来判断"已签"
const EP_SIGN_INFO = "/up/api/v1/userReward/getContinueDaysAndSignCard";
const EP_ENERGY = "/app/energy/myEnergy";

// 从录制快照学到的真实签到路径/请求体(优先级最高)
const SIGN_PATH_STORE = "lynkco_sign_path";
const SIGN_BODY_STORE = "lynkco_sign_body";

const ACCOUNT_KEY = "lynkco_accounts";

/**
 * 签名串最后一段的拼接方式。
 * 标准阿里云网关规范是 path + "?query" (无 query 时就是 path)。
 * 个别实现里无 query 时会留空, 若签到返回 "Invalid Signature",
 * 把这里改成 "legacy" 再试。
 */
const SIGN_STYLE = "standard"; // "standard" | "legacy"

/* ==================== 平台适配 ==================== */

const isQuanX = typeof $task !== "undefined";

function readStore(key) {
  if (isQuanX) return $prefs.valueForKey(key);
  return $persistentStore.read(key) || null;
}

function writeStore(key, value) {
  if (isQuanX) return $prefs.setValueForKey(value, key);
  return $persistentStore.write(value, key);
}

function notify(title, subtitle, body) {
  if (typeof $notification !== "undefined" && $notification.post) {
    $notification.post(title, subtitle, body);
  } else if (typeof $notify !== "undefined") {
    $notify(title, subtitle, body);
  }
}

function done() {
  $done();
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/* 统一 HTTP 请求, 返回 Promise<{status, body, json}> */
function httpRequest(method, url, headers, body) {
  return new Promise(function (resolve, reject) {
    const options = { url: url, headers: headers || {} };
    if (body !== undefined && body !== null) options.body = body;

    const handler = function (error, response, data) {
      if (error) return reject(new Error(String(error)));
      resolve({
        status: response && response.status ? response.status : 0,
        body: data || "",
        json: safeJson(data || "")
      });
    };

    // 1. 常规环境 (Loon / QX / Surge 的定时任务都提供)
    if (typeof $httpClient !== "undefined" && $httpClient && typeof $httpClient.get === "function") {
      if (method === "POST") $httpClient.post(options, handler);
      else $httpClient.get(options, handler);
      return;
    }

    // 2. Quantumult X 的 Promise 风格接口兜底
    if (typeof $task !== "undefined" && typeof $task.fetch === "function") {
      const opts = { url: url, method: method, headers: headers || {} };
      if (body !== undefined && body !== null) opts.body = body;
      $task.fetch(opts)
        .then(function (resp) {
          resolve({
            status: resp.statusCode || resp.status || 0,
            body: resp.body || "",
            json: safeJson(resp.body || "")
          });
        })
        .catch(function (err) {
          reject(new Error(String(err && err.error ? err.error : err)));
        });
      return;
    }

    // 3. 都没有: 说明脚本被放进了重写上下文(同步执行, 不允许发网络请求)
    reject(new Error("$httpClient 不可用, 请把本脚本加到【定时任务】, 不要加到【重写】"));
  });
}

/* ==================== 加密工具 (纯 JS, 无依赖) ==================== */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const code = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function sha256(bytes) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const msg = bytes.slice(0);
  const len = msg.length;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 消息长度按 64 位大端写入 (JS 里消息远小于 2^32 位, 高位补 0)
  const bitLen = len * 8;
  msg.push(0, 0, 0, 0);
  msg.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  const w = new Array(64);
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const p = i + t * 4;
      w[t] = (msg[p] << 24) | (msg[p + 1] << 16) | (msg[p + 2] << 8) | msg[p + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((H[i] >>> 24) & 0xff, (H[i] >>> 16) & 0xff, (H[i] >>> 8) & 0xff, H[i] & 0xff);
  }
  return out;
}

function hmacSha256(keyStr, msgStr) {
  let key = utf8Bytes(keyStr);
  if (key.length > 64) key = sha256(key);

  const k = key.slice(0);
  while (k.length < 64) k.push(0);

  const ipad = [], opad = [];
  for (let i = 0; i < 64; i++) {
    ipad.push(k[i] ^ 0x36);
    opad.push(k[i] ^ 0x5c);
  }

  const inner = sha256(ipad.concat(utf8Bytes(msgStr)));
  return sha256(opad.concat(inner));
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : "=";
  }
  return out;
}

function uuidUpper() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else if (i === 19) s += hex[(Math.random() * 4 | 0) + 8];
    else s += hex[Math.random() * 16 | 0];
  }
  return s.toUpperCase();
}

/* ==================== 网关签名 ==================== */

/**
 * 生成阿里云 API 网关的 X-Ca-* 签名头
 * 签名串 = method\Accept\nContentMD5\nContentType\nDate\n自定义头\npath?query
 */
function buildSignHeaders(method, path, query) {
  const timestamp = String(Date.now());
  const nonce = uuidUpper();

  let signedPath = path;
  if (query && Object.keys(query).length) {
    const qs = Object.keys(query)
      .sort()
      .map(function (k) { return k + "=" + query[k]; })
      .join("&");
    signedPath = path + "?" + qs;
  } else if (SIGN_STYLE === "legacy") {
    signedPath = "";
  }

  const parts = [
    String(method).toUpperCase(),
    "*/*",
    "",
    "application/json",
    "",
    "X-Ca-Key:" + caKey,
    "X-Ca-Nonce:" + nonce,
    "X-Ca-Signature-Method:HmacSHA256",
    "X-Ca-Timestamp:" + timestamp,
    signedPath
  ];

  const signature = base64(hmacSha256(CA_SECRET, parts.join("\n")));

  return {
    "X-Ca-Key": caKey,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature-Method": "HmacSHA256",
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Signature-Headers": "X-Ca-Key,X-Ca-Nonce,X-Ca-Signature-Method,X-Ca-Timestamp",
    "X-Ca-Signature": signature,
    "Accept": "*/*"
  };
}

/* 调用业务接口 */
function callApi(method, path, accessToken, query, payload) {
  const headers = buildSignHeaders(method, path, query);
  headers["token"] = accessToken;
  headers["content-type"] = "application/json";

  let url = API_HOST + path;
  if (query && Object.keys(query).length) {
    const qs = Object.keys(query)
      .map(function (k) { return k + "=" + encodeURIComponent(query[k]); })
      .join("&");
    url += "?" + qs;
  }

  const body = method === "POST" ? JSON.stringify(payload || {}) : undefined;
  return httpRequest(method, url, headers, body);
}

/* 按完整路径(可含 query)调用; 路径整体参与签名 */
function callApiRaw(method, fullPath, accessToken, payload, rawBody) {
  const timestamp = String(Date.now());
  const nonce = uuidUpper();
  const parts = [
    String(method).toUpperCase(),
    "*/*",
    "",
    "application/json",
    "",
    "X-Ca-Key:" + caKey,
    "X-Ca-Nonce:" + nonce,
    "X-Ca-Signature-Method:HmacSHA256",
    "X-Ca-Timestamp:" + timestamp,
    fullPath
  ];
  const signature = base64(hmacSha256(CA_SECRET, parts.join("\n")));

  const headers = {
    "X-Ca-Key": caKey,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature-Method": "HmacSHA256",
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Signature-Headers": "X-Ca-Key,X-Ca-Nonce,X-Ca-Signature-Method,X-Ca-Timestamp",
    "X-Ca-Signature": signature,
    "token": accessToken,
    "content-type": "application/json",
    "Accept": "*/*"
  };

  let body;
  if (String(method).toUpperCase() === "POST") {
    body = (typeof rawBody === "string" && rawBody.length) ? rawBody : JSON.stringify(payload || {});
  }
  return httpRequest(method, API_HOST + fullPath, headers, body);
}

/* ==================== 录制重放 ====================
 * App 的签到请求带 30+ 个业务头, 其中可能有参与网关签名的自定义头,
 * 靠猜永远猜不全。这里直接重放录制的真实请求:
 *   头全盘照抄 -> 只替换 token / gl_dev_id / X-Ca-Nonce / X-Ca-Timestamp
 *   -> 按 App 自己声明的 X-Ca-Signature-Headers 顺序重算签名
 */

const PROBE_KEY = "lynkco_sign_probe";

const HOP_HEADERS = [
  "host", "connection", "content-length", "accept-encoding",
  "proxy-connection", "te", "trailer", "upgrade",
  "x-ca-signature", "x-ca-nonce", "x-ca-timestamp", "x-ca-key"
];

function hFind(headers, name) {
  const t = String(name).toLowerCase();
  for (const k in headers) if (k.toLowerCase() === t) return k;
  return "";
}

function hGet(headers, name) {
  const k = hFind(headers, name);
  return k ? headers[k] : "";
}

function hSet(headers, name, value) {
  headers[hFind(headers, name) || name] = value;
}

/* 快照是不是"签到"动作 (排除 day/info、sign/info 这类查询) */
function isSignProbe(probe) {
  if (!probe || !probe.url) return false;
  const p = String(probe.url).replace(/^https?:\/\/[^/]+/, "");
  if (!/\/user\/sign/i.test(p)) return false;
  if (/\/info|\/query|\/list|\/config|\/record|\/day\//i.test(p)) return false;
  return String(probe.method || "POST").toUpperCase() === "POST";
}

/* 用快照构造一份可直接发送的请求 */
function buildReplay(probe, account) {
  const base = probe.headers || {};
  const path = String(probe.url || "").replace(/^https?:\/\/[^/]+/, "");
  const method = String(probe.method || "POST").toUpperCase();

  const headers = {};
  for (const k in base) {
    if (HOP_HEADERS.indexOf(k.toLowerCase()) < 0) headers[k] = base[k];
  }

  hSet(headers, "X-Ca-Key", caKey);
  hSet(headers, "X-Ca-Nonce", uuidUpper());
  hSet(headers, "X-Ca-Signature-Method", "HmacSHA256");
  hSet(headers, "X-Ca-Timestamp", String(Date.now()));

  hSet(headers, "token", account.at);
  if (hGet(headers, "gl_dev_id")) hSet(headers, "gl_dev_id", account.did);
  if (hGet(headers, "deviceId")) hSet(headers, "deviceId", account.did);

  // Date 头存在就必须刷新, 否则网关按时间偏差直接拒绝
  let dateLine = "";
  if (hGet(headers, "Date")) {
    dateLine = new Date().toUTCString();
    hSet(headers, "Date", dateLine);
  }

  const accept = hGet(headers, "Accept") || "*/*";
  const md5 = hGet(headers, "Content-MD5") || "";
  const ctype = hGet(headers, "Content-Type") || "application/json";

  // 关键: 按 App 声明的签名头顺序拼签名串, 少一个都会 Invalid Signature
  // (清单原文必须原样回传, 大小写变了服务端拼串就对不上)
  const specRaw = hGet(headers, "X-Ca-Signature-Headers");
  const names = (specRaw || "X-Ca-Key,X-Ca-Nonce,X-Ca-Signature-Method,X-Ca-Timestamp")
    .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const custom = names.map(function (n) { return n + ":" + (hGet(headers, n) || ""); });

  const parts = [method, accept, md5, ctype, dateLine].concat(custom, [path]);
  hSet(headers, "X-Ca-Signature", base64(hmacSha256(CA_SECRET, parts.join("\n"))));
  if (!specRaw) hSet(headers, "X-Ca-Signature-Headers", names.join(","));

  const body = method === "POST" && typeof probe.body === "string" && probe.body.length
    ? probe.body
    : undefined;

  return { method: method, path: path, url: API_HOST + path, headers: headers, body: body };
}

/* ==================== 结果判定 ==================== */

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE";
}

function judge(res, path) {
  const json = res.json;
  if (isOk(json)) {
    const d = json.data || {};
    const reward = [];
    if (d.rewardEnergyNumber) reward.push("+" + d.rewardEnergyNumber + " 能量体");
    if (d.rewardPointNumber) reward.push("+" + d.rewardPointNumber + " Co积分");
    if (d.rewardSignCardNumber) reward.push("+" + d.rewardSignCardNumber + " 补签卡");
    return { ok: true, text: reward.length ? reward.join(", ") : "签到成功", path: path };
  }

  const msg = json
    ? "code=" + json.code + " " + errorMessage(json)
    : "HTTP " + res.status + " " + String(res.body || "").slice(0, 60);
  if (/已签到|已经签到|重复|已签/.test(msg)) {
    return { ok: true, already: true, text: "今日已签到", path: path };
  }
  return { ok: false, text: msg, path: path, status: res.status, json: json };
}

/* 查今日签到状态: 接口返回 400 操作失败时多为"今天已签过", 用它确认 */
async function probeDayInfo(account) {
  try {
    const p = await callApiRaw("GET", EP_SIGN_DAY, account.at);
    const j = p.json || {};
    const d = j.data || {};
    const signed =
      truthy(d.todayIsSign) || truthy(d.isSign) || truthy(d.todaySigned) ||
      truthy(d.signStatus) || truthy(d.status);
    return { status: p.status, body: String(p.body || ""), signed: signed, data: d };
  } catch (e) {
    return null;
  }
}

/* 从录制快照中学习真实的签到路径 (App 可能使用与旧版不同的路径) */
function learnSignPath() {
  const probe = safeJson(readStore(PROBE_KEY) || "null");
  if (!isSignProbe(probe)) return "";

  const full = String(probe.url || "").replace(/^https?:\/\/[^/]+/, "");
  writeStore(SIGN_PATH_STORE, full);
  return full;
}

/* 从录制快照中学习真实的签到请求体 */
function learnSignBody() {
  const probe = safeJson(readStore(PROBE_KEY) || "null");
  if (!isSignProbe(probe) || !probe.body) return "";
  const bodyText = String(probe.body);
  if (!bodyText.length) return "";
  writeStore(SIGN_BODY_STORE, bodyText);
  return bodyText;
}

/* ==================== 业务逻辑 ==================== */

function isOk(json) {
  if (!json) return false;
  const code = json.code;
  return code === "success" || code === "SUCCESS" || code === 0 || code === 200 || code === "200";
}

function errorMessage(json, fallback) {
  if (!json) return fallback || "返回数据为空";
  return json.message || json.msg || json.errorMsg || ("code=" + json.code);
}

/* 用 refreshToken 换新的 accessToken (顺带轮换 refreshToken) */
async function refreshToken(account) {
  const url = OAUTH_HOST +
    "/auth/login/refresh?refreshToken=" + encodeURIComponent(account.rt) +
    "&deviceId=" + encodeURIComponent(account.did) +
    "&deviceType=IOS&appVersion=" + APP_VERSION;

  const headers = {
    "Authorization": "APPCODE " + APP_CODE,
    "accept": "application/json",
    "content-type": "application/json; charset=UTF-8",
    "publicplatform": "iOS",
    "user-agent": "CA_iOS_SDK_2.0",
    "token": "",
    "gl_dev_id": account.did,
    "appversioncode": APP_VERSION,
    "appversionname": APP_BUILD,
    "gl_app_version": APP_VERSION,
    "gl_app_build": APP_BUILD,
    "x-ca-version": "1"
  };

  const res = await httpRequest("GET", url, headers);
  const json = res.json;

  if (!isOk(json)) {
    const m = errorMessage(json, "HTTP " + res.status);
    if (/invalid_expired|refresh.*(invalid|expired)/i.test(m)) {
      throw new Error("登录态已失效, 请在领克 App 里退出重登再抓一次");
    }
    throw new Error("刷新登录态失败: " + m);
  }

  const dto = (json.data && json.data.centerTokenDto) || {};
  if (!dto.token) throw new Error("刷新登录态失败: 未返回 token");

  account.at = dto.token;
  if (dto.refreshToken) account.rt = dto.refreshToken;
  if (dto.expireAt) account.atExpire = dto.expireAt;
  account.updatedAt = Date.now();
  return account;
}

/* 查询连续签到天数 / 补签卡 */
async function querySignInfo(account) {
  try {
    const res = await callApi("GET", EP_SIGN_INFO, account.at);
    if (!isOk(res.json)) return null;
    const d = res.json.data || {};
    return {
      continueDays: d.continueDays != null ? d.continueDays : d.continuousDays,
      signCard: d.signCardNumber != null ? d.signCardNumber : d.signCardCount,
      signedToday: d.todayIsSign != null ? d.todayIsSign : d.isSign
    };
  } catch (e) {
    return null;
  }
}

/* 查询能量体 */
async function queryEnergy(account) {
  try {
    const res = await callApi("GET", EP_ENERGY, account.at);
    if (!isOk(res.json)) return null;
    const d = res.json.data || {};
    return d.energyNumber != null ? d.energyNumber : (d.totalEnergy != null ? d.totalEnergy : null);
  } catch (e) {
    return null;
  }
}

/* 执行签到 */
async function doSign(account) {
  const learned = readStore(SIGN_PATH_STORE) || "";
  const learnedBody = readStore(SIGN_BODY_STORE) || "";
  const probe = safeJson(readStore(PROBE_KEY) || "null");

  const tried = [];

  // 1) 首选: 重放 App 的真实请求 (头最全, 签名最接近原样)
  if (isSignProbe(probe)) {
    try {
      const built = buildReplay(probe, account);
      const res = await httpRequest(built.method, built.url, built.headers, built.body);
      const r = judge(res, built.path);
      console.log("[领克] 重放 " + built.path + " -> " + res.status + " " + String(res.body || "").slice(0, 90));
      if (r.ok) return r;
      tried.push({ path: built.path, mode: "replay", status: res.status, text: r.text });
    } catch (e) {
      console.log("[领克] 重放异常: " + e);
      tried.push({ path: "replay", mode: "replay", status: 0, text: String(e && e.message ? e.message : e) });
    }
  } else {
    console.log("[领克] 无有效签到录制, 跳过重放");
  }

  // 2) 兜底: 自建签名, 按候选路径依次尝试
  //    注意排除 /sign/xxx/info 这类查询接口, 它们不是签到动作
  const candidates = [];
  if (learned && !/\/info|\/query|\/day\//i.test(learned)) candidates.push(learned);
  [EP_SIGN_SECURED, EP_SIGN].forEach(function (p) {
    if (candidates.indexOf(p) < 0) candidates.push(p);
  });

  for (let i = 0; i < candidates.length; i++) {
    const res = await callApiRaw("POST", candidates[i], account.at, {}, learnedBody);
    const r = judge(res, candidates[i]);
    console.log("[领克] 自建 " + candidates[i] + " -> " + res.status + " " + String(res.body || "").slice(0, 90));
    if (r.ok) return r;
    tried.push({ path: candidates[i], mode: "self", status: res.status, text: r.text });
    if (res.status === 403) continue; // 该接口未授权给当前 consumer, 换下一个
  }

  // 3) 全都失败: 查签到状态, 区分 "已签过" 与 "真的失败"
  const day = await probeDayInfo(account);
  if (day && day.signed) {
    // 顺手把接口的真实回包带上: 能看出是"重复签到"还是"签名被拒"
    const echo = tried.length
      ? " | 接口 " + (tried[0].mode === "replay" ? "重放 " : "") + tried[0].text.slice(0, 44)
      : "";
    return {
      ok: true,
      already: true,
      text: "今日已签到 (day/info 显示已签)" + echo
    };
  }

  const first = tried[0] || { text: "无可用路径", path: "-" };
  const tail = day ? " | day/info " + day.status + " " + String(day.body).slice(0, 70) : " | day/info ERR";
  return {
    ok: false,
    text: first.text + tail + " (" + first.path + (first.mode === "replay" ? " 重放" : "") + ")"
  };
}

/* accessToken 是否还能直接用 (减少刷新次数, 避免频繁轮换 refreshToken) */
function hasValidAccessToken(account) {
  if (!account.at) return false;
  const exp = Number(account.atExpire);
  if (!exp || isNaN(exp)) return true; // 没有过期信息时先试一次, 失败再刷新
  return exp - Date.now() > 5 * 60 * 1000;
}

/* 单个账号完整流程 */
async function runAccount(account, index) {
  const label = account.name || ("账号 " + (index + 1));

  try {
    if (hasValidAccessToken(account)) {
      // accessToken 仍有效, 跳过刷新
    } else if (account.rt) {
      await refreshToken(account);
    } else if (!account.at) {
      return { label: label, ok: false, text: "缺少 refreshToken, 请重新抓包" };
    }

    const sign = await doSign(account);

    // accessToken 失效时补一次刷新再重试
    if (!sign.ok && /token|登录|授权|401/i.test(sign.text) && account.rt) {
      await refreshToken(account);
      const retry = await doSign(account);
      if (retry.ok) {
        Object.assign(sign, retry);
      }
    }

    if (!sign.ok) {
      return { label: label, ok: false, text: sign.text };
    }

    const info = await querySignInfo(account);
    const energy = await queryEnergy(account);

    let detail = sign.text;
    if (info && info.continueDays != null) detail += " | 连续 " + info.continueDays + " 天";
    if (info && info.signCard != null) detail += " | 补签卡 " + info.signCard;
    if (energy != null) detail += " | 能量 " + energy;

    return { label: label, ok: true, text: detail };
  } catch (e) {
    return { label: label, ok: false, text: String(e && e.message ? e.message : e) };
  }
}

/* ==================== 签名诊断 ====================
 * 用 cookie 脚本录制的 App 真实请求, 反推: 旧 secret 是否仍然有效。
 * 判定方式: 用旧 secret 按标准签名串重算, 与 App 的 X-Ca-Signature 逐字符比对。
 */
function diagSignature() {
  const probe = safeJson(readStore("lynkco_sign_probe") || "null");
  if (!probe || !probe.headers) return null;
  if (readStore("lynkco_diag_at") === String(probe.at)) return null; // 同一份快照只诊断一次

  const H = probe.headers;
  function g(name) {
    const t = String(name).toLowerCase();
    for (const k in H) if (k.toLowerCase() === t) return H[k];
    return "";
  }

  const realSig = g("X-Ca-Signature");
  const method = String(probe.method || "GET").toUpperCase();
  const path = String(probe.url || "").replace(/^https?:\/\/[^/]+/, "");
  const key = g("X-Ca-Key");
  const nonce = g("X-Ca-Nonce");
  const ts = g("X-Ca-Timestamp");
  const ctype = g("Content-Type");

  if (!realSig) {
    notify("签名诊断", "录制的请求里没有 X-Ca-Signature", method + " " + path);
    writeStore("lynkco_diag_at", String(probe.at));
    return null;
  }

  const caHeaders = function () {
    return [
      "X-Ca-Key:" + key,
      "X-Ca-Nonce:" + nonce,
      "X-Ca-Signature-Method:HmacSHA256",
      "X-Ca-Timestamp:" + ts
    ];
  };

  // 第一优先: 完全按 App 自己声明的签名头清单重算 —— 命中就说明"重放"这套逻辑可用
  const spec = g("X-Ca-Signature-Headers") ||
    "X-Ca-Key,X-Ca-Nonce,X-Ca-Signature-Method,X-Ca-Timestamp";
  const specNames = spec.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const specLines = specNames.map(function (n) { return n + ":" + g(n); });

  const acceptReal = g("Accept") || "*/*";
  const md5Real = g("Content-MD5") || "";
  const dateReal = g("Date") || "";

  const variants = [
    ["App签名头", [method, acceptReal, md5Real, ctype || "application/json", dateReal].concat(specLines, [path])],
    ["标准GET", [method, "*/*", "", "application/json", ""].concat(caHeaders(), [path])],
    ["ctype实际", [method, "*/*", "", ctype, ""].concat(caHeaders(), [path])],
    ["ctype空", [method, "*/*", "", "", ""].concat(caHeaders(), [path])],
    ["无path", [method, "*/*", "", "application/json", ""].concat(caHeaders(), [""])]
  ];

  let hit = "";
  for (let i = 0; i < variants.length; i++) {
    const sig = base64(hmacSha256(CA_SECRET, variants[i][1].join("\n")));
    if (sig === realSig) { hit = variants[i][0]; break; }
  }

  writeStore("lynkco_diag_at", String(probe.at));

  if (hit) {
    notify("签名诊断: 旧 secret 有效", "命中 " + hit + " | " + method + " " + path.slice(0, 46),
      "已学习签到路径: " + path.slice(0, 60));
  } else {
    notify("签名诊断: 旧 secret 已失效", method + " " + path.slice(0, 46),
      "key=" + key + " 头数=" + Object.keys(H).length + " App签名=" + String(realSig).slice(0, 10) + "…");
  }

  return { hit: hit, method: method, path: path, key: key, headers: Object.keys(H) };
}

/* ==================== 入口 ==================== */

(async function main() {
  // 优先使用 cookie 脚本抓到的最新网关密钥
  const storedCaKey = readStore(CA_KEY_STORE);
  if (storedCaKey) caKey = storedCaKey;

  // 打印当前存储状态, 方便判断"到底有没有录到签到请求"
  const dbgProbe = safeJson(readStore(PROBE_KEY) || "null");
  console.log("[领克] 录制快照: " + (dbgProbe
    ? (String(dbgProbe.method || "?").toUpperCase() + " " + String(dbgProbe.url || "").replace(/^https?:\/\/[^/]+/, "") +
       " | 头 " + Object.keys(dbgProbe.headers || {}).length + " 个 | body " + (dbgProbe.body ? String(dbgProbe.body).length + " 字节" : "空"))
    : "无"));

  // 有录制快照时, 先做一次签名有效性诊断
  try { diagSignature(); } catch (e) { console.log("[领克] 诊断失败: " + e); }

  // 从录制快照学习真实签到路径 + 请求体 (每次运行都刷新)
  try { learnSignPath(); } catch (e) { console.log("[领克] 学习路径失败: " + e); }
  try { learnSignBody(); } catch (e) { console.log("[领克] 学习请求体失败: " + e); }
  console.log("[领克] 学习路径: " + (readStore(SIGN_PATH_STORE) || "无"));

  const list = safeJson(readStore(ACCOUNT_KEY) || "[]");

  if (!Array.isArray(list) || !list.length) {
    notify("领克签到", "未找到账号", "请先安装 lynkco-cookie.js 规则, 打开领克 App 抓取登录态");
    return done();
  }

  const results = [];
  for (let i = 0; i < list.length; i++) {
    results.push(await runAccount(list[i], i));
  }

  // 回写: refreshToken 已轮换, 必须持久化, 否则下次会失效
  writeStore(ACCOUNT_KEY, JSON.stringify(list));

  const failed = results.filter(function (r) { return !r.ok; });
  const title = failed.length
    ? "领克签到 " + (results.length - failed.length) + "/" + results.length
    : "领克签到成功";

  const body = results
    .map(function (r) {
      return (r.ok ? "✅ " : "❌ ") + r.label + ": " + r.text;
    })
    .join("\n");

  console.log("[领克] " + body);
  notify(title, results.length > 1 ? "共 " + results.length + " 个账号" : "", body);
  done();
})();
