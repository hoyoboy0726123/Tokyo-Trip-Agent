// 相片：大家在聊天傳的照片和票券照片，依日期分組。
// 手機用分享面板分批存進相簿（iPhone、Android）；電腦（或不支援的手機）下載成 zip。
// 這個檔案東京版和通用版共用，兩邊內容一樣。

const PH = { data: null, loading: false, error: "", open: new Set(), prep: {}, busy: {} };
const SHARE_BATCH = 10;
const phRoom = () => (typeof ROOM !== "undefined" && ROOM ? `?room=${encodeURIComponent(ROOM)}` : "");
const phMB = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}GB` : `${Math.max(0.1, n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}MB`);
const phDay = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${"日一二三四五六"[new Date(d + "T00:00:00Z").getUTCDay()]}）`;
const phTitle = () => String(S.trip?.title || S.state?.trip?.title || document.title || "旅程").replace(/[\\/:*?"<>|]/g, "");

async function loadPhotos() {
  PH.loading = true;
  try {
    const j = await (await fetch(`/api/photos${phRoom()}`)).json();
    if (!j.ok) throw new Error(j.error || "讀不到相片");
    PH.data = j;
    PH.error = "";
    if (!PH.open.size && j.days.length) PH.open.add(j.days[0].date);
  } catch (e) {
    PH.error = e.message || "讀不到相片";
  }
  PH.loading = false;
  if (S.panel === "photos") renderPanel();
}

/** 這支手機能不能用分享面板一次存好幾張照片 */
function canShareFiles() {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], "x.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

function renderPhotosPanel(b) {
  els.panelTitle.textContent = "📷 相片";
  if (!PH.data && !PH.loading) loadPhotos();
  const d = PH.data;
  if (!d) {
    b.innerHTML = `${backToHub()}<div class="card small muted">${PH.error ? escapeHtml(PH.error) : "讀取中…"}</div>`;
    return bindBack(b);
  }
  const share = canShareFiles();
  b.innerHTML = `${backToHub()}
    <div class="card pic-head">
      <div><b>${d.count} 張照片</b><span class="small muted">　照片空間用了 ${phMB(d.bytes)}${d.limit ? `／上限 ${phMB(d.limit)}` : ""}</span></div>
      ${d.limit ? `<div class="pic-bar"><i style="width:${Math.min(100, (d.bytes / d.limit) * 100).toFixed(1)}%"></i></div>` : ""}
      <div class="small muted">照片存在這個旅程的雲端空間。${share ? "按每天的「存到手機相簿」就會存進手機，一次 10 張，張數多要按幾次。" : "按每天的「下載這天」會打包成 zip。"}</div>
    </div>
    ${d.days.length ? d.days.map((day) => phDayCard(day, share)).join("") : `<div class="card small muted">還沒有照片。在聊天傳的照片、票券保管箱的票券，都會出現在這裡。</div>`}`;
  bindBack(b);
  b.querySelectorAll("details.pic-day").forEach((x) =>
    x.addEventListener("toggle", () => {
      const was = PH.open.has(x.dataset.day);
      if (x.open === was) return;
      x.open ? PH.open.add(x.dataset.day) : PH.open.delete(x.dataset.day);
      renderPanel();
    }),
  );
  b.querySelectorAll("[data-ph]").forEach((x) => x.addEventListener("click", () => openViewer(`/api/photo/${encodeURIComponent(x.dataset.ph)}`)));
  b.querySelectorAll("[data-ph-share]").forEach((x) => x.addEventListener("click", () => sharePhotos(x.dataset.phShare)));
  b.querySelectorAll("[data-ph-zip]").forEach((x) => x.addEventListener("click", () => zipPhotos(x.dataset.phZip)));
}

function phDayCard(day, share) {
  const open = PH.open.has(day.date);
  const p = PH.prep[day.date];
  const left = p ? p.files.length - p.next : day.photos.length;
  const busy = PH.busy[day.date];
  const label = busy ? "準備中…" : !p ? `📲 存到手機相簿（${day.photos.length} 張）` : left > 0 ? `📲 存第 ${Math.floor(p.next / SHARE_BATCH) + 1} 批（${Math.min(SHARE_BATCH, left)} 張）` : "✅ 這天都存好了";
  return `<details class="card pic-day" data-day="${day.date}" ${open ? "open" : ""}>
    <summary><b>${phDay(day.date)}</b><span class="small muted">${day.photos.length} 張・${phMB(day.bytes)}</span></summary>
    <div class="row pic-actions">
      ${share ? `<button type="button" class="btn small primary-sm" data-ph-share="${day.date}" ${busy || (p && left <= 0) ? "disabled" : ""}>${label}</button>` : ""}
      <button type="button" class="btn small" data-ph-zip="${day.date}" ${PH.busy[`zip${day.date}`] ? "disabled" : ""}>${PH.busy[`zip${day.date}`] ? "打包中…" : "⬇️ 下載這天（zip）"}</button>
    </div>
    ${p && left > 0 && p.next === 0 ? `<div class="small muted">準備好了，再按一次就會叫出分享面板，選「儲存影像」。</div>` : ""}
    ${open ? `<div class="pic-grid">${day.photos.map((x) => `<button type="button" class="pic-cell" data-ph="${escapeHtml(x.id)}" aria-label="${escapeHtml(`${x.time} ${x.by}${x.ticket ? `・票券 ${x.ticket}` : ""}`)}"><img src="/api/photo/${encodeURIComponent(x.id)}" loading="lazy" alt="" />${x.ticket ? `<span class="pic-tag">🎫</span>` : ""}</button>`).join("")}</div>` : ""}
  </details>`;
}

/** 下載一天的照片成檔案（照片網址看過就有快取，不會重複下載） */
async function phFiles(date) {
  const day = PH.data.days.find((x) => x.date === date);
  const files = [];
  for (const [i, x] of day.photos.entries()) {
    const r = await fetch(`/api/photo/${encodeURIComponent(x.id)}`);
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    const ext = /png/.test(blob.type) ? "png" : /webp/.test(blob.type) ? "webp" : "jpg";
    files.push(new File([blob], `${date}_${x.time.replace(":", "")}_${String(i + 1).padStart(2, "0")}.${ext}`, { type: blob.type || "image/jpeg" }));
  }
  return files;
}

/** 分享面板一定要在按下去的當下叫出：第一次按先把照片準備好，再按一次才分享 */
async function sharePhotos(date) {
  const p = PH.prep[date];
  if (!p) {
    PH.busy[date] = true;
    renderPanel();
    try {
      PH.prep[date] = { files: await phFiles(date), next: 0 };
    } catch {
      alert("有照片下載失敗，請確認網路後再試一次");
    }
    PH.busy[date] = false;
    return renderPanel();
  }
  const batch = p.files.slice(p.next, p.next + SHARE_BATCH);
  try {
    await navigator.share({ files: batch });
    p.next += batch.length;
  } catch (e) {
    if (e.name !== "AbortError") alert(`沒有存成功：${e.message || e.name}`);
  }
  renderPanel();
}

async function zipPhotos(date) {
  const key = `zip${date}`;
  PH.busy[key] = true;
  renderPanel();
  try {
    const files = PH.prep[date]?.files ?? (await phFiles(date));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await makeZip(files));
    a.download = `${phTitle()}-${date}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch {
    alert("打包失敗，請確認網路後再試一次");
  }
  PH.busy[key] = false;
  renderPanel();
}

const ZIP_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function zipCrc(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = ZIP_CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 照片本來就壓縮過，zip 直接存（不再壓縮），手機打包也很快 */
async function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = zipCrc(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // 檔名用 UTF-8
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, x) => n + x.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}
