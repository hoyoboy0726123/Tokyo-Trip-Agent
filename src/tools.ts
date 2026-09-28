import { sign } from "./auth";
import type { Env, ToolDecl } from "./types";
import { TRIP } from "./trip-data";

/** 工具可以用到的聊天室功能（由 TripRoom 實作） */
export interface RoomApi {
  members(): string[];
  memberLocation(name?: string): { name: string; lat: number; lon: number; accuracy: number | null; ts: number; area: string | null }[];
  addMemory(content: string, category: string, author: string): number;
  deleteMemory(id: number): boolean;
  searchHistory(keyword: string, limit: number): { ts: number; author: string; text: string }[];
  updateItinerary(date: string, fields: { title?: string; detail?: string; status?: string }, author: string): unknown;
  addExpense(e: ExpenseInput): unknown;
  deleteExpense(id: number): boolean;
  expenseSummary(): unknown;
  cacheGet(key: string, maxAgeMs: number): string | null;
  cacheSet(key: string, value: string): void;
}

export interface ExpenseInput {
  description: string;
  amount: number;
  currency: string;
  amountJpy: number;
  amountTwd: number;
  payer: string;
  splitAmong: string[];
  category: string;
  date: string;
  author: string;
}

export interface AttachedImage {
  src: string; // 經過本站轉送的網址
  caption: string;
  label?: string; // 這張圖是哪個地點（搜尋關鍵字）
  source: string; // 圖片所在網站
  page?: string; // 來源網頁
}

export interface ToolContext {
  env: Env;
  room: RoomApi;
  author: string;
  /** 工具找到的圖片，會附在這次 AI 回答下方 */
  attachImage?: (img: AttachedImage) => void;
}

type Executor = (args: any, ctx: ToolContext) => Promise<unknown>;

interface Tool {
  decl: ToolDecl;
  label: string;
  run: Executor;
}

const UA = "TokyoTripAgent/1.0 (family travel assistant)";

async function getJSON(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
  return res.json();
}

function jstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function normalizeDate(input: string): string | null {
  const s = String(input ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (m) return `${TRIP.startDate.slice(0, 4)}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (s.includes("今天")) return jstDate();
  if (s.includes("明天")) return jstDate(1);
  if (s.includes("後天")) return jstDate(2);
  return null;
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function mapsLink(q: string | { lat: number; lon: number }): string {
  const query = typeof q === "string" ? q : `${q.lat},${q.lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// ---------------- 匯率 ----------------

// 連不到匯率服務時的備用估計值（只用在記帳，會標示為估計）
const FALLBACK_TO_JPY: Record<string, number> = { JPY: 1, TWD: 4.7, USD: 150 };

export async function fxRate(ctx: ToolContext, from: string, to: string): Promise<{ rate: number; updated: string; estimated?: boolean }> {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) return { rate: 1, updated: "" };
  const key = `fx:${f}`;
  let data: any;
  const cached = ctx.room.cacheGet(key, 3600_000);
  if (cached) data = JSON.parse(cached);
  else {
    try {
      data = await getJSON(`https://open.er-api.com/v6/latest/${f}`);
      if (data.result !== "success") throw new Error("匯率服務暫時無法使用");
      ctx.room.cacheSet(key, JSON.stringify({ rates: data.rates, time_last_update_utc: data.time_last_update_utc }));
    } catch (e) {
      // 用最後一次成功的匯率（最多 7 天）
      const stale = ctx.room.cacheGet(key, 7 * 86400_000);
      if (stale) data = { ...JSON.parse(stale), stale: true };
      else throw e;
    }
  }
  const rate = data.rates?.[t];
  if (!rate) throw new Error(`不支援的幣別 ${t}`);
  return { rate, updated: data.time_last_update_utc ?? "", estimated: !!data.stale };
}

/** 記帳用：一定要拿到匯率，連不到就用估計值 */
async function fxForLedger(ctx: ToolContext, from: string, to: string): Promise<{ rate: number; estimated: boolean }> {
  try {
    const r = await fxRate(ctx, from, to);
    return { rate: r.rate, estimated: !!r.estimated };
  } catch {
    const a = FALLBACK_TO_JPY[from.toUpperCase()], b = FALLBACK_TO_JPY[to.toUpperCase()];
    if (!a || !b) throw new Error(`不支援的幣別 ${from}`);
    return { rate: a / b, estimated: true };
  }
}

// ---------------- 天氣代碼 ----------------

const WEATHER: Record<number, string> = {
  0: "晴天 ☀️", 1: "大致晴朗 🌤", 2: "晴時多雲 ⛅", 3: "陰天 ☁️", 45: "有霧 🌫", 48: "霧淞 🌫",
  51: "毛毛雨 🌦", 53: "毛毛雨 🌦", 55: "較強毛毛雨 🌧", 61: "小雨 🌧", 63: "中雨 🌧", 65: "大雨 🌧",
  66: "凍雨", 67: "凍雨", 71: "小雪 🌨", 73: "中雪 🌨", 75: "大雪 ❄️", 80: "陣雨 🌦", 81: "較強陣雨 🌧",
  82: "豪大陣雨 ⛈", 95: "雷雨 ⛈", 96: "雷雨伴冰雹 ⛈", 99: "強雷雨伴冰雹 ⛈",
};

async function geocode(place: string): Promise<{ name: string; lat: number; lon: number } | null> {
  const data = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=ja&countryCode=JP`);
  const r = data.results?.[0];
  return r ? { name: r.name, lat: r.latitude, lon: r.longitude } : null;
}

const COORD_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
// 繁體字地名換成日文漢字，日本地圖資料才查得到（例如 龜有→亀有、舞濱→舞浜）
const JA_KANJI: Record<string, string> = { 龜: "亀", 濱: "浜", 澤: "沢", 櫻: "桜", 驛: "駅", 樂: "楽", 國: "国", 廣: "広", 淺: "浅", 邊: "辺", 黑: "黒", 圓: "円", 學: "学", 藝: "芸", 橫: "横", 關: "関", 鹽: "塩", 戶: "戸" };

/** 地名或座標 → 位置。座標直接用；地名先查 OpenStreetMap（車站、公園、店名較準），再退回 Open-Meteo */
async function locate(place: string): Promise<{ name: string; lat: number; lon: number } | null> {
  const m = place.match(COORD_RE);
  if (m) return { name: `${m[1]},${m[2]}`, lat: Number(m[1]), lon: Number(m[2]) };
  const ja = [...place].map((c) => JA_KANJI[c] ?? c).join("");
  for (const q of [...new Set([ja, place])]) {
    try {
      const r = (await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`))[0];
      if (r) return { name: r.name || q, lat: Number(r.lat), lon: Number(r.lon) };
    } catch {}
  }
  try {
    return await geocode(ja);
  } catch {
    return null;
  }
}

/** 座標 → 人看得懂的地名（例如「新北市板橋區館前西路」），給 AI 用，避免它自己猜 */
export async function reverseArea(lat: number, lon: number): Promise<string> {
  const g = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=zh-TW,ja&zoom=17`, undefined, 8_000);
  const a = g.address ?? {};
  const parts = [a.state, a.city || a.county, a.town || a.city_district || a.suburb, a.quarter || a.neighbourhood, a.road].filter(Boolean);
  return [...new Set(parts)].join("") || g.display_name || "";
}

const IMG_UA = "Mozilla/5.0 (compatible; TokyoTripAgent/1.0)";
const IMG_MAX_BYTES = 1_500_000;

/** 圖片能不能顯示：200、真的是圖片、不要太大（手機流量） */
async function imageUsable(url: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//.test(url)) return false;
    const res = await fetch(url, { headers: { "user-agent": IMG_UA, accept: "image/*" }, signal: AbortSignal.timeout(4_000) });
    const type = res.headers.get("content-type") ?? "";
    const size = Number(res.headers.get("content-length") || 0);
    await res.body?.cancel();
    return res.ok && type.startsWith("image/") && (!size || size <= IMG_MAX_BYTES);
  } catch {
    return false;
  }
}

/** 發問者 3 小時內分享過的位置（沒有就用其他成員的） */
function recentLocation(room: RoomApi, author: string) {
  const fresh = (l?: { ts: number }) => !!l && Date.now() - l.ts < 3 * 3600_000;
  const mine = room.memberLocation(author)[0];
  if (fresh(mine)) return mine;
  const other = room.memberLocation()[0];
  return fresh(other) ? other : null;
}

/**
 * Overpass 同時問兩台，用先回來的。實測從 Cloudflare 連：法國鏡像站 2–5 秒，
 * 主站常 504（太忙），逐台輪流等會等太久。quick = 附加資訊用（例如最近車站），等比較短
 */
async function overpass(query: string, quick = false): Promise<any> {
  const body = "data=" + encodeURIComponent(query);
  const timeout = quick ? 10_000 : 15_000;
  const servers = ["https://overpass.openstreetmap.fr/api/interpreter", "https://overpass-api.de/api/interpreter"];
  try {
    return await Promise.any(
      servers.map(async (url) => {
        const d = await getJSON(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, timeout);
        if (!Array.isArray(d?.elements)) throw new Error("回應格式不對");
        return d;
      }),
    );
  } catch {
    throw new Error("地圖資料服務忙碌中");
  }
}

// Overpass 都失敗時改用 Photon（另一個 OpenStreetMap 搜尋服務）找附近地點
const PHOTON: Record<string, { q: string; tags: string[] }> = {
  food: { q: "restaurant", tags: ["amenity:restaurant", "amenity:fast_food"] },
  cafe: { q: "cafe", tags: ["amenity:cafe"] },
  convenience: { q: "convenience", tags: ["shop:convenience"] },
  drugstore: { q: "pharmacy", tags: ["shop:chemist", "amenity:pharmacy"] },
  supermarket: { q: "supermarket", tags: ["shop:supermarket"] },
  toilet: { q: "toilets", tags: ["amenity:toilets"] },
  atm: { q: "atm", tags: ["amenity:atm"] },
  locker: { q: "locker", tags: ["amenity:locker"] },
  station: { q: "station", tags: ["railway:station"] },
  shopping: { q: "shop", tags: ["shop:department_store", "shop:mall", "shop:variety_store"] },
  park: { q: "park", tags: ["leisure:park", "leisure:playground"] },
};

async function photonNearby(category: string, lat: number, lon: number, radius: number, keyword: string): Promise<any[]> {
  const p = PHOTON[category] ?? PHOTON.food;
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", keyword || p.q);
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lon));
  u.searchParams.set("limit", "40");
  for (const t of p.tags) u.searchParams.append("osm_tag", t);
  const d = await getJSON(u.toString(), undefined, 10_000);
  return (d.features ?? [])
    .map((f: any) => ({ lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], tags: { name: f.properties?.name } }))
    .filter((e: any) => Number.isFinite(e.lat) && distanceM(lat, lon, e.lat, e.lon) <= Math.max(radius * 2, 1000));
}

// 料理關鍵字 → OpenStreetMap 的 cuisine 標籤（店名沒寫「ラーメン」的拉麵店也找得到）
const CUISINE: [RegExp, RegExp][] = [
  [/ラーメン|らーめん|拉麵|拉面|ramen/i, /ramen/],
  [/寿司|壽司|すし|鮨|sushi/i, /sushi/],
  [/焼肉|燒肉|烤肉|yakiniku/i, /yakiniku|barbecue/],
  [/うどん|烏龍麵|udon/i, /udon/],
  [/そば|蕎麥|soba/i, /soba/],
  [/カレー|咖哩|curry/i, /curry/],
  [/とんかつ|豬排|tonkatsu/i, /tonkatsu/],
  [/天ぷら|天婦羅|tempura/i, /tempura/],
  [/丼|donburi/i, /donburi|gyudon/],
  [/カフェ|咖啡|cafe|coffee/i, /coffee|cafe/],
  [/ハンバーガー|漢堡|burger/i, /burger/],
  [/ピザ|披薩|pizza/i, /pizza/],
];

// ---------------- 附近地點（OpenStreetMap Overpass） ----------------

const NEARBY: Record<string, string> = {
  food: `nw(around:{r},{lat},{lon})["amenity"~"^(restaurant|fast_food|food_court)$"];`,
  cafe: `nw(around:{r},{lat},{lon})["amenity"="cafe"];`,
  convenience: `nw(around:{r},{lat},{lon})["shop"="convenience"];`,
  drugstore: `nw(around:{r},{lat},{lon})["shop"~"^(chemist|pharmacy)$"];nw(around:{r},{lat},{lon})["amenity"="pharmacy"];`,
  supermarket: `nw(around:{r},{lat},{lon})["shop"="supermarket"];`,
  toilet: `nw(around:{r},{lat},{lon})["amenity"="toilets"];`,
  atm: `nw(around:{r},{lat},{lon})["amenity"="atm"];`,
  locker: `nw(around:{r},{lat},{lon})["amenity"="locker"];`,
  station: `nw(around:{r},{lat},{lon})["railway"="station"];`,
  shopping: `nw(around:{r},{lat},{lon})["shop"~"^(department_store|mall|variety_store|toys|electronics)$"];`,
  park: `nw(around:{r},{lat},{lon})["leisure"~"^(park|playground)$"];`,
};

// ---------------- 工具清單 ----------------

export const TOOLS: Tool[] = [
  {
    label: "🔍 搜尋網路",
    decl: {
      name: "web_search",
      description: "搜尋網路上的最新資訊：景點介紹、營業時間、票價、活動、美食評價、商品價格、交通方式等。回傳摘要與來源網址。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜尋關鍵字，日本當地資訊建議加日文關鍵字" },
          max_results: { type: "integer", description: "結果數量，預設 5，最多 8" },
        },
        required: ["query"],
      },
    },
    async run(args, { env }) {
      if (!env.TAVILY_API_KEY) return { error: "尚未設定 TAVILY_API_KEY，無法搜尋網路" };
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY.trim()}` },
        body: JSON.stringify({ query: args.query, max_results: Math.min(Number(args.max_results) || 5, 8), include_answer: "basic", search_depth: "basic" }),
      });
      if (!res.ok) return { error: `搜尋失敗 ${res.status}` };
      const d: any = await res.json();
      return {
        answer: d.answer,
        results: (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, content: String(r.content ?? "").slice(0, 600) })),
      };
    },
  },
  {
    label: "📄 閱讀網頁",
    decl: {
      name: "read_webpage",
      description: "讀取指定網址的網頁全文（例如搜尋結果中的官方網站），用來確認細節。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(args, { env }) {
      if (!env.TAVILY_API_KEY) return { error: "尚未設定 TAVILY_API_KEY" };
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY.trim()}` },
        body: JSON.stringify({ urls: [args.url] }),
      });
      if (!res.ok) return { error: `讀取失敗 ${res.status}` };
      const d: any = await res.json();
      const r = d.results?.[0];
      return r ? { url: r.url, content: String(r.raw_content ?? "").slice(0, 8000) } : { error: "無法讀取這個網頁" };
    },
  },
  {
    label: "🖼 找圖片",
    decl: {
      name: "find_images",
      description:
        "上網找照片（餐廳外觀、料理、景點、商品），找到的圖片會自動顯示在你的回答下方。只有成員明確要求看照片／圖片時才使用。" +
        "要看好幾個地方（例如剛才推薦的幾家店）就把每個地方放進 queries 一次查完。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "單一搜尋關鍵字：店名或景點名稱加地名，例如「一風堂 池袋 ラーメン」「亀有 両津勘吉 銅像」" },
          queries: { type: "array", items: { type: "string" }, description: "要看好幾個地方時用，每個地方一個關鍵字，最多 4 個，例如 [\"必勝客 板橋\", \"阿勝麻辣雞 板橋\"]" },
          count: { type: "integer", description: "總共要幾張，預設 4，最多 6" },
        },
      },
    },
    async run(args, { env, attachImage }) {
      if (!env.TAVILY_API_KEY) return { error: "尚未設定 TAVILY_API_KEY，無法找圖片" };
      const list: string[] = (Array.isArray(args.queries) && args.queries.length ? args.queries : [args.query])
        .map((q: unknown) => String(q ?? "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (!list.length) return { error: "請提供要找圖片的地點或關鍵字" };
      const total = Math.min(Math.max(Number(args.count) || 4, list.length), 6);
      // 小店的網路照片常常不能用，每個地方多留一張候選
      const perQuery = Math.max(1, Math.ceil(total / list.length));

      // 每個關鍵字各自搜尋、各自檢查圖片能不能顯示（約三成會擋外連、不是圖片或太大）
      const groups = await Promise.all(
        list.map(async (query) => {
          try {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY!.trim()}` },
              body: JSON.stringify({ query, max_results: 5, include_images: true, include_image_descriptions: true, search_depth: "basic" }),
              signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) return { query, picked: [] as { url: string; description: string; page?: string }[] };
            const d: any = await res.json();
            const seen = new Set<string>();
            const candidates: { url: string; description: string; page?: string }[] = [];
            const add = (img: any, page?: string) => {
              const url = typeof img === "string" ? img : img?.url;
              if (!url || seen.has(url)) return;
              seen.add(url);
              candidates.push({ url, description: typeof img === "string" ? "" : String(img.description ?? ""), page });
            };
            for (const img of d.images ?? []) add(img);
            for (const r of d.results ?? []) for (const img of r.images ?? []) add(img, r.url);
            const checked = await Promise.all(candidates.slice(0, 8).map(async (c) => ((await imageUsable(c.url)) ? c : null)));
            return { query, picked: checked.filter((c): c is NonNullable<typeof c> => !!c).slice(0, perQuery) };
          } catch {
            return { query, picked: [] as { url: string; description: string; page?: string }[] };
          }
        }),
      );

      const results: { query: string; found: number; descriptions: string[] }[] = [];
      for (const g of groups) {
        for (const p of g.picked) {
          attachImage?.({
            src: `/api/img?u=${encodeURIComponent(p.url)}&s=${await sign(env, "img:" + p.url)}`,
            caption: p.description.slice(0, 120),
            label: g.query,
            source: new URL(p.url).host,
            page: p.page,
          });
        }
        results.push({ query: g.query, found: g.picked.length, descriptions: g.picked.map((p) => p.description.slice(0, 100)) });
      }
      const found = results.reduce((s, r) => s + r.found, 0);
      if (!found) return { found: 0, note: "找不到可以顯示的圖片，可以換個關鍵字（日文或英文）再試" };
      return {
        found,
        results,
        note: "圖片已自動顯示在回答下方（每張都標了地點名稱）。文字裡不要貼圖片網址或任何搜尋連結；簡單說明找到哪些地方的圖，並提醒是網路圖片、不一定是同一家分店，僅供參考",
      };
    },
  },
  {
    label: "💱 匯率換算",
    decl: {
      name: "convert_currency",
      description: "即時匯率換算，例如日圓換台幣。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from: { type: "string", description: "來源幣別代碼，例如 JPY" },
          to: { type: "string", description: "目標幣別代碼，例如 TWD" },
        },
        required: ["amount", "from", "to"],
      },
    },
    async run(args, ctx) {
      const { rate, updated } = await fxRate(ctx, args.from, args.to);
      const amount = Number(args.amount);
      return { amount, from: args.from, to: args.to, rate, result: Math.round(amount * rate * 100) / 100, updated, source: "ExchangeRate-API (open.er-api.com)" };
    },
  },
  {
    label: "🌤 查天氣",
    decl: {
      name: "get_weather",
      description: "查詢天氣預報（未來最多 14 天）與目前天氣。沒給地點就查住宿附近（池袋・要町）。",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "地名，例如 舞浜、龜有、川崎。可留空" },
          days: { type: "integer", description: "預報天數，預設 7" },
        },
      },
    },
    async run(args) {
      let loc = { name: "要町（住宿）", lat: TRIP.accommodation.lat, lon: TRIP.accommodation.lon };
      if (args.place) {
        const g = await locate(String(args.place));
        if (g) loc = g;
      }
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 14);
      const d = await getJSON(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=Asia%2FTokyo&forecast_days=${days}` +
          `&current=temperature_2m,apparent_temperature,weather_code,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max`,
      );
      return {
        place: loc.name,
        now: d.current && { temp: d.current.temperature_2m, feels: d.current.apparent_temperature, weather: WEATHER[d.current.weather_code] ?? d.current.weather_code },
        daily: (d.daily?.time ?? []).map((date: string, i: number) => ({
          date,
          weather: WEATHER[d.daily.weather_code[i]] ?? d.daily.weather_code[i],
          max: d.daily.temperature_2m_max[i],
          min: d.daily.temperature_2m_min[i],
          rain_chance: d.daily.precipitation_probability_max[i],
          uv: d.daily.uv_index_max[i],
        })),
        source: "Open-Meteo",
      };
    },
  },
  {
    label: "🏰 迪士尼排隊",
    decl: {
      name: "disney_wait_times",
      description: "查詢東京迪士尼樂園或迪士尼海洋各設施的即時等待時間與是否營運。",
      parameters: {
        type: "object",
        properties: { park: { type: "string", enum: ["land", "sea"], description: "land=迪士尼樂園, sea=迪士尼海洋" } },
        required: ["park"],
      },
    },
    async run(args) {
      const id = args.park === "sea" ? 275 : 274;
      const d = await getJSON(`https://queue-times.com/parks/${id}/queue_times.json`);
      const rides = [...(d.lands ?? []).flatMap((l: any) => l.rides.map((r: any) => ({ ...r, area: l.name }))), ...(d.rides ?? [])];
      const open = rides.filter((r) => r.is_open).sort((a, b) => b.wait_time - a.wait_time);
      return {
        park: args.park === "sea" ? "東京迪士尼海洋" : "東京迪士尼樂園",
        open_count: open.length,
        closed: rides.filter((r) => !r.is_open).map((r) => r.name).slice(0, 30),
        rides: open.map((r) => ({ name: r.name, area: r.area, wait_min: r.wait_time })),
        updated: rides[0]?.last_updated,
        source: "Powered by Queue-Times.com",
      };
    },
  },
  {
    label: "📍 成員位置",
    decl: {
      name: "get_member_locations",
      description: "取得成員最近分享的 GPS 位置：所在區域、地址、最近的車站與距離。回答「我在哪」或要知道某位成員在哪時使用。",
      parameters: { type: "object", properties: { name: { type: "string", description: "成員名稱，留空=全部" } } },
    },
    async run(args, { room }) {
      const locs = room.memberLocation(args.name);
      if (!locs.length) return { error: "還沒有人分享位置。請按輸入框旁的 📍 分享位置。" };
      const out = [];
      for (const l of locs.slice(0, 4)) {
        let area = l.area ?? "";
        if (!area) {
          try {
            area = await reverseArea(l.lat, l.lon);
          } catch {}
        }
        let nearestStation: { name: string; distance_m: number; walk_min: number } | null = null;
        try {
          // 只查車站的點（node），比 nwr 快很多
          const d = await overpass(`[out:json][timeout:10];node(around:1200,${l.lat},${l.lon})["railway"="station"];out 20;`, true);
          const s = (d.elements ?? [])
            .map((e: any) => ({ name: e.tags?.name, distance_m: distanceM(l.lat, l.lon, e.lat ?? e.center?.lat, e.lon ?? e.center?.lon) }))
            .filter((x: any) => x.name)
            .sort((a: any, b: any) => a.distance_m - b.distance_m)[0];
          if (s) nearestStation = { ...s, walk_min: Math.max(1, Math.round(s.distance_m / 80)) };
        } catch {}
        out.push({
          name: l.name, lat: l.lat, lon: l.lon, accuracy_m: l.accuracy,
          minutes_ago: Math.round((Date.now() - l.ts) / 60000),
          area, nearest_station: nearestStation, map: mapsLink(l),
        });
      }
      return out;
    },
  },
  {
    label: "🗺 找附近",
    decl: {
      name: "find_nearby",
      description: "找實際距離最近的地點（餐廳、咖啡、便利商店、藥妝、超市、廁所、ATM、置物櫃、車站、購物、公園），依距離排序並附步行分鐘。問「我附近」時 near 一定留空，系統會自動用發問者的 GPS 位置。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: Object.keys(NEARBY) },
          keyword: { type: "string", description: "店名或料理類型，例如 ラーメン、寿司、焼肉、ユニクロ" },
          near: { type: "string", description: "只有要查「別的地方」附近才填，用日文地名，例如 亀有公園、浅草寺、舞浜駅。問「我附近」請留空" },
          radius_m: { type: "integer", description: "搜尋半徑公尺，預設 600，最大 2000" },
        },
        required: ["category"],
      },
    },
    async run(args, { room, author }) {
      const mine = recentLocation(room, author);
      let center: { lat: number; lon: number; label: string } | null = null;
      let note = "";
      // AI 常把發問者自己的地名填進 near，這時直接用 GPS 比較準
      const near = String(args.near ?? "").trim();
      const isMyArea = !!near && !!mine?.area && (mine.area.includes(near) || near.includes(mine.area));
      if (near && !isMyArea) {
        const g = await locate(near);
        if (g) center = { lat: g.lat, lon: g.lon, label: COORD_RE.test(String(args.near)) ? "指定座標" : g.name };
        else note = `找不到「${args.near}」這個地點，改用${mine ? "發問者目前位置" : "住宿"}為中心`;
      }
      if (!center && mine) {
        const where = mine.area ? `：${mine.area}` : "";
        center = { lat: mine.lat, lon: mine.lon, label: `${mine.name} 的 GPS 位置${where}（${Math.round((Date.now() - mine.ts) / 60000)} 分鐘前）` };
      }
      if (!center) {
        center = { lat: TRIP.accommodation.lat, lon: TRIP.accommodation.lon, label: "住宿（要町）" };
        note ||= "沒有成員分享位置，先以住宿為中心；要找自己附近請先按 📍 分享位置";
      }
      const r = Math.min(Math.max(Number(args.radius_m) || 600, 100), 2000);
      const q = (NEARBY[args.category] ?? NEARBY.food).replaceAll("{r}", String(r)).replaceAll("{lat}", String(center.lat)).replaceAll("{lon}", String(center.lon));
      const kwRaw = String(args.keyword ?? "").trim();
      let elements: any[];
      let source = "© OpenStreetMap contributors";
      try {
        elements = (await overpass(`[out:json][timeout:15];(${q});out center 150;`)).elements ?? [];
      } catch {
        elements = await photonNearby(args.category, center.lat, center.lon, r, kwRaw);
        source += "（Photon）";
      }
      const all = elements
        .map((e: any) => {
          const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
          const t = e.tags ?? {};
          const distance = distanceM(center.lat, center.lon, lat, lon);
          return {
            name: t["name:zh"] || t.name || t["name:en"] || "(無名稱)",
            name_ja: t.name,
            cuisine: t.cuisine,
            opening_hours: t.opening_hours,
            distance_m: distance,
            walk_min: Math.max(1, Math.round(distance / 80)),
            map: mapsLink(t.name ? `${t.name} ${lat},${lon}` : { lat, lon }),
          };
        })
        .sort((a: any, b: any) => a.distance_m - b.distance_m);
      const kw = kwRaw;
      const cuisine = CUISINE.find(([re]) => re.test(kw))?.[1];
      let places = kw
        ? all.filter((p: any) => `${p.name} ${p.name_ja ?? ""}`.toLowerCase().includes(kw.toLowerCase()) || (cuisine && cuisine.test(p.cuisine ?? "")))
        : all;
      if (kw && !places.length) {
        note = [note, `半徑 ${r} 公尺內沒有符合「${kw}」的店家資料，以下是附近所有結果；可加大 radius_m 再找，或用 web_search 補充`].filter(Boolean).join("；");
        places = all;
      }
      return {
        center: center.label,
        center_coords: `${center.lat.toFixed(5)},${center.lon.toFixed(5)}`,
        radius_m: r,
        note: note || undefined,
        places: places.slice(0, 12),
        source,
        tip: "結果依實際距離排序；評價與排隊狀況可再用 web_search 查 Tabelog / Google",
      };
    },
  },
  {
    label: "🚃 規劃路線",
    decl: {
      name: "plan_route",
      description: "產生 Google Maps 導航連結（大眾運輸/步行/開車）。詳細轉乘與票價請搭配 web_search 查詢。起點留空=發問者目前位置或住宿。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string" },
          destination: { type: "string" },
          mode: { type: "string", enum: ["transit", "walking", "driving"] },
        },
        required: ["destination"],
      },
    },
    async run(args, { room, author }) {
      let origin = args.origin as string | undefined;
      if (!origin) {
        const mine = room.memberLocation(author)[0];
        origin = mine && Date.now() - mine.ts < 3 * 3600_000 ? `${mine.lat},${mine.lon}` : TRIP.accommodation.address;
      }
      const mode = args.mode || "transit";
      const u = new URL("https://www.google.com/maps/dir/");
      u.searchParams.set("api", "1");
      u.searchParams.set("origin", origin);
      u.searchParams.set("destination", args.destination);
      u.searchParams.set("travelmode", mode);
      return { origin, destination: args.destination, mode, google_maps: u.toString() };
    },
  },
  {
    label: "🧾 免稅試算",
    decl: {
      name: "tax_free_check",
      description: "日本購物免稅試算：判斷是否達免稅門檻（同一天同一店家，一般品或消耗品各滿 ¥5,000 未稅）並計算可省多少。",
      parameters: {
        type: "object",
        properties: {
          amount_jpy: { type: "number", description: "商品價格（日圓）" },
          includes_tax: { type: "boolean", description: "價格是否已含稅，預設 true" },
          kind: { type: "string", enum: ["general", "consumable"], description: "general=一般品（電器、衣服），consumable=消耗品（藥妝、食品）" },
          food: { type: "boolean", description: "是否為食品飲料（稅率 8%）" },
        },
        required: ["amount_jpy"],
      },
    },
    async run(args, ctx) {
      const rate = args.food ? 0.08 : 0.1;
      const incl = args.includes_tax !== false;
      const amt = Number(args.amount_jpy);
      const pre = incl ? Math.round(amt / (1 + rate)) : amt;
      const tax = Math.round(pre * rate);
      const eligible = pre >= 5000 && (args.kind !== "consumable" || pre <= 500000);
      let twd: number | undefined;
      try {
        twd = Math.round(tax * (await fxRate(ctx, "JPY", "TWD")).rate);
      } catch {}
      return {
        price_before_tax: pre,
        tax,
        eligible,
        save_jpy: eligible ? tax : 0,
        save_twd: eligible ? twd : 0,
        need_more_jpy: eligible ? 0 : Math.max(0, Math.ceil(5000 * (1 + rate)) - (incl ? amt : Math.round(amt * (1 + rate)))),
        notes: "需出示護照；消耗品會密封包裝，出境前不可拆封。同一天同一店家的金額可合併計算。",
      };
    },
  },
  {
    label: "💰 記帳",
    decl: {
      name: "add_expense",
      description: "記一筆旅費並分帳。例如「晚餐 8400 日圓我付的」。payer 預設為發問者，split_among 預設為全部旅伴（見系統提示的旅伴名單），只有特定人分攤時才填。",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", description: "JPY 或 TWD，預設 JPY" },
          payer: { type: "string" },
          split_among: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: ["餐飲", "交通", "門票", "購物", "住宿", "其他"] },
          date: { type: "string", description: "日期，預設今天（東京時間）" },
        },
        required: ["description", "amount"],
      },
    },
    async run(args, ctx) {
      const currency = String(args.currency || "JPY").toUpperCase();
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { error: "金額不正確" };
      const toJpy = currency === "JPY" ? { rate: 1, estimated: false } : await fxForLedger(ctx, currency, "JPY");
      const jpy = Math.round(amount * toJpy.rate);
      const toTwd = await fxForLedger(ctx, "JPY", "TWD");
      const twd = Math.round(jpy * toTwd.rate);
      const members = ctx.room.members();
      const split = Array.isArray(args.split_among) && args.split_among.length ? args.split_among : members.length ? members : [ctx.author];
      const saved = ctx.room.addExpense({
        description: args.description,
        amount,
        currency,
        amountJpy: jpy,
        amountTwd: twd,
        payer: args.payer || ctx.author,
        splitAmong: split,
        category: args.category || "其他",
        date: normalizeDate(args.date) ?? jstDate(),
        author: ctx.author,
      });
      return { saved, rate_estimated: toJpy.estimated || toTwd.estimated };
    },
  },
  {
    label: "📊 帳目統計",
    decl: {
      name: "expense_summary",
      description: "旅費統計：總花費、每人付了多少、每人應付多少、誰該給誰多少錢（結算）、分類與每日花費。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { room }) {
      return room.expenseSummary();
    },
  },
  {
    label: "🗑 刪除帳目",
    decl: {
      name: "delete_expense",
      description: "刪除記錯的一筆帳（用 expense_summary 裡的 id）。",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    },
    async run(args, { room }) {
      return { deleted: room.deleteExpense(Number(args.id)) };
    },
  },
  {
    label: "🧠 記住",
    decl: {
      name: "remember",
      description: "把重要資訊存入長期記憶：成員偏好（不吃辣、想買什麼）、決定、訂位與票券、密碼、集合地點、待辦等。成員說「記住…」或做出決定時使用。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要記住的內容，寫成完整一句話" },
          category: { type: "string", enum: ["偏好", "決定", "預訂", "資訊", "待辦"] },
        },
        required: ["content"],
      },
    },
    async run(args, { room, author }) {
      return { saved_id: room.addMemory(args.content, args.category || "資訊", author) };
    },
  },
  {
    label: "🧠 刪除記憶",
    decl: {
      name: "forget",
      description: "刪除一條過時或錯誤的長期記憶（id 見系統提示中的記憶清單）。",
      parameters: { type: "object", properties: { memory_id: { type: "integer" } }, required: ["memory_id"] },
    },
    async run(args, { room }) {
      return { deleted: room.deleteMemory(Number(args.memory_id)) };
    },
  },
  {
    label: "🔎 翻聊天紀錄",
    decl: {
      name: "search_history",
      description: "搜尋以前的聊天紀錄（例如「上次說的那家拉麵店叫什麼」）。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string" }, limit: { type: "integer" } },
        required: ["keyword"],
      },
    },
    async run(args, { room }) {
      return room.searchHistory(args.keyword, Math.min(Number(args.limit) || 10, 30));
    },
  },
  {
    label: "📅 修改行程",
    decl: {
      name: "update_itinerary",
      description: "修改某一天的行程（標題、細節、狀態）。成員決定改行程、買好票、預約完成時使用。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期，例如 2026-10-09 或 10/9" },
          title: { type: "string" },
          detail: { type: "string" },
          status: { type: "string", description: "例如 ✅ 已購票、⚠️ 尚未購票、彈性" },
        },
        required: ["date"],
      },
    },
    async run(args, { room, author }) {
      const date = normalizeDate(args.date);
      if (!date) return { error: "看不懂日期，請用 10/9 或 2026-10-09" };
      return room.updateItinerary(date, { title: args.title, detail: args.detail, status: args.status }, author);
    },
  },
];

export const TOOL_DECLS = TOOLS.map((t) => t.decl);

export function toolLabel(name: string): string {
  return TOOLS.find((t) => t.decl.name === name)?.label ?? name;
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS.find((t) => t.decl.name === name);
  if (!tool) return { error: `沒有這個工具：${name}` };
  const t0 = Date.now();
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (e: any) {
    console.error(`tool ${name} failed`, JSON.stringify(args), e?.message ?? e);
    return { error: String(e?.message ?? e) };
  } finally {
    // 慢的工具記下來，之後才知道要優化哪裡
    const ms = Date.now() - t0;
    if (ms > 5_000) console.log(`tool ${name} slow ${ms}ms`);
  }
}
