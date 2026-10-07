/**
 * 地圖連結修正（AI 回答存檔前）。模型只要自己寫網址就可能出錯，Gemini 也一樣：
 * 1. 手動編碼寫壞（「下北�%8�站」、混進奇怪文字）→ 改用連結文字或前面提到的地點名稱
 * 2. 自己編的地址（記錯號碼就指到別處）→ 有地點名稱就改用名稱搜尋
 * 3. 編造的短網址 maps.app.goo.gl/亂碼（代碼是 Google 隨機產生的，編的一定打不開）→ 改用地點名稱搜尋；
 *    確定正確的短網址（例如房東給的住宿地圖）用 keep 保留
 * 4. 查詢字裡有座標（找附近的結果）→ 直接用座標，位置最準
 * 5. 提到住宿 → 一律換成正確的住宿位置與導航目的地（home）
 * 6. 導航連結文字寫了「從 A 到 B」→ 起訖點以文字為準（網址常把站名編碼錯）
 * 找不到可靠的地點名稱又是亂碼的連結就拿掉，只留文字，不給會帶錯路的連結。
 */

const MAP_SEARCH = "https://www.google.com/maps/search/?api=1&query=";
const FAKE_MAP = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i;
const SEARCH_LINK = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps(?:\/search\/)?\/?\?(?:api=1&)?(?:query|q)=|maps\.google\.[a-z.]+\/(?:maps)?\?q=)(.*)$/i;
const DIR_LINK = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/dir\//i;
const MAP_REF = /^map(?::|$)/i;
/** 查詢字裡的座標（找附近工具給的「店名 緯度,經度」） */
const COORDS = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
/** 看起來是模型自己寫的地址 */
const ADDRESS = /〒|\d+\s*丁目|\d+\s*番地|\d+-\d+-\d+|[都道府県].{1,8}[区市町村郡].{0,10}\d/;
/** 連結文字只是在說「這是地圖」，不是地點名稱 */
const GENERIC = /^(google\s*)?(地圖|maps?|導航|連結|位置|地點|路線|link|here|這裡|點這裡|點此|開啟|查看|打開|看|點我|按這裡|請點)+$/i;
/** 粗體小標（「為什麼必去」「位置」）不是地點名稱 */
const NOT_PLACE = /為什麼|位置|地址|亮點|交通|營業|時間|價格|費用|推薦|注意|建議|提醒|重點|怎麼|如何|必逛|必吃|必去|特色|說明|小撇步|備註|預算|天氣|抵達|到達|出發|步驟|路線|走法|方向|距離|分鐘|^\d/;
/** 連結文字或搜尋字只是「民宿／住宿（的位置、導航）」 */
const HOME_WORDS = /^(我們的?|回)?(民宿|住宿|住的地方|飯店|酒店|旅館)(的)?(位置|地圖|地址|地圖位置|導航|導航連結|路線|門口)?$/;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

export interface MapFixOptions {
  /** 確定正確的連結（例如房東給的住宿地圖短網址），原封不動 */
  keep?: string[];
  /**
   * 住宿：模型自己寫的住宿連結常常錯（用房源名稱搜尋會跑到別處、地址抄錯字），提到住宿的連結一律換成正確的。
   * names＝住宿的名稱、地址等專有寫法；search＝正確的位置連結；dest＝導航用的正確目的地
   */
  home?: { names: RegExp | null; search: string; dest: string };
}

function clean(s: string): string {
  return s
    .replace(EMOJI, "")
    .replace(/^[\s#*\d.、)）\-—:：]+/, "")
    .replace(/[（(—–\-:：|｜].*$/, "")
    .replace(/的$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 連結文字裡的地點名稱（拿掉「Google 地圖」「點這裡看步行路線」這類字）；只是在說「這是地圖」就回傳 null */
function labelPlace(label: string): string | null {
  const name = clean(label.replace(/google\s*|maps?\b/gi, "").replace(/地圖|點這裡|點此開啟|點此|按這裡|點我|開啟|打開|導航|連結|查看|看|步行|走路|大眾運輸|搭車|開車|路線|前往|帶路/g, ""));
  return name.length >= 2 && !GENERIC.test(name.replace(/\s/g, "")) && !looksBroken(name) ? name : null;
}

const MAP_URL = (url: string) => FAKE_MAP.test(url) || SEARCH_LINK.test(url) || DIR_LINK.test(url) || MAP_REF.test(url);

/**
 * 從連結前面的文字找最近的地點名稱（前面的地圖連結文字、粗體、標題）。
 * 導航連結前面常是「**過馬路**」「**走出大門**」這類步驟小標，所以 preferLinks 時先找前面地圖連結裡的地名
 */
function nearestPlace(before: string, preferLinks = false): string | null {
  const tail = before.slice(-800);
  const links: { at: number; name: string }[] = [];
  for (const m of tail.matchAll(/\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
    const name = MAP_URL(m[2].trim()) ? labelPlace(m[1]) : null;
    if (name && !NOT_PLACE.test(name) && !HOME_WORDS.test(name.replace(/\s/g, ""))) links.push({ at: m.index ?? 0, name });
  }
  if (preferLinks && links.length) return links[links.length - 1].name;
  const found = [...links];
  for (const m of tail.matchAll(/\*\*([^*\n]{2,40})\*\*/g)) found.push({ at: m.index ?? 0, name: m[1] });
  for (const m of tail.matchAll(/^#{1,4}\s+(.+)$/gm)) found.push({ at: m.index ?? 0, name: m[1] });
  found.sort((a, b) => b.at - a.at);
  for (const f of found) {
    const name = clean(f.name);
    const bare = name.replace(/\s/g, "");
    if (name.length >= 2 && !NOT_PLACE.test(name) && !GENERIC.test(bare) && !HOME_WORDS.test(bare) && !looksBroken(name)) return name;
  }
  return null;
}

/** 連結文字裡的地點名稱；只是「地圖點這裡」就往前找 */
function placeFor(label: string, before: string, preferLinks = false): string | null {
  return labelPlace(label) ?? nearestPlace(before, preferLinks);
}

function decodeQuery(query: string): { text: string; ok: boolean } {
  const q = query.trim().replace(/\+/g, " ");
  try {
    return { text: decodeURIComponent(q), ok: true };
  } catch {
    return { text: q, ok: false };
  }
}

/** 模型手動編碼寫壞的痕跡：替換字元、殘留的 %XX、混進其他語系的文字 */
function looksBroken(s: string, decodedOk = true): boolean {
  return (!decodedOk && s.includes("%")) || s.includes("�") || /%[0-9A-Fa-f]{1,2}/.test(s) || /[֐-ࣿऀ-෿]/.test(s);
}

const searchUrl = (text: string) => MAP_SEARCH + encodeURIComponent(text);

/** 搜尋連結：有座標用座標；亂碼或自編地址改用地點名稱；回傳 null＝沒有可靠的地點，拿掉連結 */
function fixQuery(raw: string, label: string, before: string): string | null {
  const { text, ok } = decodeQuery(raw);
  // 編碼寫壞時座標可能還是「35.73%2C139.70」：放寬比對
  const c = text.replace(/%2C/gi, ",").replace(/%20/g, " ").match(COORDS);
  if (c) return searchUrl(`${c[1]},${c[2]}`);
  const broken = looksBroken(text, ok);
  if (broken || ADDRESS.test(text)) {
    const name = placeFor(label, before);
    if (name) return searchUrl(name);
    if (broken) return null;
  }
  return text.trim() ? searchUrl(text.trim()) : null;
}

/**
 * 導航連結：起點、終點是住宿就換成正確地址（模型常抄錯字）；
 * 目的地有座標保留座標；亂碼或自編地址改用前面提到的地點名稱；起點是亂碼就拿掉（改用目前位置）
 */
function fixDirection(url: string, label: string, before: string, home?: MapFixOptions["home"]): string | null {
  let u: URL;
  try {
    u = new URL(url.replace(/ /g, "%20"));
  } catch {
    if (home && isHome(home, label, "")) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(home.dest)}`;
    const name = nearestPlace(before, true);
    return name ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(name)}` : null;
  }
  // 連結文字寫了「從 A 到 B」：模型自己編碼網址常打錯字（「六本本駅」「澤交駅」），以連結文字為準
  const pair = routeLabel(label);
  if (pair) {
    if (!sameName(pair[0], u.searchParams.get("origin") ?? "")) u.searchParams.set("origin", pair[0]);
    if (!sameName(pair[1], u.searchParams.get("destination") ?? "")) u.searchParams.set("destination", pair[1]);
  }
  const origin = u.searchParams.get("origin");
  const fromHome = !!home && !!origin && isHome(home, "", origin);
  if (fromHome) u.searchParams.set("origin", home!.dest);
  else if (origin && looksBroken(origin)) u.searchParams.delete("origin");

  const dest = u.searchParams.get("destination") ?? "";
  const c = dest.match(COORDS);
  if (home && (isHome(home, "", dest) || (!fromHome && isHome(home, label, "")))) {
    u.searchParams.set("destination", home.dest);
    // 從住宿導航到住宿沒有意義：起點拿掉，改用目前位置
    if (fromHome) u.searchParams.delete("origin");
  }
  else if (c) u.searchParams.set("destination", `${c[1]},${c[2]}`);
  else if (looksBroken(dest) || ADDRESS.test(dest)) {
    const name = placeFor(label, before, true);
    if (name) u.searchParams.set("destination", name);
    else if (looksBroken(dest)) return null;
  }
  return u.toString();
}

/** 連結文字裡的「從 A 到 B」「A → B」 */
function routeLabel(label: string): [string, string] | null {
  const t = label.replace(EMOJI, "");
  const m = t.match(/從\s*(.{2,20}?)\s*(?:到|前往|去)\s*(.{2,20}?)\s*(?:的|$|\s|（|\()/) ?? t.match(/([^\s→>]{2,20})\s*(?:→|->|➡)\s*([^\s的（(]{2,20})/);
  if (!m) return null;
  const a = m[1].trim(), b = m[2].trim();
  return !GENERIC.test(a) && !GENERIC.test(b) && !/google|地圖|導航|路線/i.test(a + b) ? [a, b] : null;
}

/** 站名比對：繁體／日文漢字、「站」「駅」「station」都算一樣 */
const VARIANT: Record<string, string> = { 樂: "楽", 淺: "浅", 澀: "渋", 藏: "蔵", 驛: "駅", 國: "国", 廣: "広", 濱: "浜", 澤: "沢", 邊: "辺", 惠: "恵", 兩: "両", 區: "区", 黑: "黒", 龜: "亀", 豐: "豊", 臺: "台", 鐵: "鉄", 櫻: "桜", 學: "学", 會: "会" };
function sameName(a: string, b: string): boolean {
  const k = (s: string) => [...s.normalize("NFKC")].map((c) => VARIANT[c] ?? c).join("").replace(/\s|站|駅|역|station/gi, "").toLowerCase();
  return k(a) === k(b);
}

function linkTarget(url: string): string {
  if (MAP_REF.test(url)) return url.slice(4).trim();
  try {
    const u = new URL(url.replace(/ /g, "%20"));
    return u.searchParams.get("query") ?? u.searchParams.get("q") ?? u.searchParams.get("destination") ?? "";
  } catch {
    return "";
  }
}

function isHome(home: NonNullable<MapFixOptions["home"]>, label: string, target: string): boolean {
  const bare = (s: string) => s.replace(EMOJI, "").replace(/\s/g, "");
  return !!home.names?.test(label) || !!home.names?.test(target) || HOME_WORDS.test(bare(label)) || HOME_WORDS.test(bare(target));
}

export function fixMapLinks(text: string, opts: MapFixOptions = {}): string {
  const keep = new Set((opts.keep ?? []).filter(Boolean));
  // Markdown 連結 [文字](網址)；網址裡可能有沒編碼的空白，所以抓到右括號為止
  let out = text.replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, label: string, rawUrl: string, offset: number) => {
    const url = rawUrl.trim();
    if (keep.has(url)) return whole;
    if (!MAP_URL(url)) return whole;
    const before = text.slice(0, offset);
    let fixed: string | null;
    if (DIR_LINK.test(url)) fixed = fixDirection(url, label, before, opts.home);
    // 提到住宿的位置連結：一律用正確的住宿連結
    else if (opts.home && isHome(opts.home, label, linkTarget(url))) fixed = opts.home.search;
    else if (MAP_REF.test(url)) {
      // 提示詞要模型寫 [📍地點名稱](map)：地名只寫一次，網址由這裡產生
      const ref = url.slice(4).trim();
      fixed = ref ? fixQuery(ref, label, before) : (() => { const name = placeFor(label, before); return name ? searchUrl(name) : null; })();
    } else if (FAKE_MAP.test(url)) {
      const name = placeFor(label, before);
      fixed = name ? searchUrl(name) : null;
    } else {
      // [網址](網址)：模型把網址抄了兩次，第二次常抄錯；用文字那份
      const labelUrl = label.trim().match(SEARCH_LINK);
      if (labelUrl) {
        const q = fixQuery(labelUrl[1].split("&")[0], "", before);
        if (!q) return label;
        return `[📍 ${decodeQuery(new URL(q).searchParams.get("query") ?? "").text}](${q})`;
      }
      fixed = fixQuery(url.match(SEARCH_LINK)![1].split("&")[0], label, before);
    }
    return fixed ? `[${label}](${fixed})` : label;
  });
  // 沒包在 Markdown 裡的假短網址
  out = out.replace(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[A-Za-z0-9_\-]*/g, (url, offset: number, all: string) => {
    if (keep.has(url)) return url;
    // 已經包在 Markdown 連結裡的（例如保留下來的房東短網址）不要再動
    if (all[offset - 1] === "(" && all[offset - 2] === "]") return url;
    const place = nearestPlace(out.slice(0, offset));
    return place ? `[Google 地圖](${searchUrl(place)})` : "";
  });
  return out;
}
