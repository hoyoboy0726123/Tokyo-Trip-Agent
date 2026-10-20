// Transitous（https://transitous.org）大眾運輸路線查詢。
// 已取得維護者同意：低用量（每天約 20–50 次）、結果快取、User-Agent 標明專案、畫面附資料來源連結。
// 這個檔案不依賴 Workers 環境，可以直接用 node 測試（scripts/test-transit.ts）。

export const TRANSITOUS_API = "https://api.transitous.org";
export const TRANSITOUS_UA = "TripAgent/1.0 (+https://github.com/hoyoboy0726123/Trip-Agent)";
export const TRANSITOUS_ATTRIBUTION = "路線資料：Transitous（https://transitous.org/sources/）";

const JST_OFFSET = 9 * 3600_000;

export interface LatLon {
  lat: number;
  lon: number;
  name?: string;
}

export interface TransitLeg {
  /** walk = 步行；其餘是搭車 */
  kind: "walk" | "ride";
  line?: string;
  operator?: string;
  direction?: string;
  from: string;
  to: string;
  depart: string; // 東京時間 HH:MM
  arrive: string;
  minutes: number;
  stops?: number; // 坐幾站
  walk_m?: number;
  realtime?: boolean;
}

export interface TransitOption {
  depart: string;
  arrive: string;
  minutes: number;
  transfers: number;
  legs: TransitLeg[];
  note?: string;
}

/** UTC ISO → 東京時間 HH:MM */
export function jstTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + JST_OFFSET).toISOString().slice(11, 16);
}

/** 東京時間「YYYY-MM-DDTHH:MM」→ UTC ISO（給 API 的 time 參數） */
export function jstToUtcIso(local: string): string | null {
  const m = String(local ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00Z`);
  return Number.isFinite(t) ? new Date(t - JST_OFFSET).toISOString() : null;
}

/** 去掉日文後面重複的英文：「池袋 Ikebukuro」→「池袋」、「JR京葉線 JR Keiyō Line」→「JR京葉線」 */
function stripEn(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/(?<=[^\x00-\x7F)）])\s+[A-Za-zŌōŪūĀā][\w\s.'ōūŌŪāĀ-]*$/, "")
    .trim();
}

function stationName(name: string): string {
  const s = String(name ?? "").trim();
  if (s === "START") return "出發地";
  if (s === "END") return "目的地";
  return stripEn(s);
}

/** 路線名稱：Transitous 合併了好幾份資料，有些路線名稱只是一串數字，要換成看得懂的說法 */
export function lineName(leg: any): string {
  const long = stripEn(leg.routeLongName);
  if (long) return long;
  const short = String(leg.routeShortName ?? "").trim();
  const agency = stripEn(leg.agencyName);
  if (short && !/^\d+$/.test(short)) return agency ? `${agency} ${short}` : short;
  // 只有數字代碼的路線：用「業者（往○○）」描述
  const dir = headsign(leg);
  return `${agency || "電車"}${dir ? `（往${dir}）` : ""}`;
}

function headsign(leg: any): string {
  // 「(各駅停車 Local) 池袋 Ikebukuro」→「池袋」
  return stripEn(String(leg.headsign ?? "").replace(/^\([^)]*\)\s*/, ""));
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}

/** 把 /api/v5/plan 的大回應精簡成 AI 好讀的幾條路線（原始回應常有幾百 KB，大多是地圖線條） */
export function compactPlan(json: any, max = 3): TransitOption[] {
  const out: TransitOption[] = [];
  const seen = new Set<string>();
  for (const it of json?.itineraries ?? []) {
    const legsRaw: any[] = it.legs ?? [];
    // 有任何一段被取消的路線直接丟掉
    if (legsRaw.some((l) => l.cancelled || l.from?.cancelled || l.to?.cancelled)) continue;

    const legs: TransitLeg[] = [];
    for (const l of legsRaw) {
      const mins = minutesBetween(l.startTime, l.endTime);
      if (l.mode === "WALK") {
        const dist = Math.round(Number(l.distance) || 0);
        const prev = legs[legs.length - 1];
        // 同一站內轉乘、距離 0 的步行合併掉
        if (dist === 0 && prev) continue;
        if (prev && prev.kind === "walk") {
          prev.to = stationName(l.to?.name);
          prev.arrive = jstTime(l.endTime);
          prev.minutes += mins;
          prev.walk_m = (prev.walk_m ?? 0) + dist;
          continue;
        }
        legs.push({ kind: "walk", from: stationName(l.from?.name), to: stationName(l.to?.name), depart: jstTime(l.startTime), arrive: jstTime(l.endTime), minutes: mins, walk_m: dist });
      } else {
        legs.push({
          kind: "ride",
          line: lineName(l),
          operator: stripEn(l.agencyName) || undefined,
          direction: headsign(l) || undefined,
          from: stationName(l.from?.name),
          to: stationName(l.to?.name),
          depart: jstTime(l.startTime),
          arrive: jstTime(l.endTime),
          minutes: mins,
          stops: (l.intermediateStops?.length ?? 0) + 1,
          realtime: l.realTime === true || undefined,
        });
      }
    }
    const rides = legs.filter((l) => l.kind === "ride");
    if (!rides.length) continue;
    // 同樣的搭車組合只留最早出發的那班
    const key = rides.map((r) => `${r.line}|${r.from}|${r.to}`).join(">");
    if (seen.has(key)) continue;
    seen.add(key);

    const first = legs[0];
    const note = first.kind === "walk" && first.minutes >= 12 ? `第一段要走 ${first.minutes} 分鐘，附近可能有更近的車站，可以對照 Google 地圖` : undefined;
    out.push({
      depart: jstTime(it.startTime),
      arrive: jstTime(it.endTime),
      minutes: minutesBetween(it.startTime, it.endTime),
      transfers: Math.max(0, rides.length - 1),
      legs,
      note,
    });
  }
  return out.sort((a, b) => a.arrive.localeCompare(b.arrive) || a.transfers - b.transfers).slice(0, max);
}

async function getJSON(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": TRANSITOUS_UA, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Transitous 回應 ${res.status}`);
  return res.json();
}

/** 地名 → 座標（偏向東京附近的結果） */
export async function transitGeocode(text: string, near: LatLon = { lat: 35.68, lon: 139.76 }): Promise<LatLon | null> {
  const u = new URL("/api/v1/geocode", TRANSITOUS_API);
  u.searchParams.set("text", text);
  u.searchParams.set("language", "ja");
  u.searchParams.set("place", `${near.lat},${near.lon}`);
  const data = await getJSON(u.toString(), 10_000);
  const list: any[] = Array.isArray(data) ? data : data?.matches ?? [];
  const hit = list.find((m) => Number.isFinite(m?.lat) && Number.isFinite(m?.lon));
  return hit ? { lat: hit.lat, lon: hit.lon, name: hit.name } : null;
}

/** 查路線：time 是 UTC ISO；arriveBy=true 表示「要在這個時間前到」 */
export async function transitPlan(from: LatLon, to: LatLon, opts: { time?: string; arriveBy?: boolean } = {}): Promise<TransitOption[]> {
  const u = new URL("/api/v5/plan", TRANSITOUS_API);
  u.searchParams.set("fromPlace", `${from.lat},${from.lon}`);
  u.searchParams.set("toPlace", `${to.lat},${to.lon}`);
  if (opts.time) u.searchParams.set("time", opts.time);
  if (opts.arriveBy) u.searchParams.set("arriveBy", "true");
  return compactPlan(await getJSON(u.toString(), 20_000));
}

/** 「35.7,139.6」這種座標字串 */
export function parseLatLon(s: string): LatLon | null {
  const m = String(s ?? "").trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
