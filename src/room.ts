import { DurableObject } from "cloudflare:workers";
import { safeEqual } from "./auth";
import { providerFor } from "./providers";
import { runTool, toolLabel, TOOL_DECLS, type ExpenseInput, type RoomApi } from "./tools";
import { INITIAL_ITINERARY, TRIP } from "./trip-data";
import type { Env, Part, Provider, SessionUser, Turn } from "./types";

const HISTORY_WINDOW = 40; // 每次帶給模型的最近訊息數
const MAX_STEPS = 8; // 單次回答最多工具回合
const MEMORY_EVERY = 10; // 每 10 則新訊息自動整理一次長期記憶
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

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class TripRoom extends DurableObject<Env> implements RoomApi {
  private sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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

    const admin = !!this.env.ADMIN_PASSWORD && safeEqual(password, this.env.ADMIN_PASSWORD);
    const member = admin || (!!this.env.ROOM_PASSWORD && safeEqual(password, this.env.ROOM_PASSWORD));
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
        const row = this.insertMessage({
          author: user.name, role: "user", text, photo_id: photoId, lat: loc?.lat ?? null, lon: loc?.lon ?? null, meta: null,
        });
        this.broadcast({ type: "message", message: this.publicMessage(row) });
        if (this.shouldReply(text, !!photoId)) {
          const job = this.queue.then(() => this.runAgent(row, user));
          this.queue = job.catch(() => {});
          await job;
        }
        return;
      }

      case "location":
        if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) this.saveLocation(user.name, msg);
        return;

      case "load_more": {
        const rows = this.sql
          .exec<MessageRow>("SELECT * FROM messages WHERE ts < ? ORDER BY ts DESC LIMIT 50", Number(msg.before) || Date.now())
          .toArray()
          .reverse();
        return this.send(ws, { type: "older", messages: rows.map((m) => this.publicMessage(m)) });
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

  private shouldReply(text: string, hasPhoto: boolean): boolean {
    if (!text && !hasPhoto) return false; // 單純分享位置不打擾 AI
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
      case "settings":
        if (!user.admin) return reply(false, "只有管理員可以修改設定");
        if (msg.provider === "gemini" || msg.provider === "workers-ai") this.setSetting("provider", msg.provider);
        if (msg.replyMode === "all" || msg.replyMode === "mention") this.setSetting("reply_mode", msg.replyMode);
        if (typeof msg.travelers === "string") {
          this.setSetting("travelers", msg.travelers.slice(0, 200));
          this.broadcastState();
        }
        this.broadcast({ type: "settings", settings: this.settings() });
        break;
      case "clear_chat":
        if (!user.admin) return reply(false, "只有管理員可以清除聊天");
        this.sql.exec("DELETE FROM messages");
        this.sql.exec("DELETE FROM photos");
        this.setSetting("summary", "");
        this.broadcast({ type: "cleared" });
        break;
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
    return {
      id: m.id,
      ts: m.ts,
      author: m.author,
      role: m.role,
      text: m.text,
      photo: m.photo_id ? `/api/photo/${m.photo_id}` : null,
      location: m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon } : null,
      meta: m.meta ? JSON.parse(m.meta) : null,
    };
  }

  private saveLocation(name: string, loc: { lat: number; lon: number; accuracy?: number }) {
    this.sql.exec(
      "INSERT INTO locations VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, accuracy = excluded.accuracy, ts = excluded.ts",
      name, loc.lat, loc.lon, loc.accuracy ?? null, Date.now(),
    );
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
    return rows.map((r) => ({ name: r.name as string, lat: r.lat as number, lon: r.lon as number, accuracy: r.accuracy as number | null, ts: r.ts as number }));
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
    return this.sql
      .exec(`SELECT ts, author, text FROM messages WHERE ${where} ORDER BY ts DESC LIMIT ?`, ...words.map((w) => `%${w}%`), limit)
      .toArray()
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
      locations: this.memberLocation(),
      trip: { title: TRIP.title, startDate: TRIP.startDate, endDate: TRIP.endDate, accommodation: TRIP.accommodation.name },
    };
  }

  private broadcastState() {
    this.broadcast({ type: "state", state: this.state() });
  }

  // ================= Agent =================

  private systemPrompt(): string {
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
      .map((l) => `- ${l.name}：${l.lat.toFixed(5)},${l.lon.toFixed(5)}（${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`)
      .join("\n");
    const summary = this.setting("summary");

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
${summary ? `\n# 更早的對話摘要\n${summary}\n` : ""}${locs ? `\n# 成員最近位置\n${locs}\n` : ""}
# 回答規則
- 一律使用繁體中文與台灣用語，語氣親切，適合手機閱讀：精簡、條列、重點加粗，不要長篇大論。
- 訊息開頭的［名字］代表是誰說的，回答時可以稱呼對方。
- 營業時間、票價、活動、交通、天氣、排隊等「會變動的資訊」一定要用工具查，並附上來源連結；查不到就說不確定，絕不編造。
- 工具回傳 error 代表失敗：要如實告訴成員沒有完成，不可以說已完成。記帳前確認分攤對象是否符合成員說的人數。
- 提到日圓價格時附上約合台幣（用 convert_currency）。
- 問路：用 plan_route 給 Google Maps 連結，必要時用 web_search 補充轉乘與票價。問「附近」先看成員位置，再用 find_nearby。
- 迪士尼當天問排隊，用 disney_wait_times。
- 有人說「我付了／花了…」→ 用 add_expense 記帳；問「花多少、怎麼分」→ expense_summary。
- 成員做了決定、說了偏好、訂了東西、改了計畫 → 主動用 remember 或 update_itinerary 記下來。只有工具呼叫成功後才能說「已記住／已更新」；沒有呼叫工具就不要聲稱已記住（系統也會在背景定期自動整理記憶）。
- 收到照片：辨識菜單、商品、看板、車票並翻譯說明；商品可以查價比價並試算免稅（tax_free_check）。
- 安全第一：遇到緊急狀況提供日本緊急電話（警察 110、救護/消防 119）與最近的醫院資訊。`;
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
      if (m.role === "assistant") push("model", m.text || "（略）");
      else if (m.role === "user") {
        let t = `［${m.author}］${m.text}`;
        if (m.photo_id) t += "（附了一張照片）";
        if (m.lat != null) t += `（分享位置 ${m.lat?.toFixed(5)},${m.lon?.toFixed(5)}）`;
        push("user", t);
      }
    }
    let t = `［${trigger.author}］${trigger.text || (trigger.photo_id ? "請看這張照片" : "")}`;
    if (trigger.lat != null) t += `（我目前的位置：${trigger.lat?.toFixed(5)},${trigger.lon?.toFixed(5)}）`;
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
    const primary = settings.provider === "workers-ai" || !settings.hasGemini ? "workers-ai" : "gemini";
    const order = primary === "gemini" ? ["gemini", "workers-ai"] : settings.hasGemini ? ["workers-ai", "gemini"] : ["workers-ai"];

    let image: Part | null = null;
    if (trigger.photo_id) {
      const p = this.sql.exec("SELECT mime, data FROM photos WHERE id = ?", trigger.photo_id).toArray()[0];
      if (p) image = { image: { mime: p.mime as string, data: toBase64(p.data as ArrayBuffer) } };
    }
    const history = this.recentMessages(HISTORY_WINDOW);
    const system = this.systemPrompt();
    const toolsUsed: string[] = [];
    let lastError = "";

    for (const pid of order) {
      const provider: Provider = providerFor(this.env, pid);
      this.broadcast({ type: "ai_start", id, provider: provider.id, model: provider.model });
      let turns = this.buildTurns(history, trigger, image);
      let finalText = "";
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const res = await provider.generate({
            system,
            turns,
            tools: TOOL_DECLS,
            onDelta: (delta) => this.broadcast({ type: "ai_delta", id, delta }),
          });
          if (!res.calls.length) {
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
            const result = await runTool(c.name, c.args, { env: this.env, room: this, author: user.name });
            resultParts.push({ result: { id: c.id, name: c.name, response: result } });
          }
          turns = [...turns, { role: "model", parts: modelParts }, { role: "user", parts: resultParts }];
          if (step === MAX_STEPS - 1) finalText = res.text || "（查了很多資料，但還沒整理完，請再問一次更具體的問題 🙏）";
        }
        if (!finalText.trim()) finalText = "嗯…我沒有想到好的回答，可以換個方式問我嗎？";
        const row = this.insertMessage({
          id, author: AI_NAME, role: "assistant", text: finalText, photo_id: null, lat: null, lon: null,
          meta: JSON.stringify({ provider: provider.id, model: provider.model, tools: [...new Set(toolsUsed)].map(toolLabel) }),
        });
        this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
        this.ctx.waitUntil(this.maybeConsolidateMemory());
        return;
      } catch (e: any) {
        lastError = String(e?.message ?? e);
        console.error(`provider ${pid} failed`, lastError);
        this.broadcast({ type: "ai_retry", id, error: lastError });
      }
    }

    const row = this.insertMessage({
      id, author: AI_NAME, role: "assistant", text: `抱歉，AI 暫時無法回答 🙇\n\n\`${lastError.slice(0, 200)}\``, photo_id: null, lat: null, lon: null,
      meta: JSON.stringify({ error: true }),
    });
    this.broadcast({ type: "ai_done", id, message: this.publicMessage(row) });
  }

  /** 長期記憶：定期把聊天內容濃縮成摘要，並萃取值得記住的事實 */
  private async maybeConsolidateMemory() {
    const cursor = Number(this.setting("memory_cursor", "0"));
    const fresh = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE ts > ? ORDER BY ts", cursor).toArray();
    if (fresh.filter((m) => m.role === "user").length < MEMORY_EVERY) return;
    this.setSetting("memory_cursor", String(fresh[fresh.length - 1].ts));

    const transcript = fresh
      .slice(-60)
      .map((m) => `${m.role === "assistant" ? AI_NAME : m.author}：${m.text.slice(0, 500)}`)
      .join("\n");
    const existing = this.memories().map((m) => `- ${m.content}`).join("\n") || "（無）";
    const prompt = `以下是家庭旅遊群組最近的對話，請完成兩件事：
1. summary：把「舊摘要」與這段對話合併成新的對話摘要（300 字內，保留決定、偏好、待辦、重要資訊）。
2. memories：從這段對話萃取「之後還會用到」且「不在現有記憶裡」的事實（偏好、決定、預訂、資訊、待辦），每條一句話、寫清楚是誰；沒有就回空陣列。
   不要收錄住宿地址、航班、行程表這些系統已經知道的基本資料（除非有變更），也不要收錄閒聊或 AI 自己的建議。

舊摘要：
${this.setting("summary") || "（無）"}

現有記憶：
${existing}

對話：
${transcript}

輸出 JSON：{"summary": "...", "memories": [{"content": "...", "category": "偏好|決定|預訂|資訊|待辦"}]}`;

    const pid = this.settings().hasGemini ? "gemini" : "workers-ai";
    try {
      const res = await providerFor(this.env, pid).generate({ system: "你是負責整理旅遊群組記憶的助理，只輸出 JSON。", turns: [{ role: "user", parts: [{ text: prompt }] }], json: true });
      const json = JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim());
      if (typeof json.summary === "string" && json.summary.trim()) this.setSetting("summary", json.summary.trim().slice(0, 1500));
      for (const m of (json.memories ?? []).slice(0, 20)) {
        if (m?.content) this.addMemory(String(m.content), String(m.category || "資訊"), "AI 自動整理");
      }
    } catch (e) {
      console.error("memory consolidation failed", e);
    }
  }
}
