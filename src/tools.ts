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
  checklistAdd(list: string, items: string[], forWhom: string, author: string): unknown;
  checklistUpdate(match: { id?: number; keyword?: string; list?: string }, patch: { done?: boolean; remove?: boolean }, by: string): unknown;
  checklistGet(list?: string): unknown;
  reminderAdd(due: number, message: string, author: string): unknown;
  reminderList(): unknown;
  reminderDelete(id: number): boolean;
  reminderGet(id: number): { id: number; time: string; message: string } | null;
  itineraryDay(date: string): { title: string; detail: string; status: string } | null;
  expenseGet(id: number): ExpenseBrief | null;
  /** 品項關鍵字找帳（空字串＝最近的幾筆） */
  expenseFind(keyword: string): ExpenseBrief[];
  documentSave(title: string, note: string, photoId: string, author: string, folder?: number | null): unknown;
  documentFind(keyword?: string): { id: number; title: string; note: string; photo_id: string; author: string; ts: number; folder: string }[];
  /** 翻聊天室裡大家傳過的照片 */
  chatPhotos(q: { date?: unknown; dateTo?: unknown; sender?: unknown; keyword?: unknown; ids?: string[]; count?: unknown }): Promise<{
    total: number;
    shown: { id: string; when: string; by: string; kind: string; note: string }[];
    catalog: { id: string; when: string; by: string; kind: string; note: string }[];
  }>;
  /** 只根據路線圖回答怎麼搭（Gemini 看圖；不能用就回 null） */
  readRouteMap(image: { bytes: ArrayBuffer; mime: string }, origin: string, destination: string, city: string, proposal?: string): Promise<ReturnType<typeof cleanRouteMap> | null>;
  documentFolder(name: string, author: string): number | null;
  cacheGet(key: string, maxAgeMs: number): string | null;
  cacheSet(key: string, value: string): void;
}

export interface ExpenseBrief {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
  payer: string;
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
  /** 短片卡片（find_short_videos）：page 是影片網址，src 是縮圖 */
  video?: { platform: "Instagram" | "YouTube"; author: string; verified: boolean };
}

export interface ToolContext {
  env: Env;
  room: RoomApi;
  author: string;
  /** 發問者這則訊息附的照片（存票券、讀收據用） */
  photoId?: string | null;
  /** 工具找到的圖片，會附在這次 AI 回答下方 */
  attachImage?: (img: AttachedImage) => void;
  /** AI 發起的寫入（記帳、改行程、刪除）先做成確認卡片，成員按確認才寫入；畫面上手動操作沒有這個，直接寫 */
  propose?: (d: DraftInput) => unknown;
}

/** 要成員按確認才會執行的動作 */
export type DraftKind = "add_expense" | "update_itinerary" | "delete_expense" | "delete_reminder";
export const DRAFT_TOOLS = new Set<string>(["add_expense", "update_itinerary", "delete_expense", "delete_reminder"]);

export interface DraftInput {
  kind: DraftKind;
  /** 確認後原封不動拿去寫入的資料 */
  payload: unknown;
  /** 卡片內容：rows 是 [欄位, 新值, 原本的值?]；summary 給系統提示與對話紀錄用 */
  preview: { title: string; confirm: string; summary: string; rows: [string, string, string?][] };
  /** 取代還沒確認的舊卡片 */
  replaces?: number;
  /** 要 AI 特別提醒成員的地方 */
  warning?: string;
}

const REPLACES_PARAM = { type: "integer", description: "修正還沒確認的卡片時，填那張卡片的編號（見系統提示「等待成員確認的卡片」）" };

/** 民宿：模型寫「民宿」「IKEBUKURO 4」或自己打的地址常跑錯地方，一律換成正確地址 */
const HOME_ADDRESS = "東京都豊島区要町1-44-8";
const HOME_ALIAS = /^(我們的?|回)?(民宿|住宿|住的地方|飯店|旅館|airbnb)$|IKEBUKURO\s*4|要町\s*1-44-8|セレッソ|Seresso/i;
function homeOr(place: string): string {
  return HOME_ALIAS.test(place.trim()) ? HOME_ADDRESS : place;
}

function money(amount: number, currency: string): string {
  const n = Number(amount).toLocaleString("en-US", { maximumFractionDigits: Math.abs(amount) >= 100 ? 0 : 2 });
  return currency === "JPY" ? `¥${n}` : currency === "TWD" ? `NT$${n}` : `${n} ${currency}`;
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
const JA_KANJI: Record<string, string> = { 龜: "亀", 濱: "浜", 澤: "沢", 櫻: "桜", 驛: "駅", 樂: "楽", 國: "国", 廣: "広", 淺: "浅", 邊: "辺", 黑: "黒", 圓: "円", 學: "学", 內: "内", 藏: "蔵", 總: "総", 鐵: "鉄", 藝: "芸", 橫: "横", 關: "関", 鹽: "塩", 戶: "戸" };

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

// ---------------- 查證路線圖：官方優先，找不到才用維基共享資源、其他網站 ----------------

/** /api/img 轉送的上限：超過就顯示不出來 */
const ROUTE_MAP_MAX = 5_000_000;
/** 短片網址整理成固定格式（IG Reels、YouTube Shorts）；個人頁、標籤頁這類不是單支影片的回 null */
function videoOf(u: string): { platform: "Instagram" | "YouTube"; url: string; id: string } | null {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^(www|m)\./, "");
    if (host === "instagram.com") {
      const m = x.pathname.match(/^\/(?:[\w.]+\/)?(reels?|p)\/([\w-]{5,})/);
      return m ? { platform: "Instagram", url: `https://www.instagram.com/${m[1] === "p" ? "p" : "reel"}/${m[2]}/`, id: m[2] } : null;
    }
    if (host === "youtube.com") {
      const m = x.pathname.match(/\/shorts\/([\w-]{11})/) ?? x.pathname.match(/\/source\/([\w-]{11})\/shorts/);
      return m ? { platform: "YouTube", url: `https://www.youtube.com/shorts/${m[1]}`, id: m[1] } : null;
    }
  } catch {}
  return null;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * 確認影片真的存在，順便拿標題、作者、縮圖：YouTube 用官方 oEmbed；IG 用網頁版的 oEmbed（沒有公開文件，隨時可能失效）。
 * 404／400＝已刪除或不存在；其他錯誤＝沒辦法確認（不要當成失效）
 */
async function checkVideo(v: { platform: string; url: string; id: string }): Promise<{ ok: boolean | null; title?: string; author?: string; thumb?: string; vertical?: boolean }> {
  const api =
    v.platform === "YouTube"
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v.url)}`
      : `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(v.url)}`;
  try {
    const r = await fetch(api, { headers: { "user-agent": BROWSER_UA, accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
    if (r.status === 404 || r.status === 400) return { ok: false };
    if (!r.ok) return { ok: null };
    const j: any = await r.json();
    return {
      ok: true, title: String(j.title ?? ""), author: String(j.author_name ?? ""),
      thumb: v.platform === "YouTube" ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : typeof j.thumbnail_url === "string" ? j.thumbnail_url : undefined,
      vertical: Number(j.thumbnail_height) > Number(j.thumbnail_width),
    };
  } catch {
    return { ok: null };
  }
}

/** 文字比對用：繁體／日文漢字、全半形、大小寫都算一樣 */
const textKey = (s: unknown) => [...String(s ?? "").normalize("NFKC")].map((c) => KANJI[c] ?? c).join("").toLowerCase().replace(/\s+/g, "");

async function tavilyVideos(key: string, query: string, domains: string[]) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
      body: JSON.stringify({ query, max_results: 10, search_depth: "basic", include_domains: domains }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const d: any = await res.json();
    return (d.results ?? []).map((r: any) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), content: String(r.content ?? ""), score: Number(r.score) || 0 }));
  } catch {
    return [];
  }
}

type ShortPlace = { name_local: string; name_zh: string; area: string; category: string; keywords: string[] };

/** 一個地點的短片：IG、YouTube 同時查；過濾掉不是單支影片、跟地點無關、已刪除的；IG 最多 3 支、YouTube 最多 2 支，合計 4 支 */
async function placeVideos(key: string, country: string, p: ShortPlace) {
  const reel = /韓/.test(country) ? "릴스" : /日本/.test(country) ? "リール" : "reels";
  const withArea = (name: string) => [name, p.area && !name.includes(p.area) ? p.area : ""].filter(Boolean).join(" ");
  const [ig, yt] = await Promise.all([
    // IG 用當地語言＋地區＋類別找（限定 /reel 路徑才不會混進圖文貼文）；YouTube 用中文找，只限網域（限定 /shorts 反而不準）
    tavilyVideos(key, `${withArea(p.name_local)} ${p.category} ${reel}`.replace(/\s+/g, " "), ["instagram.com/reel"]),
    tavilyVideos(key, `${withArea(p.name_zh || p.name_local)} shorts`, ["youtube.com"]),
  ]);
  // 店名或景點名本身要出現在影片說明裡：用 AI 給的 keywords；沒有就從名稱去掉地區和分店（「池袋店」「駅前店」）
  const branch = /(店|駅|站|역|점|口|前)$/;
  const tokens = [p.name_local, p.name_zh].flatMap((n) => n.split(/[\s　]+/)).filter((t) => t && !(p.area && t.includes(p.area)) && !branch.test(t));
  const cores = (p.keywords.length ? p.keywords : tokens).map(textKey).filter((n) => n.length >= 2);
  const relevant = (t: string) => cores.some((c) => textKey(t).includes(c));
  const inArea = (t: string) => !!p.area && textKey(t).includes(textKey(p.area));
  const seen = new Set<string>();
  const hits = [...ig, ...yt].flatMap((r) => {
    const v = videoOf(r.url);
    if (!v || seen.has(v.id)) return [];
    seen.add(v.id);
    // Tavily 有時只抓到 IG 的登入頁，看不出內容，要等 oEmbed 拿到說明再比對
    const login = /^instagram$/i.test(r.title.trim()) || /^(log ?in|sign ?up|ログイン|로그인)/i.test(r.content.trim());
    // YouTube 有些影片在這裡播不了（oEmbed 還是會回成功）
    if (/content isn.t available|この動画は再生できません/i.test(r.content)) return [];
    return [{ ...v, text: `${r.title} ${r.content}`, head: r.title, login, score: r.score }];
  }).filter((h) => h.login || relevant(h.text));
  const pick = [...hits.filter((h) => h.platform === "Instagram").slice(0, 5), ...hits.filter((h) => h.platform === "YouTube").slice(0, 3)];
  const checked = await Promise.all(pick.map(async (h) => ({ ...h, ...(await checkVideo(h)) })));
  // Tavily 的說明常混進別頁的內容：確認存在的只看平台回傳的影片說明；沒辦法確認的只看 Tavily 的標題
  const own = (h: (typeof checked)[number]) => (h.ok === true ? `${h.title ?? ""} ${h.login ? "" : h.head}` : h.head);
  const ok = checked.filter((h) => (h.ok === true || (h.ok === null && !h.login)) && relevant(own(h)));
  ok.sort((a, b) => Number(b.ok === true) - Number(a.ok === true) || Number(inArea(own(b))) - Number(inArea(own(a))) || Number(!!b.vertical) - Number(!!a.vertical) || b.score - a.score);
  return [...ok.filter((h) => h.platform === "Instagram").slice(0, 3), ...ok.filter((h) => h.platform === "YouTube").slice(0, 2)].slice(0, 4);
}

/** find_short_videos：每個地點找 IG Reels、YouTube Shorts，影片卡片附在回答下方（網址不經過模型，不會是編的） */
async function findShortVideos(args: any, key: string, country: string, env: Env, attachImage?: (img: AttachedImage) => void) {
  if (!key) return { error: "沒有設定 Tavily 搜尋金鑰，沒辦法找短片" };
  const s = (v: unknown, n = 40) => String(v ?? "").trim().slice(0, n);
  const places: ShortPlace[] = (Array.isArray(args.places) ? args.places : [])
    .slice(0, 2)
    .map((p: any) => ({
      name_local: s(p?.name_local) || s(p?.name_zh), name_zh: s(p?.name_zh), area: s(p?.area, 20), category: s(p?.category, 20),
      keywords: (Array.isArray(p?.keywords) ? p.keywords : []).map((k: unknown) => s(k, 30)).filter(Boolean).slice(0, 4),
    }))
    .filter((p: ShortPlace) => p.name_local);
  if (!places.length) return { error: "請提供要找短片的地點或店家名稱" };
  const found = await Promise.all(places.map((p) => placeVideos(key, country, p)));
  const videos: { place: string; platform: string; title: string; author: string; verified: boolean }[] = [];
  for (const [i, list] of found.entries()) {
    const place = places[i].name_zh || places[i].name_local;
    for (const v of list) {
      const title = (v.title || v.head).replace(/\s*[|｜-]\s*(Instagram|YouTube)\s*$/i, "").replace(/\s+/g, " ").trim().slice(0, 80);
      const thumb = v.thumb ? `/api/img?u=${encodeURIComponent(v.thumb)}&s=${await sign(env, "img:" + v.thumb)}` : "";
      attachImage?.({ src: thumb, caption: title, label: place, source: v.platform, page: v.url, video: { platform: v.platform, author: v.author ?? "", verified: v.ok === true } });
      videos.push({ place, platform: v.platform, title, author: v.author ?? "", verified: v.ok === true });
    }
  }
  if (!videos.length) {
    return { found: 0, note: `沒找到確定跟這些地點有關的短片：照實說，建議成員直接在 IG 或 YouTube 搜尋「${places.map((p) => p.name_local).join("」「")}」。不要自己寫影片網址。` };
  }
  return {
    found: videos.length, videos,
    note:
      "影片卡片（縮圖、標題、連結）已經自動顯示在回答下方。用一兩句話說找到哪些地點的短片、大概在介紹什麼；絕對不要自己寫影片網址。IG 沒登入可能只能看幾支。" +
      (videos.some((v) => !v.verified) ? "標「未確認」的是沒辦法確認還在不在的影片。" : ""),
  };
}

/** 官方來源：營運公司、政府、交通局的網域 */
const OFFICIAL_HOST = /metro|subway|mrt|transit|railway|rail|kotsu|tetsudo|\.go\.|\.gov|\.or\.jp|jreast|jrwest|toei|bts|mtr|krta|korail|smrt|lta\.|tfl\./i;
/** 維基共享資源要求說明是誰在用 */
const WIKI_UA = "TripAgent/1.0 (family travel assistant)";

/** 請 AI 只根據路線圖回答怎麼搭：坐哪條線、往哪個方向、在哪轉乘 */
export function routeMapPrompt(city: string, origin: string, destination: string, proposal = ""): string {
  const check = proposal
    ? `有人建議這樣搭：
${proposal}
請先在圖上逐段核對這個建議：每一段的上下車站是不是都在那條線上（看車站編號）、轉乘站是不是兩條線都有停。建議可行，routes 第一條就照建議的走法寫（填上圖上的車站編號），proposal_ok 填 true；有錯，proposal_ok 填 false，在 uncertain 說明哪裡錯，routes 改寫你在圖上找到的正確走法。
`
    : "";
  return `這是${city}的鐵路／地鐵路線圖。請只根據這張圖上看得到的內容，回答怎麼從「${origin}」到「${destination}」。
${check}只輸出 JSON：
{"is_route_map": 這張是不是${city}現在的鐵路／地鐵路線圖（true／false）, "proposal_ok": 建議的走法在圖上核對可行嗎（true／false；沒有建議就 null）,
 "origin_found": 圖上找得到出發站嗎（或旁邊相連、可以走過去的站）, "origin_on_map": "圖上的站名", "destination_found": 圖上找得到目的地站嗎, "destination_on_map": "圖上的站名",
 "routes": [{"summary": "一句話說明", "legs": [{"line": "路線名稱（照圖上寫的）", "line_code": "路線代號（例如 G；圖上沒有就空字串）", "from": "上車站", "from_no": "上車站在這條線的車站編號（例如 \"Y18\"；圖上沒有就空字串）", "to": "下車站（轉乘站或目的地）", "to_no": "下車站在這條線的車站編號", "loop": 這條線是不是繞一圈的環狀線（true／false）, "direction": "往哪個終點方向（看得出來才寫）"}], "transfers": ["轉乘站"], "walk": "需要步行的地方（例如出發站不在地鐵上、走地下通道到相連的站），沒有就空字串"}],
 "uncertain": "看不清楚或不確定的地方（字太小、線重疊、看不出是否直通）"}
請比較所有可行的走法，優先選轉乘次數最少、總站數最少的；出發站或目的地附近有用地下通道相連的車站，可以步行過去轉乘（寫在 walk）。最多 2 條路線，最好的排前面，每條路線的最後一段一定要到目的地站。站名和車站編號照圖上寫的（編號要是那一段路線的編號，例如銀座線的銀座是 G09），看不清楚就寫在 uncertain，不要用記憶補；找不到出發站或目的地站，就把 routes 設成空陣列。`;
}

/** 站名比對：繁體、日文漢字、「站」「駅」的寫法都算同一站 */
const KANJI: Record<string, string> = { 淺: "浅", 樂: "楽", 澀: "渋", 藏: "蔵", 驛: "駅", 國: "国", 廣: "広", 濱: "浜", 澤: "沢", 邊: "辺", 當: "当", 圓: "円", 會: "会", 學: "学", 總: "総", 實: "実", 鐵: "鉄", 戶: "戸", 櫻: "桜", 惠: "恵", 兩: "両", 縣: "県", 區: "区", 發: "発", 轉: "転", 門: "門", 晝: "昼", 舊: "旧", 檜: "桧", 麥: "麦", 齋: "斎", 黑: "黒", 龜: "亀", 條: "条", 濟: "済", 劍: "剣", 驗: "験", 壽: "寿", 竜: "竜", 龍: "竜", 島: "島", 嶋: "島", 惣: "惣", 塚: "塚", 豐: "豊", 灣: "湾", 臺: "台", 萬: "万", 與: "与", 雜: "雑", 稻: "稲", 葉: "葉" };
function stationKey(s: string): string {
  return [...String(s ?? "").normalize("NFKC")].map((c) => KANJI[c] ?? c).join("").replace(/\s|（.*?）|\(.*?\)|駅|站|station|stn\.?/gi, "").toLowerCase();
}
function sameStation(a: string, b: string): boolean {
  const x = stationKey(a), y = stationKey(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** 車站編號拆成路線代號和號碼（G09、JY01、BL12）；最後一欄是能不能拿來算站數 */
function stationNo(no: string): [string, number, boolean] | null {
  const t = no.normalize("NFKC").trim().toUpperCase();
  const m = t.match(/^([A-Z]{1,3})\s*-?\s*(\d{1,3})$/);
  if (m) return [m[1], Number(m[2]), true];
  // 首爾、釜山的三位數編號：第一碼是路線（424 是 4 號線）。只拿來核對路線，不算站數（2 號線是環狀，相減會錯）
  const n = t.match(/^(\d)(\d{2})$/);
  return n ? [n[1], Number(n[2]), false] : null;
}
function lineLetters(no: string): string | null {
  return stationNo(no)?.[0] ?? null;
}
/** 同一條線兩站的編號相減就是站數（G09→G19 是 10 站）；圖上沒有編號、或是環狀線（山手線編號繞一圈會接回來）就不算 */
function stopsBetween(a: string, b: string, loop: boolean): number | null {
  const x = stationNo(a), y = stationNo(b);
  return !loop && x && y && x[2] && y[2] && x[0] === y[0] && x[1] !== y[1] ? Math.abs(x[1] - y[1]) : null;
}
function sameLine(l: { line_code: string; from_no: string; to_no: string }): boolean {
  const a = lineLetters(l.from_no), b = lineLetters(l.to_no);
  if (!a || !b) return true;
  const code = l.line_code.normalize("NFKC").trim().toUpperCase();
  return a === b && (!/^[A-Z]{1,3}$/.test(code) || code === a);
}

/** 兩次讀圖都讀出同一條走法（同樣的路線、同樣的轉乘站）才算確認；站數也要兩次一樣才留。沒有就 null */
export function agreeRoutes(a: ReturnType<typeof cleanRouteMap>, b: ReturnType<typeof cleanRouteMap>) {
  const sig = (r: any) => r.legs.map((l: any) => `${lineLetters(l.from_no) ?? ""}:${stationKey(l.to)}`).join("|");
  for (const ra of a.routes as any[]) {
    const rb = (b.routes as any[]).find((x) => sig(x) === sig(ra));
    if (rb) return { ...ra, legs: ra.legs.map((l: any, i: number) => (l.stops === rb.legs[i].stops ? l : { ...l, stops: null })) };
  }
  return null;
}

/** Google 地圖用的車站名稱 */
function stationQuery(name: string): string {
  return /[站駅역]$|station$/i.test(name) ? name : `${name} station`;
}

/** 整理 AI 讀圖的結果並核對：每一段的上車站要接上前一段的下車站（或寫了要步行），最後一段要到目的地；站數由程式照車站編號算（AI 自己數常數錯） */
export function cleanRouteMap(j: any, origin: string, destination: string) {
  const s = (v: unknown, n = 60) => String(v ?? "").trim().slice(0, n);
  const routes = (Array.isArray(j?.routes) ? j.routes : [])
    .map((r: any) => ({
      summary: s(r?.summary, 120),
      legs: (Array.isArray(r?.legs) ? r.legs : []).slice(0, 5).map((l: any) => ({
        line: s(l?.line), line_code: s(l?.line_code, 6), from: s(l?.from, 30), from_no: s(l?.from_no, 8), to: s(l?.to, 30), to_no: s(l?.to_no, 8), direction: s(l?.direction, 30),
        stops: stopsBetween(s(l?.from_no, 8), s(l?.to_no, 8), l?.loop === true),
      })),
      transfers: (Array.isArray(r?.transfers) ? r.transfers : []).map((x: unknown) => s(x, 30)).filter(Boolean).slice(0, 4),
      walk: s(r?.walk, 80),
    }))
    .filter((r: any) => {
      if (!r.legs.length || r.legs.some((l: any) => !l.line || !l.from || !l.to)) return false;
      // 上下車站的編號要是同一條線的（例如淺草線是 A，寫成從押上 A20 到大手町 T09 就是這條線沒經過大手町）
      if (r.legs.some((l: any) => !sameLine(l))) return false;
      if (!sameStation(r.legs[r.legs.length - 1].to, destination)) return false;
      for (let i = 1; i < r.legs.length; i++) if (!sameStation(r.legs[i].from, r.legs[i - 1].to) && !r.walk) return false;
      return sameStation(r.legs[0].from, origin) || !!r.walk;
    });
  // 轉乘少的排前面；同樣轉乘次數照 AI 排的順序（它比較過總站數）
  // 核對過的建議走法放第一條，照原順序；沒有建議時轉乘少的排前面
  const proposalOk = j?.proposal_ok === true ? true : j?.proposal_ok === false ? false : null;
  if (!proposalOk) routes.sort((a: any, b: any) => a.legs.length - b.legs.length);
  return {
    is_route_map: j?.is_route_map !== false, proposal_ok: proposalOk, origin_on_map: s(j?.origin_on_map, 30), destination_on_map: s(j?.destination_on_map, 30),
    routes: routes.slice(0, 2), uncertain: s(j?.uncertain, 200),
  };
}

type RouteMap = { url: string; page?: string; bytes: ArrayBuffer; mime: string; source: string };

async function loadMap(url: string, source: string, page?: string): Promise<RouteMap | null> {
  try {
    if (!/^https?:\/\//.test(url)) return null;
    const res = await fetch(url, { headers: { "user-agent": url.includes("wikimedia.org") ? WIKI_UA : IMG_UA, accept: "image/*" }, signal: AbortSignal.timeout(8_000) });
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !/^image\/(png|jpe?g|webp|gif)$/.test(mime) || Number(res.headers.get("content-length") || 0) > ROUTE_MAP_MAX) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await res.arrayBuffer();
    return bytes.byteLength > 30_000 && bytes.byteLength <= ROUTE_MAP_MAX ? { url, page, bytes, mime, source } : null;
  } catch {
    return null;
  }
}

/** 上網找路線圖的候選：官方網域排前面，其他網站排後面 */
async function webMapCandidates(key: string, city: string, cityEn: string) {
  if (!key) return { official: [] as { url: string; page?: string }[], other: [] as { url: string; page?: string }[] };
  const seen = new Set<string>();
  const all: { url: string; page?: string; description: string }[] = [];
  await Promise.all(
    [`${city} 地鐵 路線圖 官方`, `${cityEn || city} metro subway official route map`].map(async (query) => {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key.trim()}` },
          body: JSON.stringify({ query, max_results: 6, include_images: true, include_image_descriptions: true, search_depth: "basic" }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return;
        const d: any = await res.json();
        const add = (img: any, page?: string) => {
          const url = typeof img === "string" ? img : img?.url;
          if (!url || seen.has(url)) return;
          seen.add(url);
          all.push({ url, page, description: typeof img === "string" ? "" : String(img.description ?? "") });
        };
        for (const r of d.results ?? []) for (const img of r.images ?? []) add(img, r.url);
        for (const img of d.images ?? []) add(img);
      } catch {}
    }),
  );
  const host = (u?: string) => {
    try {
      return new URL(u ?? "").host;
    } catch {
      return "";
    }
  };
  const mapLike = (c: { url: string; description: string }) => /map|route|路線|路线|地鐵|地下鉄|metro|subway|railway|network/i.test(`${c.description} ${c.url}`);
  const official = all.filter((c) => mapLike(c) && (OFFICIAL_HOST.test(host(c.url)) || OFFICIAL_HOST.test(host(c.page))));
  const other = all.filter((c) => mapLike(c) && !official.includes(c));
  return { official, other };
}

/** 維基共享資源的路線圖：現在的全線圖（不要歷史、規劃中的），大的優先 */
async function wikiMapCandidates(city: string, cityEn: string): Promise<{ url: string; page: string }[]> {
  const out: { url: string; page: string; score: number }[] = [];
  for (const q of [...new Set([cityEn && `${cityEn} subway map`, cityEn && `${cityEn} metro map`, `${city} 路線図`].filter(Boolean))]) {
    try {
      const u = new URL("https://commons.wikimedia.org/w/api.php");
      for (const [k, v] of Object.entries({ action: "query", generator: "search", gsrsearch: String(q), gsrnamespace: "6", gsrlimit: "12", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "3840", format: "json" })) u.searchParams.set(k, v);
      const d: any = await (await fetch(u, { headers: { "user-agent": WIKI_UA }, signal: AbortSignal.timeout(15_000) })).json();
      for (const p of Object.values<any>(d?.query?.pages ?? {})) {
        const ii = p?.imageinfo?.[0];
        const title = String(p?.title ?? "");
        if (!ii || /propos|plan|histor|future|19\d\d|200\d|201[0-5]|black|old|draft/i.test(title)) continue;
        if (!/svg|png|jpeg/.test(String(ii.mime))) continue;
        const score = (/system|network|subway map|metro map|linemap|路線/i.test(title) ? 2 : 0) + (/ja|jp|zh|en/i.test(title) ? 1 : 0) + Math.min(Number(ii.width) || 0, 8000) / 4000;
        if (!out.some((x) => x.page === ii.descriptionurl)) out.push({ url: ii.thumburl || ii.url, page: ii.descriptionurl, score });
      }
    } catch {}
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
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
        "上網找圖片（餐廳外觀、料理、景點、商品、捷運／地鐵路線圖、平面圖、菜單），找到的圖片會自動顯示在你的回答下方。只有成員明確要求看照片／圖片時才使用。" +
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
            // 只給座標：店名一起放進搜尋字，模型抄網址時最常把日文編碼抄壞；座標也不會跑到連鎖店的別家分店
            map: mapsLink({ lat, lon }),
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
      description: "產生 Google Maps 導航連結（大眾運輸/步行/開車）。詳細轉乘與票價請搭配 web_search 查詢。起點留空=發問者目前位置或住宿。要回民宿 destination 填「民宿」（系統會換成正確地址）。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "照成員訊息裡的寫法直接複製（例如「新宿站」），不要自己翻成日文" },
          destination: { type: "string", description: "照成員訊息裡的寫法直接複製（例如「池袋站」），不要自己翻成日文" },
          mode: { type: "string", enum: ["transit", "walking", "driving"] },
        },
        required: ["destination"],
      },
    },
    async run(args, { room, author }) {
      let origin = args.origin as string | undefined;
      if (!origin) {
        const mine = room.memberLocation(author)[0];
        origin = mine && Date.now() - mine.ts < 3 * 3600_000 ? `${mine.lat},${mine.lon}` : HOME_ADDRESS;
      }
      origin = homeOr(origin);
      const mode = args.mode || "transit";
      const u = new URL("https://www.google.com/maps/dir/");
      u.searchParams.set("api", "1");
      u.searchParams.set("origin", origin);
      const destination = homeOr(String(args.destination));
      u.searchParams.set("destination", destination);
      u.searchParams.set("travelmode", mode);
      return { origin, destination, mode, google_maps: u.toString() };
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
      description: "記一筆旅費並分帳。例如「晚餐 8400 日圓我付的」。payer 預設為發問者，split_among 預設為全部旅伴（見系統提示的旅伴名單），只有特定人分攤時才填，成員說誰就照填誰（名單裡沒有也照填，不可以換成別人）。",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string", description: "JPY 或 TWD，預設 JPY；台灣的收據（NT$、民國年、統一發票）是 TWD" },
          payer: { type: "string" },
          split_among: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: ["餐飲", "交通", "門票", "購物", "住宿", "其他"] },
          date: { type: "string", description: "日期 YYYY-MM-DD，預設今天（東京時間）。收據上的民國年要加 1911（民國 113 年＝2024 年）；令和 N 年＝2018+N 年（令和 7 年＝2025 年）" },
          replaces: REPLACES_PARAM,
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
      const e: ExpenseInput = {
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
      };
      const rateEstimated = toJpy.estimated || toTwd.estimated;
      if (ctx.propose) {
        // 日期離旅程太遠（例如兩年前在台灣的收據）特別標出來，幣別也最容易在這種時候看錯；出發前幾個月先買票是正常的
        const shift = (d: string, days: number) => new Date(Date.parse(d + "T00:00:00Z") + days * 86400_000).toISOString().slice(0, 10);
        const outside = e.date < shift(TRIP.startDate, -90) || e.date > shift(TRIP.endDate, 14);
        const warn = outside ? `日期離旅遊期間（${TRIP.startDate}～${TRIP.endDate.slice(5)}）很遠，請確認日期與幣別` : "";
        const other = currency === "JPY" ? `≈ NT$${twd.toLocaleString("en-US")}` : currency === "TWD" ? `≈ ¥${jpy.toLocaleString("en-US")}` : `≈ ¥${jpy.toLocaleString("en-US")}｜NT$${twd.toLocaleString("en-US")}`;
        return ctx.propose({
          kind: "add_expense",
          payload: e,
          replaces: Number(args.replaces) || undefined,
          preview: {
            title: "記帳確認",
            confirm: "確認記帳",
            summary: `${e.date} ${e.description} ${money(amount, currency)}（${e.payer} 付，${split.length} 人分）`,
            rows: [
              ["日期", e.date],
              ["項目", String(e.description)],
              ["金額", `${money(amount, currency)}（${other}${rateEstimated ? "，匯率為估計值" : ""}）`],
              ["付款人", String(e.payer)],
              ["分攤", `${split.join("、")}（每人約 NT$${Math.round(twd / split.length).toLocaleString("en-US")}）`],
              ["分類", e.category],
              ...(warn ? [["⚠️ 注意", warn] as [string, string]] : []),
            ],
          },
          warning: warn || undefined,
        });
      }
      return { saved: ctx.room.addExpense(e), rate_estimated: rateEstimated };
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
      description: "刪除已經記進帳本的一筆帳。可以用品項關鍵字（例如「拉麵」）找，或用 expense_summary 裡的帳目 id（不是確認卡片的編號）。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "品項或店名關鍵字" }, id: { type: "integer", description: "帳目 id" } },
      },
    },
    async run(args, { room, propose }) {
      let ex = args.id ? room.expenseGet(Number(args.id)) : null;
      if (!ex && args.keyword) {
        const found = room.expenseFind(String(args.keyword));
        if (found.length > 1) return { matches: found, note: "有好幾筆符合，請問成員要刪哪一筆，再用 id 呼叫" };
        ex = found[0] ?? null;
      }
      if (!ex) return { error: "帳本裡找不到這筆帳（還沒確認的卡片不在帳本裡，請成員直接按卡片上的「取消」）", recent: room.expenseFind("").slice(0, 8) };
      const id = ex.id;
      if (propose) {
        return propose({
          kind: "delete_expense",
          payload: { id },
          preview: {
            title: "刪除帳目確認",
            confirm: "確認刪除",
            summary: `刪除 #${id} ${ex.date} ${ex.description} ${money(ex.amount, ex.currency)}`,
            rows: [["日期", ex.date], ["項目", ex.description], ["金額", money(ex.amount, ex.currency)], ["付款人", ex.payer]],
          },
        });
      }
      return { deleted: room.deleteExpense(id) };
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
          replaces: REPLACES_PARAM,
        },
        required: ["date"],
      },
    },
    async run(args, { room, author, propose }) {
      const date = normalizeDate(args.date);
      if (!date) return { error: "看不懂日期，請用 10/9 或 2026-10-09" };
      const fields = { title: args.title, detail: args.detail, status: args.status };
      if (propose) {
        const cur = room.itineraryDay(date);
        const rows: [string, string, string?][] = [["日期", date]];
        for (const [k, label] of [["title", "標題"], ["detail", "細節"], ["status", "狀態"]] as const) {
          const v = fields[k];
          if (v == null || String(v) === (cur?.[k] ?? "")) continue;
          rows.push([label, String(v), cur?.[k] || undefined]);
        }
        if (rows.length === 1) return { unchanged: true, note: "內容和目前的行程一樣，不需要修改" };
        return propose({
          kind: "update_itinerary",
          payload: { date, fields, author },
          replaces: Number(args.replaces) || undefined,
          preview: { title: "修改行程確認", confirm: "確認修改", summary: `${date} ${fields.title ?? cur?.title ?? ""}`.trim(), rows },
        });
      }
      return room.updateItinerary(date, fields, author);
    },
  },
  {
    label: "🚆 電車狀況",
    decl: {
      name: "train_status",
      description: "查關東電車（JR、地鐵、私鉄）現在的運行狀況：延誤、停駛、運轉計畫。可以指定路線，例如 有楽町線、山手線、京成本線。",
      parameters: { type: "object", properties: { line: { type: "string", description: "路線名稱（日文漢字最準），留空=列出目前所有異常路線" } } },
    },
    async run(args) {
      const res = await fetch("https://transit.yahoo.co.jp/diainfo/area/4", {
        headers: { "user-agent": "Mozilla/5.0 (compatible; TokyoTripAgent/1.0)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return { error: `運行情報暫時查不到（${res.status}）` };
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) return { error: "運行情報格式改了，暫時無法解析" };
      const page = JSON.parse(m[1])?.props?.pageProps ?? {};
      const flat = (x: any): any[] => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" && !x.routeInfo ? Object.values(x).flatMap(flat) : x ? [x] : []);
      const lines = flat(page.diainfoTrainFeatures ?? [])
        .map((x: any) => x?.routeInfo?.property)
        .filter((p: any) => p?.displayName)
        .map((p: any) => ({
          line: p.displayName as string,
          company: p.companyName as string,
          issues: (p.diainfo ?? []).map((d: any) => ({ status: d.status, message: d.message, updated: d.updateDate })),
        }));
      const want = String(args.line ?? "").trim();
      if (want) {
        const ja = [...want.replace("丸之內", "丸ノ内")].map((c) => JA_KANJI[c] ?? c).join("").replace(/線$/, "");
        const hits = lines.filter((l: any) => l.line.includes(ja) || ja.includes(l.line.replace(/線$/, "")));
        if (!hits.length) return { line: want, note: "沒有找到這條路線，可能名稱不同；目前異常路線如下", troubles: lines.filter((l: any) => l.issues.length).slice(0, 15) };
        return { results: hits.map((h: any) => ({ ...h, status: h.issues.length ? h.issues.map((i: any) => i.status).join("、") : "平常運轉" })), source: "Yahoo!路線情報" };
      }
      const troubles = lines.filter((l: any) => l.issues.length);
      return { troubles: troubles.slice(0, 20), normal_count: lines.length - troubles.length, source: "Yahoo!路線情報" };
    },
  },
  {
    label: "🚕 計程車估價",
    decl: {
      name: "taxi_fare",
      description: "估算東京計程車車資與車程（依實際行車距離與東京 23 區計費）。起點留空=發問者目前位置或住宿。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "起點（日文地名或座標），留空=目前位置或住宿" },
          to: { type: "string", description: "目的地，例如 東京ディズニーシー、成田空港第2ターミナル" },
          night: { type: "boolean", description: "是否深夜（22:00–05:00 加成 20%），留空=依現在時間判斷" },
        },
        required: ["to"],
      },
    },
    async run(args, { room, author }) {
      let from: { name: string; lat: number; lon: number } | null = null;
      if (args.from) from = await locate(String(args.from));
      if (!from) {
        const mine = recentLocation(room, author);
        from = mine ? { name: mine.area || "目前位置", lat: mine.lat, lon: mine.lon } : { name: "住宿（要町）", lat: TRIP.accommodation.lat, lon: TRIP.accommodation.lon };
      }
      const to = await locate(String(args.to));
      if (!to) return { error: `找不到「${args.to}」，請用日文地名再試` };
      const d = await getJSON(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`, undefined, 12_000);
      const route = d.routes?.[0];
      if (!route) return { error: "算不出行車路線" };
      const km = route.distance / 1000;
      const minutes = Math.round(route.duration / 60);
      // 東京 23 區（2022 起）：1.096 km 內 500 圓，之後每 255 m 加 100 圓；另估塞車時間計費約多 10–25%
      const meter = (m: number) => 500 + Math.max(0, Math.ceil((m - 1096) / 255)) * 100;
      const jstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
      const night = typeof args.night === "boolean" ? args.night : jstHour >= 22 || jstHour < 5;
      const base = meter(night ? route.distance * 1.25 : route.distance); // 深夜 20% 加成＝以 1.25 倍距離計算
      const low = Math.round(base / 100) * 100;
      const high = Math.round((base * 1.25) / 100) * 100;
      return {
        from: from.name,
        to: to.name,
        distance_km: Math.round(km * 10) / 10,
        drive_minutes: `${minutes}–${Math.round(minutes * 1.5)} 分鐘（視路況）`,
        fare_jpy: `約 ¥${low.toLocaleString()}–¥${high.toLocaleString()}`,
        night_surcharge: night,
        notes: "估算值，不含高速公路過路費與叫車費（用 GO 等 App 叫車約多 ¥0–500）。4 人＋行李建議叫大一點的車（ジャンボタクシー）。可以先把目的地的日文給司機看。",
        source: "路線：OSRM（OpenStreetMap）；費率：東京 23 區",
      };
    },
  },
  {
    label: "🆘 災害警報",
    decl: {
      name: "japan_alerts",
      description: "查日本的地震、海嘯、颱風與東京附近的強風豪雨預報。問「有地震嗎」「颱風會不會影響行程」時使用。",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      return japanAlerts();
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "add_checklist_items",
      description: "把東西加進全家共用清單：購物、行李、待辦。只有成員明確要求加入清單時才能使用，例如「把皮卡丘玩偶加入購物清單」；只是說想買或問推薦時不要使用。",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["購物", "行李", "待辦"] },
          items: { type: "array", items: { type: "string" }, description: "要加入的項目，每項一句" },
          for_whom: { type: "string", description: "是誰要的（購物用），可留空" },
        },
        required: ["list", "items"],
      },
    },
    async run(args, { room, author }) {
      const items = (Array.isArray(args.items) ? args.items : [args.items]).map((s: unknown) => String(s ?? "").trim()).filter(Boolean).slice(0, 20);
      if (!items.length) return { error: "沒有要加入的項目" };
      return room.checklistAdd(String(args.list || "購物"), items, String(args.for_whom ?? ""), author);
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "update_checklist_item",
      description: "清單項目打勾（買到了、帶了、辦好了）、取消勾選或刪除。用關鍵字或 id 指定。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "項目關鍵字，例如 皮卡丘" },
          id: { type: "integer" },
          list: { type: "string", enum: ["購物", "行李", "待辦"] },
          done: { type: "boolean", description: "true=打勾，false=取消勾選" },
          remove: { type: "boolean", description: "true=刪除" },
        },
      },
    },
    async run(args, { room, author }) {
      return room.checklistUpdate(
        { id: args.id ? Number(args.id) : undefined, keyword: args.keyword, list: args.list },
        { done: typeof args.done === "boolean" ? args.done : args.remove ? undefined : true, remove: !!args.remove },
        author,
      );
    },
  },
  {
    label: "✅ 清單",
    decl: {
      name: "get_checklist",
      description: "查看全家共用清單（購物、行李、待辦），包含哪些已完成、哪些還沒。",
      parameters: { type: "object", properties: { list: { type: "string", enum: ["購物", "行李", "待辦"] } } },
    },
    async run(args, { room }) {
      return room.checklistGet(args.list);
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "create_reminder",
      description: "設定提醒，時間到了會在群組發訊息通知全家。例如「10/4 早上 9:30 提醒大家出門去藤子博物館」。",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "東京時間，格式 YYYY-MM-DD HH:mm，例如 2026-10-04 09:30" },
          message: { type: "string", description: "提醒內容" },
        },
        required: ["time", "message"],
      },
    },
    async run(args, { room, author }) {
      const m = String(args.time ?? "").match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
      if (!m) return { error: "時間格式看不懂，請用 2026-10-04 09:30（東京時間）" };
      const due = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]);
      if (due < Date.now() - 60_000) return { error: "這個時間已經過了" };
      return room.reminderAdd(due, String(args.message).slice(0, 300), author);
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "list_reminders",
      description: "列出還沒到的提醒。",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, { room }) {
      return room.reminderList();
    },
  },
  {
    label: "⏰ 提醒",
    decl: {
      name: "delete_reminder",
      description: "刪除一個提醒（用 list_reminders 的 id）。",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    },
    async run(args, { room, propose }) {
      const id = Number(args.id);
      const r = room.reminderGet(id);
      if (!r) return { error: `找不到 #${id} 這個提醒（可能已經通知過），請先用 list_reminders 確認 id` };
      if (propose) {
        return propose({
          kind: "delete_reminder",
          payload: { id },
          preview: { title: "刪除提醒確認", confirm: "確認刪除", summary: `刪除提醒 #${id} ${r.time} ${r.message}`, rows: [["時間", r.time], ["內容", r.message]] },
        });
      }
      return { deleted: room.reminderDelete(id) };
    },
  },
  {
    label: "🎫 票券",
    decl: {
      name: "save_document",
      description: "把成員這則訊息附的照片存進票券保管箱（門票、訂位確認、QR Code、登機證、保險單等），之後可以快速叫出來，沒網路也看得到。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "名稱，例如「藤子博物館門票 10/4 11:00」" },
          note: { type: "string", description: "補充說明，可留空" },
          folder: { type: "string", description: "放進哪個資料夾（例如「機票」「門票」），成員沒指定就不要填（放最外層）；沒有這個資料夾會自動建立" },
        },
        required: ["title"],
      },
    },
    async run(args, { room, author, photoId }) {
      if (!photoId) return { error: "這則訊息沒有附照片，請附上票券照片再說要存起來" };
      const folder = args.folder ? room.documentFolder(String(args.folder), author) : null;
      return room.documentSave(String(args.title).slice(0, 80), String(args.note ?? "").slice(0, 300), photoId, author, folder);
    },
  },
  {
    label: "🎬 找短片",
    decl: {
      name: "find_short_videos",
      description:
        "找景點、美食、餐廳的 IG Reels、YouTube Shorts 短片介紹（成員說「有沒有短片」「找影片介紹」「找相關短片」時用）。" +
        "會確認影片真的存在、跟地點有關，影片卡片（縮圖、標題、連結）會自動顯示在回答下方；不要自己寫影片網址。一次最多 2 個地點。",
      parameters: {
        type: "object",
        properties: {
          places: {
            type: "array",
            description: "要找短片的地點或店家，最多 2 個",
            items: {
              type: "object",
              properties: {
                name_local: { type: "string", description: "當地語言的名稱（例如「一蘭 池袋」「浅草寺」「명동교자」）" },
                name_zh: { type: "string", description: "中文名稱（例如「一蘭拉麵」「淺草寺」「明洞餃子」）" },
                area: { type: "string", description: "地區（例如 池袋、明洞）；景點本身就是地名可以留空" },
                category: { type: "string", description: "類別，用當地語言（例如 ラーメン、寺、맛집）" },
                keywords: {
                  type: "array", items: { type: "string" },
                  description: "相關影片的說明裡一定會出現的名稱：店名或景點名本身的各種寫法，不含地區和分店（例如 [\"一蘭\",\"Ichiran\"]、[\"仲見世\"]、[\"명동교자\",\"明洞餃子\"]）",
                },
              },
              required: ["name_local", "keywords"],
            },
          },
        },
        required: ["places"],
      },
    },
    async run(args, { env, attachImage }) {
      return findShortVideos(args, env.TAVILY_API_KEY ?? "", "日本", env, attachImage);
    },
  },
  {
    label: "🗺️ 查證路線",
    decl: {
      name: "check_route_map",
      description:
        "成員問坐幾站、或要求查證／確認地鐵電車捷運路線時才用：找這個城市的路線圖（官方優先，找不到才用維基共享資源或其他網站的圖），照圖確認路線、轉乘站和站數，路線圖會附在回答下方。" +
        "呼叫時把你認為的搭法填在 legs，工具會在圖上逐段核對、改正，並照車站編號算站數。回答照回傳的 routes 寫，最後附上回傳的 google_maps 連結。",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "出發的車站名稱（當地寫法，例如「押上」「有楽町」）；成員說了車站就照填，不要換成別站（要走到別站搭車就寫在 legs）；在住處或目前位置就填最近的車站" },
          destination: { type: "string", description: "要去的車站名稱（當地寫法，例如「浅草」）" },
          city: { type: "string", description: "城市（當地或中文名稱，例如 東京、大阪、首爾）；留空用旅程的城市" },
          city_en: { type: "string", description: "城市的英文名稱（例如 Tokyo、Seoul），用來找維基共享資源的路線圖" },
          legs: {
            type: "array",
            description: "你認為的搭法（照你知道的，每一段一筆），工具會在路線圖上逐段核對",
            items: { type: "object", properties: { line: { type: "string", description: "路線名稱" }, from: { type: "string", description: "上車站" }, to: { type: "string", description: "下車站" } } },
          },
        },
        required: ["origin", "destination"],
      },
    },
    async run(args, { env, room, attachImage }) {
      const origin = String(args.origin ?? "").trim(), destination = String(args.destination ?? "").trim();
      if (!origin || !destination) return { error: "請提供出發和要去的車站" };
      const city = String(args.city ?? "").trim() || "東京";
      const cityEn = String(args.city_en ?? "").trim() || "Tokyo";
      const key = env.TAVILY_API_KEY ?? "";
      const miss = "跟大家說沒查到可以查證的路線圖，不要寫站數，附上 google_maps 連結請大家直接看 Google 地圖的路線";
      // AI 照記憶提出的走法，拿去圖上核對（記憶的路線通常對，讀圖自己規劃反而容易繞路）
      const proposal = (Array.isArray(args.legs) ? args.legs : [])
        .slice(0, 5)
        .map((l: any, i: number) => `${i + 1}. ${String(l?.line ?? "").slice(0, 30)}：從「${String(l?.from ?? "").slice(0, 30)}」到「${String(l?.to ?? "").slice(0, 30)}」`)
        .join("\n");
      const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(stationQuery(origin))}&destination=${encodeURIComponent(stationQuery(destination))}&travelmode=transit`;
      // 試的順序：上次查證成功的 → 官方 → 維基共享資源 → 其他網站；每張都讓 AI 照圖回答，程式檢查通過才採用
      const tried = new Set<string>();
      let attempts = 0, aiDown = false;
      // 同一張圖讀兩次（同時跑），兩次讀出同樣的走法才算確認；只有一次讀得出來也照樣回答，但提醒對照附圖
      const tryMap = async (m: RouteMap | null) => {
        if (!m || attempts >= 3 || aiDown) return null;
        attempts++;
        const reads = await Promise.all([0, 1].map(() => room.readRouteMap({ bytes: m.bytes, mime: m.mime }, origin, destination, city, proposal)));
        if (reads.every((x) => !x)) {
          aiDown = true;
          return null;
        }
        const [a, b] = reads.filter((x): x is NonNullable<typeof x> => !!x && x.is_route_map && x.routes.length > 0);
        if (!a) {
          if (!seenMap && reads.some((x) => x?.is_route_map)) seenMap = m;
          return null;
        }
        const agreed = b ? agreeRoutes(a, b) : null;
        // 沒有交叉確認的路線不給站數（只讀一次的編號常讀錯）
        const single = { ...a.routes[0], legs: a.routes[0].legs.map((l: any) => ({ ...l, stops: null })) };
        return { m, r: { ...a, routes: [agreed ?? single] }, confirmed: !!agreed };
      };
      let hit: Awaited<ReturnType<typeof tryMap>> = null;
      // 是這個城市的路線圖、但圖上核對不出這段路線：還是附給大家對照
      let seenMap = null as RouteMap | null;
      const cached = room.cacheGet(`routemap3:${city}`, 7 * 86400_000);
      if (cached) {
        try {
          const c = JSON.parse(cached);
          tried.add(c.url);
          hit = await tryMap(await loadMap(c.url, c.source, c.page));
        } catch {}
      }
      if (!hit) {
        const [web, wiki] = await Promise.all([webMapCandidates(key, city, cityEn), wikiMapCandidates(city, cityEn)]);
        // 每一組候選一起下載（官方網站常常擋程式下載，不用一張一張等）
        const load = (list: { url: string; page?: string }[], source: string, n: number) =>
          Promise.all(list.filter((c) => !tried.has(c.url)).slice(0, n).map((c) => (tried.add(c.url), loadMap(c.url, source, c.page))));
        const [official, commons, other] = await Promise.all([load(web.official, "官方", 3), load(wiki, "維基共享資源", 2), load(web.other, "網路", 2)]);
        for (const m of [...official, ...commons, ...other]) if (!hit && m) hit = await tryMap(m);
      }
      const attach = async (m: RouteMap, label: string) => {
        room.cacheSet(`routemap3:${city}`, JSON.stringify({ url: m.url, source: m.source, page: m.page }));
        attachImage?.({
          src: `/api/img?u=${encodeURIComponent(m.url)}&s=${await sign(env, "img:" + m.url)}`,
          caption: `${city}路線圖`, label: `🗺️ ${m.source === "官方" ? "官方" : m.source === "維基共享資源" ? "維基共享資源的" : "網路上的"}路線圖（${label}）`, source: new URL(m.url).host, page: m.page,
        });
        return `${m.source}（${new URL(m.url).host}）`;
      };
      if (!hit && seenMap) {
        return {
          found_map: true, verified: false, source: await attach(seenMap, "請對照"), google_maps: gmaps, routes: [],
          note: "找到這個城市的路線圖，但在圖上沒能核對出這段路線：照你知道的說坐哪條線、在哪轉乘，但要清楚說明這次沒能用路線圖確認，請大家對照附圖和 Google 地圖；不要寫站數。最後附上 google_maps 連結。",
        };
      }
      if (!hit) return { found_map: false, google_maps: gmaps, note: aiDown ? `AI 暫時不能看圖（額度或連線問題）：${miss}` : `找不到能確認這段路線的路線圖：${miss}` };
      const { m, r, confirmed } = hit;
      const host = new URL(m.url).host;
      await attach(m, "回答的依據");
      return {
        found_map: true, source: `${m.source}（${host}）`, ...r,
        routes: r.routes.map((x: any) => ({ ...x, legs: x.legs.map(({ from_no, to_no, ...l }: any) => l) })),
        google_maps: gmaps,
        total_stops: r.routes[0].legs.every((l: any) => l.stops != null) ? r.routes[0].legs.reduce((n: number, l: any) => n + l.stops, 0) : null,
        ...(confirmed ? {} : { caution: "這條路線只讀到一次、還沒有交叉確認：照樣回答，但要提醒大家對照附圖確認轉乘站" }),
        rule: "只寫 routes 裡的路線（不要自己補其他路線或其他鐵路公司的路線）：每一段寫路線名稱、方向、上下車站和 stops 站數（stops 是照圖上的車站編號算的，兩次讀圖一致才有；是 null 就說站數請對照附圖數）；總站數只能寫 total_stops，是 null 就不要寫總站數，不要自己加或用車站編號算，轉乘和步行照 walk、transfers 寫；uncertain 裡的提醒大家注意；proposal_ok 是 false，先說原本以為的走法哪裡不對（照 uncertain），再照 routes 寫正確的。" +
          "開頭或結尾寫一句「依據：" + m.source + "路線圖（已附在下方，可以對照）」。最後附上 google_maps 連結（不用再呼叫 plan_route），提醒即時班次和月台以 Google 地圖為準。",
      };
    },
  },
  {
    label: "🖼 翻照片",
    decl: {
      name: "find_chat_photos",
      description:
        "找大家自己拍、傳到這個聊天室的照片，照片會直接顯示在回答下方。例如「第一天的照片」「昨天吃拉麵的照片」「小佑傳的照片」「我們在晴空塔的合照」。" +
        "要看沒去過的地方、店家、料理長什麼樣（網路圖片）才用 find_images。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "哪一天（YYYY-MM-DD）；「今天」「昨天」「第一天」都要換算成日期。沒提到日期才留空（全部）" },
          date_to: { type: "string", description: "找一段期間時的最後一天（YYYY-MM-DD）" },
          sender: { type: "string", description: "誰傳的（成員名字），沒指定就留空" },
          keyword: { type: "string", description: "照片內容，例如 拉麵、合照、晴空塔、夜景；沒指定就留空（會挑最精彩的）" },
          ids: { type: "array", items: { type: "string" }, description: "要顯示的照片 id（前一次結果 catalog 裡的），要指定特定幾張時才填" },
          count: { type: "number", description: "要幾張，預設 6，最多 8" },
        },
      },
    },
    async run(args, { room, attachImage }) {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
      const r = await room.chatPhotos({ date: args.date, dateTo: args.date_to, sender: args.sender, keyword: args.keyword, ids, count: args.count });
      for (const p of r.shown) attachImage?.({ src: `/api/photo/${p.id}`, caption: p.note, label: p.when, source: `${p.by} 傳的` });
      if (!r.total) return { found: 0, note: "這段期間聊天室裡沒有照片（存成票券的不算）。如果其實是想看網路上的圖片，可以改用 find_images" };
      if (!r.shown.length) return { found: 0, total: r.total, catalog: r.catalog, note: "照片說明裡找不到符合的；看 catalog 有沒有要的，有就用 ids 再呼叫一次，沒有就照實說" };
      return {
        shown: r.shown.length, total: r.total, photos: r.shown, ...(r.catalog.length ? { catalog: r.catalog } : {}),
        note: "photos 是符合條件、已經顯示在回答下方的照片（大家自己傳的，不是網路圖片，不用加「僅供參考」）。回答要跟這些照片一致，用說明簡短介紹，不要說找不到；如果明顯不是要的，可以從 catalog 挑 ids 再呼叫一次",
      };
    },
  },
  {
    label: "🎫 票券",
    decl: {
      name: "find_documents",
      description: "從票券保管箱找出票券或憑證，照片會顯示在回答下方。例如「給我看藤子博物館的票」。",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "關鍵字（票券名稱、備註或資料夾名稱），留空=全部" } } },
    },
    async run(args, { room, attachImage }) {
      const docs = room.documentFind(args.keyword);
      for (const d of docs.slice(0, 6)) attachImage?.({ src: `/api/photo/${d.photo_id}`, caption: d.note, label: d.title, source: `${d.author} 存的` });
      if (!docs.length) return { found: 0, note: "保管箱裡沒有符合的票券；可以在 下方「工具箱」→ 票券保管箱 上傳，或傳照片並說「存成票券」" };
      return { found: docs.length, documents: docs.map((d) => ({ id: d.id, title: d.title, note: d.note, by: d.author, folder: d.folder || "最外層" })), note: "票券照片已顯示在回答下方" };
    },
  },
];

// ---------------- 災害警報（地震、海嘯、颱風、強風豪雨） ----------------

const KANTO = ["東京都", "千葉県", "神奈川県", "埼玉県"];
export const SCALE_TEXT: Record<number, string> = { 10: "1", 20: "2", 30: "3", 40: "4", 45: "5弱", 50: "5強", 55: "6弱", 60: "6強", 70: "7" };

export async function japanAlerts() {
  const out: Record<string, unknown> = {};
  await Promise.all([
    (async () => {
      try {
        const list = await getJSON("https://api.p2pquake.net/v2/history?codes=551&codes=552&limit=20", undefined, 10_000);
        const since = Date.now() - 48 * 3600_000;
        out.earthquakes = (list as any[])
          .filter((e) => e.code === 551)
          .map((e) => {
            const kanto = (e.points ?? []).filter((p: any) => KANTO.includes(p.pref));
            const tokyoMax = kanto.reduce((mx: number, p: any) => Math.max(mx, p.scale ?? 0), 0);
            return {
              id: e.id,
              time: e.earthquake?.time,
              place: e.earthquake?.hypocenter?.name,
              magnitude: e.earthquake?.hypocenter?.magnitude,
              max_intensity: SCALE_TEXT[e.earthquake?.maxScale] ?? "不明",
              kanto_max_intensity: tokyoMax ? SCALE_TEXT[tokyoMax] : null,
              tsunami: e.earthquake?.domesticTsunami,
            };
          })
          .filter((e) => Date.parse(String(e.time).replace(/\//g, "-") + "+09:00") > since)
          .slice(0, 8);
        out.tsunami = (list as any[]).filter((e) => e.code === 552 && !e.cancelled).slice(0, 3).map((e) => ({ time: e.time, areas: (e.areas ?? []).map((a: any) => `${a.name}（${a.grade}）`) }));
      } catch {
        out.earthquakes = "暫時查不到";
      }
    })(),
    (async () => {
      try {
        const tcs = await getJSON("https://www.jma.go.jp/bosai/typhoon/data/targetTc.json", undefined, 10_000);
        out.typhoons = (tcs as any[]).map((t) => ({ number: t.typhoonNumber ? `第 ${Number(String(t.typhoonNumber).slice(2))} 號` : t.tropicalCyclone, category: t.category, issued: t.issue }));
      } catch {
        out.typhoons = "暫時查不到";
      }
    })(),
    (async () => {
      try {
        const w = await getJSON("https://www.jma.go.jp/bosai/warning/data/warning/130000.json", undefined, 10_000);
        out.tokyo_warning_headline = w.headlineText || "目前沒有特別提醒";
      } catch {}
    })(),
    (async () => {
      try {
        const f = await getJSON(
          `https://api.open-meteo.com/v1/forecast?latitude=${TRIP.accommodation.lat}&longitude=${TRIP.accommodation.lon}&timezone=Asia%2FTokyo&forecast_days=3&daily=precipitation_sum,wind_gusts_10m_max,weather_code`,
          undefined,
          10_000,
        );
        out.tokyo_forecast = (f.daily?.time ?? []).map((date: string, i: number) => ({
          date,
          rain_mm: f.daily.precipitation_sum[i],
          max_gust_kmh: f.daily.wind_gusts_10m_max[i],
          weather: WEATHER[f.daily.weather_code[i]] ?? f.daily.weather_code[i],
          severe: f.daily.wind_gusts_10m_max[i] >= 60 || f.daily.precipitation_sum[i] >= 30 || f.daily.weather_code[i] >= 95,
        }));
      } catch {}
    })(),
  ]);
  out.emergency = "緊急電話：警察 110、救護車／消防 119；日本觀光局 24 小時多語熱線 050-3816-2787（有中文）";
  out.source = "P2P地震情報、日本氣象廳、Open-Meteo";
  return out;
}

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
