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
const CA_KEY = "204644386";
const CA_SECRET = "QCl7udM3PB9cOIOwquwPglikFQnzJRsX";

const APP_VERSION = "4.2.0";
const APP_BUILD = "40200106";

const EP_SIGN = "/up/api/v1/user/sign";
const EP_SIGN_INFO = "/up/api/v1/userReward/getContinueDaysAndSignCard";
const EP_ENERGY = "/app/energy/myEnergy";

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

    if (method === "POST") $httpClient.post(options, handler);
    else $httpClient.get(options, handler);
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
    "X-Ca-Key:" + CA_KEY,
    "X-Ca-Nonce:" + nonce,
    "X-Ca-Signature-Method:HmacSHA256",
    "X-Ca-Timestamp:" + timestamp,
    signedPath
  ];

  const signature = base64(hmacSha256(CA_SECRET, parts.join("\n")));

  return {
    "X-Ca-Key": CA_KEY,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature-Method": "HmacSHA256",
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Signature-Headers": "X-Ca-Key,X-Ca-Timestamp,X-Ca-Nonce,X-Ca-Signature-Method",
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
    throw new Error("刷新登录态失败: " + errorMessage(json, "HTTP " + res.status));
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
  const res = await callApi("POST", EP_SIGN, account.at, null, {});
  const json = res.json;

  if (isOk(json)) {
    const d = json.data || {};
    const reward = [];
    if (d.rewardEnergyNumber) reward.push("+" + d.rewardEnergyNumber + " 能量体");
    if (d.rewardPointNumber) reward.push("+" + d.rewardPointNumber + " Co积分");
    if (d.rewardSignCardNumber) reward.push("+" + d.rewardSignCardNumber + " 补签卡");
    return { ok: true, text: reward.length ? reward.join(", ") : "签到成功" };
  }

  const msg = errorMessage(json);
  if (/已签到|已经签到|重复|已签/.test(msg)) {
    return { ok: true, already: true, text: "今日已签到" };
  }
  return { ok: false, text: msg };
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

/* ==================== 入口 ==================== */

(async function main() {
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
