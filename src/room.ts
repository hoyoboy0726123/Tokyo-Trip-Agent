import { DurableObject } from "cloudflare:workers";
import { safeEqual } from "./auth";
import { parseArgs, providerFor, type GeminiGate } from "./providers";
import { GeminiLimiter, RateLimitedError } from "./ratelimit";
import { DRAFT_TOOLS, japanAlerts, reverseArea, runTool, SCALE_TEXT, toolLabel, TOOL_DECLS, type AttachedImage, type DraftInput, type ExpenseInput, type RoomApi } from "./tools";
import { fixMapLinks, type MapFixOptions } from "./maplinks";
import { renderDiaryPage } from "./diary-page";
import { looksJapanese, translate, type Lang } from "./translate";
import { DEFAULT_CHECKLIST, DEFAULT_PHRASES, INITIAL_ITINERARY, TRIP } from "./trip-data";
import type { Env, Part, Provider, SessionUser, Turn } from "./types";

const HISTORY_WINDOW = 24; // 每次帶給模型的最近訊息數（更早的靠自動回想找回，省 TPM）
const HISTORY_CHARS = 600; // 每則歷史訊息最多帶多少字
const PIN_LIMIT = 20; // 置頂訊息上限（每次狀態更新都會帶完整內容，不宜太多）
const MAX_STEPS = 8; // 單次回答最多工具回合（含系統提醒／代為執行）
const FOREGROUND_MAX_WAIT = 10_000; // 回答問題時，Gemini 額度滿最多等幾毫秒，超過就改用備援
const MEMORY_EVERY = 4; // 每 4 則新的成員訊息自動整理一次長期記憶
const RECALL_LIMIT = 8; // 從較舊的聊天中自動找回的相關訊息數
const AI_NAME = "旅伴 AI";

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
  // 「路線圖」「傳圖給我」也算要看圖；自己附了照片時是要 AI 看那張照片，不是上網找圖
  { tool: "find_images", test: (t, p) => !p && /照片|圖片|相片|看圖|附圖|長什麼樣|路線圖|地鐵圖|捷運圖|平面圖|示意圖|菜單圖|(傳|給|找|看).{0,6}圖(?!書)|photo|picture|image/i.test(t) && !/存|票券|地圖/.test(t) },
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

/** 模型偶爾學對話紀錄的格式，回答開頭多一個「［爸爸］」，存檔前拿掉 */
function stripSpeakerTag(text: string): string {
  return text.replace(/^\s*［[^］\n]{1,16}］\s*/, "");
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

export class TripRoom extends DurableObject<Env> implements RoomApi {
  private sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();
  private limiter: GeminiLimiter;
  /** 備援 Gemini 模型的額度在 Google 那邊是分開算的，冷卻也分開 */
  private backupLimiter: GeminiLimiter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const limits = { rpm: Number(env.GEMINI_RPM) || 15, tpm: Number(env.GEMINI_TPM) || 250_000, rpd: Number(env.GEMINI_RPD) || 500 };
    const dayStore = (key: string) => ({
      load: () => JSON.parse(this.setting(key, '{"day":"","count":0}')),
      save: (v: { day: string; count: number }) => this.setSetting(key, JSON.stringify(v)),
    });
    this.limiter = new GeminiLimiter(limits, dayStore("gemini_day"));
    this.backupLimiter = new GeminiLimiter(limits, dayStore("gemini_day_backup"));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, role TEXT, text TEXT, photo_id TEXT, lat REAL, lon REAL, meta TEXT);
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, ts INTEGER, author TEXT, mime TEXT, data BLOB);
      CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, category TEXT, content TEXT, author TEXT);
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
    // 家人修改日記：記下最後是誰改的
    for (const col of ["edited_by TEXT", "edited_at INTEGER"]) {
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

  private settings() {
    return {
      provider: this.setting("provider", this.env.DEFAULT_PROVIDER || "gemini"),
      replyMode: this.setting("reply_mode", "all"), // all | mention
      travelers: this.setting("travelers"),
      geminiModel: this.env.GEMINI_MODEL,
      workersModel: this.env.WORKERS_AI_MODEL,
      hasGemini: !!this.env.GEMINI_API_KEY,
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
        const photoId = typeof msg.photoId === "string" ? msg.photoId : null;
        const loc = msg.location && Number.isFinite(msg.location.lat) ? msg.location : null;
        if (!text && !photoId && !loc) return;
        if (loc) this.saveLocation(user.name, loc);
        // 回覆某一則訊息：記下被回覆的是誰說的、說了什麼（畫面上顯示引用，AI 追問時也看得到）
        const quoted = typeof msg.replyTo === "string" ? this.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.replyTo).toArray()[0] : undefined;
        const reply = quoted ? { id: quoted.id, author: quoted.author, text: String(quoted.text ?? "").slice(0, 300) || (quoted.photo_id ? "（照片）" : "") } : null;
        const row = this.insertMessage({
          author: user.name, role: "user", text, photo_id: photoId, lat: loc?.lat ?? null, lon: loc?.lon ?? null, meta: reply ? JSON.stringify({ reply }) : null,
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
        this.documentSave(String(msg.title || "票券").slice(0, 80), String(msg.note ?? "").slice(0, 300), msg.photoId, user.name);
        break;
      case "document_delete":
        this.sql.exec("DELETE FROM documents WHERE id = ?", Number(msg.id));
        this.broadcastState();
        break;
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
        const row = this.sql.exec("SELECT ts FROM diaries WHERE date = ?", date).toArray()[0];
        if (!row) return reply(false, "找不到這天的日記");
        if (Number(msg.base) !== Number(row.ts)) return reply(false, "剛剛有人修改過這篇日記，請回上一頁重新打開再改");
        const title = String(msg.title ?? "").trim().slice(0, 40);
        const text = String(msg.text ?? "").trim().slice(0, 6000);
        const ids = (Array.isArray(msg.photos) ? msg.photos : []).map(String).filter((id: string) => /^[\w-]+$/.test(id)).slice(0, 30);
        const known = new Set(
          ids.length ? this.sql.exec(`SELECT id FROM photos WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map((r) => r.id as string) : [],
        );
        const photos = [...new Set(ids.filter((id: string) => known.has(id)))];
        if (!title && !text && !photos.length) return reply(false, "日記不能全部清空");
        const now = Date.now();
        this.sql.exec(
          "UPDATE diaries SET title = ?, text = ?, photo_ids = ?, ts = ?, edited_by = ?, edited_at = ? WHERE date = ?",
          title, text, JSON.stringify(photos), now, user.name, now, date,
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
    if (!keepArea) this.ctx.waitUntil(this.ensureArea(name));
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

  documentSave(title: string, note: string, photoId: string, author: string) {
    const row = this.sql
      .exec("INSERT INTO documents (ts, author, title, note, photo_id) VALUES (?, ?, ?, ?, ?) RETURNING id, title", Date.now(), author, title, note, photoId)
      .one();
    this.broadcastState();
    return { saved: row, note: "已存進 下方「工具箱」→ 票券保管箱，打開過一次之後沒網路也看得到" };
  }

  documentFind(keyword?: string) {
    const words = String(keyword ?? "").split(/\s+/).filter(Boolean).slice(0, 3);
    const rows = words.length
      ? this.sql.exec(`SELECT * FROM documents WHERE ${words.map(() => "(title LIKE ? OR note LIKE ?)").join(" AND ")} ORDER BY ts DESC`, ...words.flatMap((w) => [`%${w}%`, `%${w}%`])).toArray()
      : this.sql.exec("SELECT * FROM documents ORDER BY ts DESC").toArray();
    return rows as unknown as { id: number; title: string; note: string; photo_id: string; author: string; ts: number }[];
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
  private async generatePlain(system: string, prompt: string): Promise<string> {
    const order = this.settings().provider === "workers-ai" || !this.settings().hasGemini ? ["workers-ai", "gemini", "gemini-backup"] : ["gemini", "workers-ai", "gemini-backup"];
    for (const pid of order) {
      if (pid !== "workers-ai" && !this.settings().hasGemini) continue;
      try {
        const r = await providerFor(this.env, pid, this.geminiGate(1, 5_000, undefined, pid === "gemini-backup")).generate({ system, turns: [{ role: "user", parts: [{ text: prompt }] }] });
        if (r.text.trim()) return r.text.trim();
      } catch (e) {
        if (!(e instanceof RateLimitedError)) console.error(`generatePlain via ${pid} failed`, e);
      }
    }
    throw new Error("AI 暫時無法產生內容");
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

  /** announce＝在群組貼出來（每晚自動寫）；管理員重寫舊日記時不貼 */
  async writeDiary(date: string, announce = true) {
    if (announce) this.setSetting("diary_sent", date);
    const start = Date.parse(date + "T00:00:00Z") - 9 * 3600_000;
    const msgs = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts", start, start + 86400_000).toArray();
    const photos = msgs.filter((m) => m.photo_id && m.role === "user").map((m) => m.photo_id as string).slice(0, 12);
    // 出發前預付的機票、住宿、門票（台幣大額）也記在出發日，不能當成當天花費；只拿當天買的東西當寫作素材
    const bought = this.sql
      .exec("SELECT description FROM expenses WHERE date = ? AND currency = 'JPY' AND amount < 30000 ORDER BY id", date)
      .toArray()
      .map((r) => String(r.description))
      .slice(0, 15);
    const today = this.itinerary().find((d) => d.date === date);
    const transcript = msgs
      .filter((m) => m.role !== "system" && (m.meta ? !JSON.parse(m.meta).kind : true))
      .map((m) => `${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 200)}${m.photo_id ? "（照片）" : ""}`)
      .join("\n")
      .slice(-6000);
    const prompt = `請用今天的群組對話，幫這個台灣家庭寫一篇旅遊日記，繁體中文，溫馨有趣、像家人一起回憶。
格式：第一行只寫標題（14 字以內、生動有畫面，不要加符號、引號或「標題：」），空一行，接著是內文 3–5 段、共 350–500 字，段落之間空一行。
寫出今天去了哪裡、吃了什麼、買了什麼、小朋友的有趣時刻、印象深刻的事；不要編造對話裡沒有的事，資料少就寫短一點；不要寫花了多少錢。
日期：${date}；行程：${today ? today.title : "自由活動"}；照片 ${photos.length} 張
今天買的東西：${bought.join("、") || "（沒有記帳）"}
對話：
${transcript || "（今天群組沒什麼對話）"}`;
    const raw = (await this.generatePlain("你是幫家庭寫旅遊日記的溫暖作家，只根據提供的資料寫。", prompt)).trim();
    const [first = "", ...rest] = raw.split("\n");
    let title = first.replace(/^#+\s*|^標題[:：]\s*|\*\*|[「」『』"“”]/g, "").trim();
    let text = rest.join("\n").trim();
    // 模型沒照格式（第一行就是內文）：整段當內文，標題用當天行程
    if (!text || title.length > 24) {
      text = raw;
      title = today ? String(today.title) : "旅途中的一天";
    }
    this.sql.exec(
      "INSERT INTO diaries (date, ts, title, text, photo_ids) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET ts = excluded.ts, title = excluded.title, text = excluded.text, photo_ids = excluded.photo_ids, edited_by = NULL, edited_at = NULL",
      date, Date.now(), title, text, JSON.stringify(photos),
    );
    if (announce) {
      const images: AttachedImage[] = photos.slice(0, 8).map((id) => ({ src: `/api/photo/${id}`, caption: "", source: "今天的照片" }));
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
        return {
          date,
          dayNo: Math.floor((Date.parse(date + "T00:00:00Z") - start) / 86400_000) + 1,
          title: String(d.title || plan.get(date) || "旅途中的一天"),
          plan: plan.get(date) ?? "",
          text: String(d.text ?? ""),
          photos: (JSON.parse((d.photo_ids as string) || "[]") as string[]).map((id) => photoBase + id),
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
      documents: this.documentFind().map((d) => ({ id: d.id, title: d.title, note: d.note, author: d.author, ts: d.ts, photo: `/api/photo/${d.photo_id}` })),
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
    const mems = this.memories().map((m) => `- #${m.id}［${m.category}］${m.content}（${m.author}）`).join("\n") || "（目前沒有）";
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

# 長期記憶（成員偏好、決定、預訂…，#編號可用 forget 刪除）
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
- 問路：用 plan_route 給 Google Maps 連結，必要時用 web_search 補充轉乘與票價。
- 民宿的位置一律用房東給的地圖連結 ${a.googleMap}；要帶路回民宿就用 plan_route，destination 填「民宿」。不要用「IKEBUKURO 4」或自己打的地址搜尋（會跑到池袋四丁目或錯的地方）。
- 地圖連結：工具回傳的連結可以直接用；其他地點一律寫成 [📍地點名稱](map)，系統會自動換成 Google 地圖搜尋連結（地點名稱用日文或英文的正式名稱，可加地區，例如 [📍ドン・キホーテ 池袋駅西口店](map)）。不要自己寫 Google 地圖網址，絕對不要編 maps.app.goo.gl 短網址，也不要用自己記得的地址或座標當連結（記錯一個字就會指到別的地方）。
- 成員在哪裡，一律以「成員最近位置」或訊息裡附的地名為準，絕對不要自己猜地名；以前聊天裡說過的位置可能已經過時，不要沿用。
- 每次有人問「附近」都要重新呼叫工具查詢，不可以沿用之前的回答。
- 你可以用 find_images 把網路上的圖片直接顯示給成員（照片、捷運／地鐵路線圖、平面圖、菜單…），絕對不要說「無法傳送圖片」。
- 成員要求看照片／圖片／路線圖時，一定要用 find_images（店名或景點名稱加地名；好幾個地方就放進 queries 一次查完）；圖片會自動顯示在回答下方。絕對不要自己產生圖片網址或 Google 圖片搜尋連結，並提醒是網路圖片、僅供參考。沒有要求就不要找圖片。
- 問「我附近有什麼」：直接用 find_nearby，near 留空（系統會自動用發問者的 GPS），回答時列出實際店名、距離、步行分鐘與地圖連結，不要只給「附近有很多」這種泛泛建議；需要評價再用 web_search 補充。問「某個地方附近有什麼」（例如龜有公園附近），也要用 find_nearby，near 填日文地名（亀有公園）。問「我在哪」用 get_member_locations，說出區域與最近的車站。
- 迪士尼當天問排隊，用 disney_wait_times。
- 問電車有沒有延誤、停駛 → train_status；問計程車多少錢、要多久 → taxi_fare；問地震、颱風、天氣會不會影響行程 → japan_alerts。
- 收到收據照片（或說「記帳這張收據」）：讀出店名、日期、含稅總金額、幣別與主要品項，用 add_expense 產生記帳卡片（description 寫「店名：品項」），付款人預設是發問者。幣別要看清楚：日本收據是 JPY（¥、円、令和），台灣收據是 TWD（NT$、民國年、統一發票）。民國年要加 1911（113 年＝2024 年），令和 N 年＝2018+N 年。若是免稅店或金額可能達免稅門檻，順便提醒。
- 只有成員明確說「加入／加到清單」時才用 add_checklist_items。只是說想買、要帶、問推薦，都不可以自動加入清單；只有成員提到想買或要帶東西時，才在回答最後問一句要不要加進清單，其他話題（例如記帳、問路）不要問。買到了、帶了、辦好了 → update_checklist_item；問清單 → get_checklist。
- 要求「幾點提醒」→ create_reminder（時間用東京時間 YYYY-MM-DD HH:mm）。
- 傳照片說要「存起來／存成票券」→ save_document；問「給我看○○的票／訂位」→ find_documents。
- 有人傳「🆘」走散求助：先安撫，用 get_member_locations 看大家在哪，建議就近約在明顯地標或車站剪票口集合，提醒可找工作人員幫忙、緊急打 110。
- 有人說「我付了／花了…」→ 用 add_expense 產生記帳卡片；問「花多少、怎麼分」→ expense_summary。只有成員說付了、花了、要記帳，或傳收據時才記帳；問「怎麼儲值、怎麼買票、要多少錢」是在問做法或價格，直接回答，不要問金額、不要產生記帳卡片。
- 成員做了決定、說了偏好、訂了東西 → 主動用 remember 記下來；行程要改就用 update_itinerary 產生修改卡片。只有 remember 成功後才能說「已記住」；沒有呼叫工具就不要聲稱已記住（系統也會在背景定期自動整理記憶）。
- 收到照片：辨識菜單、商品、看板、車票並翻譯說明；商品可以查價比價並試算免稅（tax_free_check）。
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

  private buildTurns(history: MessageRow[], trigger: MessageRow, image: Part | null): Turn[] {
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
        if (m.photo_id) t += "（附了一張照片）";
        if (m.lat != null) t += `（分享位置 ${m.lat?.toFixed(5)},${m.lon?.toFixed(5)}）`;
        push("user", t);
      }
    }
    let t = `［${trigger.author}］${this.replyContext(trigger)}${trigger.text || (trigger.photo_id ? "請看這張照片" : "")}`;
    if (trigger.lat != null) {
      const area = this.memberLocation(trigger.author)[0]?.area;
      t += `（我目前的位置：${area ? `${area}附近，` : ""}座標 ${trigger.lat?.toFixed(5)},${trigger.lon?.toFixed(5)}。位置可能變了，需要地點資訊請用工具重新查詢，不要沿用之前的回答）`;
    }
    const parts: Part[] = [{ text: t }];
    if (image) parts.push(image);
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

    let image: Part | null = null;
    if (trigger.photo_id) {
      const p = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", trigger.photo_id).toArray()[0];
      if (p) image = { image: { mime: p.mime as string, data: toBase64(p.data as ArrayBuffer) } };
    }
    // 附了位置就先把地名查好，AI 才不會自己猜在哪裡
    if (trigger.lat != null) await this.ensureArea(trigger.author);
    const history = this.recentMessages(HISTORY_WINDOW);
    const system = this.systemPrompt(trigger, history[0]?.ts ?? trigger.ts);
    const images: AttachedImage[] = [];
    const toolsUsed: string[] = [];
    const drafts: number[] = [];
    const propose = (d: DraftInput) => this.propose(d, user.name, id, drafts);
    // 成員像是在修改剛才還沒確認的卡片（「打錯了，是 3500」）
    const fixing = /改成|改為|改一下|打錯|寫錯|記錯|不對|應該是|更正|修正/.test(trigger.text)
      ? this.sql.exec("SELECT id, kind, preview FROM drafts WHERE status = 'pending' AND ts > ? ORDER BY id DESC LIMIT 1", Date.now() - 30 * 60_000).toArray()[0]
      : undefined;
    let lastError = "";
    // 跨模型共用：Gemini 中途被限流時，備援模型接著已完成的工具結果繼續，不會重複記帳或重複查詢
    let turns = this.buildTurns(history, trigger, image);
    const onWait = (ms: number) => this.broadcast({ type: "ai_note", id, text: `Gemini 額度冷卻中，等待 ${Math.ceil(ms / 1000)} 秒…` });
    const gate = this.geminiGate(1, FOREGROUND_MAX_WAIT, onWait);
    const backupGate = this.geminiGate(1, FOREGROUND_MAX_WAIT, onWait, true);

    for (const pid of order) {
      const provider: Provider = providerFor(this.env, pid, pid === "gemini-backup" ? backupGate : gate);
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
            resultParts.push({ result: { id: c.id, name: c.name, response: result } });
          }
          turns = [...turns, { role: "model", parts: modelParts }, { role: "user", parts: resultParts }];
          if (step === MAX_STEPS - 1) finalText = res.text || "（查了很多資料，但還沒整理完，請再問一次更具體的問題 🙏）";
        }
        if (!finalText.trim()) finalText = images.length ? "幫你找到這些圖片 👇（網路圖片，僅供參考）" : "嗯…我沒有想到好的回答，可以換個方式問我嗎？";
        const row = this.insertMessage({
          id, author: AI_NAME, role: "assistant", text: fixMapLinks(stripSpeakerTag(finalText), this.mapFix()), photo_id: null, lat: null, lon: null,
          meta: JSON.stringify({
            provider: provider.id, model: provider.model, tools: [...new Set(toolsUsed)].map(toolLabel),
            ...(images.length ? { images } : {}),
            ...(drafts.length ? { drafts } : {}),
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
      id, author: AI_NAME, role: "assistant", text: `抱歉，AI 暫時無法回答 🙇\n\n\`${lastError.slice(0, 200)}\``, photo_id: null, lat: null, lon: null,
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
          text: `成員（${user.name}）說：「${trigger.text}」
現在是東京時間 ${now.date}（${now.weekday}）${now.time}。旅伴名單：${this.members().join("、") || user.name}。
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
    const existing = this.memories().map((m) => `#${m.id}［${m.category}］${m.content}`).join("\n") || "（無）";
    const prompt = `以下是家庭旅遊群組最新的對話，請整理群組的長期記憶：
1. summary：把「舊摘要」與新對話合併成新的「整趟旅程對話摘要」（400 字內；保留每個人的偏好、做過的決定、討論過的店家與地點、待辦、重要資訊）。
2. memories：萃取新對話中「之後還會用到」且「不在現有記憶裡」的事實，每條一句話、寫清楚是誰。
   例如：誰喜歡／不吃什麼、想買什麼、想去哪、決定了什麼、訂了什麼、待辦事項、聊到的店名與地址。
   不要收錄住宿地址、航班這些系統已知的資料，也不要收錄閒聊或 AI 自己的建議。沒有就回空陣列。
3. remove_ids：現有記憶中已經過時、被新對話推翻、或重複的記憶 id（例如「想吃燒肉」後來改成「想吃壽司」，就刪掉舊的）。沒有就回空陣列。

舊摘要：
${this.setting("summary") || "（無）"}

現有記憶：
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
          const res = await providerFor(this.env, pid, gate).generate({
            system: "你是負責整理旅遊群組長期記憶的助理，只輸出 JSON。",
            turns: [{ role: "user", parts: [{ text: prompt }] }],
            json: true,
          });
          const json = JSON.parse(res.text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
          if (typeof json.summary === "string" && json.summary.trim()) this.setSetting("summary", json.summary.trim().slice(0, 2000));
          for (const id of (json.remove_ids ?? []).slice(0, 20)) {
            if (Number.isInteger(Number(id))) this.sql.exec("DELETE FROM memories WHERE id = ?", Number(id));
          }
          for (const m of (json.memories ?? []).slice(0, 20)) {
            if (m?.content) this.addMemory(String(m.content), String(m.category || "資訊"), "AI 自動整理");
          }
          this.setSetting("memory_cursor", String(fresh[fresh.length - 1].ts));
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
