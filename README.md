# 🗼 東京旅伴 Tokyo Trip Agent

家族東京自由行的 **AI 群聊助理**，一站式部署在 Cloudflare。

四個人用同一組密碼登入同一個聊天室，任何人發問，AI 的回答會**即時逐字出現在每個人的手機上**。
交通、景點、購物比價、美食、匯率、天氣、迪士尼排隊、記帳分帳、照片翻譯……都能問，而且**會記得**大家聊過的事與修改過的行程。

## 功能

| | |
| --- | --- |
| 💬 即時群聊 | 多人同時在線，AI 回答串流給所有人；斷線自動重連、補回訊息 |
| 🧠 長期記憶 | 所有聊天永久保存；AI 會主動記住偏好／決定／預訂，每 10 則訊息自動整理重點與摘要；可翻舊聊天紀錄 |
| 📅 行程 | 內建最新行程，聊天說「10/8 改去淺草」就會更新；也可在面板直接編輯 |
| 📷 拍照 | 拍菜單、商品、看板 → 辨識、翻譯、比價、免稅試算 |
| 📍 定位 | 按 📍 附上目前位置，或在設定開啟「自動分享位置」，問「附近」「怎麼回住宿」更準 |
| 💰 記帳分帳 | 「晚餐 8400 日圓我付的」自動記帳，算出每人應付與最少轉帳的結算方式 |
| 🔍 網路搜尋 | Tavily 搜尋＋讀網頁，附來源連結 |
| 💱 匯率 | 即時日圓↔台幣 |
| 🌤 天氣 | Open-Meteo 14 天預報 |
| 🏰 迪士尼 | 樂園／海洋即時排隊時間（Queue-Times） |
| 🗺 附近 | 餐廳、便利商店、藥妝、廁所、ATM、置物櫃…（OpenStreetMap） |
| 🚃 路線 | 產生 Google Maps 導航連結 |
| 🧾 免稅 | 是否達 ¥5,000 門檻、可省多少 |
| 🤖 雙模型 | Gemini（預設 `gemini-3.5-flash-lite`）⇄ Cloudflare Workers AI，出錯自動切換 |
| ⚙️ 管理員 | 切換模型、設定「每則都回／只回 @AI」、旅伴名單、清除聊天 |

## 架構

```
手機瀏覽器（PWA，可加到主畫面）
   │ WebSocket
   ▼
Cloudflare Worker ── 靜態網頁、登入（HMAC 簽章 Cookie）、照片上傳
   │
   ▼
Durable Object「TripRoom」（SQLite）
   ├─ 群聊廣播（Hibernation WebSocket）
   ├─ 資料：聊天、照片、行程、記憶、帳目、位置
   └─ Agent：Gemini / Workers AI + 16 個工具
```

全部使用免費額度：Workers、Durable Objects（SQLite）、Workers AI 每日免費額度、Gemini 免費層、Tavily 每月 1,000 次。

## 部署（第一次約 5 分鐘）

需要：Node.js 20 以上、Cloudflare 帳號（免費）、Gemini 與 Tavily API key。

```bash
git clone https://github.com/<你的帳號>/Tokyo-Trip-Agent.git
cd Tokyo-Trip-Agent
npm install
npm run setup
```

`setup` 會：登入 Cloudflare → 部署 → 依序詢問四個密碼／金鑰：

| 名稱 | 說明 |
| --- | --- |
| `ROOM_PASSWORD` | 家人共用的房間密碼 |
| `ADMIN_PASSWORD` | 管理員密碼（用它登入就是管理員） |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `TAVILY_API_KEY` | https://app.tavily.com |

完成後打開 `https://tokyo-trip-agent.<你的子網域>.workers.dev`，把網址和房間密碼傳給家人就好。

> 金鑰只存在 Cloudflare 的 Secrets，不會出現在程式碼或 git 裡。之後要改：`npx wrangler secret put 名稱`。

### 更新程式

```bash
git pull
npm run deploy
```

資料（聊天、記憶、帳目）存在 Durable Object，重新部署不會消失。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # 填入密碼與金鑰
npm run dev                      # http://localhost:8787
```

Workers AI 在本機需要 `npx wrangler login` 才能使用；Gemini 在本機可直接用。

## 修改旅程資料

初始行程、住宿、航班在 `src/trip-data.ts`。第一次啟動時寫入資料庫，之後以資料庫為準（在聊天或行程面板修改）。
門鎖密碼、Wi-Fi 密碼等敏感資訊請不要寫進程式碼，直接在聊天說「記住門鎖密碼是 xxxx」。

## 專案結構

```
src/
  index.ts       路由、登入、轉交 Durable Object
  auth.ts        簽章 Cookie
  room.ts        TripRoom：群聊、資料庫、Agent 迴圈、長期記憶
  providers.ts   Gemini（串流＋工具呼叫）與 Workers AI 轉接
  tools.ts       16 個工具
  trip-data.ts   住宿、航班、初始行程
public/          前端（原生 JS、無需建置）
scripts/setup.sh 一鍵部署
```
