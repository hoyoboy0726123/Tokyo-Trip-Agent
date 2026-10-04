/**
 * 模型常自己編 Google 地圖連結：maps.app.goo.gl/亂碼（短網址代碼是 Google 隨機產生的，編的一定打不開；
 * 確定正確的短網址例如房東給的住宿地圖，用 keep 保留）。
 * 回答存檔前把這種連結換成「用地點名稱搜尋」的連結；名稱取連結文字，
 * 連結文字只是「地圖點這裡」時，改取前面最近的粗體或標題裡的地點名稱；找不到名稱就拿掉連結，只留文字。
 * 也順便把搜尋連結裡沒編碼的中日文、空白編好，免得連結在空白處斷掉。
 */

const MAP_SEARCH = "https://www.google.com/maps/search/?api=1&query=";
const FAKE_MAP = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i;
const SEARCH_LINK = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps(?:\/search\/)?\/?\?(?:api=1&)?(?:query|q)=|maps\.google\.[a-z.]+\/(?:maps)?\?q=)(.*)$/i;
/** 連結文字只是在說「這是地圖」，不是地點名稱 */
const GENERIC = /^(google\s*)?(地圖|maps?|導航|連結|位置|地點|路線|link|here|這裡|點這裡|點此|開啟|查看|打開|看|點我|按這裡|請點)+$/i;
/** 粗體小標（「為什麼必去」「位置」）不是地點名稱 */
const NOT_PLACE = /為什麼|位置|地址|亮點|交通|營業|時間|價格|費用|推薦|注意|建議|提醒|重點|怎麼|如何|必逛|必吃|必去|特色|說明|小撇步|備註|預算|天氣|^\d/;

function clean(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/^[\s#*\d.、)）\-—:：]+/, "")
    .replace(/[（(—–\-:：|｜].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 從連結前面的文字找最近的地點名稱（粗體或標題） */
function nearestPlace(before: string): string | null {
  const tail = before.slice(-600);
  const found: { at: number; name: string }[] = [];
  for (const m of tail.matchAll(/\*\*([^*\n]{2,40})\*\*/g)) found.push({ at: m.index ?? 0, name: m[1] });
  for (const m of tail.matchAll(/^#{1,4}\s+(.+)$/gm)) found.push({ at: m.index ?? 0, name: m[1] });
  found.sort((a, b) => b.at - a.at);
  for (const f of found) {
    const name = clean(f.name);
    if (name.length >= 2 && !NOT_PLACE.test(name) && !GENERIC.test(name.replace(/\s/g, ""))) return name;
  }
  return null;
}

function placeFor(label: string, before: string): string | null {
  const name = clean(label.replace(/google\s*/i, "").replace(/地圖|點這裡|點此開啟|點此|開啟|導航|連結|查看/g, ""));
  if (name.length >= 2 && !GENERIC.test(name.replace(/\s/g, ""))) return name;
  return nearestPlace(before);
}

function decodeQuery(query: string): string {
  const q = query.trim().replace(/\+/g, " ");
  try {
    return decodeURIComponent(q);
  } catch {
    return q;
  }
}

function searchUrl(query: string): string {
  return MAP_SEARCH + encodeURIComponent(decodeQuery(query));
}

export interface MapFixOptions {
  /** 確定正確的連結（例如房東給的住宿地圖短網址），原封不動 */
  keep?: string[];
  /**
   * 住宿：模型自己寫的住宿連結常常錯（用房源名稱搜尋會跑到別處、地址抄錯字），提到住宿的連結一律換成正確的。
   * names＝住宿的名稱、地址等專有寫法；search＝正確的位置連結；dest＝導航用的正確目的地
   */
  home?: { names: RegExp | null; search: string; dest: string };
}

/** 連結文字或搜尋字只是「民宿／住宿（的位置、導航）」 */
const HOME_WORDS = /^(我們的?|回)?(民宿|住宿|住的地方|飯店|酒店|旅館)(的)?(位置|地圖|地址|地圖位置|導航|導航連結|路線|門口)?$/;

function linkTarget(url: string): string {
  if (/^map(?::|$)/i.test(url)) return url.slice(4).trim();
  try {
    const u = new URL(url.replace(/ /g, "%20"));
    return u.searchParams.get("query") ?? u.searchParams.get("q") ?? u.searchParams.get("destination") ?? "";
  } catch {
    return "";
  }
}

function isHome(home: NonNullable<MapFixOptions["home"]>, label: string, target: string): boolean {
  const bare = (s: string) => s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]/gu, "");
  return !!home.names?.test(label) || !!home.names?.test(target) || HOME_WORDS.test(bare(label)) || HOME_WORDS.test(bare(target));
}

function withDestination(url: string, dest: string): string {
  try {
    const u = new URL(url.replace(/ /g, "%20"));
    u.searchParams.set("destination", dest);
    return u.toString();
  } catch {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  }
}

export function fixMapLinks(text: string, opts: MapFixOptions = {}): string {
  const keep = new Set((opts.keep ?? []).filter(Boolean));
  // Markdown 連結 [文字](網址)；網址裡可能有沒編碼的空白，所以抓到右括號為止
  let out = text.replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, label: string, rawUrl: string, offset: number) => {
    const url = rawUrl.trim();
    if (keep.has(url)) return whole;
    // 提到住宿的連結：位置用正確的連結，導航的目的地換成正確地址（模型自己寫的常跑錯地方）
    if (opts.home && (FAKE_MAP.test(url) || SEARCH_LINK.test(url) || /\/maps\/dir\//.test(url) || /^map(?::|$)/i.test(url)) && isHome(opts.home, label, linkTarget(url))) {
      return `[${label}](${/\/maps\/dir\//.test(url) ? withDestination(url, opts.home.dest) : opts.home.search})`;
    }
    // 提示詞要模型寫 [📍地點名稱](map)：地名只寫一次，網址由這裡產生（Gemma 在網址裡重抄日文常抄錯）
    if (/^map(?::|$)/i.test(url)) {
      const place = (url.slice(4).trim() || label).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim();
      return place ? `[${label}](${searchUrl(place)})` : label;
    }
    // [網址](網址)：模型把網址抄了兩次，第二次常抄錯；用文字那份，顯示改成地名
    const labelUrl = label.trim().match(SEARCH_LINK);
    if (labelUrl && (SEARCH_LINK.test(url) || FAKE_MAP.test(url))) {
      const name = decodeQuery(labelUrl[1].split("&")[0]);
      return `[📍 ${name}](${MAP_SEARCH}${encodeURIComponent(name)})`;
    }
    if (FAKE_MAP.test(url)) {
      const place = placeFor(label, text.slice(0, offset));
      return place ? `[${label}](${searchUrl(place)})` : label;
    }
    // 已經編好碼的搜尋連結（工具給的，可能還帶 query_place_id）原封不動；有空白或沒編碼的中日文才重組
    const s = /[\s\u0080-￿]/.test(url) ? url.match(SEARCH_LINK) : null;
    if (s) return `[${label}](${searchUrl(s[1].split("&")[0])})`;
    return whole;
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
