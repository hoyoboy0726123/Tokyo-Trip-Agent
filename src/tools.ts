import type { Env, ToolDecl } from "./types";
import { TRIP } from "./trip-data";

/** 工具可以用到的聊天室功能（由 TripRoom 實作） */
export interface RoomApi {
  members(): string[];
  memberLocation(name?: string): { name: string; lat: number; lon: number; accuracy: number | null; ts: number }[];
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

export interface ToolContext {
  env: Env;
  room: RoomApi;
  author: string;
}

type Executor = (args: any, ctx: ToolContext) => Promise<unknown>;

interface Tool {
  decl: ToolDecl;
  label: string;
  run: Executor;
}

const UA = "TokyoTripAgent/1.0 (family travel assistant)";

async function getJSON(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) } });
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

// ---------------- 附近地點（OpenStreetMap Overpass） ----------------

const NEARBY: Record<string, string> = {
  food: `nwr(around:{r},{lat},{lon})["amenity"~"^(restaurant|fast_food|food_court)$"];`,
  cafe: `nwr(around:{r},{lat},{lon})["amenity"="cafe"];`,
  convenience: `nwr(around:{r},{lat},{lon})["shop"="convenience"];`,
  drugstore: `nwr(around:{r},{lat},{lon})["shop"~"^(chemist|pharmacy)$"];nwr(around:{r},{lat},{lon})["amenity"="pharmacy"];`,
  supermarket: `nwr(around:{r},{lat},{lon})["shop"="supermarket"];`,
  toilet: `nwr(around:{r},{lat},{lon})["amenity"="toilets"];`,
  atm: `nwr(around:{r},{lat},{lon})["amenity"="atm"];`,
  locker: `nwr(around:{r},{lat},{lon})["amenity"="locker"];`,
  station: `nwr(around:{r},{lat},{lon})["railway"="station"];`,
  shopping: `nwr(around:{r},{lat},{lon})["shop"~"^(department_store|mall|variety_store|toys|electronics)$"];`,
  park: `nwr(around:{r},{lat},{lon})["leisure"~"^(park|playground)$"];`,
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
        const g = await geocode(args.place);
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
      description: "取得成員最近分享的 GPS 位置與附近地址。回答「附近」「我在哪」「怎麼去」類問題時先用這個。",
      parameters: { type: "object", properties: { name: { type: "string", description: "成員名稱，留空=全部" } } },
    },
    async run(args, { room }) {
      const locs = room.memberLocation(args.name);
      if (!locs.length) return { error: "還沒有人分享位置。請按輸入框旁的 📍 分享位置。" };
      const out = [];
      for (const l of locs.slice(0, 4)) {
        let address = "";
        try {
          const g = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${l.lat}&lon=${l.lon}&accept-language=ja,zh-TW&zoom=17`);
          address = g.display_name ?? "";
        } catch {}
        out.push({ ...l, minutes_ago: Math.round((Date.now() - l.ts) / 60000), address, map: mapsLink(l) });
      }
      return out;
    },
  },
  {
    label: "🗺 找附近",
    decl: {
      name: "find_nearby",
      description: "找附近的地點（餐廳、咖啡、便利商店、藥妝、超市、廁所、ATM、置物櫃、車站、購物、公園）。預設以發問者的位置為中心。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: Object.keys(NEARBY) },
          keyword: { type: "string", description: "名稱或料理關鍵字過濾，例如 ラーメン、寿司、ユニクロ" },
          near: { type: "string", description: "地名；留空=發問者目前位置，沒有位置就用住宿" },
          radius_m: { type: "integer", description: "搜尋半徑公尺，預設 600" },
        },
        required: ["category"],
      },
    },
    async run(args, { room, author }) {
      let center = { lat: TRIP.accommodation.lat, lon: TRIP.accommodation.lon, label: "住宿（要町）" };
      if (args.near) {
        const g = await geocode(args.near);
        if (g) center = { ...g, label: g.name };
      } else {
        const mine = room.memberLocation(author)[0] ?? room.memberLocation()[0];
        if (mine && Date.now() - mine.ts < 3 * 3600_000) center = { lat: mine.lat, lon: mine.lon, label: `${mine.name} 的位置` };
      }
      const r = Math.min(Math.max(Number(args.radius_m) || 600, 100), 2000);
      const q = (NEARBY[args.category] ?? NEARBY.food).replaceAll("{r}", String(r)).replaceAll("{lat}", String(center.lat)).replaceAll("{lon}", String(center.lon));
      const d = await getJSON("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(`[out:json][timeout:20];(${q});out center 80;`),
      });
      const kw = String(args.keyword ?? "").toLowerCase();
      const places = (d.elements ?? [])
        .map((e: any) => {
          const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
          const t = e.tags ?? {};
          return {
            name: t["name:zh"] || t.name || t["name:en"] || "(無名稱)",
            name_ja: t.name,
            cuisine: t.cuisine,
            opening_hours: t.opening_hours,
            distance_m: distanceM(center.lat, center.lon, lat, lon),
            map: mapsLink(t.name ? `${t.name} ${lat},${lon}` : { lat, lon }),
          };
        })
        .filter((p: any) => !kw || JSON.stringify(p).toLowerCase().includes(kw))
        .sort((a: any, b: any) => a.distance_m - b.distance_m)
        .slice(0, 12);
      return { center: center.label, radius_m: r, places, source: "© OpenStreetMap contributors", tip: "評價與排隊狀況可再用 web_search 查 Tabelog / Google" };
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
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}
