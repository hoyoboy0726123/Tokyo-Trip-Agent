import { DurableObject } from "cloudflare:workers";
import { decryptText, encryptText, maskKey, safeEqual } from "./auth";
import { geminiProvider, parseArgs, providerFor, validateGemini, type GeminiGate } from "./providers";
import { GeminiLimiter, RateLimitedError } from "./ratelimit";
import { cleanRouteMap, routeMapPrompt, DRAFT_TOOLS, japanAlerts, reverseArea, runTool, SCALE_TEXT, toolLabel, TOOL_DECLS, type AttachedImage, type DraftInput, type ExpenseInput, type RoomApi } from "./tools";
import { fixMapLinks, type MapFixOptions } from "./maplinks";
import { renderDiaryPage } from "./diary-page";
import { looksJapanese, translate, type Lang } from "./translate";
import { DEFAULT_CHECKLIST, DEFAULT_PHRASES, INITIAL_ITINERARY, TRIP } from "./trip-data";
import type { Env, Part, Provider, SessionUser, Turn } from "./types";

const HISTORY_WINDOW = 24; // 每次帶給模型的最近訊息數（更早的靠自動回想找回，省 TPM）
const HISTORY_CHARS = 600; // 每則歷史訊息最多帶多少字
const PIN_LIMIT = 20; // 置頂訊息上限（每次狀態更新都會帶完整內容，不宜太多）

/** AI 看過照片後的說明（存起來，重寫日記不用再看一次） */
interface PhotoNote { kind: string; score: number; note: string }
/** 日記裡的照片：放在第幾段後面、照片說明 */
interface DiaryPhoto { id: string; para: number; caption: string }
const PHOTO_KINDS = ["景點", "風景", "美食", "人物", "購物", "交通", "住宿", "收據", "截圖", "文件", "旅途外", "其他"];
/** 不放進日記的照片（日記會分享給親友；收據截圖沒有閱讀價值；家裡的寵物、舊照片不是這趟旅行） */
const NOT_DIARY_PHOTO = new Set(["收據", "截圖", "文件", "旅途外"]);
/** 照片說明的評分標準版本：標準改了就加 1，舊的說明會重看一次 */
const PHOTO_NOTE_V = 2;
const hhmm = (ts: number) => new Date(ts + 9 * 3600_000).toISOString().slice(11, 16);

function parseJsonArray(text: string): any[] | null {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 日記原文：第一行標題，之後每行一段；照片標記 [P3｜說明] 跟在它描述的那段後面 */
function parseDiary(raw: string): { title: string; paragraphs: string[]; marks: { tag: string; para: number; caption: string }[] } {
  const MARK = /\[\s*(P\d+)\s*(?:[｜|:：]\s*([^\]\n]*))?\]/gi;
  const paragraphs: string[] = [];
  const marks: { tag: string; para: number; caption: string }[] = [];
  let title = "";
  for (const line of raw.replace(/```\w*/g, "").split("\n")) {
    const found = [...line.matchAll(MARK)];
    const rest = line.replace(MARK, "").replace(/^#+\s*|\*\*/g, "").trim();
    const named = rest.match(/^標題[:：]\s*(.+)$/);
    if (named || (!title && !paragraphs.length && rest && !found.length && rest.length <= 24)) {
      title = (named ? named[1] : rest).replace(/[「」『』"“”]/g, "").trim();
      continue;
    }
    if (rest) paragraphs.push(rest);
    for (const f of found) marks.push({ tag: f[1].toUpperCase(), para: Math.max(0, paragraphs.length - 1), caption: (f[2] ?? "").trim().slice(0, 40) });
  }
  return { title, paragraphs, marks };
}
const MAX_STEPS = 8; // 單次回答最多工具回合（含系統提醒／代為執行）
const FOREGROUND_MAX_WAIT = 10_000; // 回答問題時，Gemini 額度滿最多等幾毫秒，超過就改用備援
const MEMORY_EVERY = 4; // 每 4 則新的成員訊息自動整理一次長期記憶
const RECALL_LIMIT = 8; // 從較舊的聊天中自動找回的相關訊息數
const AI_NAME = "旅伴 AI";

/** 票券保管箱的一張票券（folder＝所在資料夾的完整路徑，最外層是空字串） */
type DocRow = { id: number; title: string; note: string; photo_id: string; author: string; ts: number; folder_id: number | null; folder: string };

type MessageRow = {
  id: string;
  ts: number;
  author: string;
  role: "user" | "assistant" | "system";
  text: string;
  photo_id: string | null;
  lat: number | null;
  lon: number | null;
  meta: string | null;
};

interface Attachment extends SessionUser {
  joined: number;
}

function newId(): string {
  return Date.now().toString(36) + crypto.randomUUID().slice(0, 6);
}

function jstNow(): { date: string; time: string; weekday: string } {
  const d = new Date(Date.now() + 9 * 3600_000);
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
    weekday: "日一二三四五六"[d.getUTCDay()],
  };
}

/**
 * 這些話一定要用工具處理。模型（尤其 Gemma）偶爾會「嘴上說已完成」卻沒呼叫工具，
 * 靠關鍵字抓出來：先提醒一次，再不做就由系統代為執行。順序有意義（打勾要先於加入清單）。
 */
const INTENTS: { tool: string; test: (text: string, hasPhoto: boolean) => boolean; alt?: string[] }[] = [
  { tool: "save_document", test: (t, p) => p && /存成票券|存起來|存進票券|收進票券|保存這張|存下來/.test(t) },
  { tool: "find_documents", test: (t) => /(給我看|找出|叫出|拿出).{0,12}(票|門票|票券|訂位|確認信|QR|登機證)/.test(t) },
  // 問幾站、要查證確認路線：找路線圖（官方優先）照圖回答
  { tool: "check_route_map", test: (t, p) => !p && ROUTE_VERIFY.test(t) && !/延誤|停駛|誤點|運行|計程車|taxi|uber|走路|步行/i.test(t) },
  // 要看 IG／YouTube 短片介紹
  { tool: "find_short_videos", test: (t, p) => !p && /短片|短影音|reels?\b|shorts|(找|看|有沒有|推薦).{0,8}(影片|視頻)|youtube|\big\b.{0,6}(影片|介紹|推薦)/i.test(t) },
  // 「路線圖」「傳圖給我」也算要看圖；自己附了照片時是要 AI 看那張照片，不是上網找圖
  { tool: "find_chat_photos", test: (t, p) => !p && OWN_PHOTO.test(t) && !/長什麼樣|網路|網上|存成|票券/.test(t), alt: ["find_images", "find_documents"] },
  { tool: "find_images", test: (t, p) => !p && /照片|圖片|相片|看圖|附圖|長什麼樣|路線圖|地鐵圖|捷運圖|平面圖|示意圖|菜單圖|(傳|給|找|看).{0,6}圖(?!書)|photo|picture|image/i.test(t) && !/存|票券|地圖/.test(t) && !OWN_PHOTO.test(t), alt: ["find_chat_photos", "check_route_map"] },
  { tool: "add_expense", test: (t, p) => (p && /收據|發票|記帳/.test(t)) || /(我付了|付了|花了|請客|記帳).{0,20}\d/.test(t) || /\d.{0,12}(日圓|円|元).{0,12}(我付|付的|記帳)/.test(t) },
  { tool: "create_reminder", test: (t) => /提醒(我|大家|全家|我們)/.test(t) && /\d/.test(t) },
  { tool: "update_checklist_item", test: (t) => /買到了|買好了|帶了|帶好了|打勾|已經買|辦好了|已經填|已經訂/.test(t) },
  // 只在明確說要加進清單時才算；「想買…幫我推薦」這類只是詢問，不能自動加
  { tool: "add_checklist_items", test: (t) => /(加入|加到|加進|放進|放到|列入|記到|記進|寫進|存進).{0,8}(清單|待辦)|清單.{0,4}(加|新增|放)/.test(t) },
  { tool: "taxi_fare", test: (t) => /(計程車|taxi|叫車|的士).{0,20}(多少|費用|車資|多久|錢|價)/i.test(t) || /車資/.test(t) },
  { tool: "japan_alerts", test: (t) => /地震|颱風|海嘯|警報|豪雨/.test(t) },
  { tool: "train_status", test: (t) => /延誤|停駛|誤點|停開|運行狀況|電車.{0,6}(正常|狀況)/.test(t) },
  { tool: "find_nearby", test: (t) => /附近|周邊|周圍|旁邊有什麼/.test(t), alt: ["web_search"] },
];

/** 一則訊息附的所有照片：多張時存在 meta.photos（第一張同時放在 photo_id，收據、票券等舊功能照用） */
function photosOf(m: { photo_id: string | null; meta: string | null }): string[] {
  try {
    const list = m.meta ? JSON.parse(m.meta).photos : null;
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch {}
  return m.photo_id ? [m.photo_id] : [];
}

/** 附了好幾張照片的訊息拆成一張一張（日記、找照片用）；同一張照片出現在好幾則訊息只留第一次 */
function photoRows<T extends { photo_id: string | null; meta: string | null }>(msgs: T[]): T[] {
  const seen = new Set<string>();
  return msgs.flatMap((m) => photosOf(m).filter((x) => !seen.has(x) && !!seen.add(x)).map((photo_id) => ({ ...m, photo_id })));
}

/** 一則訊息最多幾張照片（菜單好幾頁一起翻譯；再多 AI 的回答會太長、容易漏） */
const MAX_PHOTOS = 6;

/** 自己拍、傳到聊天室的照片（「第一天的照片」「我們在晴空塔的合照」「小佑傳的照片」）要翻聊天室，不是上網找 */
const OWN_PHOTO = /(我們|我的|我傳|我拍|大家|全家|家人|自己|第\s*[一二三四五六七八九十\d]+\s*天|今天|昨天|前天|那天|這幾天|\d{1,2}\s*[\/／月]\s*\d{1,2}|傳過|傳的|傳了|拍的|拍過|拍了|上傳).{0,12}(照片|相片|合照)|(照片|相片|合照).{0,8}(我們|大家|傳過|拍的|傳的)/;

const PHOTO_SYNONYMS: [RegExp, string][] = [
  [/合照|合影|全家|一家人|大家/, "合照 合影 全家 家人 一起"],
  [/風景|景色|景觀/, "風景 景色 景觀 景點"],
  [/夜景/, "夜景 夜晚 燈光"],
  [/吃|美食|食物|料理|大餐/, "美食 料理 餐點 食物"],
  [/小孩|孩子|兒子|女兒|寶寶/, "小孩 孩子 兒童"],
];

/** 照片說明和關鍵字有多像：整個詞出現 3 分；沒有就看中文兩字一組重疊多少（同義說法也算） */
function photoMatch(keyword: string, text: string): number {
  const grams = (s: string) => {
    const c = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const g = new Set<string>(c.length === 1 ? [c] : []);
    for (let i = 0; i < c.length - 1; i++) g.add(c.slice(i, i + 2));
    return g;
  };
  const words = [keyword, ...PHOTO_SYNONYMS.filter(([re]) => re.test(keyword)).map(([, w]) => w)].join(" ").split(/[\s、,，]+/).filter(Boolean);
  const hay = text.toLowerCase();
  const tg = grams(text);
  let score = 0;
  for (const w of words) {
    if (hay.includes(w.toLowerCase())) score += 3;
    else {
      const g = [...grams(w)];
      const hit = g.filter((x) => tg.has(x)).length / Math.max(g.length, 1);
      if (hit >= 0.6) score += hit;
    }
  }
  return score;
}


/** 這個問題一定要用到、但模型還沒呼叫的工具（沒有就回 null） */
function requiredTool(text: string, used: string[], hasPhoto: boolean): string | null {
  for (const i of INTENTS) {
    if (i.test(text, hasPhoto) && !used.includes(i.tool) && !(i.alt ?? []).some((a) => used.includes(a))) return i.tool;
  }
  return null;
}

function expenseBrief(r: Record<string, SqlStorageValue>) {
  return { id: r.id as number, date: r.date as string, description: r.description as string, amount: r.amount as number, currency: r.currency as string, payer: r.payer as string };
}

/** 民宿的專有寫法（房源名稱、地址、大樓名），出現在地圖連結裡就換成正確的位置 */
const HOME_NAMES = /IKEBUKURO\s*4|要町\s*1-44-8|1-44-8|セレッソ|Seresso/i;
/** 導航用的民宿地址（不含郵遞區號與大樓名，Google 地圖最穩） */
const HOME_ADDRESS = "東京都豊島区要町1-44-8";

/** 記憶超過幾條就改成只挑相關的、挑幾條（跟通用版的個人助理一樣） */
const MEMORY_ALL = 40;
const MEMORY_PICK = 25;
/** 語意相似度超過這個才加分；加多少 */
const SEM_MIN = 0.4;
const SEM_W = 10;

function bigrams(s: string): Set<string> {
  const clean = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

/** 兩句話是不是在講同一件事：雙字詞重疊比例（以短的那句為準） */
function sameFact(a: string, b: string): boolean {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return a.trim() === b.trim();
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / Math.min(x.size, y.size) >= 0.75;
}

function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function semanticBoost(sim: number | undefined): number {
  return sim != null && sim > SEM_MIN ? (sim - SEM_MIN) * SEM_W : 0;
}

/** 挑記憶用的文字：這則訊息加上它回覆的那則（「那第一天呢？」要靠被回覆的內容才知道在問什麼） */
function memoryText(m: { text: string; meta: string | null }): string {
  let quoted = "";
  try {
    quoted = m.meta ? String(JSON.parse(m.meta).reply?.text ?? "") : "";
  } catch {}
  return `${m.text} ${quoted.slice(0, 300)}`.trim();
}

/** 問幾站、或要查證確認路線：才去找路線圖照圖回答（平常問路照記憶回答，不寫站數） */
const ROUTE_WORD = "(路線|線|站|搭|坐|轉乘|換車|地鐵|電車|捷運|怎麼去)";
const CHECK_WORD = "(查證|確認|核對|確定|對不對|對嗎|正確嗎|沒錯嗎|官方|路線圖)";
const ROUTE_VERIFY = new RegExp(`幾站|站數|${CHECK_WORD}.{0,20}${ROUTE_WORD}|${ROUTE_WORD}.{0,20}${CHECK_WORD}`);

/** 問交通路線：備援模型（Gemma）記的路線比較不準，回答要加註 */
const ROUTE_ASK = /(怎麼|如何).{0,8}(去|到|搭|坐|走)|交通|路線|轉乘|換車|幾站|(搭|坐).{0,6}(線|車)|地鐵|捷運|電車|JR|新幹線|巴士|公車/;
const BACKUP_ROUTE_NOTE = "⚠️ 這次由備援模型回答，路線的方向和轉乘可能不準，出發前請以 Google 地圖為準。";

/** 憑記憶回答的路線：回答下方放查證按鈕，按了才去找路線圖（送出的問題帶著原本的問題，放久了再按也查得對） */
function routeCheckButton(question: string) {
  const q = question.replace(/@(ai|AI|旅伴|助理|小幫手)\s*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { hint: "路線是 AI 憑記憶回答的，可能有錯", buttons: [{ label: "🗺️ 上網找路線圖查證", text: `幫我上網找官方地鐵路線圖，查證「${q}」的路線對不對` }] };
}

/** 問景點、美食、餐廳：回答下方放「找相關短片」按鈕 */
const PLACE_ASK = /好吃|美食|餐廳|吃什麼|吃哪|拉麵|燒肉|壽司|咖啡|甜點|小吃|景點|好玩|推薦|必去|必吃|必逛|逛街|夜市|市場|商圈|神社|寺|公園|博物館|美術館|樂園|展望台|晴空塔|迪士尼|值得去/;
function videoButton(question: string) {
  const q = question.replace(/@(ai|AI|旅伴|助理|小幫手)\s*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { buttons: [{ label: "🎬 找相關短片", text: `幫我找剛才介紹的地點的 IG、YouTube 短片（原本的問題：「${q}」）` }] };
}

/** 模型自己寫的 IG／YouTube／TikTok 網址常是編的：不是工具找到的就拿掉（連結文字留著） */
const SOCIAL_HOST = /^https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|youtube\.com|youtu\.be|tiktok\.com)\//i;
function dropFakeVideoLinks(text: string, known: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (all, label: string, url: string) => (SOCIAL_HOST.test(url) && !known.includes(url) ? label : all))
    .replace(/https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|youtube\.com|youtu\.be|tiktok\.com)\/[^\s)）\]]+/gi, (url, offset: number, all: string) =>
      all[offset - 1] === "(" || known.includes(url) ? url : "",
    );
}

/** 沒附任何圖時，拿掉「依據…路線圖」「已附在下方」這類說法（模型會學前面查證過的回答） */
const MAP_CLAIM = /路線圖.{0,20}(已附|附在下方|附圖)|依據[:：]?.{0,20}路線圖/;
function dropMapClaims(text: string): string {
  return text
    .split("\n")
    .map((l) => (MAP_CLAIM.test(l) ? l.replace(/[（(][^（()）\n]*路線圖[^（()）\n]*[)）]/g, "") : l))
    .filter((l) => !MAP_CLAIM.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 模型偶爾學對話紀錄的格式，回答開頭多一個「［爸爸］」，存檔前拿掉 */
function stripSpeakerTag(text: string): string {
  // 也拿掉結尾假的工具呼叫文字（模型偶爾把 find_images{queries:[...]} 寫進回答）
  return text.replace(/^\s*［[^］\n]{1,16}］\s*/, "").replace(/(\s*\b[a-z]+(?:_[a-z]+)+\s*[{(][^\n]*[})])+\s*$/, "");
}

/** 對話紀錄裡標出「這則是在回覆誰的哪句話」 */
function replyNote(meta: string | null, max: number): string {
  const r = meta ? JSON.parse(meta).reply : null;
  return r ? `（回覆 ${r.author}：「${String(r.text).replace(/\s+/g, " ").slice(0, max)}」）` : "";
}

/** 分享連結用的隨機碼（24 個網址安全字元，猜不到） */
function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 回答裡說下方有確認卡片（用來抓「沒呼叫工具卻說有卡片」） */
function claimsCard(text: string): boolean {
  return /(下方|下面)的?.{0,8}(卡片|內容)|按\s*\**\s*「\s*確認|［卡片|確認卡片/.test(text);
}

/** 回答結尾在問成員問題（而且沒有謊稱已經寫入） */
function isAskingBack(text: string): boolean {
  const t = text.trim();
  return /[？?]/.test(t.slice(-80)) && !/已(經)?(幫你|幫您)?(記好|記下|記帳|記入|寫入|更新|修改|刪除)/.test(t);
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 金鑰指紋：分開記每把金鑰的每日用量，不存金鑰本身 */
async function keyTag(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class TripRoom extends DurableObject<Env> implements RoomApi {
  private sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();
  private limiter!: GeminiLimiter;
  /** 備援 Gemini 模型的額度在 Google 那邊是分開算的，冷卻也分開 */
  private backupLimiter!: GeminiLimiter;
  private resetLimiters: () => void;
  /** 管理員在設定裡換的 Gemini 金鑰；undefined = 還沒讀，"" = 用部署時設定的預設金鑰 */
  private customGemini: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const limits = { rpm: Number(env.GEMINI_RPM) || 15, tpm: Number(env.GEMINI_TPM) || 250_000, rpd: Number(env.GEMINI_RPD) || 500 };
    // 每把金鑰的每日用量分開記：換新金鑰馬上有整份額度，換回原本那把也接得上它的用量
    const dayKey = (key: string) => key + (this.setting("key_gemini") ? `_${this.setting("key_gemini_tag")}` : "");
    const dayStore = (key: string) => ({
      load: () => JSON.parse(this.setting(dayKey(key), '{"day":"","count":0}')),
      save: (v: { day: string; count: number }) => this.setSetting(dayKey(key), JSON.stringify(v)),
    });
    this.resetLimiters = () => {
      this.limiter = new GeminiLimiter(limits, dayStore("gemini_day"));
      this.backupLimiter = new GeminiLimiter(limits, dayStore("gemini_day_backup"));
    };
    this.resetLimiters();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, role TEXT, text TEXT, photo_id TEXT, lat REAL, lon REAL, meta TEXT);
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, mime TEXT, data BLOB);
      CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, category TEXT, content TEXT, author TEXT);
      CREATE TABLE IF NOT EXISTS embeddings (kind TEXT, ref INTEGER, hash TEXT, vec BLOB, PRIMARY KEY (kind, ref));
      CREATE TABLE IF NOT EXISTS itinerary (date TEXT PRIMARY KEY, title TEXT, detail TEXT, status TEXT, updated_at INTEGER, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, date TEXT, description TEXT, amount REAL, currency TEXT, amount_jpy INTEGER, amount_twd INTEGER, payer TEXT, split_among TEXT, category TEXT, author TEXT);
      CREATE TABLE IF NOT EXISTS locations (name TEXT PRIMARY KEY, lat REAL, lon REAL, accuracy REAL, ts INTEGER);
      CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER, ts INTEGER);
    `);
    // v3：翻譯頁（全家共用的常用句、翻譯紀錄）
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS phrases (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, zh TEXT, ja TEXT, kana TEXT, author TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS translations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, from_lang TEXT, source TEXT, result TEXT, reading TEXT);
    `);
    if (!this.setting("phrases_seeded")) {
      for (const p of DEFAULT_PHRASES) {
        this.sql.exec("INSERT INTO phrases (category, zh, ja, kana, author, ts) VALUES (?, ?, ?, ?, ?, ?)", p.category, p.zh, p.ja, p.kana, "預設", Date.now());
      }
      this.setSetting("phrases_seeded", "1");
    }
    // v4：共用清單、提醒、票券保管箱、旅遊日記
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, list TEXT, item TEXT, for_whom TEXT, author TEXT, done INTEGER DEFAULT 0, done_by TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, due INTEGER, message TEXT, author TEXT, created INTEGER, sent INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, author TEXT, title TEXT, note TEXT, photo_id TEXT);
      CREATE TABLE IF NOT EXISTS diaries (date TEXT PRIMARY KEY, ts INTEGER, text TEXT, photo_ids TEXT);
    `);
    // v5：AI 要寫入的資料（記帳、改行程、刪除）先做成確認卡片，成員按確認才寫入
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, payload TEXT, preview TEXT, author TEXT, message_id TEXT, status TEXT DEFAULT 'pending', resolved_by TEXT, resolved_at INTEGER);
    `);
    // v6：日記加上每天的標題
    if (!this.sql.exec("PRAGMA table_info(diaries)").toArray().some((c) => c.name === "title")) this.sql.exec("ALTER TABLE diaries ADD COLUMN title TEXT");
    // v7：置頂訊息（全家共用，等一下還要再看的資訊不會被洗掉）
    this.sql.exec("CREATE TABLE IF NOT EXISTS pins (message_id TEXT PRIMARY KEY, ts INTEGER, by TEXT)");
    // 票券保管箱的資料夾（可以一層層放）；票券的 folder_id 是 NULL＝放在最外層
    this.sql.exec("CREATE TABLE IF NOT EXISTS doc_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER, ts INTEGER, author TEXT)");
    if (!this.sql.exec("PRAGMA table_info(documents)").toArray().some((c) => c.name === "folder_id")) this.sql.exec("ALTER TABLE documents ADD COLUMN folder_id INTEGER");
    // 日記挑照片用：AI 看過每張照片的說明
    this.sql.exec("CREATE TABLE IF NOT EXISTS photo_notes (photo_id TEXT PRIMARY KEY, kind TEXT, score INTEGER, note TEXT, ts INTEGER, v INTEGER)");
    if (!this.sql.exec("PRAGMA table_info(photo_notes)").toArray().some((c) => c.name === "v")) this.sql.exec("ALTER TABLE photo_notes ADD COLUMN v INTEGER");
    // 家人修改日記：記下最後是誰改的
    for (const col of ["edited_by TEXT", "edited_at INTEGER", "layout TEXT"]) {
      if (!this.sql.exec("PRAGMA table_info(diaries)").toArray().some((c) => c.name === col.split(" ")[0])) this.sql.exec(`ALTER TABLE diaries ADD COLUMN ${col}`);
    }
    if (!this.setting("checklist_seeded")) {
      for (const c of DEFAULT_CHECKLIST) {
        this.sql.exec("INSERT INTO checklist (list, item, for_whom, author, ts) VALUES (?, ?, '', '預設', ?)", c.list, c.item, Date.now());
      }
      this.setSetting("checklist_seeded", "1");
    }
    // 排程（提醒、每日早報、旅遊日記、災害警報）靠 Durable Object 的 alarm，最多每 5 分鐘醒來一次
    ctx.blockConcurrencyWhile(async () => {
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
    // v2：位置多存一個地名（反查地址），讓 AI 不用自己猜座標在哪
    if (!this.sql.exec("PRAGMA table_info(locations)").toArray().some((c) => c.name === "area")) {
      this.sql.exec("ALTER TABLE locations ADD COLUMN area TEXT");
    }
    if (this.sql.exec("SELECT COUNT(*) AS n FROM itinerary").one().n === 0) {
      for (const d of INITIAL_ITINERARY) {
        this.sql.exec("INSERT INTO itinerary VALUES (?, ?, ?, ?, ?, ?)", d.date, d.title, d.detail, d.status, Date.now(), "初始行程");
      }
    }
  }

  // ================= 設定 =================

  private setting(key: string, fallback = ""): string {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0];
    return (row?.value as string) ?? fallback;
  }

  private setSetting(key: string, value: string) {
    this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** 管理員換過 Gemini 金鑰就用那把，否則用部署時設定的 GEMINI_API_KEY */
  private async aiEnv(): Promise<Env> {
    if (this.customGemini === undefined) {
      this.customGemini = await decryptText(this.env, this.setting("key_gemini"));
      if (!this.customGemini && this.setting("key_gemini")) {
        // 解不開（改過密碼）：當成沒換過
        for (const k of ["key_gemini", "key_gemini_mask", "key_gemini_tag"]) this.setSetting(k, "");
        this.resetLimiters();
      }
    }
    return this.customGemini ? { ...this.env, GEMINI_API_KEY: this.customGemini } : this.env;
  }

  private settings() {
    return {
      provider: this.setting("provider", this.env.DEFAULT_PROVIDER || "gemini"),
      replyMode: this.setting("reply_mode", "all"), // all | mention
      travelers: this.setting("travelers"),
      geminiModel: this.env.GEMINI_MODEL,
      workersModel: this.env.WORKERS_AI_MODEL,
      hasGemini: !!this.env.GEMINI_API_KEY || !!this.setting("key_gemini"),
      geminiKey: this.setting("key_gemini_mask"), // 管理員換上的金鑰（遮罩），空字串 = 用預設金鑰
      geminiDefault: !!this.env.GEMINI_API_KEY,
      hasTavily: !!this.env.TAVILY_API_KEY,
      autoBrief: this.setting("auto_brief", "1") === "1", // 每天 07:00 早報
      autoDiary: this.setting("auto_diary", "1") === "1", // 每天 22:00 旅遊日記
      autoAlerts: this.setting("auto_alerts", "1") === "1", // 地震、颱風、強風豪雨通知
      share: this.setting("share_token") ? `/share/${this.setting("share_token")}` : null, // 日記分享連結
    };
  }

  // ================= HTTP（登入、照片） =================

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const user: SessionUser = {
      name: decodeURIComponent(req.headers.get("x-user-name") ?? ""),
      admin: req.headers.get("x-user-admin") === "1",
    };

    if (url.pathname === "/login") return this.login(req);
    if (url.pathname === "/album") return this.album("member", req, url);
    const shared = url.pathname.match(/^\/share\/([\w-]+)(?:\/photo\/([\w-]+))?$/);
    if (shared) return this.shared(shared[1], shared[2], req, url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ...user, joined: Date.now() } satisfies Attachment);
      this.touchMember(user.name);
      this.sendHello(pair[1], user);
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/photos" && req.method === "GET") return this.photoList();
    if (url.pathname === "/expenses.csv" && req.method === "GET") return this.expensesCsv();

    if (url.pathname === "/photo" && req.method === "POST") {
      const mime = req.headers.get("content-type") ?? "image/jpeg";
      if (!mime.startsWith("image/")) return new Response("只接受圖片", { status: 400 });
      const data = await req.arrayBuffer();
      if (data.byteLength > 1_800_000) return new Response("圖片太大", { status: 413 });
      const id = newId();
      this.sql.exec("INSERT INTO photos VALUES (?, ?, ?, ?, ?)", id, Date.now(), user.name, mime, data);
      return Response.json({ id });
    }

    const photo = url.pathname.match(/^\/photo\/([\w-]+)$/);
    if (photo) {
      const row = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", photo[1]).toArray()[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.data as ArrayBuffer, { headers: { "content-type": row.mime as string, "cache-control": "private, max-age=31536000, immutable" } });
    }

    return new Response("Not found", { status: 404 });
  }

  private async login(req: Request): Promise<Response> {
    const ip = req.headers.get("x-ip") ?? "?";
    const { password = "", name = "" } = (await req.json().catch(() => ({}))) as { password?: string; name?: string };
    const row = this.sql.exec("SELECT count, ts FROM login_attempts WHERE ip = ?", ip).toArray()[0];
    const recent = row && Date.now() - (row.ts as number) < 15 * 60_000 ? (row.count as number) : 0;
    if (recent >= 8) return Response.json({ ok: false, error: "嘗試太多次，請 15 分鐘後再試" }, { status: 429 });

    const cleanName = name.trim().slice(0, 16);
    if (!cleanName) return Response.json({ ok: false, error: "請輸入暱稱" }, { status: 400 });
    if (cleanName === AI_NAME) return Response.json({ ok: false, error: "這個名字保留給 AI" }, { status: 400 });

    // Windows 用管線設定 secret 會多帶換行，比對前一律去掉前後空白
    const adminPw = (this.env.ADMIN_PASSWORD ?? "").trim();
    const roomPw = (this.env.ROOM_PASSWORD ?? "").trim();
    const pw = password.trim();
    const admin = !!adminPw && safeEqual(pw, adminPw);
    const member = admin || (!!roomPw && safeEqual(pw, roomPw));
    if (!member) {
      this.sql.exec(
        "INSERT INTO login_attempts VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = ?, ts = ?",
        ip, recent + 1, Date.now(), recent + 1, Date.now(),
      );
      return Response.json({ ok: false, error: "密碼不正確" }, { status: 401 });
    }
    this.sql.exec("DELETE FROM login_attempts WHERE ip = ?", ip);
    this.touchMember(cleanName);
    return Response.json({ ok: true, user: { name: cleanName, admin } });
  }

  private touchMember(name: string) {
    if (!name) return;
    this.sql.exec(
      "INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen",
      name, Date.now(), Date.now(),
    );
  }

  // ================= WebSocket =================

  private sockets(): { ws: WebSocket; user: Attachment }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, user: ws.deserializeAttachment() as Attachment }));
  }

  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  private broadcast(data: unknown) {
    const s = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {}
    }
  }

  private broadcastPresence() {
    const online = [...new Set(this.sockets().map((s) => s.user.name))];
    this.broadcast({ type: "presence", online });
  }

  private sendHello(ws: WebSocket, user: SessionUser) {
    this.send(ws, {
      type: "hello",
      version: this.env.CF_VERSION?.id ?? "",
      me: user,
      aiName: AI_NAME,
      settings: this.settings(),
      messages: this.recentMessages(60).map((m) => this.publicMessage(m)),
      locateReq: this.locateRequest(),
      state: this.state(),
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const user = ws.deserializeAttachment() as Attachment;
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong" });

      case "send": {
        const text = String(msg.text ?? "").slice(0, 4000).trim();
        // 一次最多 6 張（菜單好幾頁一起翻譯）；只收這個聊天室真的有的照片
        const asked = [...new Set<string>((Array.isArray(msg.photoIds) ? msg.photoIds : typeof msg.photoId === "string" ? [msg.photoId] : []).map(String))].slice(0, MAX_PHOTOS);
        const found = new Set(asked.length ? this.sql.exec(`SELECT id FROM photos WHERE id IN (${asked.map(() => "?").join(",")})`, ...asked).toArray().map((r) => r.id as string) : []);
        const photoIds = asked.filter((x) => found.has(x));
        const photoId = photoIds[0] ?? null;
        const loc = msg.location && Number.isFinite(msg.location.lat) ? msg.location : null;
        if (!text && !photoId && !loc) return;
        if (loc) this.saveLocation(user.name, loc);
        // 回覆某一則訊息：記下被回覆的是誰說的、說了什麼（畫面上顯示引用，AI 追問時也看得到）
        const quoted = typeof msg.replyTo === "string" ? this.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.replyTo).toArray()[0] : undefined;
        const reply = quoted ? { id: quoted.id, author: quoted.author, text: String(quoted.text ?? "").slice(0, 300) || (quoted.photo_id ? "（照片）" : "") } : null;
        const row = this.insertMessage({
          author: user.name, role: "user", text, photo_id: photoId, lat: loc?.lat ?? null, lon: loc?.lon ?? null,
          meta: reply || photoIds.length > 1 ? JSON.stringify({ ...(reply ? { reply } : {}), ...(photoIds.length > 1 ? { photos: photoIds } : {}) }) : null,
        });
        this.broadcast({ type: "message", message: this.publicMessage(row) });
        if (this.shouldReply(text, !!photoId, quoted?.role === "assistant")) {
          const job = this.queue.then(() => this.runAgent(row, user));
          this.queue = job.catch(() => {});
          await job;
        } else {
          // 只回 @AI 模式下，一般聊天也要被記住
          this.ctx.waitUntil(this.maybeConsolidateMemory());
        }
        return;
      }

      case "location":
        if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) this.saveLocation(user.name, msg);
        return;

      // 有人打開「家人位置」：請每支開著 App 的手機回報一次；沒開的人 30 分鐘內打開 App 也會補報
      case "locate_all": {
        const prev = this.locateRequest();
        if (prev && Date.now() - prev.ts < 60_000) return;
        const req = { by: user.name, ts: Date.now() };
        this.setSetting("locate_req", JSON.stringify(req));
        this.broadcast({ type: "locate_request", ...req });
        return;
      }

      case "load_more": {
        const before = Number(msg.before) || Date.now();
        const after = Number(msg.after) || 0;
        // after＝回到上次讀到的地方：一次補到未讀起點前兩則（最多 200 則）；平常往上捲每次 50 則
        const floor = after
          ? (this.sql.exec<{ ts: number }>("SELECT ts FROM messages WHERE ts <= ? ORDER BY ts DESC LIMIT 1 OFFSET 2", after).toArray()[0]?.ts ?? 0)
          : 0;
        const rows = this.sql
          .exec<MessageRow>(`SELECT * FROM messages WHERE ts < ? AND ts >= ? ORDER BY ts DESC LIMIT ${after ? 200 : 50}`, before, floor)
          .toArray()
          .reverse();
        const hasMore = rows.length > 0 && this.sql.exec("SELECT 1 FROM messages WHERE ts < ? LIMIT 1", rows[0].ts).toArray().length > 0;
        return this.send(ws, { type: "older", messages: rows.map((m) => this.publicMessage(m)), hasMore });
      }

      case "get_state":
        return this.send(ws, { type: "state", state: this.state() });

      case "action":
        return this.handleAction(ws, user, msg);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {}
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }

  private shouldReply(text: string, hasPhoto: boolean, toAi = false): boolean {
    if (!text && !hasPhoto) return false; // 單純分享位置不打擾 AI
    if (toAi) return true; // 回覆 AI 的訊息＝在問 AI，「只回 @AI」模式也要回答
    if (this.settings().replyMode === "all") return true;
    return /@(ai|AI|旅伴|助理|小幫手)/.test(text) || text.startsWith("/ai") || (hasPhoto && /@/.test(text));
  }

  // ================= 使用者在畫面上的操作 =================

  private async handleAction(ws: WebSocket, user: Attachment, msg: any) {
    const reply = (ok: boolean, error?: string) => this.send(ws, { type: "action_result", ok, error, action: msg.action });
    switch (msg.action) {
      case "add_memory":
        if (String(msg.content ?? "").trim()) this.addMemory(String(msg.content).trim(), msg.category || "資訊", user.name);
        break;
      case "delete_memory":
        this.deleteMemory(Number(msg.id));
        break;
      case "update_itinerary":
        this.updateItinerary(String(msg.date), { title: msg.title, detail: msg.detail, status: msg.status }, user.name);
        break;
      case "delete_expense":
        this.deleteExpense(Number(msg.id));
        break;
      case "add_expense": {
        const r: any = await runTool("add_expense", msg.expense ?? {}, { env: this.env, room: this, author: user.name });
        if (r?.error) return reply(false, r.error);
        break;
      }
      case "draft_confirm":
      case "draft_cancel": {
        const err = this.draftResolve(Number(msg.id), user.name, msg.action === "draft_confirm");
        if (err) return reply(false, err);
        break;
      }
      case "settings":
        if (!user.admin) return reply(false, "只有管理員可以修改設定");
        if (msg.provider === "gemini" || msg.provider === "workers-ai") this.setSetting("provider", msg.provider);
        if (msg.replyMode === "all" || msg.replyMode === "mention") this.setSetting("reply_mode", msg.replyMode);
        if (typeof msg.travelers === "string") {
          this.setSetting("travelers", msg.travelers.slice(0, 200));
          this.broadcastState();
        }
        for (const [k, key] of [["autoBrief", "auto_brief"], ["autoDiary", "auto_diary"], ["autoAlerts", "auto_alerts"]] as const) {
          if (typeof msg[k] === "boolean") this.setSetting(key, msg[k] ? "1" : "0");
        }
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "gemini_key": {
        if (!user.admin) return reply(false, "只有管理員可以換金鑰");
        const key = String(msg.key ?? "").trim();
        if (key) {
          const err = await validateGemini(key);
          if (err) return reply(false, err);
        }
        this.setSetting("key_gemini", await encryptText(this.env, key));
        this.setSetting("key_gemini_mask", maskKey(key));
        this.setSetting("key_gemini_tag", key ? await keyTag(key) : "");
        this.customGemini = key;
        // 新金鑰是另一份額度：舊金鑰的冷卻不帶過去
        this.resetLimiters();
        this.broadcast({ type: "settings", settings: this.settings() });
        this.broadcastState();
        break;
      }
      // ---- 清單 ----
      case "checklist_add": {
        const items = String(msg.item ?? "").split(/\n/).map((s) => s.trim()).filter(Boolean);
        if (!items.length) return reply(false, "請輸入項目");
        this.checklistAdd(String(msg.list || "購物"), items, String(msg.forWhom ?? ""), user.name);
        break;
      }
      case "checklist_toggle":
        this.checklistUpdate({ id: Number(msg.id) }, { done: !!msg.done }, user.name);
        break;
      case "checklist_delete":
        this.checklistUpdate({ id: Number(msg.id) }, { remove: true }, user.name);
        break;
      // ---- 提醒 ----
      case "reminder_add": {
        const due = Number(msg.due);
        if (!Number.isFinite(due) || due < Date.now() - 60_000) return reply(false, "提醒時間不正確或已經過了");
        this.reminderAdd(due, String(msg.message ?? "").slice(0, 300), user.name);
        break;
      }
      case "reminder_delete":
        this.reminderDelete(Number(msg.id));
        break;
      // ---- 票券 ----
      case "document_save":
        if (typeof msg.photoId !== "string") return reply(false, "請先選擇照片");
        this.documentSave(String(msg.title || "票券").slice(0, 80), String(msg.note ?? "").slice(0, 300), msg.photoId, user.name, this.folderId(msg.folder));
        break;
      case "document_delete":
        this.sql.exec("DELETE FROM documents WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      // ---- 票券資料夾：全家共用，誰都可以整理 ----
      case "document_move": {
        const folder = this.folderId(msg.folder);
        if (msg.folder != null && folder == null) return reply(false, "找不到這個資料夾，可能剛被刪掉了");
        this.sql.exec("UPDATE documents SET folder_id = ? WHERE id = ?", folder, Number(msg.id));
        this.broadcastState();
        break;
      }
      case "folder_create": {
        const name = String(msg.name ?? "").trim().slice(0, 40);
        if (!name) return reply(false, "請輸入資料夾名稱");
        const parent = this.folderId(msg.parent);
        if (this.sql.exec("SELECT 1 FROM doc_folders WHERE name = ? AND parent_id IS ?", name, parent).toArray().length) return reply(false, "這裡已經有同名的資料夾");
        this.sql.exec("INSERT INTO doc_folders (name, parent_id, ts, author) VALUES (?, ?, ?, ?)", name, parent, Date.now(), user.name);
        this.broadcastState();
        break;
      }
      case "folder_rename": {
        const id = this.folderId(msg.id);
        const name = String(msg.name ?? "").trim().slice(0, 40);
        if (id == null || !name) return reply(false, "找不到資料夾或名稱是空的");
        this.sql.exec("UPDATE doc_folders SET name = ? WHERE id = ?", name, id);
        this.broadcastState();
        break;
      }
      case "folder_move": {
        const id = this.folderId(msg.id);
        const parent = this.folderId(msg.parent);
        if (id == null) return reply(false, "找不到這個資料夾");
        if (parent != null && this.folderLineage(parent).includes(id)) return reply(false, "不能把資料夾搬進它自己裡面");
        this.sql.exec("UPDATE doc_folders SET parent_id = ? WHERE id = ?", parent, id);
        this.broadcastState();
        break;
      }
      // 刪資料夾不刪票券：裡面的票券和子資料夾都移到上一層
      case "folder_delete": {
        const id = this.folderId(msg.id);
        if (id == null) return reply(false, "找不到這個資料夾");
        const up = this.sql.exec("SELECT parent_id FROM doc_folders WHERE id = ?", id).one().parent_id ?? null;
        this.sql.exec("UPDATE documents SET folder_id = ? WHERE folder_id = ?", up, id);
        this.sql.exec("UPDATE doc_folders SET parent_id = ? WHERE parent_id = ?", up, id);
        this.sql.exec("DELETE FROM doc_folders WHERE id = ?", id);
        this.broadcastState();
        break;
      }
      // ---- 手動觸發早報／日記（管理員，出發前測試用） ----
      case "brief_now":
        if (!user.admin) return reply(false, "只有管理員可以使用");
        await this.postMorningBrief(jstNow().date);
        break;
      case "diary_now":
        if (!user.admin) return reply(false, "只有管理員可以使用");
        await this.writeDiary(jstNow().date);
        break;
      // 家人修改日記：標題、內文、照片（只能用已上傳的照片）；有人同時在改就擋下，免得互相蓋掉
      case "diary_edit": {
        const date = String(msg.date ?? "");
        const row = this.sql.exec("SELECT ts, layout FROM diaries WHERE date = ?", date).toArray()[0];
        if (!row) return reply(false, "找不到這天的日記");
        if (Number(msg.base) !== Number(row.ts)) return reply(false, "剛剛有人修改過這篇日記，請回上一頁重新打開再改");
        const title = String(msg.title ?? "").trim().slice(0, 40);
        const text = String(msg.text ?? "").trim().slice(0, 6000);
        const ids = (Array.isArray(msg.photos) ? msg.photos : []).map(String).filter((id: string) => /^[\w-]+$/.test(id)).slice(0, 30);
        const known = new Set(
          ids.length ? this.sql.exec(`SELECT id FROM photos WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map((r) => r.id as string) : [],
        );
        const photos: string[] = [...new Set<string>(ids.filter((id: string) => known.has(id)))];
        if (!title && !text && !photos.length) return reply(false, "日記不能全部清空");
        // 照片穿插在文章裡的位置（第幾段後面）不變，依新順序換成放哪一張；新加的照片放文末，說明跟著照片走
        const prev: DiaryPhoto[] = JSON.parse((row.layout as string) || "[]");
        let layout: DiaryPhoto[] | null = null;
        if (prev.length) {
          const byId = new Map(prev.map((l) => [l.id, l]));
          const slots = photos.map((id) => byId.get(id)?.para ?? 999).sort((a, b) => a - b);
          layout = photos.map((id, i) => ({ id, para: slots[i], caption: byId.get(id)?.caption ?? "" }));
        }
        const now = Date.now();
        this.sql.exec(
          "UPDATE diaries SET title = ?, text = ?, photo_ids = ?, layout = ?, ts = ?, edited_by = ?, edited_at = ? WHERE date = ?",
          title, text, JSON.stringify(photos), layout ? JSON.stringify(layout) : null, now, user.name, now, date,
        );
        this.broadcastState();
        break;
      }
      case "pin": {
        const id = String(msg.id ?? "");
        if (!this.sql.exec("SELECT 1 FROM messages WHERE id = ?", id).toArray().length) return reply(false, "找不到這則訊息");
        if ((this.sql.exec("SELECT COUNT(*) AS n FROM pins").one().n as number) >= PIN_LIMIT) return reply(false, `置頂最多 ${PIN_LIMIT} 則，請先取消不需要的`);
        this.sql.exec("INSERT OR IGNORE INTO pins VALUES (?, ?, ?)", id, Date.now(), user.name);
        this.broadcastState();
        break;
      }
      case "unpin":
        this.sql.exec("DELETE FROM pins WHERE message_id = ?", String(msg.id ?? ""));
        this.broadcastState();
        break;
      case "diary_rewrite": {
        if (!user.admin) return reply(false, "只有管理員可以重寫日記");
        const date = String(msg.date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !this.sql.exec("SELECT 1 FROM diaries WHERE date = ?", date).toArray().length) return reply(false, "找不到這天的日記");
        await this.writeDiary(date, false);
        break;
      }
      // 日記分享連結：開啟後拿到連結的人不用登入就能看日記與照片，關閉後舊連結立刻失效
      case "share_on":
      case "share_off":
        if (!user.admin) return reply(false, "只有管理員可以開關分享連結");
        this.setSetting("share_token", msg.action === "share_on" ? this.setting("share_token") || randomToken() : "");
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "translate": {
        const text = String(msg.text ?? "").trim().slice(0, 1000);
        if (!text) return reply(false, "請輸入要翻譯的內容");
        // 選了中文卻打日文（或反過來）時自動修正方向
        let from: Lang = msg.from === "ja" ? "ja" : "zh";
        if (from === "zh" && looksJapanese(text)) from = "ja";
        try {
          const r = await translate(this.env, text, from);
          const id = this.sql
            .exec(
              "INSERT INTO translations (ts, author, from_lang, source, result, reading) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
              Date.now(), user.name, from, text, r.translation, r.reading ?? null,
            )
            .one().id as number;
          const item = this.sql.exec("SELECT * FROM translations WHERE id = ?", id).one();
          // 全家共用紀錄：發問者用 reqId 對應自己的結果，其他人更新紀錄清單
          this.broadcast({ type: "translation", reqId: msg.reqId ?? null, author: user.name, item, engine: r.engine });
        } catch (e: any) {
          return reply(false, `翻譯失敗：${e?.message ?? e}`);
        }
        break;
      }
      case "get_translations":
        this.send(ws, { type: "translations", items: this.sql.exec("SELECT * FROM translations ORDER BY ts DESC LIMIT 60").toArray() });
        return;
      case "add_phrase": {
        const zh = String(msg.zh ?? "").trim().slice(0, 200);
        const category = String(msg.category ?? "⭐ 我的常用句").slice(0, 20);
        if (!zh) return reply(false, "請輸入中文");
        let ja = String(msg.ja ?? "").trim().slice(0, 400);
        let kana = "";
        if (!ja) {
          try {
            const r = await translate(this.env, zh, "zh");
            ja = r.translation;
            kana = r.reading ?? "";
          } catch (e: any) {
            return reply(false, `翻譯失敗：${e?.message ?? e}`);
          }
        }
        this.sql.exec("INSERT INTO phrases (category, zh, ja, kana, author, ts) VALUES (?, ?, ?, ?, ?, ?)", category, zh, ja, kana, user.name, Date.now());
        this.broadcastState();
        break;
      }
      case "delete_phrase":
        this.sql.exec("DELETE FROM phrases WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
      case "reset": {
        // 管理員清除資料：測試結束正式使用前、或換一趟新行程時用。只清勾選的項目
        if (!user.admin) return reply(false, "只有管理員可以清除資料");
        const cleared: string[] = [];
        if (msg.chat) {
          this.sql.exec("DELETE FROM messages");
          this.sql.exec("DELETE FROM drafts");
          this.sql.exec("DELETE FROM pins");
          this.sql.exec("DELETE FROM photos");
          this.sql.exec("DELETE FROM photo_notes");
          this.sql.exec("DELETE FROM locations");
          this.sql.exec("DELETE FROM translations");
          this.setSetting("memory_cursor", "0");
          this.broadcast({ type: "cleared" });
          cleared.push("聊天紀錄");
        }
        if (msg.memory) {
          this.sql.exec("DELETE FROM memories");
          this.setSetting("summary", "");
          // 聊天沒清時，舊聊天不再重新整理成記憶
          if (!msg.chat) this.setSetting("memory_cursor", String(Date.now()));
          cleared.push("長期記憶");
        }
        if (msg.expenses) {
          this.sql.exec("DELETE FROM expenses");
          cleared.push("帳目");
        }
        if (msg.itinerary) {
          this.sql.exec("DELETE FROM itinerary");
          for (const d of INITIAL_ITINERARY) {
            this.sql.exec("INSERT INTO itinerary VALUES (?, ?, ?, ?, ?, ?)", d.date, d.title, d.detail, d.status, Date.now(), "初始行程");
          }
          cleared.push("行程（還原預設）");
        }
        if (msg.tools) {
          this.sql.exec("DELETE FROM checklist");
          this.sql.exec("DELETE FROM reminders");
          this.sql.exec("DELETE FROM documents");
          this.sql.exec("DELETE FROM doc_folders");
          this.sql.exec("DELETE FROM diaries");
          cleared.push("清單、提醒、票券、日記");
        }
        if (!cleared.length) return reply(false, "請至少勾選一項");
        console.log(`reset by ${user.name}: ${cleared.join("、")}`);
        this.broadcastState();
        break;
      }
      default:
        return reply(false, "未知的操作");
    }
    reply(true);
  }

  // ================= 訊息 =================

  private insertMessage(m: Omit<MessageRow, "id" | "ts"> & { id?: string }): MessageRow {
    const row: MessageRow = { id: m.id ?? newId(), ts: Date.now(), ...m } as MessageRow;
    this.sql.exec(
      "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, row.ts, row.author, row.role, row.text, row.photo_id, row.lat, row.lon, row.meta,
    );
    return row;
  }

  private recentMessages(limit: number): MessageRow[] {
    return this.sql.exec<MessageRow>("SELECT * FROM messages ORDER BY ts DESC LIMIT ?", limit).toArray().reverse();
  }

  private publicMessage(m: MessageRow) {
    const meta = m.meta ? JSON.parse(m.meta) : null;
    return {
      id: m.id,
      ts: m.ts,
      author: m.author,
      role: m.role,
      text: m.text,
      photo: m.photo_id ? `/api/photo/${m.photo_id}` : null,
      ...(photosOf(m).length > 1 ? { photos: photosOf(m).map((x) => `/api/photo/${x}`) } : {}),
      location: m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon } : null,
      meta,
      ...(meta?.drafts?.length ? { drafts: this.draftsPublic(meta.drafts) } : {}),
    };
  }

  // ================= 確認卡片（AI 要寫入的資料，成員按確認才寫） =================

  /** AI 呼叫會寫入的工具時：存成卡片，回給模型的說明要它請成員核對 */
  private propose(d: DraftInput, author: string, messageId: string, drafts: number[]) {
    if (d.replaces) this.draftSettle(d.replaces, "superseded", author);
    const id = this.sql
      .exec(
        "INSERT INTO drafts (ts, kind, payload, preview, author, message_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        Date.now(), d.kind, JSON.stringify(d.payload), JSON.stringify(d.preview), author, messageId,
      )
      .one().id as number;
    drafts.push(id);
    return {
      draft_id: id,
      status: "等待成員按確認，還沒寫入",
      preview: d.preview.rows,
      ...(d.warning ? { warning: d.warning } : {}),
      note: `已產生確認卡片 #${id}，會顯示在你的回答下方。請用一兩句話說明你從照片或訊息看到什麼、準備寫入什麼，請成員核對卡片後按「${d.preview.confirm}」，有錯直接跟你說要改哪裡。${d.warning ? `一定要提醒成員：${d.warning}。` : ""}卡片上已經有換算好的金額，說明裡不要自己換算。這段說明要寫在你這次的回覆裡（之前寫的字成員看不到）。成員按確認前不可以說「已記好／已更新／已刪除」。`,
    };
  }

  private draftsPublic(ids: number[]) {
    const list = ids.map(Number).filter(Number.isInteger).slice(0, 20);
    if (!list.length) return [];
    const rows = this.sql.exec(`SELECT * FROM drafts WHERE id IN (${list.map(() => "?").join(",")})`, ...list).toArray();
    return rows.map((r) => ({
      id: r.id as number,
      kind: r.kind as string,
      status: r.status as string,
      preview: JSON.parse(r.preview as string),
      author: r.author as string,
      resolved_by: (r.resolved_by as string | null) ?? null,
    }));
  }

  /** 還在等確認的卡片才改狀態，並通知大家更新畫面 */
  private draftSettle(id: number, status: "done" | "cancelled" | "superseded" | "failed", by: string) {
    const n = this.sql.exec("UPDATE drafts SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", status, by, Date.now(), id).rowsWritten;
    if (n) this.broadcast({ type: "draft", draft: this.draftsPublic([id])[0] });
    return n > 0;
  }

  /** 成員按了確認或取消；回傳錯誤訊息（成功是 null） */
  private draftResolve(id: number, by: string, confirm: boolean): string | null {
    const r = this.sql.exec("SELECT * FROM drafts WHERE id = ?", id).toArray()[0];
    if (!r) return "找不到這張卡片";
    if (r.status !== "pending") return "這張卡片已經處理過了";
    if (!confirm) {
      this.draftSettle(id, "cancelled", by);
      return null;
    }
    const p = JSON.parse(r.payload as string);
    let ok = true;
    switch (r.kind) {
      case "add_expense":
        this.addExpense(p as ExpenseInput);
        break;
      case "update_itinerary":
        this.updateItinerary(p.date, p.fields, p.author);
        break;
      case "delete_expense":
        ok = this.deleteExpense(Number(p.id));
        break;
      case "delete_reminder":
        ok = this.reminderDelete(Number(p.id));
        break;
      default:
        ok = false;
    }
    this.draftSettle(id, ok ? "done" : "failed", by);
    return ok ? null : "要刪除的資料已經不在了（可能有人先刪了，或提醒已經通知過）";
  }

  /** 給系統提示用：最近幾天的卡片與狀態（不放進對話紀錄，免得模型模仿格式、自己寫假卡片） */
  private draftBrief(): string {
    const status: Record<string, string> = { pending: "等待成員確認（還沒寫入）", done: "已確認並寫入", cancelled: "成員取消了", superseded: "已被新卡片取代", failed: "失效" };
    return this.sql
      .exec("SELECT id, preview, author, status, resolved_by FROM drafts WHERE ts > ? ORDER BY id DESC LIMIT 10", Date.now() - 3 * 86400_000)
      .toArray()
      .reverse()
      .map((r) => {
        const p = JSON.parse(r.preview as string);
        return `- 卡片編號 ${r.id}｜${p.title}：${p.summary}｜${r.author} 提出｜${status[r.status as string] ?? r.status}${r.status === "done" ? `（${r.resolved_by}）` : ""}`;
      })
      .join("\n");
  }

  private saveLocation(name: string, loc: { lat: number; lon: number; accuracy?: number }) {
    // 移動不到 200 公尺就沿用上次查到的地名，省得每次都反查
    const prev = this.memberLocation(name)[0];
    const keepArea = prev?.area && distanceMeters(prev.lat, prev.lon, loc.lat, loc.lon) < 200 ? prev.area : null;
    this.sql.exec(
      `INSERT INTO locations (name, lat, lon, accuracy, ts, area) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, accuracy = excluded.accuracy, ts = excluded.ts, area = excluded.area`,
      name, loc.lat, loc.lon, loc.accuracy ?? null, Date.now(), keepArea,
    );
    // 地圖開著的人馬上看到新位置；地名查好再更新一次
    this.broadcast({ type: "locations", locations: this.memberLocation() });
    if (!keepArea) this.ctx.waitUntil(this.ensureArea(name).then(() => this.broadcast({ type: "locations", locations: this.memberLocation() })));
  }

  /** 最近 30 分鐘內有人在找家人（之後才打開 App 的人也要補報位置） */
  private locateRequest(): { by: string; ts: number } | null {
    try {
      const r = JSON.parse(this.setting("locate_req") || "null");
      return r && Date.now() - r.ts < 30 * 60_000 ? r : null;
    } catch {
      return null;
    }
  }

  /** 反查成員目前位置的地名並存起來（最多等 8 秒，失敗就算了，下次再查） */
  private async ensureArea(name: string): Promise<string | null> {
    const l = this.memberLocation(name)[0];
    if (!l) return null;
    if (l.area) return l.area;
    try {
      const area = await reverseArea(l.lat, l.lon);
      if (area) this.sql.exec("UPDATE locations SET area = ? WHERE name = ? AND ts = ?", area, name, l.ts);
      return area || null;
    } catch {
      return null;
    }
  }

  // ================= RoomApi（給工具用） =================

  /** 旅伴名單：管理員設定的優先，否則用登入過的人 */
  members(): string[] {
    const configured = this.setting("travelers").split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (configured.length) return configured;
    return this.sql.exec("SELECT name FROM members ORDER BY first_seen").toArray().map((r) => r.name as string);
  }

  memberLocation(name?: string) {
    const rows = name
      ? this.sql.exec("SELECT * FROM locations WHERE name = ?", name).toArray()
      : this.sql.exec("SELECT * FROM locations ORDER BY ts DESC").toArray();
    return rows.map((r) => ({
      name: r.name as string, lat: r.lat as number, lon: r.lon as number,
      accuracy: r.accuracy as number | null, ts: r.ts as number, area: (r.area as string | null) ?? null,
    }));
  }

  addMemory(content: string, category: string, author: string): number {
    const id = this.sql
      .exec("INSERT INTO memories (ts, category, content, author) VALUES (?, ?, ?, ?) RETURNING id", Date.now(), category, content.slice(0, 500), author)
      .one().id as number;
    this.broadcastState();
    return id;
  }

  deleteMemory(id: number): boolean {
    const n = this.sql.exec("DELETE FROM memories WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  searchHistory(keyword: string, limit: number) {
    const words = String(keyword).split(/\s+/).filter(Boolean).slice(0, 4);
    if (!words.length) return [];
    const where = words.map(() => "text LIKE ?").join(" AND ");
    const likes = words.map((w) => `%${w}%`);
    // 翻譯紀錄也一起搜（原文或譯文有關鍵字就算）
    const tWhere = words.map(() => "(source LIKE ? OR result LIKE ?)").join(" AND ");
    const tLikes = likes.flatMap((l) => [l, l]);
    const rows = [
      ...this.sql.exec(`SELECT ts, author, text FROM messages WHERE ${where} ORDER BY ts DESC LIMIT ?`, ...likes, limit).toArray(),
      ...this.sql
        .exec(`SELECT ts, author, '［翻譯］' || source || ' → ' || result AS text FROM translations WHERE ${tWhere} ORDER BY ts DESC LIMIT ?`, ...tLikes, limit)
        .toArray(),
    ];
    return rows
      .sort((a, b) => (b.ts as number) - (a.ts as number))
      .slice(0, limit)
      .map((r) => ({
        time: new Date((r.ts as number) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " "),
        author: r.author as string,
        text: String(r.text).slice(0, 400),
        ts: r.ts as number,
      }));
  }

  updateItinerary(date: string, fields: { title?: string; detail?: string; status?: string }, author: string) {
    const cur = this.sql.exec("SELECT * FROM itinerary WHERE date = ?", date).toArray()[0];
    const next = {
      title: fields.title ?? (cur?.title as string) ?? "",
      detail: fields.detail ?? (cur?.detail as string) ?? "",
      status: fields.status ?? (cur?.status as string) ?? "",
    };
    this.sql.exec(
      "INSERT INTO itinerary VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title, detail = excluded.detail, status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      date, next.title, next.detail, next.status, Date.now(), author,
    );
    this.broadcastState();
    return { date, ...next, updated_by: author };
  }

  addExpense(e: ExpenseInput) {
    const id = this.sql
      .exec(
        "INSERT INTO expenses (ts, date, description, amount, currency, amount_jpy, amount_twd, payer, split_among, category, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        Date.now(), e.date, e.description, e.amount, e.currency, e.amountJpy, e.amountTwd, e.payer, JSON.stringify(e.splitAmong), e.category, e.author,
      )
      .one().id as number;
    this.broadcastState();
    return { id, ...e };
  }

  deleteExpense(id: number): boolean {
    const n = this.sql.exec("DELETE FROM expenses WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  expenseGet(id: number) {
    const r = this.sql.exec("SELECT * FROM expenses WHERE id = ?", id).toArray()[0];
    return r ? expenseBrief(r) : null;
  }

  expenseFind(keyword: string) {
    return this.sql.exec("SELECT * FROM expenses WHERE description LIKE ? ORDER BY id DESC LIMIT 8", `%${keyword}%`).toArray().map(expenseBrief);
  }

  itineraryDay(date: string) {
    const r = this.sql.exec("SELECT * FROM itinerary WHERE date = ?", date).toArray()[0];
    return r ? { title: (r.title as string) ?? "", detail: (r.detail as string) ?? "", status: (r.status as string) ?? "" } : null;
  }

  expenseSummary() {
    const rows = this.sql.exec("SELECT * FROM expenses ORDER BY ts").toArray();
    const paid: Record<string, number> = {};
    const owe: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let total = 0, totalTwd = 0;
    for (const r of rows) {
      const jpy = r.amount_jpy as number;
      total += jpy;
      totalTwd += r.amount_twd as number;
      paid[r.payer as string] = (paid[r.payer as string] ?? 0) + jpy;
      const split = JSON.parse((r.split_among as string) || "[]") as string[];
      const share = split.length ? jpy / split.length : 0;
      for (const p of split) owe[p] = (owe[p] ?? 0) + share;
      byCategory[r.category as string] = (byCategory[r.category as string] ?? 0) + jpy;
      byDay[r.date as string] = (byDay[r.date as string] ?? 0) + jpy;
    }
    const people = [...new Set([...Object.keys(paid), ...Object.keys(owe)])];
    const balance = people.map((p) => ({ name: p, paid: Math.round(paid[p] ?? 0), share: Math.round(owe[p] ?? 0), net: Math.round((paid[p] ?? 0) - (owe[p] ?? 0)) }));
    // 最少轉帳次數的結算建議
    const creditors = balance.filter((b) => b.net > 0).map((b) => ({ ...b })).sort((a, b) => b.net - a.net);
    const debtors = balance.filter((b) => b.net < 0).map((b) => ({ ...b, net: -b.net })).sort((a, b) => b.net - a.net);
    const transfers: { from: string; to: string; jpy: number }[] = [];
    for (const d of debtors) {
      for (const c of creditors) {
        if (d.net <= 0) break;
        if (c.net <= 0) continue;
        const x = Math.min(d.net, c.net);
        if (x >= 1) transfers.push({ from: d.name, to: c.name, jpy: Math.round(x) });
        d.net -= x;
        c.net -= x;
      }
    }
    return {
      total_jpy: Math.round(total),
      total_twd: Math.round(totalTwd),
      count: rows.length,
      balance,
      transfers,
      by_category: byCategory,
      by_day: byDay,
      items: rows.slice(-40).map((r) => ({
        id: r.id, date: r.date, description: r.description, amount: r.amount, currency: r.currency,
        jpy: r.amount_jpy, twd: r.amount_twd, payer: r.payer, split_among: JSON.parse((r.split_among as string) || "[]"), category: r.category,
      })),
    };
  }

  cacheGet(key: string, maxAgeMs: number): string | null {
    const row = this.sql.exec("SELECT value, ts FROM cache WHERE key = ?", key).toArray()[0];
    return row && Date.now() - (row.ts as number) < maxAgeMs ? (row.value as string) : null;
  }

  cacheSet(key: string, value: string) {
    this.sql.exec("INSERT INTO cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts", key, value, Date.now());
  }

  // ---- 清單 ----

  checklistAdd(list: string, items: string[], forWhom: string, author: string) {
    const added = items.map(
      (item) =>
        this.sql
          .exec("INSERT INTO checklist (list, item, for_whom, author, ts) VALUES (?, ?, ?, ?, ?) RETURNING id, list, item, for_whom", list, item.slice(0, 200), forWhom.slice(0, 20), author, Date.now())
          .one(),
    );
    this.broadcastState();
    return { added };
  }

  checklistUpdate(match: { id?: number; keyword?: string; list?: string }, patch: { done?: boolean; remove?: boolean }, by: string) {
    let rows: Record<string, SqlStorageValue>[] = [];
    if (match.id) rows = this.sql.exec("SELECT * FROM checklist WHERE id = ?", match.id).toArray();
    else if (match.keyword) {
      rows = match.list
        ? this.sql.exec("SELECT * FROM checklist WHERE list = ? AND item LIKE ?", match.list, `%${match.keyword}%`).toArray()
        : this.sql.exec("SELECT * FROM checklist WHERE item LIKE ?", `%${match.keyword}%`).toArray();
    }
    if (!rows.length) return { error: "清單裡找不到這個項目" };
    if (rows.length > 3 && !match.id) return { error: "符合的項目太多，請說得更具體", matches: rows.map((r) => ({ id: r.id, item: r.item })) };
    for (const r of rows) {
      if (patch.remove) this.sql.exec("DELETE FROM checklist WHERE id = ?", r.id);
      else if (typeof patch.done === "boolean") this.sql.exec("UPDATE checklist SET done = ?, done_by = ? WHERE id = ?", patch.done ? 1 : 0, patch.done ? by : null, r.id);
    }
    this.broadcastState();
    return { updated: rows.map((r) => ({ id: r.id, item: r.item, list: r.list })), action: patch.remove ? "刪除" : patch.done ? "打勾" : "取消勾選" };
  }

  checklistGet(list?: string) {
    const rows = list
      ? this.sql.exec("SELECT * FROM checklist WHERE list = ? ORDER BY done, id", list).toArray()
      : this.sql.exec("SELECT * FROM checklist ORDER BY list, done, id").toArray();
    return rows.map((r) => ({ id: r.id, list: r.list, item: r.item, for: r.for_whom || undefined, done: !!r.done, done_by: r.done_by || undefined }));
  }

  // ---- 提醒 ----

  reminderAdd(due: number, message: string, author: string) {
    const row = this.sql
      .exec("INSERT INTO reminders (due, message, author, created) VALUES (?, ?, ?, ?) RETURNING id, due, message", due, message, author, Date.now())
      .one();
    this.broadcastState();
    this.ctx.waitUntil(this.scheduleNext());
    return { ...row, time: new Date(due + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") + "（東京時間）" };
  }

  reminderList() {
    return this.sql
      .exec("SELECT * FROM reminders WHERE sent = 0 ORDER BY due")
      .toArray()
      .map((r) => ({ id: r.id, time: new Date((r.due as number) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " "), message: r.message, by: r.author }));
  }

  reminderDelete(id: number): boolean {
    const n = this.sql.exec("DELETE FROM reminders WHERE id = ?", id).rowsWritten;
    this.broadcastState();
    return n > 0;
  }

  reminderGet(id: number) {
    const r = this.sql.exec("SELECT * FROM reminders WHERE id = ? AND sent = 0", id).toArray()[0];
    return r ? { id, time: new Date((r.due as number) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " "), message: r.message as string } : null;
  }

  // ---- 票券保管箱 ----

  documentSave(title: string, note: string, photoId: string, author: string, folder: number | null = null) {
    const row = this.sql
      .exec("INSERT INTO documents (ts, author, title, note, photo_id, folder_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, title", Date.now(), author, title, note, photoId, folder)
      .one();
    this.broadcastState();
    const where = folder == null ? "" : `的「${this.folderPaths().get(folder) ?? ""}」資料夾`;
    return { saved: row, note: `已存進 下方「工具箱」→ 票券保管箱${where}，打開過一次之後沒網路也看得到` };
  }

  /** 關鍵字比對票券名稱、備註和所在資料夾（例如「機票」可以找出機票資料夾裡的全部） */
  documentFind(keyword?: string) {
    const words = String(keyword ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
    const paths = this.folderPaths();
    const rows = (this.sql.exec("SELECT * FROM documents ORDER BY ts DESC").toArray() as unknown as Omit<DocRow, "folder">[]).map((d) => ({
      ...d,
      folder: d.folder_id == null ? "" : paths.get(Number(d.folder_id)) ?? "",
    }));
    return words.length ? rows.filter((d) => words.every((w) => `${d.title} ${d.note} ${d.folder}`.toLowerCase().includes(w))) : rows;
  }

  /** AI 存票券時指定的資料夾：用名稱找（哪一層都可以），找不到就在最外層建一個 */
  documentFolder(name: string, author: string): number | null {
    const n = name.trim().slice(0, 40);
    if (!n) return null;
    const hit = this.sql.exec("SELECT id FROM doc_folders WHERE name = ? ORDER BY parent_id IS NOT NULL, id LIMIT 1", n).toArray()[0];
    if (hit) return Number(hit.id);
    const id = Number(this.sql.exec("INSERT INTO doc_folders (name, parent_id, ts, author) VALUES (?, NULL, ?, ?) RETURNING id", n, Date.now(), author).one().id);
    this.broadcastState();
    return id;
  }

  /** 前端傳來的資料夾：沒指定或不存在＝最外層（null） */
  private folderId(v: unknown): number | null {
    const id = Number(v);
    if (v == null || v === "" || !Number.isInteger(id)) return null;
    return this.sql.exec("SELECT 1 FROM doc_folders WHERE id = ?", id).toArray().length ? id : null;
  }

  /** 從這個資料夾一路往上到最外層（含自己），用來擋「把資料夾搬進自己裡面」 */
  private folderLineage(id: number): number[] {
    const out: number[] = [];
    let cur: number | null = id;
    while (cur != null && !out.includes(cur)) {
      out.push(cur);
      const up: unknown = this.sql.exec("SELECT parent_id FROM doc_folders WHERE id = ?", cur).toArray()[0]?.parent_id;
      cur = up == null ? null : Number(up);
    }
    return out;
  }

  /** 每個資料夾的完整路徑，例如「機票／回程」 */
  private folderPaths(): Map<number, string> {
    const rows = this.sql.exec("SELECT id, name, parent_id FROM doc_folders").toArray();
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const path = (id: number, seen: Set<number>): string => {
      const r = byId.get(id);
      if (!r || seen.has(id)) return "";
      seen.add(id);
      const up = r.parent_id == null ? "" : path(Number(r.parent_id), seen);
      return up ? `${up}／${r.name}` : String(r.name);
    };
    return new Map(rows.map((r) => [Number(r.id), path(Number(r.id), new Set())]));
  }

  // ================= 排程：提醒、每日早報、旅遊日記、災害警報 =================

  /** 下一次醒來：最近的提醒時間，最晚 5 分鐘後（檢查早報、日記、警報） */
  private async scheduleNext() {
    const next = this.sql.exec("SELECT MIN(due) AS due FROM reminders WHERE sent = 0").one().due as number | null;
    const at = Math.max(Date.now() + 5_000, Math.min(next ?? Infinity, Date.now() + 5 * 60_000));
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    try {
      await this.deliverReminders();
      const now = jstNow();
      const hour = Number(now.time.slice(0, 2));
      const inTrip = now.date >= TRIP.startDate && now.date <= TRIP.endDate;
      const s = this.settings();
      if (inTrip && s.autoBrief && hour >= 7 && hour < 11 && this.setting("brief_sent") !== now.date) await this.postMorningBrief(now.date);
      if (inTrip && s.autoDiary && hour >= 22 && this.setting("diary_sent") !== now.date) await this.writeDiary(now.date);
      // 警報從出發前一天開始
      const alertStart = new Date(Date.parse(TRIP.startDate + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
      if (s.autoAlerts && now.date >= alertStart && now.date <= TRIP.endDate) await this.pollAlerts(now.date);
    } catch (e) {
      console.error("alarm failed", e);
    } finally {
      await this.scheduleNext();
    }
  }

  /** 以 AI 身分在群組發一則訊息（提醒、早報、日記、警報共用） */
  private postAiMessage(text: string, meta: Record<string, unknown>) {
    const row = this.insertMessage({ author: AI_NAME, role: "assistant", text: fixMapLinks(text, this.mapFix()), photo_id: null, lat: null, lon: null, meta: JSON.stringify(meta) });
    this.broadcast({ type: "message", message: this.publicMessage(row) });
    return row;
  }

  private async deliverReminders() {
    const due = this.sql.exec("SELECT * FROM reminders WHERE sent = 0 AND due <= ? ORDER BY due", Date.now() + 30_000).toArray();
    for (const r of due) {
      this.sql.exec("UPDATE reminders SET sent = 1 WHERE id = ?", r.id);
      this.postAiMessage(`⏰ **提醒**：${r.message}\n\n（${r.author} 設定的提醒）`, { kind: "reminder" });
    }
    if (due.length) this.broadcastState();
  }

  /** 不用工具、只產生文字（早報、日記）：Gemini 有額度就用，不然用 Gemma */
  private async generatePlain(system: string, prompt: string, maxTokens?: number): Promise<string> {
    const order = this.settings().provider === "workers-ai" || !this.settings().hasGemini ? ["workers-ai", "gemini", "gemini-backup"] : ["gemini", "workers-ai", "gemini-backup"];
    for (const pid of order) {
      if (pid !== "workers-ai" && !this.settings().hasGemini) continue;
      try {
        const r = await providerFor(await this.aiEnv(), pid, this.geminiGate(1, 5_000, undefined, pid === "gemini-backup")).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], maxTokens });
        if (r.text.trim()) return r.text.trim();
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error(`generatePlain via ${pid} failed`, e);
      }
    }
    throw new Error("AI 暫時無法產生內容");
  }

  /** 日記：長文又要照格式，先用比較會寫的模型（一天一篇，額度跟聊天分開），不行再用一般的 */
  private async generateLong(system: string, prompt: string): Promise<string> {
    const writer = this.env.GEMINI_WRITER_MODEL;
    if (writer && this.settings().hasGemini) {
      try {
        const r = await geminiProvider(await this.aiEnv(), writer).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }], timeoutMs: 150_000 });
        if (r.text.trim()) return r.text.trim();
      } catch (e) {
        console.error(`diary via ${writer} failed`, e);
      }
    }
    return this.generatePlain(system, prompt, 4096);
  }

  async postMorningBrief(date: string) {
    this.setSetting("brief_sent", date);
    const today = this.itinerary().find((d) => d.date === date);
    const [weather, alerts] = await Promise.all([
      runTool("get_weather", { days: 2 }, { env: this.env, room: this, author: AI_NAME }),
      japanAlerts().catch(() => ({})),
    ]);
    const reminders = this.reminderList().filter((r) => String(r.time).startsWith(date));
    const todos = this.checklistGet("待辦").filter((c) => !c.done);
    const prompt = `請幫家庭旅遊群組寫今天（${date}）的「☀️ 早安早報」內文（標題系統會加，你不要再寫標題），繁體中文、親切、適合手機閱讀、300 字內，條列重點：
1. 今天的行程與建議出門時間（考慮 2 大 2 小）
2. 天氣與穿著、要不要帶傘
3. 今天的提醒與待辦
4. 如果有地震、颱風或強風豪雨，放在最前面提醒
資料：
- 今天行程：${today ? `${today.title}｜${today.detail}｜${today.status}` : "沒有排行程"}
- 天氣：${JSON.stringify(weather).slice(0, 1500)}
- 警報：${JSON.stringify(alerts).slice(0, 1500)}
- 今天的提醒：${JSON.stringify(reminders)}
- 未完成待辦：${JSON.stringify(todos.slice(0, 8))}
- 住宿：${TRIP.accommodation.name}，${TRIP.accommodation.nearestStation}`;
    const text = await this.generatePlain(this.systemPrompt(), prompt);
    this.postAiMessage(`☀️ **早安！${date.slice(5).replace("-", "/")} 早報**\n\n${text}`, { kind: "brief" });
  }

  /** 只根據路線圖回答怎麼搭（check_route_map 用）；密密麻麻的路線圖只有 Gemini 看得清楚，不能用就回 null */
  async readRouteMap(image: { bytes: ArrayBuffer; mime: string }, origin: string, destination: string, city: string, proposal = "") {
    const order = this.settings().hasGemini ? ["gemini", "gemini-backup"] : [];
    for (const pid of order) {
      try {
        const r = await providerFor(await this.aiEnv(), pid, this.geminiGate(1, 20_000, undefined, pid === "gemini-backup")).generate({
          system: "你只根據使用者給的路線圖回答，看不到的不要用記憶補，只輸出 JSON。",
          turns: [{ role: "user", parts: [{ image: { mime: image.mime, data: toBase64(image.bytes) } }, { text: routeMapPrompt(city, origin, destination, proposal) }] }],
          json: true,
          timeoutMs: 60_000,
        });
        return cleanRouteMap(parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()), origin, destination);
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error(`readRouteMap via ${pid} failed`, e);
      }
    }
    return null;
  }

  /**
   * 翻大家傳到聊天室的照片（存成票券、證件的不算）：照日期、誰傳的、內容找。
   * 內容靠日記用的照片說明（photo_notes）；還沒看過的先請 AI 看，一次最多 30 張
   */
  async chatPhotos(q: { date?: unknown; dateTo?: unknown; sender?: unknown; keyword?: unknown; ids?: string[]; count?: unknown }) {
    const day = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    const from = day(q.date), to = day(q.dateTo) ?? from;
    const where = ["photo_id IS NOT NULL", "role = 'user'"];
    const args: number[] = [];
    if (from) {
      where.push("ts >= ?");
      args.push(Date.parse(from + "T00:00:00Z") - 9 * 3600_000);
    }
    if (to) {
      where.push("ts < ?");
      args.push(Date.parse(to + "T00:00:00Z") - 9 * 3600_000 + 86400_000);
    }
    const docs = new Set(this.sql.exec("SELECT photo_id FROM documents WHERE photo_id IS NOT NULL").toArray().map((r) => r.photo_id as string));
    let rows = photoRows(this.sql.exec<MessageRow>(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY ts`, ...args).toArray()).filter((m) => !docs.has(m.photo_id as string));
    const sender = String(q.sender ?? "").trim();
    if (sender) rows = rows.filter((m) => m.author.includes(sender) || sender.includes(m.author));
    // 說明一次全部讀出來（IN 清單有參數個數上限），沒看過的再請 AI 看
    const notes = new Map<string, PhotoNote>(
      this.sql.exec("SELECT * FROM photo_notes WHERE v = ?", PHOTO_NOTE_V).toArray().map((r) => [String(r.photo_id), { kind: String(r.kind), score: Number(r.score), note: String(r.note) }]),
    );
    const missing = rows.filter((m) => !notes.has(m.photo_id as string)).slice(-30);
    if (missing.length) for (const [k, v] of await this.describePhotos(missing)) notes.set(k, v);
    const item = (m: MessageRow) => {
      const n = notes.get(m.photo_id as string);
      return { id: m.photo_id as string, when: `${Number(new Date(m.ts + 9 * 3600_000).toISOString().slice(5, 7))}/${Number(new Date(m.ts + 9 * 3600_000).toISOString().slice(8, 10))} ${hhmm(m.ts)}`, by: m.author, kind: n?.kind ?? "", note: n?.note ?? (m.text ? `附言：${m.text.slice(0, 60)}` : "（還沒看過）"), score: n?.score ?? 3, ts: m.ts };
    };
    const keyword = String(q.keyword ?? "").trim();
    // 收據、截圖、文件預設不列（問「收據的照片」「菜單」才列）
    const info = /收據|發票|截圖|文件|菜單|票/.test(keyword);
    const all = rows.map(item);
    const items = all.filter((x) => info || !NOT_DIARY_PHOTO.has(x.kind));
    const count = Math.min(8, Math.max(1, Number(q.count) || 6));
    let picked: typeof items;
    if (q.ids?.length) picked = all.filter((x) => q.ids!.includes(x.id)).slice(0, 8);
    else if (keyword) {
      picked = items
        .map((x) => ({ x, s: photoMatch(keyword, `${x.kind} ${x.note}`) }))
        .filter((h) => h.s > 0)
        .sort((a, b) => b.s - a.s || b.x.score - a.x.score)
        .slice(0, count)
        .map((h) => h.x);
    } else picked = [...items].sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, count);
    picked.sort((a, b) => a.ts - b.ts);
    // 給模型挑的清單：照片太多就留精彩度高的 30 張
    const catalog = (items.length > 30 ? [...items].sort((a, b) => b.score - a.score).slice(0, 30).sort((a, b) => a.ts - b.ts) : items)
      .filter((x) => !picked.includes(x))
      .map(({ id, when, by, kind, note }) => ({ id, when, by, kind, note }));
    return { total: rows.length, shown: picked.map(({ id, when, by, kind, note }) => ({ id, when, by, kind, note })), catalog };
  }

  /**
   * 日記挑照片前先看過每張照片：拍了什麼、適不適合放進日記（收據、截圖、證件不放）。
   * 看過的存進 photo_notes，重寫日記不用再看；一次送 5 張，照片多也不會太慢
   */
  private async describePhotos(rows: MessageRow[]): Promise<Map<string, PhotoNote>> {
    const notes = new Map<string, PhotoNote>();
    const ids = rows.map((m) => m.photo_id as string);
    if (!ids.length) return notes;
    for (const r of this.sql.exec(`SELECT * FROM photo_notes WHERE v = ? AND photo_id IN (${ids.map(() => "?").join(",")})`, PHOTO_NOTE_V, ...ids).toArray()) {
      notes.set(r.photo_id as string, { kind: String(r.kind), score: Number(r.score), note: String(r.note) });
    }
    const todo = rows.filter((m) => !notes.has(m.photo_id as string));
    const order = this.settings().hasGemini ? ["gemini", "gemini-backup", "workers-ai"] : ["workers-ai"];
    for (let i = 0; i < todo.length; i += 5) {
      const batch = todo.slice(i, i + 5).flatMap((m) => {
        const p = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", m.photo_id).toArray()[0];
        return p ? [{ m, image: { mime: p.mime as string, data: toBase64(p.data as ArrayBuffer) } }] : [];
      });
      if (!batch.length) continue;
      const parts: Part[] = [
        {
          text: `以下是家庭旅遊群組今天的 ${batch.length} 張照片，依序編號。請逐張判斷，只輸出 JSON 陣列：[{"n":1,"kind":"…","score":3,"note":"…"}]
kind 只能是：${PHOTO_KINDS.join("、")}（收據＝收據、發票、帳單；截圖＝手機或網頁畫面截圖；文件＝票券、證件、表單等文字資料；旅途外＝不是這趟旅行拍的，例如家裡的寵物、家裡、舊照片）
note：繁體中文 20–60 字，具體寫出看到什麼：地點或招牌、食物或商品名稱、人（大人或小孩）在做什麼、表情動作；看不出來的照實寫，不要猜人名
score：當旅遊日記插圖的價值，大部分照片是 2–4 分：
5＝一看就有故事（家人生動的表情或互動、壯觀的景色、招牌美食上桌）
4＝好看的旅途紀錄（景點、街景、店面、美食、家人合照）
3＝普通的紀錄
2＝資訊類照片（菜單、時刻表、告示牌、販賣機、垃圾桶、商品包裝特寫），或沒有重點的日常照（低頭滑手機、排隊等待、只拍到背影）
1＝沒意義（模糊、隨手亂拍、看不出內容）`,
        },
      ];
      batch.forEach(({ m, image }, k) => {
        parts.push({ text: `照片 ${k + 1}（${hhmm(m.ts)} ${m.author} 傳${m.text ? `，附言：「${m.text.slice(0, 80)}」` : ""}）` });
        parts.push({ image });
      });
      let parsed: any[] | null = null;
      for (const pid of order) {
        try {
          const r = await providerFor(await this.aiEnv(), pid, this.geminiGate(1, 20_000, undefined, pid === "gemini-backup")).generate({
            system: "你是幫家庭旅遊日記挑照片的編輯，只輸出 JSON。",
            turns: [{ role: "user", parts }],
            json: true,
          });
          parsed = parseJsonArray(r.text);
          if (parsed) break;
        } catch (e) {
          if (!(e instanceof RateLimitedError)) console.error(`describePhotos via ${pid} failed`, e);
        }
      }
      for (const x of parsed ?? []) {
        const hit = batch[Number(x?.n) - 1];
        if (!hit) continue;
        const note: PhotoNote = {
          kind: PHOTO_KINDS.includes(x.kind) ? x.kind : "其他",
          score: Math.min(5, Math.max(1, Math.round(Number(x.score) || 3))),
          note: String(x.note ?? "").slice(0, 120),
        };
        notes.set(hit.m.photo_id as string, note);
        this.sql.exec(
          "INSERT OR REPLACE INTO photo_notes (photo_id, kind, score, note, ts, v) VALUES (?, ?, ?, ?, ?, ?)",
          hit.m.photo_id, note.kind, note.score, note.note, Date.now(), PHOTO_NOTE_V,
        );
      }
    }
    return notes;
  }

  /** announce＝在群組貼出來（每晚自動寫）；管理員重寫舊日記時不貼 */
  async writeDiary(date: string, announce = true) {
    if (announce) this.setSetting("diary_sent", date);
    const start = Date.parse(date + "T00:00:00Z") - 9 * 3600_000;
    const msgs = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts", start, start + 86400_000).toArray();
    // 證件、票券照片絕對不能進日記（日記可以分享給親友）
    const docs = new Set(this.sql.exec("SELECT photo_id FROM documents WHERE photo_id IS NOT NULL").toArray().map((r) => r.photo_id as string));
    const photoMsgs = photoRows(msgs.filter((m) => m.photo_id && m.role === "user")).filter((m) => !docs.has(m.photo_id as string)).slice(-40);
    const notes = await this.describePhotos(photoMsgs);
    const score = (m: MessageRow) => notes.get(m.photo_id as string)?.score ?? 3;
    // 可以放進日記的照片依時間編號 P1、P2…；太多就留精彩度高的
    let pool = photoMsgs.filter((m) => {
      const n = notes.get(m.photo_id as string);
      return !n || (!NOT_DIARY_PHOTO.has(n.kind) && n.score >= 3);
    });
    if (pool.length > 30) {
      const keep = new Set([...pool].sort((a, b) => score(b) - score(a)).slice(0, 30));
      pool = pool.filter((m) => keep.has(m));
    }
    const tag = new Map(pool.map((m, i) => [m.photo_id as string, `P${i + 1}`]));
    const catalog = pool
      .map((m) => {
        const n = notes.get(m.photo_id as string);
        return `[${tag.get(m.photo_id as string)}] ${hhmm(m.ts)} ${m.author} 傳｜${n ? `${n.kind}｜精彩度 ${n.score}｜${n.note}` : "（沒有說明）"}${m.text ? `｜附言：「${m.text.slice(0, 60)}」` : ""}`;
      })
      .join("\n");
    // 出發前預付的機票、住宿、門票（台幣大額）也記在出發日，不能當成當天花費；只拿當天買的東西當寫作素材
    const bought = this.sql
      .exec("SELECT ts, description, category FROM expenses WHERE date = ? AND currency = 'JPY' AND amount < 30000 ORDER BY ts", date)
      .toArray()
      .slice(0, 30)
      .map((r) => `${hhmm(Number(r.ts))} ${r.description}${r.category ? `（${r.category}）` : ""}`);
    const today = this.itinerary().find((d) => d.date === date);
    // 整天的對話都要看到（不是只看最後一段）；太長先拿掉 AI 的回答，再不夠才截頭尾
    const lines = (withAi: boolean) =>
      msgs
        .filter((m) => m.role === "user" || (withAi && m.role === "assistant" && !(m.meta && JSON.parse(m.meta).kind)))
        .map((m) => {
          if (m.role === "assistant") {
            const t = m.text.replace(/\s+/g, " ");
            return `${hhmm(m.ts)} ${AI_NAME}：${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`;
          }
          const tags = photosOf(m).filter((x) => tag.has(x)).map((x) => tag.get(x));
          const pic = m.photo_id ? (tags.length ? `（傳了照片 ${tags.join("、")}）` : "（傳了照片）") : "";
          return `${hhmm(m.ts)} ${m.author}：${m.text.slice(0, 300)}${pic}`;
        })
        .join("\n");
    let transcript = lines(true);
    if (transcript.length > 14000) transcript = lines(false);
    if (transcript.length > 14000) transcript = `${transcript.slice(0, 7000)}\n…（中間省略）…\n${transcript.slice(-7000)}`;
    const plan = today ? `${today.title}${today.detail ? `（${String(today.detail).slice(0, 300)}）` : ""}` : "自由活動";
    const prompt = `請根據下面的資料，幫這個${TRIP.travelers}寫 ${date} 的旅遊日記，繁體中文，像家人一起回憶這一天，溫馨、生動、有畫面。

【寫法】
- 第一行寫「標題：」加上標題（8–16 字，生動有畫面，不加引號），空一行後寫內文。
- 先從對話、記帳和照片整理出今天的時間軸（幾點在哪裡、做了什麼），再依時間順序寫成完整的一天：出門、交通、去了哪些地方、吃了什麼、買了什麼、路上發生的事、晚上回到住處。每段寫一個時段或場景，段落之間空一行。
- 挑出當天最精彩有趣的片段多寫一點：小朋友的趣事、家人說的有趣的話（可以直接引用原話）、意外的小插曲、驚喜或感動的時刻。寫出具體的店名、景點、食物和商品名稱，不要寫「吃了美食」「逛了街」這種空泛的句子；每個場景寫出當時的氣氛、心情和小朋友的反應。
- 寫成當下發生的事，不要寫「傳了照片」「在群組問」「拍下了」這類描述，也不要描述照片的構圖或表情細節（例如「直視鏡頭」）。照片只是插圖，不要為了用照片硬寫內容。
- 最後一段做個溫暖的小結，可以帶到對明天的期待。
- 長短跟著資料走：對話和照片多的日子寫 6–9 段、每段 150–220 字、全文 900–1500 字；資料少就寫短一點，不要用想像的畫面或情節湊字數。絕對不要編造資料裡沒有的地點、事件或對話。
- 旅伴（AI）的回答只是建議或解答，不代表家人真的去了，要以家人說的話、照片和記帳為準。不要寫花了多少錢，不要提到 AI、手機或群組。
- 家人的稱呼照對話裡的用法，不要自己取名字。照片清單不會寫照片裡是誰：傳照片的人通常是拍照的人，不一定在照片裡。內文和照片說明提到照片裡的人，只有附言或對話說清楚是誰才寫名字，不然寫「孩子們」「小傢伙」「大家」，不要猜。

【照片】
- 從照片清單挑 5–10 張最精彩、而且跟內文對得上的照片（照片少就挑好的就好），優先用精彩度 4–5 分的。放在寫到那個場景的段落後面，另起一行寫成 [P編號｜照片說明]，例如：
[P3｜終於買到心心念念的鋼彈！]
- 照片說明 6–18 字，像相簿裡溫馨或俏皮的小標，不要照抄照片清單的描述，但內容要跟照片相符。
- 每段最多放 2 張；每張照片最多用一次；很像的照片只挑最好的一張；跟段落內容對不上的不要放。

日期：${date}
原本的行程：${plan}（只是計畫，實際去了哪裡以對話和照片為準）
今天記帳的品項（記帳時間）：${bought.join("、") || "（沒有記帳）"}
照片清單：
${catalog || "（今天沒有照片）"}
群組對話：
${transcript || "（今天群組沒什麼對話）"}`;
    const raw = await this.generateLong("你是幫家庭寫旅遊日記的溫暖作家，文筆生動細膩，只根據提供的資料寫。", prompt);
    const { paragraphs, marks, ...parsed } = parseDiary(raw);
    // 模型沒寫標題（第一行就是內文）：標題用當天行程
    const title = parsed.title && parsed.title.length <= 30 ? parsed.title : today ? String(today.title) : "旅途中的一天";
    const text = paragraphs.join("\n\n");
    const byTag = new Map(pool.map((m) => [tag.get(m.photo_id as string)!, m.photo_id as string]));
    const used = new Set<string>();
    const picked: DiaryPhoto[] = marks.flatMap((k) => {
      const id = byTag.get(k.tag);
      if (!id || used.has(id)) return [];
      used.add(id);
      return [{ id, para: k.para, caption: k.caption }];
    });
    // 模型常常一段塞好多張：每段最多 2 張、整篇最多 10 張，超過的留精彩度高的
    const noteScore = (id: string) => notes.get(id)?.score ?? 3;
    const keep = new Set<string>();
    const perPara = new Map<number, number>();
    for (const l of [...picked].sort((a, b) => noteScore(b.id) - noteScore(a.id))) {
      if (keep.size >= 10 || (perPara.get(l.para) ?? 0) >= 2) continue;
      keep.add(l.id);
      perPara.set(l.para, (perPara.get(l.para) ?? 0) + 1);
    }
    const layout = picked.filter((l) => keep.has(l.id));
    // 模型沒放照片標記：挑精彩度高的照片，照舊版排法穿插
    const photos = layout.length
      ? layout.map((l) => l.id)
      : [...pool].sort((a, b) => score(b) - score(a)).slice(0, 8).sort((a, b) => a.ts - b.ts).map((m) => m.photo_id as string);
    this.sql.exec(
      "INSERT INTO diaries (date, ts, title, text, photo_ids, layout) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, title = excluded.title, text = excluded.text, photo_ids = excluded.photo_ids, layout = excluded.layout, edited_by = NULL, edited_at = NULL",
      date, Date.now(), title, text, JSON.stringify(photos), layout.length ? JSON.stringify(layout) : null,
    );
    if (announce) {
      const caption = new Map(layout.map((l) => [l.id, l.caption]));
      const images: AttachedImage[] = photos.slice(0, 8).map((id) => ({ src: `/api/photo/${id}`, caption: caption.get(id) ?? "", source: "今天的照片" }));
      this.postAiMessage(
        `📔 **${date.slice(5).replace("-", "/")} 旅遊日記｜${title}**\n\n${text}\n\n（下方「工具箱」→ 旅遊日記：看圖文版、下載 PDF 或分享給親友）`,
        { kind: "diary", images },
      );
    }
    this.broadcastState();
  }

  /** 地震（關東震度 3 以上）、海嘯、新颱風、隔天強風豪雨：有新狀況才在群組發通知 */
  private async pollAlerts(date: string) {
    const a: any = await japanAlerts();
    const seen: string[] = JSON.parse(this.setting("alerts_seen", "[]"));
    const first = !this.setting("alerts_initialized");
    const notes: string[] = [];
    for (const q of Array.isArray(a.earthquakes) ? a.earthquakes : []) {
      const key = `eq:${q.id}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      const scale = Object.entries(SCALE_TEXT).find(([, v]) => v === q.kanto_max_intensity)?.[0];
      if (!first && scale && Number(scale) >= 30) {
        notes.push(`🌏 **地震**：${q.time} ${q.place} 規模 ${q.magnitude}，**關東最大震度 ${q.kanto_max_intensity}**${q.tsunami && q.tsunami !== "None" ? `，海嘯：${q.tsunami}` : "，無海嘯疑慮"}`);
      }
    }
    for (const t of Array.isArray(a.tsunami) ? a.tsunami : []) {
      const key = `ts:${t.time}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      if (!first && t.areas?.some((x: string) => /東京|千葉|神奈川|相模|九十九里/.test(x))) notes.push(`🌊 **海嘯警報**：${t.areas.join("、")}。請遠離海岸，往高處移動！`);
    }
    for (const t of Array.isArray(a.typhoons) ? a.typhoons : []) {
      const key = `tc:${t.number}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      if (!first) notes.push(`🌀 **颱風**：氣象廳發布了${t.number}颱風的資訊，可以問我「颱風會不會影響行程」。`);
    }
    const severe = (Array.isArray(a.tokyo_forecast) ? a.tokyo_forecast : []).filter((d: any) => d.severe && d.date >= date).slice(0, 2);
    for (const d of severe) {
      const key = `wx:${d.date}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      notes.push(`🌧 **${d.date.slice(5).replace("-", "/")} 天氣警示**：${d.weather}，雨量約 ${d.rain_mm} mm、陣風 ${d.max_gust_kmh} km/h，戶外行程請準備雨具或考慮室內備案。`);
    }
    this.setSetting("alerts_seen", JSON.stringify(seen.slice(-200)));
    this.setSetting("alerts_initialized", "1");
    if (notes.length) {
      this.postAiMessage(`⚠️ **警報通知**\n\n${notes.join("\n\n")}\n\n緊急電話：警察 110、救護車／消防 119；日本觀光局 24 小時中文熱線 050-3816-2787`, { kind: "alert" });
    }
  }

  /** 旅遊日記網頁（成員版／分享版）：封面＋每天一章，可以列印成 PDF */
  private album(mode: "member" | "share", req: Request, url: URL): Response {
    const origin = req.headers.get("x-origin") ?? "";
    const token = this.setting("share_token");
    const photoBase = mode === "share" ? `/share/${token}/photo/` : "/api/photo/";
    const plan = new Map(this.itinerary().map((d) => [String(d.date), String(d.title ?? "")]));
    const start = Date.parse(TRIP.startDate + "T00:00:00Z");
    const days = this.sql
      .exec("SELECT * FROM diaries ORDER BY date")
      .toArray()
      .map((d) => {
        const date = String(d.date);
        const layout = new Map((JSON.parse((d.layout as string) || "[]") as DiaryPhoto[]).map((l) => [l.id, l]));
        return {
          date,
          dayNo: Math.floor((Date.parse(date + "T00:00:00Z") - start) / 86400_000) + 1,
          title: String(d.title || plan.get(date) || "旅途中的一天"),
          plan: plan.get(date) ?? "",
          text: String(d.text ?? ""),
          photos: (JSON.parse((d.photo_ids as string) || "[]") as string[]).map((id) => {
            const l = layout.get(id);
            return { src: photoBase + id, para: l?.para, caption: l?.caption };
          }),
        };
      });
    const html = renderDiaryPage({
      tripTitle: TRIP.title,
      dates: `${TRIP.startDate.replaceAll("-", "/")} – ${TRIP.endDate.slice(5).replace("-", "/")}`,
      travelers: this.members().join("、"),
      accent: "#c8102e",
      days,
      mode,
      shareUrl: token ? `${origin}/share/${token}` : null,
      origin,
      autoPrint: url.searchParams.get("print") === "1",
    });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  /** 分享連結：分享碼對了才給看；照片只給日記裡用到的那幾張 */
  private shared(token: string, photoId: string | undefined, req: Request, url: URL): Response {
    const saved = this.setting("share_token");
    if (!saved || !safeEqual(token, saved)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>連結已失效</title><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#555">這個日記分享連結已經關閉或不存在 🙏</body>`,
        { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } },
      );
    }
    if (!photoId) return this.album("share", req, url);
    const inDiary = this.sql
      .exec("SELECT photo_ids FROM diaries")
      .toArray()
      .some((d) => (JSON.parse((d.photo_ids as string) || "[]") as string[]).includes(photoId));
    const row = inDiary ? this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", photoId).toArray()[0] : undefined;
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.data as ArrayBuffer, { headers: { "content-type": row.mime as string, "cache-control": "public, max-age=86400", "x-robots-tag": "noindex" } });
  }

  // ================= 畫面上的狀態（行程、記憶、帳目） =================

  private itinerary() {
    return this.sql.exec("SELECT * FROM itinerary ORDER BY date").toArray();
  }

  private memories() {
    return this.sql.exec("SELECT * FROM memories ORDER BY ts").toArray();
  }

  private state() {
    return {
      itinerary: this.itinerary(),
      memories: this.memories(),
      expenses: this.expenseSummary(),
      members: this.members(),
      summary: this.setting("summary"),
      gemini: this.limiter.usage(),
      phrases: this.sql.exec("SELECT id, category, zh, ja, kana, author FROM phrases ORDER BY id").toArray(),
      checklist: this.checklistGet(),
      reminders: this.reminderList(),
      documents: this.documentFind().map((d) => ({ id: d.id, title: d.title, note: d.note, author: d.author, ts: d.ts, photo: `/api/photo/${d.photo_id}`, folder: d.folder_id ?? null })),
      docFolders: this.sql.exec("SELECT id, name, parent_id AS parent FROM doc_folders ORDER BY id").toArray(),
      diaries: this.sql.exec("SELECT date, ts, title, text, photo_ids, edited_by, edited_at FROM diaries ORDER BY date DESC").toArray(),
      // 置頂訊息附完整內容：訊息再舊、畫面上沒載入也看得到
      pins: this.sql
        .exec<MessageRow & { pin_ts: number; pin_by: string }>("SELECT m.*, p.ts AS pin_ts, p.by AS pin_by FROM pins p JOIN messages m ON m.id = p.message_id ORDER BY p.ts DESC")
        .toArray()
        .map((r) => ({ ts: r.pin_ts, by: r.pin_by, message: this.publicMessage(r) })),
      locations: this.memberLocation(),
      trip: {
        title: TRIP.title, startDate: TRIP.startDate, endDate: TRIP.endDate, accommodation: TRIP.accommodation.name,
        accommodationCoords: { lat: TRIP.accommodation.lat, lon: TRIP.accommodation.lon },
      },
    };
  }

  private broadcastState() {
    this.broadcast({ type: "state", state: this.state() });
  }

  // ================= Agent =================

  /**
   * 自動回想：從「最近訊息視窗之外」的舊聊天裡，找出跟這次問題字詞重疊最多的訊息。
   * 用中文雙字詞比對，不需要向量資料庫；旅程期間訊息量不大，全掃也很快。
   */
  // ================= 相片、帳目下載 =================

  /** 相片：大家在聊天傳的照片和票券照片，依日期分組 */
  private photoList(): Response {
    const size = new Map(this.sql.exec("SELECT id, ts, author, LENGTH(data) AS n FROM photos").toArray().map((r) => [String(r.id), { ts: Number(r.ts), n: Number(r.n) }]));
    const items = new Map<string, { id: string; ts: number; by: string; bytes: number; ticket?: string }>();
    for (const m of photoRows(this.sql.exec<MessageRow>("SELECT * FROM messages WHERE photo_id IS NOT NULL AND role = 'user' ORDER BY ts").toArray())) {
      const s = size.get(m.photo_id as string);
      if (s && !items.has(m.photo_id as string)) items.set(m.photo_id as string, { id: m.photo_id as string, ts: m.ts, by: m.author, bytes: s.n });
    }
    for (const d of this.sql.exec("SELECT photo_id, title, author FROM documents WHERE photo_id IS NOT NULL").toArray()) {
      const id = String(d.photo_id), s = size.get(id);
      if (!s) continue;
      const cur = items.get(id);
      if (cur) cur.ticket = String(d.title);
      else items.set(id, { id, ts: s.ts, by: String(d.author), bytes: s.n, ticket: String(d.title) });
    }
    const days = new Map<string, { date: string; bytes: number; photos: { id: string; time: string; by: string; ticket?: string }[] }>();
    for (const x of [...items.values()].sort((a, b) => a.ts - b.ts)) {
      const date = new Date(x.ts + 9 * 3600_000).toISOString().slice(0, 10);
      const day = days.get(date) ?? { date, bytes: 0, photos: [] };
      day.photos.push({ id: x.id, time: hhmm(x.ts), by: x.by, ...(x.ticket ? { ticket: x.ticket } : {}) });
      day.bytes += x.bytes;
      days.set(date, day);
    }
    const total = Number(this.sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM photos").one().n);
    return Response.json({ ok: true, count: items.size, bytes: total, limit: null, days: [...days.values()].reverse() });
  }

  /** 帳目下載成 CSV：Excel、Google 試算表都能開（開頭加 BOM 中文才不會亂碼） */
  private expensesCsv(): Response {
    // 文字欄位開頭是 = + - @ 會被 Excel 當成公式，前面補一個 '
    const cell = (v: unknown) => {
      let s = String(v ?? "");
      if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const line = (xs: unknown[]) => xs.map(cell).join(",");
    const out = [line(["日期", "項目", "分類", "金額", "幣別", "換算日圓", "約合台幣", "付款人", "分攤", "記錄的人"])];
    for (const r of this.sql.exec("SELECT * FROM expenses ORDER BY date, ts").toArray()) {
      let split = "";
      try {
        split = (JSON.parse(String(r.split_among || "[]")) as string[]).join("、");
      } catch {}
      out.push(line([r.date, r.description, r.category, r.amount, r.currency, r.amount_jpy, r.amount_twd, r.payer, split, r.author]));
    }
    const s = this.expenseSummary();
    if (s.balance.length) {
      out.push("", line(["結算", "已付", "應分攤", "差額（正數＝要收回）"]));
      for (const b of s.balance) out.push(line([b.name, b.paid, b.share, b.net]));
      for (const t of s.transfers) out.push(line([`${t.from} 給 ${t.to}`, t.jpy]));
    }
    const name = `${TRIP.title}-帳目.csv`.replace(/[\\/:*?"<>|]/g, "");
    return new Response("\uFEFF" + out.join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="expenses.csv"; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "no-store" },
    });
  }

  // ================= 記憶多了只挑相關的：雙字詞＋語意向量（Workers AI bge-m3）＋最近記的＋待辦預訂 =================

  private memQuery: { text: string; sims: Map<number, number> } | null = null;
  private embedBusy = false;

  private async embedTexts(texts: string[]): Promise<Float32Array[] | null> {
    if (!texts.length) return [];
    try {
      const r = (await this.env.AI.run("@cf/baai/bge-m3" as any, { text: texts })) as { data?: number[][] };
      const data = r?.data ?? [];
      return data.length === texts.length ? data.map((v) => Float32Array.from(v)) : null;
    } catch (e) {
      console.error("embedding failed", String((e as Error)?.message ?? e).slice(0, 200));
      return null;
    }
  }

  /** 記憶的向量：新增、改過的才算，刪掉的順便清掉；一次最多 max 筆（Workers AI 不能用就等下次） */
  private async syncEmbeddings(max = 60) {
    if (this.embedBusy) return;
    this.embedBusy = true;
    try {
      const have = new Map(this.sql.exec("SELECT ref, hash FROM embeddings WHERE kind = 'memory'").toArray().map((r) => [Number(r.ref), String(r.hash)]));
      const src = this.memories().map((m) => {
        const text = String(m.content).slice(0, 500);
        return { ref: Number(m.id), text, hash: textHash(text) };
      });
      const live = new Set(src.map((x) => x.ref));
      for (const ref of have.keys()) if (!live.has(ref)) this.sql.exec("DELETE FROM embeddings WHERE kind = 'memory' AND ref = ?", ref);
      const todo = src.filter((x) => have.get(x.ref) !== x.hash).slice(0, max);
      for (let i = 0; i < todo.length; i += 20) {
        const batch = todo.slice(i, i + 20);
        const vecs = await this.embedTexts(batch.map((b) => b.text));
        if (!vecs) break;
        batch.forEach((b, k) => this.sql.exec("INSERT OR REPLACE INTO embeddings (kind, ref, hash, vec) VALUES ('memory', ?, ?, ?)", b.ref, b.hash, vecs[k].buffer));
      }
    } catch (e) {
      console.error("syncEmbeddings failed", e);
    } finally {
      this.embedBusy = false;
    }
  }

  /** 記憶超過 40 條：先算好這次問題跟每條記憶的語意相似度；還沒算向量的在背景補 */
  private async prepareMemoryQuery(text: string) {
    this.memQuery = null;
    if (!text.trim() || this.memories().length <= MEMORY_ALL) return;
    this.ctx.waitUntil(this.syncEmbeddings(500));
    const rows = this.sql.exec("SELECT ref, vec FROM embeddings WHERE kind = 'memory'").toArray();
    if (!rows.length) return;
    const q = (await this.embedTexts([text.slice(0, 500)]))?.[0];
    if (!q) return;
    this.memQuery = { text, sims: new Map(rows.map((r) => [Number(r.ref), cosine(q, new Float32Array(r.vec as ArrayBuffer))])) };
  }

  /** 記憶多了以後只挑跟這次問題相關的 25 條：雙字詞＋語意＋最近記的＋待辦、預訂 */
  private relevantMemories(text: string): { list: Record<string, SqlStorageValue>[]; total: number } {
    const all = this.memories();
    if (all.length <= MEMORY_ALL) return { list: all, total: all.length };
    const q = bigrams(text);
    const sims = this.memQuery?.text === text ? this.memQuery.sims : null;
    const scored = all.map((m, i) => {
      const g = bigrams(String(m.content));
      let hit = 0;
      for (const x of q) if (g.has(x)) hit++;
      const recent = i >= all.length - 8 ? 0.5 : 0;
      const urgent = m.category === "待辦" || m.category === "預訂" ? 0.3 : 0;
      return { m, score: (q.size ? hit / Math.sqrt(q.size) : 0) + recent + urgent + semanticBoost(sims?.get(Number(m.id))) };
    });
    const list = scored.sort((a, b) => b.score - a.score).slice(0, MEMORY_PICK).map((x) => x.m).sort((a, b) => Number(a.ts) - Number(b.ts));
    return { list, total: all.length };
  }

  /** 整理記憶時給 AI 看的舊記憶：不多就全部；多了只給跟新對話有關的 50 條＋最近記的 20 條（它才抓得到重複和過時的） */
  private memoriesFor(transcript: string): { list: Record<string, SqlStorageValue>[]; total: number } {
    const all = this.memories();
    if (all.length <= 70) return { list: all, total: all.length };
    const t = bigrams(transcript);
    const keep = new Set(
      all
        .map((m) => {
          const g = bigrams(String(m.content));
          let hit = 0;
          for (const x of g) if (t.has(x)) hit++;
          return { id: m.id, s: g.size ? hit / g.size : 0 };
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((x) => x.id),
    );
    for (const m of all.slice(-20)) keep.add(m.id);
    return { list: all.filter((m) => keep.has(m.id)), total: all.length };
  }

  private recallOlder(trigger: MessageRow, windowStartTs: number): string {
    const grams = (s: string) => {
      const clean = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      const set = new Set<string>();
      for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
      return set;
    };
    const q = grams(trigger.text);
    if (q.size < 2) return "";
    const older = this.sql
      .exec<MessageRow>("SELECT * FROM messages WHERE ts < ? AND text != '' ORDER BY ts DESC LIMIT 3000", windowStartTs)
      .toArray();
    const scored = older
      .map((m) => {
        const g = grams(m.text);
        let hit = 0;
        for (const x of q) if (g.has(x)) hit++;
        return { m, score: hit / Math.sqrt(q.size) };
      })
      .filter((x) => x.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECALL_LIMIT)
      .sort((a, b) => a.m.ts - b.m.ts);
    return scored
      .map(({ m }) => {
        const t = new Date(m.ts + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
        return `- ${t} ${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 300).replace(/\n+/g, " ")}`;
      })
      .join("\n");
  }

  private systemPrompt(trigger?: MessageRow, windowStartTs?: number): string {
    const recall = trigger && windowStartTs ? this.recallOlder(trigger, windowStartTs) : "";
    const now = jstNow();
    const start = new Date(TRIP.startDate + "T00:00:00Z").getTime();
    const dayNo = Math.floor((new Date(now.date + "T00:00:00Z").getTime() - start) / 86400_000) + 1;
    const dayText = dayNo < 1 ? `出發前 ${1 - dayNo} 天` : dayNo > 8 ? "旅程已結束" : `旅程第 ${dayNo} 天`;
    const online = [...new Set(this.sockets().map((s) => s.user.name))];
    const a = TRIP.accommodation;
    const itin = this.itinerary()
      .map((d) => {
        const date = String(d.date);
        const wd = "日一二三四五六"[new Date(date + "T00:00:00Z").getUTCDay()];
        return `- ${date.slice(5).replace("-", "/")}（${wd}）${d.title}${d.detail ? `｜${d.detail}` : ""}${d.status ? `｜${d.status}` : ""}`;
      })
      .join("\n");
    const picked = this.relevantMemories(trigger ? memoryText(trigger) : "");
    const mems = picked.list.map((m) => `- #${m.id}［${m.category}］${m.content}（${m.author}）`).join("\n") || "（目前沒有）";
    const locs = this.memberLocation()
      .map((l) => `- ${l.name}：${l.area ? `${l.area}附近` : "地名查詢中"}（${l.lat.toFixed(5)},${l.lon.toFixed(5)}，${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`)
      .join("\n");
    const summary = this.setting("summary");
    const translations = this.sql
      .exec("SELECT * FROM translations ORDER BY ts DESC LIMIT 8")
      .toArray()
      .reverse()
      .map((r) => {
        const t = new Date((r.ts as number) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
        return `- ${t} ${r.author}（${r.from_lang === "zh" ? "中→日" : "日→中"}）：「${String(r.source).slice(0, 120)}」→「${String(r.result).slice(0, 120)}」`;
      })
      .join("\n");
    const cards = this.draftBrief();

    return `你是「${AI_NAME}」，一個台灣家庭東京自由行群組裡的 AI 旅遊助理。群組裡的每位成員都看得到你的回答。

# 現在
東京時間 ${now.date}（${now.weekday}）${now.time}，${dayText}。
旅伴名單（記帳分攤預設對象）：${this.members().join("、") || "（尚無）"}；目前在線：${online.join("、") || "無"}

# 旅伴
${TRIP.travelers}。回答要考慮小朋友（體力、推車、兒童票、廁所、休息）。

# 住宿（最終確定）
${a.name}
地址：${a.address}（英文：${a.addressEn}）
最近車站：${a.nearestStation}
步行路線：${a.walkingRoute}
入住 ${a.checkIn}；退房 ${a.checkOut}
地圖：${a.googleMap}
房屋規則：${a.rules.join("；")}

# 航班
${TRIP.flights.map((f) => `- ${f.date.slice(5).replace("-", "/")} ${f.flight}：${f.from} → ${f.to}`).join("\n")}

# 機場交通
${TRIP.airportRoutes}

# 最新行程（以這裡為準）
${itin}

# 長期記憶（成員偏好、決定、預訂…，#編號可用 forget 刪除）${picked.list.length < picked.total ? `\n（共 ${picked.total} 條，這裡只列出跟這次對話最相關的；找不到就用 search_history）` : ""}
${mems}
${summary ? `\n# 更早的對話摘要\n${summary}\n` : ""}${recall ? `\n# 以前聊過、和這次問題相關的內容（依時間排序）\n${recall}\n` : ""}${locs ? `\n# 成員最近位置\n${locs}\n` : ""}${translations ? `\n# 最近在翻譯頁翻過的句子（成員問「剛剛跟店員說了什麼」時參考）\n${translations}\n` : ""}${cards ? `\n# 最近的確認卡片（等待確認的還沒寫入；要修改就重新呼叫同一個工具，replaces 填編號）\n${cards}\n` : ""}
# 回答規則
- 一律使用繁體中文與台灣用語，語氣親切，適合手機閱讀：精簡、條列、重點加粗，不要長篇大論。
- 不要用 LaTeX 或 $…$ 數學式，箭頭、乘號等直接寫 →、×、≈。
- 訊息開頭的［名字］代表是誰說的，回答時可以稱呼對方；但你的回答本身不要用［名字］開頭。
- 營業時間、票價、活動、交通、天氣、排隊等「會變動的資訊」一定要用工具查，並附上來源連結；查不到就說不確定，絕不編造。
- 工具回傳 error 代表失敗：要如實告訴成員沒有完成，不可以說已完成。記帳前確認分攤對象是否符合成員說的人數。
- 記帳（add_expense）、修改行程（update_itinerary）、刪除帳目或提醒：工具只會在你的回答下方產生確認卡片，要等成員按「確認」才會寫入。呼叫後用一兩句話說明你看到的內容（照片上的店名、日期、金額…）和準備寫入的內容，請成員核對卡片；絕對不要說「已記好／已更新／已刪除」。資料有疑問（日期不在旅遊期間、金額或幣別看不清楚、不確定誰付的）就先直接問成員，等成員回答再呼叫工具。成員要修改還沒確認的卡片，就重新呼叫同一個工具並在 replaces 填舊卡片編號。卡片只能靠呼叫工具產生，不要在回答裡自己寫卡片內容。還沒確認的卡片不用刪，請成員直接按卡片上的「取消」。
- 提到日圓價格時附上約合台幣（用 convert_currency）。
- 問路、問地鐵電車怎麼搭：照你知道的回答坐哪條線、往哪個方向、在哪轉乘（不要寫站數），最後用 plan_route 附 Google 地圖連結，提醒即時班次和月台以 Google 地圖為準；必要時用 web_search 補充轉乘與票價。成員問坐幾站、或要你查證／確認路線時，才用 check_route_map（官方路線圖優先），照它回傳的 routes 回答、寫出依據的路線圖（圖會附在回答下方）；呼叫時把你認為的搭法填在 legs 讓它核對；它沒找到可靠的圖，就說沒查到可以查證的路線圖，請大家看 Google 地圖。沒有用 check_route_map 時，不要說「依據路線圖」或「路線圖附在下方」。成員自己傳路線圖、時刻表或車站照片來問時，照照片上清楚看得到的內容回答。
- 用 web_search 查交通、票價、營業時間、規定時，優先採用官方網站（營運公司、政府、景點官網）的資料，找不到官方的才用其他網站，並註明來源。
- 民宿的位置一律用房東給的地圖連結 ${a.googleMap}；要帶路回民宿就用 plan_route，destination 填「民宿」。不要用「IKEBUKURO 4」或自己打的地址搜尋（會跑到池袋四丁目或錯的地方）。
- 地圖連結：工具回傳的連結可以直接用（find_nearby 給的是那家店的座標，照抄，不要改成店名搜尋，連鎖店用店名會跑到別家分店）；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結（地點名稱用日文或英文的正式名稱，連鎖店要加分店名，例如 [📍ドン・キホーテ 池袋駅西口店](map)）。不要自己寫 Google 地圖網址，絕對不要編 maps.app.goo.gl 短網址，也不要用自己記得的地址或座標當連結（記錯一個字就會指到別的地方）。
- 成員在哪裡，一律以「成員最近位置」或訊息裡附的地名為準，絕對不要自己猜地名；以前聊天裡說過的位置可能已經過時，不要沿用。
- 每次有人問「附近」都要重新呼叫工具查詢，不可以沿用之前的回答。
- 要看「大家自己拍、傳到聊天室的照片」（第一天的照片、我們在某地的合照、某人傳的照片、昨天吃的拉麵）→ find_chat_photos（「第一天」「昨天」換算成日期，內容寫進 keyword），照片會顯示在回答下方，不是網路圖片；沒找到就照實說，不要拿網路圖片代替。
- 你可以用 find_images 把網路上的圖片直接顯示給成員（照片、捷運／地鐵路線圖、平面圖、菜單…），絕對不要說「無法傳送圖片」。
- 成員要求看網路上的照片／圖片／路線圖時，一定要用 find_images（店名或景點名稱加地名；好幾個地方就放進 queries 一次查完）；圖片會自動顯示在回答下方。絕對不要自己產生圖片網址或 Google 圖片搜尋連結，並提醒是網路圖片、僅供參考。沒有要求就不要找圖片。
- 成員想看景點、美食、餐廳的短片介紹（IG Reels、YouTube Shorts）時用 find_short_videos（places 填當地語言名稱、中文名稱、地區、類別），影片卡片會自動顯示在回答下方；絕對不要自己寫 IG、YouTube、TikTok 的影片網址。
- 問「我附近有什麼」：直接用 find_nearby，near 留空（系統會自動用發問者的 GPS），回答時列出實際店名、距離、步行分鐘與地圖連結，不要只給「附近有很多」這種泛泛建議；需要評價再用 web_search 補充。問「某個地方附近有什麼」（例如龜有公園附近），也要用 find_nearby，near 填日文地名（亀有公園）。問「我在哪」用 get_member_locations，說出區域與最近的車站。
- 迪士尼當天問排隊，用 disney_wait_times。
- 問電車有沒有延誤、停駛 → train_status；問計程車多少錢、要多久 → taxi_fare；問地震、颱風、天氣會不會影響行程 → japan_alerts。
- 收到收據照片（或說「記帳這張收據」）：讀出店名、日期、含稅總金額、幣別與主要品項，用 add_expense 產生記帳卡片（description 寫「店名：品項」），付款人預設是發問者。幣別要看清楚：日本收據是 JPY（¥、円、令和），台灣收據是 TWD（NT$、民國年、統一發票）。民國年要加 1911（113 年＝2024 年），令和 N 年＝2018+N 年。若是免稅店或金額可能達免稅門檻，順便提醒。
- 只有成員明確說「加入／加到清單」時才用 add_checklist_items。只是說想買、要帶、問推薦，都不可以自動加入清單；只有成員提到想買或要帶東西時，才在回答最後問一句要不要加進清單，其他話題（例如記帳、問路）不要問。買到了、帶了、辦好了 → update_checklist_item；問清單 → get_checklist。
- 要求「幾點提醒」→ create_reminder（時間用東京時間 YYYY-MM-DD HH:mm）。
- 傳照片說要「存起來／存成票券」→ save_document（說要放哪個資料夾，例如「存到機票」，就填 folder）；問「給我看○○的票／訂位」→ find_documents（關鍵字也可以是資料夾名稱）。
- 有人傳「🆘」走散求助：先安撫，用 get_member_locations 看大家在哪，建議就近約在明顯地標或車站剪票口集合，提醒可找工作人員幫忙、緊急打 110。
- 有人說「我付了／花了…」→ 用 add_expense 產生記帳卡片；問「花多少、怎麼分」→ expense_summary。只有成員說付了、花了、要記帳，或傳收據時才記帳；問「怎麼儲值、怎麼買票、要多少錢」是在問做法或價格，直接回答，不要問金額、不要產生記帳卡片。
- 成員做了決定、說了偏好、訂了東西 → 主動用 remember 記下來；行程要改就用 update_itinerary 產生修改卡片。只有 remember 成功後才能說「已記住」；沒有呼叫工具就不要聲稱已記住（系統也會在背景定期自動整理記憶）。
- 收到照片：辨識菜單、商品、看板、車票並翻譯說明；商品可以查價比價並試算免稅（tax_free_check）。
- 一次收到好幾張照片（例如菜單好幾頁）：當成同一份資料一起整理，不要一張一張分開回答。菜單：依類別分組，每道寫中文翻譯（原文）和價格（寫成「900 円（約 NT$190）」），標出推薦、辣、生食、含酒精、適合小孩的；看不清楚的照實說。
- 安全第一：遇到緊急狀況提供日本緊急電話（警察 110、救護/消防 119）與最近的醫院資訊。`;
  }

  /** 地圖連結修正：房東給的民宿地圖保留；提到民宿的連結一律換成正確的位置與地址（用房源名稱「IKEBUKURO 4」搜尋會跑到池袋四丁目） */
  private mapFix(): MapFixOptions {
    const a = TRIP.accommodation;
    return { keep: [a.googleMap], home: { names: HOME_NAMES, search: a.googleMap, dest: HOME_ADDRESS } };
  }

  /** 這次的問題是在回覆哪一則訊息：給模型完整原文（可能早就超出最近的對話紀錄） */
  private replyContext(trigger: MessageRow): string {
    const reply = trigger.meta ? JSON.parse(trigger.meta).reply : null;
    if (!reply) return "";
    const full = this.sql.exec<MessageRow>("SELECT author, text FROM messages WHERE id = ?", reply.id).toArray()[0];
    const text = String(full?.text ?? reply.text ?? "").slice(0, 2000);
    return `（我在回覆 ${full?.author ?? reply.author} 的這則訊息，請針對它回答：「${text}」）\n`;
  }

  private buildTurns(history: MessageRow[], trigger: MessageRow, images: Part[]): Turn[] {
    const turns: Turn[] = [];
    const push = (role: Turn["role"], text: string) => {
      const last = turns[turns.length - 1];
      if (last && last.role === role) (last.parts as Part[]).push({ text });
      else turns.push({ role, parts: [{ text }] });
    };
    for (const m of history) {
      if (m.id === trigger.id) continue;
      if (m.role === "assistant") push("model", m.text.slice(0, HISTORY_CHARS) || "（略）");
      else if (m.role === "user") {
        let t = `［${m.author}］${replyNote(m.meta, 150)}${m.text.slice(0, HISTORY_CHARS)}`;
        if (m.photo_id) t += photosOf(m).length > 1 ? `（附了 ${photosOf(m).length} 張照片）` : "（附了一張照片）";
        if (m.lat != null) t += `（分享位置 ${m.lat?.toFixed(5)},${m.lon?.toFixed(5)}）`;
        push("user", t);
      }
    }
    let t = `［${trigger.author}］${this.replyContext(trigger)}${trigger.text || (trigger.photo_id ? (photosOf(trigger).length > 1 ? "請看這幾張照片" : "請看這張照片") : "")}`;
    if (trigger.lat != null) {
      const area = this.memberLocation(trigger.author)[0]?.area;
      t += `（我目前的位置：${area ? `${area}附近，` : ""}座標 ${trigger.lat?.toFixed(5)},${trigger.lon?.toFixed(5)}。位置可能變了，需要地點資訊請用工具重新查詢，不要沿用之前的回答）`;
    }
    const parts: Part[] = [{ text: t }, ...images];
    const last = turns[turns.length - 1];
    if (last && last.role === "user") last.parts.push(...parts);
    else turns.push({ role: "user", parts });
    // Gemini 要求第一個是 user
    while (turns.length && turns[0].role !== "user") turns.shift();
    return turns;
  }

  private async runAgent(trigger: MessageRow, user: Attachment) {
    const id = newId();
    const settings = this.settings();
    // 附了照片就一律先用 Gemini（看圖辨識比 Gemma 準很多），額度滿了或沒設金鑰才退回 Gemma
    const primary = settings.hasGemini && (trigger.photo_id || settings.provider !== "workers-ai") ? "gemini" : "workers-ai";
    // 主要 → 備援 → 最後防線（Gemini 另一個模型額度分開算；避免 Gemini 塞車又遇到 Workers AI 每日額度用完時全掛）
    const order =
      primary === "gemini" ? ["gemini", "workers-ai", "gemini-backup"]
      : settings.hasGemini ? ["workers-ai", "gemini", "gemini-backup"]
      : ["workers-ai"];

    const photoParts: Part[] = photosOf(trigger).flatMap((pid) => {
      const p = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", pid).toArray()[0];
      return p ? [{ image: { mime: p.mime as string, data: toBase64(p.data as ArrayBuffer) } }] : [];
    });
    const image: Part | null = photoParts[0] ?? null;
    // 附了位置就先把地名查好，AI 才不會自己猜在哪裡
    if (trigger.lat != null) await this.ensureArea(trigger.author);
    const history = this.recentMessages(HISTORY_WINDOW);
    await this.prepareMemoryQuery(memoryText(trigger));
    const system = this.systemPrompt(trigger, history[0]?.ts ?? trigger.ts);
    const images: AttachedImage[] = [];
    // 這次工具回傳的內容：檢查回答裡的影片網址是不是工具找到的
    let toolJson = "";
    const toolsUsed: string[] = [];
    const drafts: number[] = [];
    const propose = (d: DraftInput) => this.propose(d, user.name, id, drafts);
    // 成員像是在修改剛才還沒確認的卡片（「打錯了，是 3500」）
    const fixing = /改成|改為|改一下|打錯|寫錯|記錯|不對|應該是|更正|修正/.test(trigger.text)
      ? this.sql.exec("SELECT id, kind, preview FROM drafts WHERE status = 'pending' AND ts > ? ORDER BY id DESC LIMIT 1", Date.now() - 30 * 60_000).toArray()[0]
      : undefined;
    let lastError = "";
    // 跨模型共用：Gemini 中途被限流時，備援模型接著已完成的工具結果繼續，不會重複記帳或重複查詢
    let turns = this.buildTurns(history, trigger, photoParts);
    const onWait = (ms: number) => this.broadcast({ type: "ai_note", id, text: `Gemini 額度冷卻中，等待 ${Math.ceil(ms / 1000)} 秒…` });
    const gate = this.geminiGate(1, FOREGROUND_MAX_WAIT, onWait);
    const backupGate = this.geminiGate(1, FOREGROUND_MAX_WAIT, onWait, true);

    for (const pid of order) {
      const provider: Provider = providerFor(await this.aiEnv(), pid, pid === "gemini-backup" ? backupGate : gate);
      this.broadcast({ type: "ai_start", id, provider: provider.id, model: provider.model });
      let finalText = "";
      const nudged = new Set<string>();
      const forced = new Set<string>();
      let emptyRetried = false;
      let cardNudged = false;
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const res = await provider.generate({
            system,
            turns,
            tools: TOOL_DECLS,
            onDelta: (delta) => this.broadcast({ type: "ai_delta", id, delta }),
            // 好幾張照片（菜單好幾頁）回答會很長，45 秒不夠
            ...(photoParts.length > 1 ? { timeoutMs: 120_000 } : {}),
            // Gemini 塞車時不要乾等：後面還有備援就只等它開始回應 15 秒（附照片 30 秒）
            ...(pid !== order[order.length - 1] ? { firstChunkMs: photoParts.length ? 30_000 : 15_000 } : {}),
          });
          if (!res.calls.length) {
            // 模型偶爾偷懶：嘴上說「已加入清單」「圖片在下方」卻沒呼叫工具。提醒一次，重新回答
            let need = requiredTool(trigger.text, toolsUsed, !!trigger.photo_id);
            // 要寫入資料的工具：AI 正在反問成員（日期不在旅遊期間、金額看不清…）就讓它問，不要蓋掉硬寫
            if (need && DRAFT_TOOLS.has(need) && isAskingBack(res.text)) need = null;
            if (need && !nudged.has(need) && step < MAX_STEPS - 1) {
              nudged.add(need);
              this.broadcast({ type: "ai_reset", id });
              turns = [
                ...turns,
                { role: "model", parts: [{ text: res.text || "（略）" }] },
                { role: "user", parts: [{ text: `（系統提醒：你還沒有呼叫 ${need}，這件事一定要呼叫 ${need} 才算完成，沒有呼叫就不能說已完成。請現在呼叫，再根據結果完整回答。成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）` }] },
              ];
              continue;
            }
            // 提醒過還是不呼叫：系統自己執行工具，再請模型根據結果回答
            if (need && !forced.has(need) && step < MAX_STEPS - 1) {
              forced.add(need);
              const note = await this.forceTool(need, provider, history, trigger, user, id, images, toolsUsed, image, propose);
              if (note) {
                this.broadcast({ type: "ai_reset", id });
                turns = [
                  ...turns,
                  { role: "model", parts: [{ text: res.text || "（略）" }] },
                  { role: "user", parts: [{ text: note }] },
                ];
                continue;
              }
            }
            // 嘴上說「請核對下方的卡片」卻沒呼叫工具：成員看不到卡片，提醒它真的去呼叫
            if (!drafts.length && !cardNudged && (claimsCard(res.text) || fixing) && step < MAX_STEPS - 1) {
              cardNudged = true;
              this.broadcast({ type: "ai_reset", id });
              const hint = fixing
                ? `成員可能是要修改還沒確認的卡片 #${fixing.id}（${JSON.parse(fixing.preview as string).summary}）：是的話，請重新呼叫 ${fixing.kind}，所有欄位填修改後的完整內容，replaces 填 ${fixing.id}；不是的話就照原本的意思回答。`
                : "你說下方有確認卡片，但你沒有呼叫任何工具，成員看不到卡片。記帳 → add_expense；改行程 → update_itinerary；刪帳 → delete_expense；刪提醒 → delete_reminder；修改還沒確認的卡片要填 replaces。請現在呼叫，再簡短說明。";
              turns = [
                ...turns,
                { role: "model", parts: [{ text: res.text || "（略）" }] },
                { role: "user", parts: [{ text: `（系統提醒：${hint}成員沒看到你剛才那段回答，不用道歉，也不要提到這個提醒。）` }] },
              ];
              continue;
            }
            // 查完工具後偶爾一個字都不回（以為剛才那段被收回的回答已經講過了），再請它回一次
            if (!res.text.trim() && !emptyRetried && toolsUsed.length && step < MAX_STEPS - 1) {
              emptyRetried = true;
              turns = [
                ...turns,
                { role: "model", parts: [{ text: "（略）" }] },
                { role: "user", parts: [{ text: "（系統提醒：你剛才沒有輸出任何文字，成員什麼都沒看到。請根據上面的工具結果，直接完整回覆成員，不用道歉。）" }] },
              ];
              continue;
            }
            finalText = res.text;
            break;
          }
          const modelParts: Part[] = [];
          if (res.text) modelParts.push({ text: res.text });
          for (const c of res.calls) modelParts.push({ call: c });
          const resultParts: Part[] = [];
          for (const c of res.calls) {
            toolsUsed.push(c.name);
            this.broadcast({ type: "ai_tool", id, name: c.name, label: toolLabel(c.name), args: c.args });
            const result = await runTool(c.name, c.args, {
              env: this.env, room: this, author: user.name, photoId: trigger.photo_id,
              attachImage: (img) => images.length < 8 && images.push(img),
              propose,
            });
            toolJson += JSON.stringify(result ?? "");
            resultParts.push({ result: { id: c.id, name: c.name, response: result } });
          }
          turns = [...turns, { role: "model", parts: modelParts }, { role: "user", parts: resultParts }];
          if (step === MAX_STEPS - 1) finalText = res.text || "（查了很多資料，但還沒整理完，請再問一次更具體的問題 🙏）";
        }
        if (!images.length) finalText = dropMapClaims(finalText);
        if (provider.id === "workers-ai" && !toolsUsed.includes("check_route_map") && ROUTE_ASK.test(trigger.text) && /線|轉乘|方向|站/.test(finalText)) finalText = `${finalText.trim()}\n\n${BACKUP_ROUTE_NOTE}`;
        // 憑記憶回答的路線：下方放查證按鈕（已經查證過、問延誤的不用）
        const quick =
          !toolsUsed.includes("check_route_map") && !trigger.photo_id && ROUTE_ASK.test(trigger.text) && !/延誤|停駛|誤點|運行/.test(trigger.text) && /線|轉乘|方向|站/.test(finalText)
            ? routeCheckButton(trigger.text)
            : !toolsUsed.includes("find_short_videos") && !trigger.photo_id && PLACE_ASK.test(trigger.text) && finalText.length > 80
              ? videoButton(trigger.text)
              : null;
        finalText = dropFakeVideoLinks(finalText, toolJson + images.map((im) => im.page ?? "").join(" "));
        if (!finalText.trim()) finalText = images.length ? "幫你找到這些圖片 👇（網路圖片，僅供參考）" : "嗯…我沒有想到好的回答，可以換個方式問我嗎？";
        const row = this.insertMessage({
          id, author: AI_NAME, role: "assistant", text: fixMapLinks(stripSpeakerTag(finalText), this.mapFix()), photo_id: null, lat: null, lon: null,
          meta: JSON.stringify({
            // 回答的是誰（「只看我和 AI 的對話」用）
            for: { id: trigger.id, author: trigger.author },
            provider: provider.id, model: provider.model, tools: [...new Set(toolsUsed)].map(toolLabel),
            ...(images.length ? { images } : {}),
            ...(drafts.length ? { drafts } : {}),
            ...(quick ? { quick } : {}),
          }),
        });
        this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
        this.ctx.waitUntil(this.maybeConsolidateMemory());
        return;
      } catch (e: any) {
        lastError = String(e?.message ?? e);
        const rateLimited = e instanceof RateLimitedError || /Gemini (429|503)/.test(lastError);
        if (!rateLimited) console.error(`provider ${pid} failed`, lastError);
        this.broadcast({ type: "ai_retry", id, error: lastError, rateLimited });
      }
    }

    const row = this.insertMessage({
      id, author: AI_NAME, role: "assistant", text: `抱歉，AI 暫時無法回答 🙇\n\n如果是 Gemini 額度用完，管理員可以到下方「設定」換一把新的 Gemini 金鑰，馬上生效。\n\n\`${lastError.slice(0, 200)}\``, photo_id: null, lat: null, lon: null,
      // 中途產生的確認卡片還是附上，成員照樣可以確認
      meta: JSON.stringify({ error: true, ...(drafts.length ? { drafts } : {}) }),
    });
    this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
  }

  /**
   * 模型提醒過仍不呼叫工具時，由系統代為執行，回傳要交給模型的結果說明。
   * find_images：先請模型（JSON 模式，很穩定）從對話整理出要找圖的地點，再一次查完。
   */
  private async forceTool(
    need: string, provider: Provider, history: MessageRow[], trigger: MessageRow, user: Attachment,
    id: string, images: AttachedImage[], toolsUsed: string[], image: Part | null, propose: (d: DraftInput) => unknown,
  ): Promise<string | null> {
    const ctx = {
      env: this.env, room: this, author: user.name, photoId: trigger.photo_id,
      attachImage: (img: AttachedImage) => images.length < 8 && images.push(img),
      propose,
    };
    let args: Record<string, unknown>;
    if (need === "find_images") {
      const lastAi = [...history].reverse().find((m) => m.role === "assistant" && m.id !== id)?.text ?? "";
      const area = this.memberLocation(user.name)[0]?.area ?? "";
      let queries: string[] = [];
      try {
        const r = await provider.generate({
          system: "你只輸出 JSON。",
          turns: [{
            role: "user",
            parts: [{
              text: `成員說：「${trigger.text}」\n上一則 AI 回答：\n${lastAi.slice(0, 1500)}\n成員所在地區：${area || "未知"}\n\n成員想看哪些地點、店家或東西的照片？列出搜尋關鍵字（名稱加地名），最多 4 個。只輸出 JSON：{"queries":["..."]}`,
            }],
          }],
          json: true,
        });
        const j = JSON.parse(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
        queries = (j.queries ?? []).map((q: unknown) => String(q).trim()).filter(Boolean).slice(0, 4);
      } catch {}
      if (!queries.length) queries = [trigger.text.replace(/給我看|提供|請|幫我找|的?(照片|圖片|相片)|你推薦的/g, "").trim() || trigger.text];
      args = { queries, count: Math.min(queries.length * 2, 6) };
    } else if (need === "find_nearby") {
      const t = trigger.text;
      const category =
        /便利商店|超商|コンビニ/.test(t) ? "convenience" : /藥妝|藥局|藥/.test(t) ? "drugstore" : /廁所|洗手間|トイレ/.test(t) ? "toilet"
        : /咖啡|cafe/i.test(t) ? "cafe" : /超市/.test(t) ? "supermarket" : /ATM|提款/i.test(t) ? "atm" : /置物櫃|寄物/.test(t) ? "locker"
        : /車站|捷運|地鐵|電車/.test(t) ? "station" : /公園|遊樂場/.test(t) ? "park" : /購物|百貨|商場|逛街/.test(t) ? "shopping" : "food";
      args = { category };
    } else {
      // 其他工具：請模型用 JSON 模式（很穩定）照工具規格產生參數，收據照片也一起給它看
      const decl = TOOL_DECLS.find((d) => d.name === need);
      if (!decl) return null;
      const now = jstNow();
      try {
        const parts: Part[] = [{
          text: `成員（${user.name}）說：「${trigger.text}」${need === "find_short_videos" ? `\n上一則 AI 回答：\n${([...history].reverse().find((m) => m.role === "assistant" && m.id !== id)?.text ?? "").slice(0, 1500)}` : ""}
現在是東京時間 ${now.date}（${now.weekday}）${now.time}。旅程 ${TRIP.startDate} 到 ${TRIP.endDate}（第一天＝${TRIP.startDate}）。旅伴名單：${this.members().join("、") || user.name}。
請產生呼叫工具「${need}」要用的參數。
工具說明：${decl.description}
參數格式（JSON Schema）：${JSON.stringify(decl.parameters)}
只輸出參數的 JSON 物件，不要任何其他文字。`,
        }];
        if (image && need === "add_expense") parts.push(image);
        const r = await provider.generate({ system: "你只輸出 JSON。", turns: [{ role: "user", parts }], json: true });
        args = parseArgs(r.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
      } catch {
        return null;
      }
      if (!Object.keys(args).length) return null;
    }
    toolsUsed.push(need);
    this.broadcast({ type: "ai_tool", id, name: need, label: toolLabel(need), args });
    const result = await runTool(need, args, ctx);
    return `（系統已經幫你執行 ${need}，結果如下。請根據結果完整回答成員，不用道歉；不要自己產生任何圖片或搜尋連結，圖片會自動顯示在回答下方。）\n${JSON.stringify(result).slice(0, 6000)}`;
  }

  /** share：可用的 Gemini 額度比例；maxWait：額度滿時最多等幾毫秒，超過就改用備援 */
  private geminiGate(share: number, maxWait: number, onWait?: (ms: number) => void, backup = false): GeminiGate {
    const l = backup ? this.backupLimiter : this.limiter;
    return {
      acquire: (estimate) => l.acquire(estimate, share, maxWait, onWait),
      failed: (status, body) => l.penalize(status, body),
    };
  }

  private consolidating = false;

  /**
   * 長期記憶（越用越懂你）：每累積幾則新訊息就自動
   * 1) 更新整段旅程的對話摘要 2) 萃取新的偏好／決定／預訂／待辦 3) 刪掉過時或被推翻的記憶。
   * 只有成功才推進游標，失敗的那批下次會再整理，不會漏掉。
   */
  private async maybeConsolidateMemory() {
    if (this.consolidating) return;
    const cursor = Number(this.setting("memory_cursor", "0"));
    const fresh = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts > ? ORDER BY ts", cursor).toArray();
    if (fresh.filter((m) => m.role === "user").length < MEMORY_EVERY) return;
    this.consolidating = true;

    const transcript = fresh
      .slice(-80)
      .map((m) => `${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 500)}`)
      .join("\n");
    const shown = this.memoriesFor(transcript);
    const existing = shown.list.map((m) => `#${m.id}［${m.category}］${m.content}`).join("\n") || "（無）";
    const prompt = `以下是家庭旅遊群組最新的對話，請整理群組的長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「整趟旅程對話摘要」（400 字內；保留每個人的偏好、做過的決定、討論過的店家與地點、待辦、重要資訊）。
2. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話、寫清楚是誰。
   例如：誰喜歡／不吃什麼、想買什麼、想去哪、決定了什麼、訂了什麼、待辦事項、聊到的店名與地址。
   不要收錄住宿地址、航班這些系統已知的資料，也不要收錄閒聊或 AI 自己的建議。沒有就回空陣列。
3. remove_ids：現有記憶中已經過時、被新對話推翻、或重複的記憶 id（例如「想吃燒肉」後來改成「想吃壽司」，就刪掉舊的）。沒有就回空陣列。

舊摘要：
${this.setting("summary") || "（無）"}

現有記憶${shown.list.length < shown.total ? `（共 ${shown.total} 條，這裡只列出跟新對話有關的 ${shown.list.length} 條；remove_ids 只能從這些裡面挑）` : ""}：
${existing}

新對話：
${transcript}

輸出 JSON：{"summary": "...", "memories": [{"content": "...", "category": "偏好|決定|預訂|資訊|待辦"}], "remove_ids": [數字]}`;

    const order = this.settings().hasGemini ? ["gemini", "workers-ai"] : ["workers-ai"];
    // 背景整理只用 Gemini 一半的額度、不等待；額度緊就交給 Gemma，把 Gemini 留給回答問題
    const gate = this.geminiGate(0.5, 0);
    try {
      for (const pid of order) {
        try {
          const res = await providerFor(await this.aiEnv(), pid, gate).generate({
            system: "你是負責整理旅遊群組長期記憶的助理，只輸出 JSON。",
            turns: [{ role: "user", parts: [{ text: prompt }] }],
            json: true,
          });
          const json = JSON.parse(res.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
          if (typeof json.summary === "string" && json.summary.trim()) this.setSetting("summary", json.summary.trim().slice(0, 2000));
          for (const id of (json.remove_ids ?? []).slice(0, 20)) {
            if (Number.isInteger(Number(id))) this.sql.exec("DELETE FROM memories WHERE id = ?", Number(id));
          }
          // 跟現有的某條講同一件事就不再記（模型常把記過的換句話說再記一次，記憶才會一直變多）
          const known = this.memories().map((x) => String(x.content));
          for (const m of (json.memories ?? []).slice(0, 20)) {
            const content = String(m?.content ?? "").trim();
            if (!content || known.some((x) => sameFact(x, content))) continue;
            this.addMemory(content, String(m.category || "資訊"), "AI 自動整理");
            known.push(content);
          }
          this.setSetting("memory_cursor", String(fresh[fresh.length - 1].ts));
          this.ctx.waitUntil(this.syncEmbeddings(500));
          this.broadcastState();
          return;
        } catch (e) {
          if (!(e instanceof RateLimitedError)) console.error(`memory consolidation via ${pid} failed`, e);
        }
      }
    } finally {
      this.consolidating = false;
    }
  }
}
