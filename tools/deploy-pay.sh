#!/bin/bash
# 一键部署虚拟支付云函数
# 用法：tools/deploy-pay.sh <云开发环境ID>
# 例：  tools/deploy-pay.sh cloud1-xxxxxxxx
#
# ⚠️ 2026-11-09 踩坑：微信云环境不方便配云函数环境变量，createOrder / queryOrder
#    的 OFFER_ID / APP_KEY / APPSECRET 是通过部署包里的 secrets.js 注入的。
#    **全量重新部署会把 secrets.js 覆盖掉，支付立刻报“缺 OFFER_ID/APP_KEY”。**
#    所以本脚本只自动部署不需要密钥的 4 个函数；createOrder / queryOrder 只有在
#    secrets.js 存在时才单独部署。
set -euo pipefail

ENV_ID="${1:-}"
if [ -z "$ENV_ID" ]; then
  echo "用法: $0 <云开发环境ID>"
  echo "环境 ID 在 微信开发者工具 → 云开发 → 设置 → 环境 ID"
  exit 1
fi

CLI="${WECHAT_CLI:-/Applications/wechatwebdevtools.app/Contents/MacOS/cli}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"

echo "环境: $ENV_ID"
echo "项目: $PROJECT"

echo ""
echo "部署（无密钥函数）: login onDelivered getEntitlement consume"
"$CLI" cloud functions deploy \
  --env "$ENV_ID" \
  --names login onDelivered getEntitlement consume \
  --project "$PROJECT" \
  --remote-npm-install

SECRET_FUNCS_OK=1
for f in createOrder queryOrder; do
  [ -f "$PROJECT/cloudfunctions/$f/secrets.js" ] || SECRET_FUNCS_OK=0
done

if [ "$SECRET_FUNCS_OK" = "1" ]; then
  echo ""
  echo "部署（含 secrets.js）: createOrder queryOrder"
  "$CLI" cloud functions deploy \
    --env "$ENV_ID" \
    --names createOrder queryOrder \
    --project "$PROJECT" \
    --remote-npm-install
else
  echo ""
  echo "⚠️ 没找到 cloudfunctions/createOrder/secrets.js 或 queryOrder/secrets.js，跳过这两个函数。"
  echo "   跳过是对的：没有 secrets.js 部署上去，支付会报“缺 OFFER_ID/APP_KEY”。"
fi

echo ""
echo "✅ 完成。剩余检查："
echo "   1) 云开发 → 设置 → 其他设置 → 消息推送 → 云函数 → xpay_goods_deliver_notify → onDelivered"
echo "   2) MP 后台 → 虚拟支付 → 道具管理 → 发布 pkg_60（60 分钟 ¥1）、pkg_month（包月 ¥9.9）"
echo "   3) 真实收款前把 miniprogram/config.js 的 PAY_OFFLINE_FREE 改为 false"
echo "   4) 以后不要把 createOrder/queryOrder 放进全量部署，除非 secrets.js 在包里"
