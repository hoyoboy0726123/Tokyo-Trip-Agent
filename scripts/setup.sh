#!/bin/bash
# 一鍵部署：登入 Cloudflare → 設定密碼與 API 金鑰 → 部署
set -e
cd "$(dirname "$0")/.."

echo "🗼 東京旅伴 部署精靈"
echo

if [ ! -d node_modules ]; then
  echo "▶︎ 安裝套件…"
  npm install
fi

echo "▶︎ 登入 Cloudflare（會打開瀏覽器）"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

ask_secret() {
  local name="$1" prompt="$2" value=""
  read -r -s -p "$prompt：" value
  echo
  if [ -n "$value" ]; then
    printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
    echo "   ✅ $name 已設定"
  else
    echo "   ⏭  略過 $name"
  fi
}

echo
echo "▶︎ 第一次部署（建立 Worker）"
npx wrangler deploy

echo
echo "▶︎ 設定密碼與金鑰（輸入時不會顯示；直接按 Enter 可略過、保留原本的值）"
ask_secret ROOM_PASSWORD "家人共用的房間密碼"
ask_secret ADMIN_PASSWORD "管理員密碼（只有你知道）"
ask_secret GEMINI_API_KEY "Gemini API key（Google AI Studio）"
ask_secret TAVILY_API_KEY "Tavily API key（網路搜尋）"

echo
echo "🎉 完成！打開上面 deploy 顯示的 https://tokyo-trip-agent.<你的子網域>.workers.dev"
