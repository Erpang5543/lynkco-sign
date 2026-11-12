/***************************************************************
 * 领克 App - Cookie / Token 抓取脚本
 * 适用: Quantumult X / Loon
 *
 * 作用:
 *   拦截领克 App 的鉴权请求, 自动把 refreshToken / accessToken /
 *   deviceId 写入本地存储, 供 lynkco-checkin.js 签到使用。
 *
 * 工作原理:
 *   1) App 的 accessToken 过期时会调用
 *      GET https://app-services.lynkco.com.cn/auth/login/refresh
 *      query 里带 refreshToken + deviceId, 我们可以直接拿到。
 *   2) 业务请求头里的 token / gl_dev_id 作为兜底补充。
 *
 * 配置 (Quantumult X):
 *   [rewrite_local]
 *   ^https:\/\/app-services\.lynkco\.com\.cn\/auth\/login\/refresh url script-request-header lynkco-cookie.js
 *   ^https:\/\/app-services\.lynkco\.com\.cn\/auth\/login\/refresh url script-response-body lynkco-cookie.js
 *   ^https:\/\/app-api-gw-toc\.lynkco\.com url script-request-header lynkco-cookie.js
 *
 * 配置 (Loon):
 *   [Script]
 *   http-request ^https:\/\/app-services\.lynkco\.com\.cn\/auth\/login\/refresh script-path=lynkco-cookie.js, requires-body=false, tag=领克获取Cookie
 *   http-response ^https:\/\/app-services\.lynkco\.com\.cn\/auth\/login\/refresh script-path=lynkco-cookie.js, requires-body=true, tag=领克获取Cookie
 *   http-request ^https:\/\/app-api-gw-toc\.lynkco\.com script-path=lynkco-cookie.js, tag=领克获取Cookie
 *
 * 使用:
 *   装好上面的规则 -> 开启 MITM 并信任证书 -> 杀掉领克 App 重开
 *   (进"我的"页面多点几下) -> 收到"Cookie 获取成功"通知即可。
 ***************************************************************/

const ACCOUNT_KEY = "lynkco_accounts";
const CA_KEY_STORE = "lynkco_ca_key"; // 网关消费者密钥, 由 App 请求头自动抓取
const PROBE_KEY = "lynkco_sign_probe"; // 真正的签到写请求, 供签到脚本重放
const PROBE_INFO_KEY = "lynkco_sign_probe_info"; // 查询类请求(sign/info 等), 只做参考
const HISTORY_KEY = "lynkco_sign_history"; // 最近的签到类请求快照(按路径去重), 防止被覆盖丢失
const NOTIFY_KEY = "lynkco_cookie_notify_at";
const NOTIFY_GAP = 60 * 1000; // 60 秒内不重复弹通知

/* ------------------ 平台适配 ------------------ */

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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function getQuery(url, name) {
  const m = String(url).match(new RegExp("[?&]" + name + "=([^&#]*)"));
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

/* 请求头大小写不统一, 统一按小写比对 */
function getHeader(headers, name) {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const k in headers) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return "";
}

/* ------------------ 账号存取 ------------------ */

function loadAccounts() {
  const list = safeJson(readStore(ACCOUNT_KEY) || "[]");
  return Array.isArray(list) ? list : [];
}

function maskDeviceId(did) {
  if (!did) return "unknown";
  return did.length > 10 ? did.slice(0, 4) + "****" + did.slice(-4) : did;
}

/* 按 deviceId 更新或新建账号, 返回 { account, isNew } */
function upsertAccount(patch) {
  const list = loadAccounts();
  let account = null;
  let isNew = false;

  for (let i = 0; i < list.length; i++) {
    if (list[i].did && patch.did && list[i].did === patch.did) {
      account = list[i];
      break;
    }
  }

  if (!account) {
    account = { did: patch.did, name: "", rt: "", at: "", atExpire: 0 };
    list.push(account);
    isNew = true;
  }

  let changed = false;
  for (const k in patch) {
    if (patch[k] && account[k] !== patch[k]) {
      account[k] = patch[k];
      changed = true;
    }
  }
  account.updatedAt = Date.now();

  if (changed || isNew) writeStore(ACCOUNT_KEY, JSON.stringify(list));
  return { account: account, isNew: isNew, changed: changed };
}

/* ------------------ 主流程 ------------------ */

function finish() {
  // 只旁路监听, 不做任何改写
  $done({});
}

(function main() {
  const request = typeof $request !== "undefined" ? $request : null;
  if (!request) return finish();

  const url = request.url || "";
  const headers = request.headers || {};
  let patch = null;

  try {
    if (/\/auth\/login\/refresh/.test(url)) {
      // 1. 鉴权刷新请求: query 里就有 refreshToken 和 deviceId
      const rt = getQuery(url, "refreshToken");
      const did = getQuery(url, "deviceId");

      patch = { did: did, rt: rt };

      // 2. 刷新响应里会给新的 accessToken / refreshToken (轮换), 优先使用
      const resp = typeof $response !== "undefined" ? $response : null;
      if (resp && resp.body) {
        const json = safeJson(resp.body);
        const dto = json && json.data && json.data.centerTokenDto;
        if (dto) {
          if (dto.token) patch.at = dto.token;
          if (dto.refreshToken) patch.rt = dto.refreshToken;
          if (dto.expireAt) patch.atExpire = dto.expireAt;
        }
      }
    } else if (/app-api-gw-toc\.lynkco\.com/.test(url)) {
      // 3. 业务请求兜底: 从请求头拿 accessToken
      const token = getHeader(headers, "token");
      const did = getHeader(headers, "gl_dev_id");
      if (token && did) patch = { did: did, at: token };

      // 4. 顺手抓网关的消费者密钥: 若与内置值不同, 说明官方换了 X-Ca-Key
      const caKey = getHeader(headers, "X-Ca-Key");
      if (caKey) {
        const known = readStore(CA_KEY_STORE);
        writeStore(CA_KEY_STORE, caKey);
        if (caKey !== known) {
          notify("领克网关密钥已更新", "X-Ca-Key = " + caKey, "已自动记录, 签到脚本会使用新值");
        }
      }

      // 5. 录制签到请求: 只保留带 X-Ca-Signature 的真实请求, 避免被 OPTIONS 预检覆盖
      //    注意: 查询类接口(sign/info 等)也用 POST, 会覆盖真正的签到快照, 必须分开存
      if (/\/user\/sign/i.test(url) && getHeader(headers, "X-Ca-Signature")) {
        try {
          const names = [];
          for (const k in headers) names.push(k);

          const isSignWrite =
            /\/sign\/upgrade\/secured/i.test(url) || /\/user\/sign(\?|#|$)/i.test(url);
          const snapshot = JSON.stringify({
            url: url,
            method: request.method || "POST",
            headers: headers,
            body: typeof request.body !== "undefined" ? request.body : "",
            at: Date.now()
          });

          writeStore(isSignWrite ? PROBE_KEY : PROBE_INFO_KEY, snapshot);

          // 再留一份历史快照(按路径去重, 最多 6 条), 避免被后来的请求覆盖后彻底丢失
          try {
            const pathOnly = url.replace(/^https?:\/\/[^/]+/, "");
            let hist = safeJson(readStore(HISTORY_KEY) || "[]");
            if (!Array.isArray(hist)) hist = [];
            hist = hist.filter(function (h) {
              return String(h && h.url || "").replace(/^https?:\/\/[^/]+/, "") !== pathOnly;
            });
            hist.unshift(JSON.parse(snapshot));
            writeStore(HISTORY_KEY, JSON.stringify(hist.slice(0, 6)));
          } catch (e) {
            console.log("[领克] 历史快照写入失败: " + e);
          }

          // 只有真正的签到动作才弹通知, 查询接口静默
          if (isSignWrite) {
            const bodyText = typeof request.body !== "undefined" && request.body ? String(request.body) : "";
            const sigSpec = getHeader(headers, "X-Ca-Signature-Headers") || "-";
            const stage = getHeader(headers, "X-Ca-Stage") || "-";
            notify(
              "已录制签到请求",
              (request.method || "POST") + " " + url.replace(/^https?:\/\/[^/]+/, ""),
              "头 " + names.length + " 个 | body " +
                (bodyText ? " " + bodyText.length + " 字节: " + bodyText.slice(0, 60) : " 空") +
                "\nStage: " + stage + " | 签名头: " + sigSpec.replace(/x-ca-/gi, "")
            );
          } else {
            console.log("[领克] 已录制查询请求(不覆盖签到快照): " + url);
          }
        } catch (e) {
          console.log("[领克] 录制失败: " + e);
        }
      }
    }
  } catch (e) {
    console.log("[领克] 解析失败: " + e);
    return finish();
  }

  if (!patch || !patch.did) return finish();
  if (!patch.rt && !patch.at) return finish();

  const result = upsertAccount(patch);

  // 通知节流: 避免 App 每次请求都弹窗
  const now = Date.now();
  const lastNotify = parseInt(readStore(NOTIFY_KEY) || "0", 10);
  if (now - lastNotify > NOTIFY_GAP) {
    writeStore(NOTIFY_KEY, String(now));
    const tip = patch.rt
      ? "已保存 refreshToken, 可长期自动续期"
      : "仅获取到 accessToken, 请退出重进 App 以触发刷新";
    notify("领克 Cookie 获取成功", "设备 " + maskDeviceId(patch.did), tip);
  }

  console.log("[领克] 已保存账号: " + JSON.stringify(result.account));
  finish();
})();
