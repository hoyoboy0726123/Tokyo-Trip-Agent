/**
 * 旅遊日記網頁：封面＋每天一章（標題、行程、圖文交錯的內文與照片），手機好讀、可以列印成 PDF。
 * 成員版（登入後從 App 打開）和分享版（不用登入的連結）共用同一個版面，只差照片網址與工具列。
 */

export interface DiaryDay {
  date: string; // YYYY-MM-DD
  dayNo: number;
  title: string;
  plan: string; // 當天行程
  text: string;
  photos: string[]; // 照片網址
}

export interface DiaryPageInput {
  tripTitle: string;
  dates: string; // 顯示用，例如 2026/10/03 – 10/10
  travelers: string;
  accent: string;
  days: DiaryDay[];
  mode: "member" | "share";
  /** 已開啟的分享連結（完整網址）；沒開啟是 null */
  shareUrl: string | null;
  /** 完整網址開頭，給分享預覽圖用 */
  origin: string;
  autoPrint: boolean;
  /** 「回聊天」找不到上一頁時要去的網址 */
  homeUrl?: string;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const WEEKDAY = "日一二三四五六";
function dateText(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.replace(/^#+\s*|\*\*/g, "").trim())
    .filter(Boolean);
}

function img(src: string, cls = "", alt = ""): string {
  return `<img src="${esc(src)}"${cls ? ` class="${cls}"` : ""} alt="${esc(alt)}" loading="lazy" decoding="async">`;
}

/** 照片格：手機兩欄、奇數張時第一張橫跨整列；寬螢幕與列印時欄數跟著張數（最多 3 欄），才不會空一格 */
function grid(photos: string[], alt: string): string {
  if (!photos.length) return "";
  return `<div class="grid" style="--cols:${Math.min(photos.length, 3)}">${photos.map((p, i) => img(p, photos.length % 2 && i === 0 ? "wide" : "", alt)).join("")}</div>`;
}

/** 文字和照片交錯：第一段後放大圖，第二段後放兩張，其餘照片放在文末 */
function dayBody(d: DiaryDay): string {
  const ps = paragraphs(d.text);
  const [hero, ...rest] = d.photos;
  const mid = ps.length >= 3 ? rest.slice(0, 2) : [];
  const tail = rest.slice(mid.length);
  const out: string[] = [];
  ps.forEach((p, i) => {
    out.push(`<p>${esc(p)}</p>`);
    if (i === 0 && hero) out.push(`<figure class="hero">${img(hero, "", d.title)}</figure>`);
    if (i === 1 && mid.length) out.push(grid(mid, d.title));
  });
  if (!ps.length && hero) out.push(`<figure class="hero">${img(hero, "", d.title)}</figure>`);
  out.push(grid(tail, d.title));
  return out.join("");
}

export function renderDiaryPage(p: DiaryPageInput): string {
  const days = p.days;
  const photoCount = days.reduce((n, d) => n + d.photos.length, 0);
  // 封面用最近一天的照片（第一天的第一張在下面第一章就會出現，避免重複）
  const cover = [...days].reverse().find((d) => d.photos.length)?.photos[0] ?? "";
  const firstText = paragraphs(days[0]?.text ?? "")[0] ?? "";
  const ogImage = p.mode === "share" && cover ? p.origin + cover : "";
  const pageTitle = `${p.tripTitle}｜旅遊日記`;

  const toc = days.length > 1
    ? `<nav class="toc">${days.map((d) => `<a href="#${d.date}"><b>Day ${d.dayNo}</b>${esc(d.title)}</a>`).join("")}</nav>`
    : "";
  const chapters = days.length
    ? days
        .map(
          (d) => `<article class="day" id="${d.date}">
  <div class="day-head"><span class="day-no">DAY ${d.dayNo}</span><span>${dateText(d.date)}</span></div>
  <h2>${esc(d.title)}</h2>
  ${d.plan ? `<p class="plan">📍 ${esc(d.plan)}</p>` : ""}
  <div class="text">${dayBody(d)}</div>
</article>`,
        )
        .join("")
    : `<p class="empty">還沒有日記。旅途中每晚 22:00 會自動寫一篇。</p>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(pageTitle)}</title>
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(firstText.slice(0, 90))}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f4eee3;--card:#fffdf8;--ink:#1c1f26;--muted:#5b5f68;--line:#e3d9c8;--stamp:#b3400c;--accent:${esc(p.accent)};--title:"LXGW WenKai TC","Noto Serif TC",serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16.5px/1.9 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
img{display:block;max-width:100%}
.wrap{max-width:760px;margin:0 auto;padding:0 16px 104px}
.cover{position:relative;margin:0 -16px;min-height:78vh;min-height:78svh;display:flex;align-items:flex-end;overflow:hidden;background:#2a2622;color:#fff}
.cover-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.7))}
.cover-in{position:relative;z-index:1;padding:28px 22px calc(32px + env(safe-area-inset-bottom,0px))}
.cover.plain{min-height:auto;background:var(--card);color:var(--ink);border-bottom:1px solid var(--line)}
.cover.plain::after{display:none}
.cover.plain .cover-in{padding-top:48px}
.kicker{font-size:12px;letter-spacing:.3em;opacity:.9}
.cover h1{font-family:var(--title);font-size:clamp(34px,10vw,56px);line-height:1.15;margin:.25em 0 .35em}
.cover .meta{margin:0;font-size:15px;opacity:.95}
.stats{display:inline-block;margin-top:14px;padding:3px 13px;border:1px solid currentColor;border-radius:999px;font-size:13px;opacity:.9}
.toc{display:flex;gap:8px;overflow-x:auto;padding:18px 0 4px;margin:0 -16px;padding-left:16px;padding-right:16px;scrollbar-width:none}
.toc::-webkit-scrollbar{display:none}
.toc a{flex:none;max-width:72vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13.5px}
.toc b{color:var(--accent);margin-right:6px}
.day{background:var(--card);border:1px solid var(--line);border-radius:22px;margin:22px 0 0;padding:24px 18px 26px;scroll-margin-top:12px}
.day-head{display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--muted)}
.day-no{background:var(--accent);color:#fff;font-weight:800;letter-spacing:.1em;border-radius:8px;padding:1px 9px;font-size:12.5px}
.day h2{font-family:var(--title);font-size:clamp(25px,7vw,34px);line-height:1.3;margin:12px 0 6px}
.plan{font-size:14px;color:var(--stamp);margin:0 0 12px}
.text p{margin:0 0 1em}
.text>p:first-child::first-letter{font-family:var(--title);font-size:2.7em;float:left;line-height:1;margin:.1em .12em 0 0;color:var(--accent)}
figure{margin:18px -6px}
figure img,.grid img{width:100%;background:var(--line);cursor:zoom-in}
.hero img{aspect-ratio:4/3;object-fit:cover;border-radius:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px -6px}
.grid img{aspect-ratio:1;object-fit:cover;border-radius:12px}
.grid img.wide{grid-column:1/-1;aspect-ratio:16/9}
.empty{text-align:center;color:var(--muted);padding:48px 0}
footer{text-align:center;color:var(--muted);font-size:13px;padding:28px 0 8px}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:rgba(255,253,248,.94);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-top:1px solid var(--line)}
.bar button{flex:1;min-width:0;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-size:15px;font-weight:700;white-space:nowrap}
.bar button.main{background:var(--accent);border-color:transparent;color:#fff}
.lb{position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;padding:12px}
.lb.on{display:flex}
.lb img{max-width:100%;max-height:100%;border-radius:8px}
.toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:8;background:rgba(28,31,38,.92);color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;max-width:88vw;text-align:center;display:none}
.toast.on{display:block}
@media (min-width:700px){.grid{grid-template-columns:repeat(var(--cols,3),1fr)}.grid img.wide{grid-column:auto;aspect-ratio:4/3}.grid img{aspect-ratio:4/3}.day{padding:34px 40px 36px}figure,.grid{margin-left:0;margin-right:0}}
@page{size:A4;margin:14mm 14mm 16mm}
@media print{
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:#fff;font-size:11.5pt;line-height:1.8}
  .bar,.toc,.lb,.toast{display:none!important}
  .wrap{max-width:none;padding:0}
  .cover{margin:0;min-height:250mm;break-after:page}
  .day{break-before:page;border:0;border-radius:0;margin:0;padding:0}
  figure,.grid,.grid img{break-inside:avoid}
  figure,.grid{margin:12px 0}
  .hero img{max-height:105mm}
  .grid{grid-template-columns:repeat(var(--cols,3),1fr)}
  .grid img,.grid img.wide{grid-column:auto;aspect-ratio:4/3;max-height:80mm}
  footer{display:none}
}
</style>
</head>
<body>
<div class="wrap">
<header class="cover${cover ? "" : " plain"}">
  ${cover ? `<img class="cover-img" src="${esc(cover)}" alt="">` : ""}
  <div class="cover-in">
    <div class="kicker">TRAVEL DIARY ・ 旅遊日記</div>
    <h1>${esc(p.tripTitle)}</h1>
    <p class="meta">${esc(p.dates)}${p.travelers ? `　${esc(p.travelers)}` : ""}</p>
    <span class="stats">已記錄 ${days.length} 天・${photoCount} 張照片</span>
  </div>
</header>
${toc}
<main>${chapters}</main>
<footer>由旅伴 AI 根據群組對話與照片整理</footer>
</div>
<div class="bar">
  ${p.mode === "member" ? `<button type="button" onclick="goBack()">← 回聊天</button>` : ""}
  <button type="button" onclick="pdf()">下載 PDF</button>
  <button type="button" class="main" onclick="share()">分享</button>
</div>
<div class="lb" id="lb" onclick="this.classList.remove('on')"><img alt=""></div>
<div class="toast" id="toast"></div>
<script>
var MODE = ${JSON.stringify(p.mode)}, SHARE = ${JSON.stringify(p.shareUrl)}, TITLE = ${JSON.stringify(pageTitle)}, HOME = ${JSON.stringify(p.homeUrl ?? "/")};
function toast(t, ms) {
  var el = document.getElementById("toast");
  el.textContent = t; el.classList.toggle("on", !!t);
  clearTimeout(el._t); if (t && ms) el._t = setTimeout(function () { el.classList.remove("on"); }, ms);
}
// 主畫面 App 模式下會在同一個視窗打開、沒有返回鍵；另開分頁時直接關掉
function goBack() { if (history.length > 1) { history.back(); return; } window.close(); setTimeout(function () { location.href = HOME; }, 300); }
// 延遲載入的照片要先全部載好，列印出來才不會空白
function pdf() {
  var imgs = Array.prototype.slice.call(document.images);
  imgs.forEach(function (i) { i.loading = "eager"; });
  toast("正在準備 PDF…");
  Promise.all(imgs.map(function (i) { return i.complete ? 0 : new Promise(function (r) { i.onload = i.onerror = r; }); })).then(function () {
    toast("");
    var iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    window.print();
    if (iOS) toast("在列印畫面點右上角「分享」→「儲存到檔案」就是 PDF", 6000);
  });
}
function share() {
  var url = MODE === "share" ? location.href.split("#")[0] : SHARE;
  if (!url) { toast("還沒開啟分享連結：請管理員到 App 的「旅遊日記」開啟", 4000); return; }
  if (navigator.share) {
    navigator.share({ title: TITLE, url: url }).catch(function (e) { if (e && e.name !== "AbortError") copy(url); });
    return;
  }
  copy(url);
}
function copy(url) {
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("已複製分享連結", 2500); }, function () { window.prompt("複製這個連結分享：", url); });
  else window.prompt("複製這個連結分享：", url);
}
document.addEventListener("click", function (e) {
  var t = e.target;
  if (t.tagName === "IMG" && t.closest(".day")) { var lb = document.getElementById("lb"); lb.querySelector("img").src = t.src; lb.classList.add("on"); }
});
${p.autoPrint ? `window.addEventListener("load", function () { setTimeout(pdf, 300); });` : ""}
</script>
</body>
</html>`;
}
