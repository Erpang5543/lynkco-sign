#!/bin/bash
# 生成三份镜像配置, 保证内容一致只差域名
set -e
cd "$(dirname "$0")"
HASH="$1"
if [ -z "$HASH" ]; then echo "usage: gen-conf.sh <commit-hash>"; exit 1; fi

write_conf() {
  local file="$1" label="$2" base="$3"
  cat > "$file" <<EOF
# 领克 App 自动签到 — Quantumult X 重写资源 ($label)
# 含: 登录态抓取 / 网关密钥抓取 / 签到请求录制

hostname = app-api-gw-toc.lynkco.com, app-services.lynkco.com.cn

# 1. 登录态 refreshToken (query 中) + 刷新后的新 accessToken
^https://app-services\.lynkco\.com\.cn/auth/login/refresh url script-request-header $base/lynkco-cookie.js

# 2. 签到请求录制 (带 body, 必须排在域名总规则之前, 否则 body 拿不到)
^https://app-api-gw-toc\.lynkco\.com/up/api/v1/user/sign url script-request-body $base/lynkco-cookie.js

# 3. 其他业务请求: 取 accessToken 与 X-Ca-Key (排除 sign 路径, 避免抢走第 2 条)
^https://app-api-gw-toc\.lynkco\.com/(?!up/api/v1/user/sign) url script-request-header $base/lynkco-cookie.js
EOF
}

write_conf lynkco.conf "jsDelivr" "https://cdn.jsdelivr.net/gh/Erpang5543/lynkco-sign@$HASH"
write_conf lynkco.ghfast.conf "ghfast 加速" "https://ghfast.top/https://raw.githubusercontent.com/Erpang5543/lynkco-sign/$HASH"
write_conf lynkco.ghproxy.conf "gh-proxy 加速" "https://gh-proxy.com/https://raw.githubusercontent.com/Erpang5543/lynkco-sign/$HASH"
echo "done: $HASH"
