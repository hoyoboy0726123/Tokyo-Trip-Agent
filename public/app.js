// 東京旅伴 前端：登入、即時群聊（WebSocket）、照片、定位、行程／記帳／記憶面板
const $ = (s) => document.querySelector(s);
const els = {
  login: $("#login"), loginForm: $("#login-form"), loginName: $("#login-name"), loginPassword: $("#login-password"), loginError: $("#login-error"),
  app: $("#app"), messages: $("#messages"), loadMore: $("#load-more"), toLatest: $("#to-latest"), toLatestN: $("#to-latest-n"), conn: $("#conn"),
  dayBadge: $("#day-badge"), todayTitle: $("#today-title"), online: $("#online"), avatars: $("#avatars"), chips: $("#chips"),
  replyBar: $("#reply-bar"), pinBar: $("#pin-bar"), pins: $("#pins"), pinList: $("#pin-list"),
  nextCard: $("#next-card"), ncToggle: $("#nc-toggle"), chipsToggle: $("#chips-toggle"), tabbar: $("#tabbar"), more: $("#more"), moreActions: $("#more-actions"), moreAsks: $("#more-asks"),
  input: $("#input"), sendForm: $("#send-form"), sendBtn: $("#send-btn"), photoInput: $("#photo-input"),
  attach: $("#attach"), attachImgs: $("#attach-imgs"), attachLoc: $("#attach-loc"), attachClear: $("#attach-clear"),
  panel: $("#panel"), panelTitle: $("#panel-title"), panelBody: $("#panel-body"), panelClose: $("#panel-close"),
  viewer: $("#viewer"), viewerImg: $("#viewer-img"), viewerDl: $("#viewer-dl"),
  translator: $("#translator"), trBody: $("#tr-body"), trTabs: $("#tr-tabs"),
  showcase: $("#showcase"),
};

const S = {
  me: null, aiName: "旅伴 AI", settings: {}, state: null, ws: null, retry: 0,
  oldest: null, pending: { photos: [], location: null },
  live: new Map(), // 正在生成的 AI 訊息
  panel: null, lastDay: null,
};

const COLORS = ["#e4572e", "#2e86ab", "#7b2cbf", "#f29e4c", "#17a398", "#d81159", "#3a86ff", "#8338ec"];
const colorFor = (name) => COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const jst = (ts) => new Date(ts + 9 * 3600e3);
const timeText = (ts) => jst(ts).toISOString().slice(11, 16);
const dayText = (ts) => { const d = jst(ts); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日一二三四五六"[d.getUTCDay()]}）`; };
const yen = (n) => `${n < 0 ? "-" : ""}¥${Math.abs(Math.round(n)).toLocaleString()}`;
const dateLabel = (date) => { const d = new Date(date + "T00:00:00Z"); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日一二三四五六"[d.getUTCDay()]}）`; };

// 方案 A 的線條圖示（路徑取自 Lucide）
const ICONS = {
  luggage: '<path d="M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"/><path d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 8h8M8 12h8"/>',
  lang: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  exchange: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  train: '<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M18 22l-2-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  list: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pushpin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

// 模型偶爾會寫 $\rightarrow$ 這類 LaTeX；聊天室不載數學排版，換成對應符號就好
const LATEX = { rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", times: "×", div: "÷", approx: "≈", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", cdot: "·", sim: "～", yen: "¥" };
function unLatex(text) {
  return String(text ?? "")
    .replace(/\$\s*\\([a-zA-Z]+)\s*\$/g, (m, k) => LATEX[k] ?? m)
    .replace(/\\(rightarrow|leftarrow|Rightarrow|times|approx|cdot)\b/g, (_, k) => LATEX[k]);
}

function md(text) {
  text = unLatex(text);
  if (window.marked && window.DOMPurify) {
    const html = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
    return html.replace(/<a /g, '<a target="_blank" rel="noopener" ');
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

// ================= 登入 =================

async function checkSession() {
  let res;
  try {
    res = await fetch("/api/me");
  } catch {
    // 沒網路：用上次登入的名字進入離線模式（常用句、票券還能用）
    const name = localStorage.getItem("tta-name");
    if (name) {
      S.me = { name, admin: false };
      S.offline = true;
      els.app.hidden = false;
      renderChips();
      els.conn.hidden = false;
      els.conn.textContent = "📴 離線中：翻譯常用句與票券仍可使用";
      setTimeout(connect, 5000);
      return;
    }
    els.login.hidden = false;
    return;
  }
  if (res.ok) {
    S.me = (await res.json()).user;
    startApp();
  } else {
    els.login.hidden = false;
    els.loginName.value = localStorage.getItem("tta-name") || "";
  }
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.loginError.hidden = true;
  const btn = els.loginForm.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: els.loginName.value.trim(), password: els.loginPassword.value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "登入失敗");
    localStorage.setItem("tta-name", data.user.name);
    S.me = data.user;
    els.login.hidden = true;
    startApp();
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function startApp() {
  els.app.hidden = false;
  renderChips();
  connect();
  if (localStorage.getItem("tta-autoloc") === "1") startAutoLocation();
}

// ================= WebSocket =================

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  els.conn.hidden = false;
  els.conn.textContent = "連線中…";
  ws.onopen = () => { S.retry = 0; els.conn.hidden = true; };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    if (e.code === 1008 || e.code === 4001) return location.reload();
    els.conn.hidden = false;
    els.conn.textContent = "連線中斷，重新連線中…";
    const delay = Math.min(1000 * 2 ** S.retry++, 15000);
    setTimeout(async () => {
      try {
        const me = await fetch("/api/me");
        if (me.status === 401) return location.reload();
      } catch {}
      connect();
    }, delay);
  };
}

setInterval(() => S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: "ping" })), 25000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.ws && S.ws.readyState > 1) connect();
});

function wsSend(obj) {
  if (S.ws?.readyState !== 1) {
    alert("目前沒有連線，請稍後再試");
    return false;
  }
  S.ws.send(JSON.stringify(obj));
  return true;
}

function handle(m) {
  switch (m.type) {
    case "hello":
      checkVersion(m.version);
      S.me = m.me;
      S.aiName = m.aiName;
      S.settings = m.settings;
      setState(m.state);
      if (m.locateReq && m.locateReq.by !== m.me?.name) reportLocationFor(m.locateReq);
      els.messages.querySelectorAll(".msg, .day-sep, .unread-sep").forEach((n) => n.remove());
      S.lastDay = null;
      S.live.clear();
      m.messages.forEach((msg) => appendMessage(msg));
      S.oldest = m.messages[0]?.ts ?? null;
      els.loadMore.hidden = m.messages.length < 60;
      restoreReadPosition();
      break;
    case "message":
      newMessage(m.message);
      if (m.message.role === "user" && m.message.text.startsWith("🆘") && m.message.author !== S.me.name) showSos(m.message);
      break;
    case "older":
      prependMessages(m.messages, m.hasMore);
      S.loadingOlder = false;
      if (S.jumpAfterLoad) {
        S.jumpAfterLoad = false;
        jumpToUnread();
      }
      break;
    case "presence":
      renderPresence(m.online);
      break;
    case "settings":
      S.settings = m.settings;
      if (S.panel === "settings" || S.panel === "diary") renderPanel();
      break;
    case "locate_request":
      if (m.by !== S.me?.name) reportLocationFor(m);
      break;
    case "locations":
      if (S.state) {
        S.state.locations = m.locations;
        clearTimeout(S.mapRedraw);
        if (S.panel === "map") S.mapRedraw = setTimeout(() => S.panel === "map" && renderPanel(), 800);
      }
      break;
    case "state":
      setState(m.state);
      break;
    case "cleared":
      els.messages.querySelectorAll(".msg, .day-sep, .unread-sep").forEach((n) => n.remove());
      S.lastDay = null;
      break;
    case "ai_start":
      aiStart(m);
      break;
    case "ai_tool":
      aiTool(m);
      break;
    case "ai_delta":
      aiDelta(m);
      break;
    case "ai_retry":
      aiRetry(m);
      break;
    case "ai_reset": {
      const live = S.live.get(m.id);
      if (live) {
        live.text = "";
        live.node.querySelector(".ai-body").innerHTML = TYPING;
      }
      break;
    }
    case "ai_note": {
      const live = S.live.get(m.id);
      if (live) live.node.querySelector(".ai-time").textContent = m.text;
      break;
    }
    case "ai_done":
      aiDone(m);
      break;
    case "translation":
      onTranslation(m);
      break;
    case "translations":
      TR.history = m.items;
      if (els.translator.open && TR.tab === "history") renderTranslator();
      break;
    case "draft":
      document.querySelectorAll(`[data-draft="${m.draft.id}"]`).forEach((el) => (el.outerHTML = draftHtml(m.draft)));
      break;
    case "action_result":
      if (m.action === "translate" || m.action === "add_phrase") trActionDone(m);
      // 卡片按了但失敗（例如別人已經處理過）：把按鈕恢復，畫面會跟著伺服器的狀態更新
      if (!m.ok && (m.action === "draft_confirm" || m.action === "draft_cancel")) document.querySelectorAll(".draft-actions button:disabled").forEach((x) => (x.disabled = false));
      if (m.action === "diary_edit") {
        if (m.ok) {
          S.diaryEdit = null;
          if (S.panel === "diary-edit") openPanel("diary");
        } else {
          const sv = $("#de-save");
          if (sv) {
            sv.disabled = false;
            sv.textContent = "儲存";
          }
        }
      }
      if (!m.ok && m.error) alert(m.error);
      else if (m.ok && m.action === "reset") alert("已清除 ✅");
      else if (m.ok && m.action === "gemini_key") alert("Gemini 金鑰已更新，馬上生效 ✅");
      if (m.action === "gemini_key" && S.panel === "settings") renderPanel();
      break;
  }
}

// ================= 訊息渲染 =================

const TYPING = `<span class="typing"><span></span><span></span><span></span></span>`;

/** 工具標籤原本帶 emoji（🌤 查天氣），方案 A 只留文字 */
const toolBadge = (label) => `<span class="tool-chip">${escapeHtml(String(label).replace(/^[^\p{L}\p{N}]+/u, ""))}</span>`;

function renderPresence(online) {
  els.online.textContent = online.length ? `${online.join("、")}在線` : "";
  els.avatars.innerHTML = online.slice(0, 3).map((n) => `<span style="background:${colorFor(n)}">${escapeHtml([...n][0])}</span>`).join("");
}

function messageNode(msg) {
  const isAI = msg.role === "assistant";
  const isMe = !isAI && msg.author === S.me?.name;
  const node = document.createElement("div");
  node.className = `msg ${isAI ? "ai" : isMe ? "me" : "other"}`;
  node.dataset.id = msg.id;
  node.dataset.ts = msg.ts;
  node.dataset.author = msg.author;
  if (isAI && msg.meta?.for?.author) node.dataset.for = msg.meta.for.author;
  if (isAI && msg.meta?.kind) node.dataset.sys = "1";
  let body = "";
  // 這則是在回覆別的訊息：上面顯示引用，點一下跳回原訊息
  if (!isAI && msg.meta?.reply) body += `<button type="button" class="quote" data-quote="${escapeHtml(msg.meta.reply.id)}"><b>${escapeHtml(msg.meta.reply.author)}</b><span>${escapeHtml(plainExcerpt({ text: msg.meta.reply.text }))}</span></button>`;
  const pics = msg.photos?.length ? msg.photos : msg.photo ? [msg.photo] : [];
  if (pics.length > 1) body += `<div class="photo-grid">${pics.map((src) => `<img class="photo" src="${escapeHtml(src)}" loading="lazy" alt="照片" />`).join("")}</div>`;
  else if (pics.length) body += `<img class="photo" src="${escapeHtml(pics[0])}" loading="lazy" alt="照片" />`;
  if (msg.location) {
    const url = `https://www.google.com/maps/search/?api=1&query=${msg.location.lat},${msg.location.lon}`;
    body += `<div class="loc-card">📍 <a href="${url}" target="_blank" rel="noopener">分享了目前位置</a></div>`;
  }
  // 文字部分包一層，「複製」只拿這段（不含圖片說明）
  if (msg.text) body += isAI ? `<div class="msg-text">${md(msg.text)}</div>` : `<span class="msg-text">${escapeHtml(msg.text).replace(/\n/g, "<br>")}</span>`;
  const pinned = S.pinned?.has(msg.id);
  if (pinned) node.classList.add("pinned");
  const actions = `<div class="msg-actions"><button type="button" data-act="reply">${svg("reply")}<span>回覆</span></button><button type="button" data-act="copy">${svg("copy")}<span>複製</span></button><button type="button" data-act="pin">${svg("pushpin")}<span>${pinned ? "取消置頂" : "置頂"}</span></button></div>`;
  const images = (msg.meta?.images ?? []).filter((im) => typeof im.src === "string" && (im.src.startsWith("/api/img?") || im.src.startsWith("/api/photo/")));
  const webImages = images.some((im) => im.src.startsWith("/api/img?"));
  if (images.length) {
    body += `<div class="gallery">${images
      .map((im) => {
        const link = /^https?:\/\//.test(im.page ?? "") ? im.page : null;
        return `<figure>
          <img class="photo web" src="${escapeHtml(im.src)}" loading="lazy" alt="${escapeHtml(im.caption)}" onerror="this.closest('figure').remove()" />
          <figcaption>${im.label ? `<b>${escapeHtml(im.label)}</b><br>` : ""}${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(im.source)}</a>` : escapeHtml(im.source)}</figcaption>
        </figure>`;
      })
      .join("")}</div>${webImages ? `<div class="small muted">🖼 網路圖片，僅供參考</div>` : ""}`;
  }
  if (isAI) {
    const provider = msg.meta?.provider ? (msg.meta.provider === "workers-ai" ? "Workers AI" : "Gemini") : "";
    node.innerHTML = `<div class="ai-card">
      <div class="ai-head"><span class="ai-avatar">${svg("luggage")}</span><span class="ai-name">${escapeHtml(msg.author)}</span>
        <span class="ai-tools">${(msg.meta?.tools ?? []).map(toolBadge).join("")}</span>
        <span class="ai-time">${timeText(msg.ts)}${provider ? ` · ${provider}` : ""}</span></div>
      <div class="ai-body rich">${body}</div>
      ${(msg.drafts ?? []).map(draftHtml).join("")}
      ${actions}
    </div>`;
  } else if (isMe) {
    node.innerHTML = `<div class="bubble-wrap"><div class="bubble rich">${body}</div><div class="meta">${timeText(msg.ts)}</div>${actions}</div>`;
  } else {
    node.innerHTML = `<div class="avatar" style="background:${colorFor(msg.author)}">${escapeHtml([...msg.author][0])}</div>
      <div class="bubble-wrap"><div class="name">${escapeHtml(msg.author)}・${timeText(msg.ts)}</div><div class="bubble rich">${body}</div>${actions}</div>`;
  }
  node.querySelectorAll("img.photo").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  return node;
}

// ---------- 確認卡片：AI 要記帳、改行程、刪除時，先列出內容，成員按確認才寫入 ----------

const DRAFT_STATE = { done: (d) => `✅ ${d.resolved_by} 已確認`, cancelled: (d) => `已取消（${d.resolved_by}）`, superseded: () => "已改用新的卡片", failed: () => "資料已經不在，沒有執行" };

function draftHtml(d) {
  const p = d.preview || {};
  const rows = (p.rows || [])
    .map(([k, v, old]) => `<dt>${escapeHtml(k)}</dt><dd${k.startsWith("⚠️") ? ' class="warn"' : ""}>${escapeHtml(v)}${old ? `<small>原本：${escapeHtml(old)}</small>` : ""}</dd>`)
    .join("");
  const foot = d.status === "pending"
    ? `<div class="draft-actions"><button type="button" class="ok" data-draft-act="confirm">${escapeHtml(p.confirm || "確認")}</button><button type="button" data-draft-act="cancel">取消</button></div>`
    : `<div class="draft-state">${escapeHtml((DRAFT_STATE[d.status] ?? (() => d.status))(d))}</div>`;
  return `<div class="draft${d.status === "pending" ? "" : " settled"}" data-draft="${d.id}">
    <div class="draft-head"><b>${escapeHtml(p.title || "請確認")}</b><span class="draft-no">#${d.id}・${d.status === "pending" ? "還沒寫入" : "已處理"}</span></div>
    <dl>${rows}</dl>${foot}</div>`;
}

// ---------- 新版自動更新：每次部署版本號都不同，重新連線時比對 ----------
// 主畫面 App 從背景切回來不會重新載入程式，不處理的話會一直用舊版
function checkVersion(v) {
  if (!v) return;
  if (!S.version) S.version = v;
  else if (v !== S.version && !S.updateReady) {
    S.updateReady = true;
    if (document.hidden) return location.reload();
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "update-bar";
    bar.textContent = "🔄 新版本已推出，點這裡更新";
    bar.addEventListener("click", () => location.reload());
    els.conn.after(bar);
  }
}
// 切回 App 時，沒有打到一半的訊息就直接換新版
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.updateReady && !els.input.value.trim() && !document.querySelector("dialog[open]")) location.reload();
});

// ---------- 複製與置頂 ----------

els.messages.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const msgEl = btn.closest(".msg");
    if (btn.dataset.act === "copy") copyText(msgEl.querySelector(".msg-text")?.innerText.trim() || "", btn);
    else if (btn.dataset.act === "reply") startReply(msgEl);
    else action({ action: S.pinned?.has(msgEl.dataset.id) ? "unpin" : "pin", id: msgEl.dataset.id });
    return;
  }
  const quote = e.target.closest(".quote");
  if (quote) {
    const orig = els.messages.querySelector(`.msg[data-id="${quote.dataset.quote}"]`);
    if (orig) {
      orig.scrollIntoView({ block: "center", behavior: "smooth" });
      orig.classList.remove("flash");
      requestAnimationFrame(() => orig.classList.add("flash"));
    }
    return;
  }
  // 家人的訊息點一下才出現「複製／置頂」，畫面比較乾淨
  const bubble = e.target.closest(".msg:not(.ai) .bubble");
  if (bubble && !e.target.closest("a, img")) bubble.closest(".msg").classList.toggle("show-actions");
});

/** 回覆某一則訊息：輸入框上方顯示要回覆的內容，送出時一起帶給 AI */
function startReply(msgEl) {
  const author = msgEl.classList.contains("ai") ? S.aiName : msgEl.classList.contains("me") ? S.me.name : (msgEl.querySelector(".name")?.textContent || "").split("・")[0];
  const text = (msgEl.querySelector(".msg-text")?.innerText || "").replace(/\s+/g, " ").trim();
  S.replyTo = { id: msgEl.dataset.id, author, text: text.slice(0, 80) || "（照片）" };
  renderReplyBar();
  els.input.focus();
}

function renderReplyBar() {
  const r = S.replyTo;
  els.replyBar.hidden = !r;
  if (r) els.replyBar.innerHTML = `${svg("reply")}<span><b>回覆 ${escapeHtml(r.author)}</b>${escapeHtml(r.text)}</span><button type="button" class="icon" aria-label="取消回覆">✕</button>`;
}
els.replyBar.addEventListener("click", (e) => {
  if (!e.target.closest("button")) return;
  S.replyTo = null;
  renderReplyBar();
});

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // 舊瀏覽器或沒有權限：用隱藏的文字框複製
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  const label = btn?.querySelector("span") ?? btn;
  if (!label) return;
  const old = label.textContent;
  label.textContent = ok ? "已複製 ✓" : "複製失敗";
  setTimeout(() => (label.textContent = old), 1500);
}

function plainExcerpt(msg) {
  const t = String(msg.text || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*(?:[-•]|\d+\.)\s+/gm, "").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  return t.slice(0, 80) || (msg.photo ? "（照片）" : msg.location ? "（位置）" : "");
}

/** 置頂：上方一條細列（不佔聊天空間），點開看全部；訊息上的按鈕跟著更新 */
function renderPins(pins = []) {
  S.pins = pins;
  S.pinned = new Set(pins.map((p) => p.message.id));
  els.messages.querySelectorAll(".msg[data-id]").forEach((n) => {
    const on = S.pinned.has(n.dataset.id);
    n.classList.toggle("pinned", on);
    const label = n.querySelector('[data-act="pin"] span');
    if (label) label.textContent = on ? "取消置頂" : "置頂";
  });
  els.pinBar.hidden = !pins.length;
  if (pins.length) els.pinBar.innerHTML = `${svg("pushpin")}<b>置頂 ${pins.length}</b><span>${escapeHtml(plainExcerpt(pins[0].message))}</span>${svg("chev")}`;
  if (els.pins.open) renderPinList();
}

function renderPinList() {
  const pins = S.pins ?? [];
  els.pinList.innerHTML = pins.length ? "" : `<div class="small muted">目前沒有置頂訊息</div>`;
  for (const p of pins) {
    const item = document.createElement("div");
    item.className = "pin-item";
    item.innerHTML = `<div class="pin-meta">${svg("pushpin")}${escapeHtml(p.by)} 置頂・${timeText(p.ts)}</div>`;
    const node = messageNode(p.message);
    node.querySelector(".msg-actions")?.remove();
    item.append(node);
    const inChat = els.messages.querySelector(`.msg[data-id="${p.message.id}"]`);
    item.insertAdjacentHTML(
      "beforeend",
      `<div class="pin-actions"><button type="button" data-pa="copy"><span>複製</span></button>${inChat ? `<button type="button" data-pa="jump">跳到原訊息</button>` : ""}<button type="button" data-pa="unpin">取消置頂</button></div>`,
    );
    item.querySelector('[data-pa="copy"]').addEventListener("click", (e) => copyText(node.querySelector(".msg-text")?.innerText.trim() || "", e.currentTarget));
    item.querySelector('[data-pa="unpin"]').addEventListener("click", () => action({ action: "unpin", id: p.message.id }));
    item.querySelector('[data-pa="jump"]')?.addEventListener("click", () => {
      els.pins.close();
      inChat.scrollIntoView({ block: "center", behavior: "smooth" });
      inChat.classList.remove("flash");
      requestAnimationFrame(() => inChat.classList.add("flash"));
    });
    els.pinList.append(item);
  }
}

els.pinBar.addEventListener("click", () => {
  renderPinList();
  els.pins.showModal();
});
$("#pins-close").addEventListener("click", () => els.pins.close());
els.pins.addEventListener("click", (e) => e.target === els.pins && els.pins.close());

els.messages.addEventListener("click", (e) => {
  const b = e.target.closest("[data-draft-act]");
  if (!b) return;
  const id = Number(b.closest("[data-draft]").dataset.draft);
  const confirmIt = b.dataset.draftAct === "confirm";
  b.closest(".draft-actions").querySelectorAll("button").forEach((x) => (x.disabled = true));
  if (!wsSend({ type: "action", action: confirmIt ? "draft_confirm" : "draft_cancel", id })) {
    b.closest(".draft-actions").querySelectorAll("button").forEach((x) => (x.disabled = false));
  }
});

function daySeparator(ts) {
  const d = dayText(ts);
  if (d === S.lastDay) return null;
  S.lastDay = d;
  const sep = document.createElement("div");
  sep.className = "day-sep";
  sep.textContent = d;
  return sep;
}

function appendMessage(msg) {
  if (els.messages.querySelector(`[data-id="${msg.id}"]`)) return;
  const sep = daySeparator(msg.ts);
  if (sep) els.messages.appendChild(sep);
  return els.messages.appendChild(messageNode(msg));
}

function prependMessages(list, hasMore) {
  if (!list.length) {
    els.loadMore.hidden = true;
    return;
  }
  // 以目前最上面那則訊息當錨點，插入舊訊息後把它留在原本的位置（不論使用者停在哪）
  const anchor = els.messages.querySelector(".msg");
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const frag = document.createDocumentFragment();
  let last = null;
  for (const msg of list) {
    const d = dayText(msg.ts);
    if (d !== last) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = d;
      frag.appendChild(sep);
      last = d;
    }
    frag.appendChild(messageNode(msg));
  }
  const firstSep = els.messages.querySelector(".day-sep");
  if (firstSep && firstSep.textContent === last) firstSep.remove();
  els.loadMore.after(frag);
  S.oldest = list[0].ts;
  els.loadMore.hidden = !hasMore;
  if (anchor) els.messages.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
}

// ---------- 已讀位置：像通訊軟體一樣，回來時停在上次讀到的地方（記在這支手機） ----------

let readMarkCache = null;
function readMark() {
  if (readMarkCache === null) {
    try {
      readMarkCache = Number(localStorage.getItem("tta-read")) || 0;
    } catch {
      readMarkCache = 0;
    }
  }
  return readMarkCache;
}
function writeMark(ts) {
  readMarkCache = ts;
  try {
    localStorage.setItem("tta-read", String(ts));
  } catch {}
}

/** 聊天畫面現在真的看得到：不在背景、沒有被分頁或翻譯蓋住 */
const chatVisible = () => !document.hidden && !els.app.hidden && !els.panel.open && !els.translator.open;
/** 正在看最底下：新訊息來了就跟著捲 */
const following = () => nearBottom() && chatVisible();

function loadOlder() {
  if (S.loadingOlder || !S.oldest || S.ws?.readyState !== 1) return;
  S.loadingOlder = true;
  S.ws.send(JSON.stringify({ type: "load_more", before: S.oldest }));
}
els.loadMore.addEventListener("click", loadOlder);
// 捲到接近頂端就自動載入更早的訊息，按鈕留著當備用
new IntersectionObserver((entries) => entries[0].isIntersecting && !els.loadMore.hidden && loadOlder(), {
  root: els.messages,
  rootMargin: "300px 0px 0px 0px",
}).observe(els.loadMore);

function unreadSep() {
  const sep = document.createElement("div");
  sep.className = "unread-sep";
  sep.textContent = "以下是未讀訊息";
  return sep;
}

/** 連線（或重新連線）後：未讀起點比已載入的還早，就先補抓到那裡再跳過去 */
function restoreReadPosition() {
  S.loadingOlder = S.jumpAfterLoad = false;
  const mark = readMark();
  if (mark && S.oldest && mark < S.oldest && !els.loadMore.hidden) {
    els.messages.scrollTop = els.messages.scrollHeight;
    S.loadingOlder = S.jumpAfterLoad = true;
    S.ws.send(JSON.stringify({ type: "load_more", before: S.oldest, after: mark }));
  } else {
    jumpToUnread();
  }
}

/** 跳到第一則未讀並標出分隔線；沒有未讀（或第一次來）就到最底 */
function jumpToUnread() {
  els.messages.querySelector(".unread-sep")?.remove();
  const mark = readMark();
  const first = mark ? [...els.messages.querySelectorAll(".msg:not(.me)[data-ts]")].find((n) => Number(n.dataset.ts) > mark) : null;
  if (first) {
    const sep = unreadSep();
    first.before(sep);
    els.messages.scrollTop += sep.getBoundingClientRect().top - els.messages.getBoundingClientRect().top - 8;
  } else {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  requestAnimationFrame(updateReadMark);
}

/** 別人的新訊息：正在看最底下就跟著捲；沒在看（背景、開著其他分頁、往上翻舊訊息）就標出未讀起點 */
function arrived(node, stick) {
  if (!node) return;
  if (stick) {
    scrollToBottom(true);
  } else {
    const old = els.messages.querySelector(".unread-sep");
    // 舊分隔線後面還有沒讀的就沿用（像通訊軟體一樣停在最早的未讀），都讀過了才移到這則前面
    let stillUnread = false;
    for (let n = old?.nextElementSibling; n && n !== node && !stillUnread; n = n.nextElementSibling) {
      stillUnread = n.matches(".msg:not(.me)") && !!(n.dataset.live || Number(n.dataset.ts) > readMark());
    }
    if (!stillUnread) {
      old?.remove();
      node.before(unreadSep());
    }
  }
  requestAnimationFrame(updateReadMark);
}

function newMessage(msg) {
  const stick = following();
  const node = appendMessage(msg);
  if (msg.author === S.me?.name) scrollToBottom(true);
  else arrived(node, stick);
}

/** 回到聊天（切回 App、關掉分頁或翻譯）時，未讀起點還在畫面下方就捲過去 */
function revealUnread() {
  if (!chatVisible()) return;
  const sep = els.messages.querySelector(".unread-sep");
  const box = els.messages.getBoundingClientRect();
  if (sep && unreadCount() && sep.getBoundingClientRect().top > box.bottom - 60) {
    els.messages.scrollTop += sep.getBoundingClientRect().top - box.top - 8;
  }
  requestAnimationFrame(updateReadMark);
}

/** 畫面上看得到的最後一則訊息就是「讀到這裡」 */
function updateReadMark() {
  // 正在補抓未讀起點之前的訊息時，畫面只是暫時停在最底，不算讀過
  if (chatVisible() && !S.jumpAfterLoad) {
    const bottom = els.messages.getBoundingClientRect().bottom;
    const nodes = els.messages.querySelectorAll(".msg[data-ts]:not([data-live])");
    for (let i = nodes.length - 1; i >= 0; i--) {
      const r = nodes[i].getBoundingClientRect();
      if (r.top + Math.min(r.height, 80) <= bottom) {
        const ts = Number(nodes[i].dataset.ts);
        if (ts > readMark()) writeMark(ts);
        break;
      }
    }
  }
  renderLatestBtn();
}

function unreadCount() {
  const mark = readMark();
  let n = 0;
  els.messages.querySelectorAll(".msg:not(.me)[data-ts]").forEach((x) => (x.dataset.live || Number(x.dataset.ts) > mark) && n++);
  return n;
}

/** 往上翻時右下角出現「最新」按鈕，數字是還沒讀的則數 */
function renderLatestBtn() {
  const away = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight > 300;
  const n = away ? unreadCount() : 0;
  els.toLatest.hidden = !away;
  els.toLatestN.hidden = !n;
  els.toLatestN.textContent = n > 99 ? "99+" : String(n);
}

let markRaf = 0;
els.messages.addEventListener(
  "scroll",
  () => {
    if (!markRaf) markRaf = requestAnimationFrame(() => ((markRaf = 0), updateReadMark()));
  },
  { passive: true },
);
els.toLatest.addEventListener("click", () => els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" }));
els.panel.addEventListener("close", revealUnread);
els.translator.addEventListener("close", revealUnread);
document.addEventListener("visibilitychange", revealUnread);

function nearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 160;
}

function scrollToBottom(force) {
  if (force || following()) requestAnimationFrame(() => (els.messages.scrollTop = els.messages.scrollHeight));
}

// ---------- AI 即時生成 ----------

function aiStart(m) {
  let live = S.live.get(m.id);
  if (!live) {
    const stick = following();
    const node = messageNode({ id: m.id, ts: Date.now(), author: S.aiName, role: "assistant", text: "", meta: null });
    node.querySelector(".ai-body").innerHTML = TYPING;
    node.dataset.live = "1";
    node.querySelector(".msg-actions")?.remove(); // 還在打字、還沒存檔的回答不能複製或置頂
    const sep = daySeparator(Date.now());
    if (sep) els.messages.appendChild(sep);
    els.messages.appendChild(node);
    live = { node, text: "", raf: 0 };
    S.live.set(m.id, live);
    arrived(node, stick);
  }
  live.node.querySelector(".ai-time").textContent = `${m.provider === "workers-ai" ? "Workers AI" : "Gemini"} 思考中…`;
}

function aiTool(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.node.querySelector(".ai-tools").insertAdjacentHTML("beforeend", toolBadge(m.label));
  scrollToBottom(false);
}

function aiDelta(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text += m.delta;
  if (live.raf) return;
  live.raf = requestAnimationFrame(() => {
    live.raf = 0;
    const stick = following();
    live.node.querySelector(".ai-body").innerHTML = md(live.text);
    scrollToBottom(stick);
  });
}

function aiRetry(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text = "";
  live.node.querySelector(".ai-body").innerHTML = m.rateLimited
    ? `<span class="muted small">Gemini 額度冷卻中，改用備援模型回答…</span>`
    : `<span class="muted small">主要模型出錯，改用備援模型…</span>`;
}

function aiDone(m) {
  const live = S.live.get(m.id);
  const stick = following();
  const node = messageNode(m.message);
  if (live) {
    cancelAnimationFrame(live.raf);
    live.node.replaceWith(node);
    S.live.delete(m.id);
  } else {
    arrived(appendMessage(m.message), stick);
  }
  scrollToBottom(stick);
}

// ================= 送出訊息 =================

els.input.addEventListener("input", autoGrow);
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
}

els.input.addEventListener("keydown", (e) => {
  // 電腦上 Enter 送出、Shift+Enter 換行；手機用送出鍵
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    els.sendForm.requestSubmit();
  }
});

els.sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  const { photos, location: loc } = S.pending;
  if (!text && !photos.length && !loc) return;
  els.sendBtn.disabled = true;
  try {
    const photoIds = [];
    for (const [i, ph] of photos.entries()) {
      if (photos.length > 1) els.attachImgs.dataset.status = `上傳 ${i + 1}/${photos.length}…`;
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": ph.blob.type }, body: ph.blob });
      if (!res.ok) throw new Error(`照片上傳失敗（${res.status}）`);
      photoIds.push((await res.json()).id);
    }
    if (wsSend({ type: "send", text, photoId: photoIds[0] ?? null, photoIds, location: loc, replyTo: S.replyTo?.id })) {
      S.replyTo = null;
      renderReplyBar();
      els.input.value = "";
      autoGrow();
      clearAttachment();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    els.sendBtn.disabled = false;
    delete els.attachImgs.dataset.status;
  }
});

/** 送出一句問題；問「附近／回住宿」要先附上位置 */
function ask(q, withLocation = false) {
  els.input.value = q;
  if (withLocation) attachLocation(true);
  else els.sendForm.requestSubmit();
}

/** 收據記帳：先選照片，文字幫忙填好，確認後按送出 */
function receiptFlow() {
  els.input.value = "幫我把這張收據記帳（我付的）";
  els.photoInput.click();
}

/** 輸入框上方的快捷列（左右滑動）：分隔線前是直接問 AI 的常用問題，後面是打開各個工具頁 */
function renderChips() {
  const chips = [
    ["sun", "今天", () => ask("今天的行程和天氣？")],
    ["users", els.messages.classList.contains("only-mine") ? "顯示全部對話" : "只看我和 AI", () => toggleMine()],
    ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ["receipt", "收據記帳", receiptFlow],
    ["train", "電車狀況", () => ask("有樂町線、山手線現在有延誤嗎？")],
    ["exchange", "匯率", () => ask("現在日圓匯率多少？1000 日圓等於多少台幣？")],
    ["clock", "迪士尼排隊", () => ask("迪士尼現在哪些設施排隊最少？")],
    ["wallet", "帳目", () => ask("目前花了多少錢？大家要怎麼分？")],
    ["home", "回住宿", () => ask("我要怎麼回住宿？", true)],
    ["pin", "附上位置", () => attachLocation(false)],
    null,
    ["calendar", "行程", () => openPanel("itinerary")],
    ["ticket", "票券", () => openPanel("tickets")],
    ["users", "家人位置", () => openPanel("map")],
    ["list", "清單", () => openPanel("checklist")],
    ["bell", "提醒", () => openPanel("reminders")],
    ["book", "旅遊日記", () => openPanel("diary")],
    ["bookmark", "長期記憶", () => openPanel("memories")],
    ["help", "使用說明", () => openPanel("guide")],
    ["plus", "更多", openMore],
  ];
  els.chips.innerHTML = chips
    .map((c, i) => (c ? `<button type="button" data-i="${i}">${svg(c[0])}${c[1]}</button>` : `<span class="chip-sep" aria-hidden="true"></span>`))
    .join("");
  els.chips.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => chips[Number(b.dataset.i)][2]()));
}

/** 這支手機的顯示偏好；無痕模式存不了就用預設（收起） */
function pref(key, on) {
  try {
    if (on === undefined) return localStorage.getItem(key) === "1";
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
  return false;
}

// 快捷列預設收起，讓聊天區多一點空間；按「＋」展開，展開與否記在這支手機
function showChips(show) {
  els.chips.hidden = !show;
  els.chipsToggle.setAttribute("aria-expanded", String(show));
  els.chipsToggle.setAttribute("aria-label", show ? "收起快捷功能" : "展開快捷功能");
}
showChips(pref("tta-show-chips"));
els.chipsToggle.addEventListener("click", () => {
  const show = els.chips.hidden;
  const stick = nearBottom();
  pref("tta-show-chips", show);
  showChips(show);
  scrollToBottom(stick);
});

// ---------- 「更多」：傳給 AI 的動作與常用問法 ----------

const MORE_ASKS = ["明天的行程和天氣？", "目前花了多少錢？大家要怎麼分？", "最近東京有地震或颱風嗎？會影響行程嗎？"];

function moreActions() {
  return [
    ["camera", "拍照問", () => els.photoInput.click()],
    ["pin", "附上位置", () => attachLocation(false)],
    ["receipt", "收據記帳", receiptFlow],
    ["lang", "翻譯", openTranslator],
    ["sun", "今天", () => ask("今天的行程和天氣？")],
    ["utensils", "附近美食", () => ask("我附近有什麼好吃的？", true)],
    ["exchange", "匯率", () => ask("現在日圓匯率多少？1000 日圓等於多少台幣？")],
    ["home", "回住宿", () => ask("我要怎麼回住宿？", true)],
    ["train", "電車狀況", () => ask("有樂町線、山手線現在有延誤嗎？")],
    ["clock", "迪士尼排隊", () => ask("迪士尼現在哪些設施排隊最少？")],
  ];
}

function openMore() {
  const actions = moreActions();
  els.moreActions.innerHTML = actions.map(([icon, label], i) => `<button type="button" data-i="${i}"><span class="ag-icon">${svg(icon)}</span>${label}</button>`).join("");
  els.moreAsks.innerHTML = MORE_ASKS.map((q, i) => `<button type="button" data-q="${i}">${svg("msg")}${escapeHtml(q)}</button>`).join("");
  els.moreActions.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      actions[Number(b.dataset.i)][2]();
    }),
  );
  els.moreAsks.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      els.more.close();
      ask(MORE_ASKS[Number(b.dataset.q)]);
    }),
  );
  if (!els.more.open) els.more.showModal();
}
$("#more-close").addEventListener("click", () => els.more.close());
els.more.addEventListener("click", (e) => e.target === els.more && els.more.close());

// ---------- 照片 ----------

/** 一則訊息最多幾張照片（跟伺服器一樣）：菜單好幾頁可以一次翻譯整理 */
const MAX_PHOTOS = 6;

els.photoInput.addEventListener("change", async () => {
  const files = [...(els.photoInput.files || [])];
  els.photoInput.value = "";
  if (!files.length) return;
  const room = MAX_PHOTOS - S.pending.photos.length;
  if (files.length > room) alert(`一則訊息最多 ${MAX_PHOTOS} 張照片，${room > 0 ? `這次只加入前 ${room} 張` : "已經滿了"}；其他的請下一則再傳。`);
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      // 菜單、文件的小字要看得清楚：長邊 1600
      const blob = await resizeImage(file, 1600, 0.82);
      S.pending.photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      alert("有一張照片無法讀取");
    }
  }
  renderAttach();
  els.input.focus();
});

/** 附件列：照片縮圖（可以一張一張拿掉）＋再加一張 */
function renderAttach() {
  const list = S.pending.photos;
  delete els.attachImgs.dataset.status;
  els.attachImgs.innerHTML =
    list.map((p, i) => `<span class="attach-thumb"><img src="${p.url}" alt="照片 ${i + 1}" /><button type="button" data-rm="${i}" aria-label="拿掉第 ${i + 1} 張">✕</button></span>`).join("") +
    (list.length && list.length < MAX_PHOTOS ? `<button type="button" class="attach-add" aria-label="再加一張照片">＋</button>` : "");
  els.attachImgs.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      const [p] = S.pending.photos.splice(Number(b.dataset.rm), 1);
      URL.revokeObjectURL(p.url);
      renderAttach();
    }),
  );
  els.attachImgs.querySelector(".attach-add")?.addEventListener("click", () => els.photoInput.click());
  els.attach.hidden = !list.length && !S.pending.location && !els.attachLoc.textContent;
  els.input.placeholder = list.length > 1 ? "例如：翻譯整理這幾張菜單" : list.length ? "要問什麼？例如：這是什麼、幫我翻譯、比價" : "問旅伴 AI 任何事…";
}

async function resizeImage(file, max, quality) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/jpeg", quality));
}

// ---------- 定位 ----------

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("這個瀏覽器不支援定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? "請允許瀏覽器使用定位" : "無法取得位置")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

async function attachLocation(thenSend) {
  els.attachLoc.textContent = "📍 定位中…";
  els.attach.hidden = false;
  try {
    S.pending.location = await getPosition();
    els.attachLoc.textContent = `📍 已附上位置（±${S.pending.location.accuracy}m）`;
    if (thenSend) els.sendForm.requestSubmit();
  } catch (err) {
    els.attachLoc.textContent = "";
    if (!S.pending.photos.length) els.attach.hidden = true;
    alert(err.message);
    if (thenSend && els.input.value) els.sendForm.requestSubmit();
  }
}

function clearLocation() {
  S.pending.location = null;
  els.attachLoc.textContent = "";
  if (!S.pending.photos.length) els.attach.hidden = true;
}

function clearAttachment() {
  for (const p of S.pending.photos) URL.revokeObjectURL(p.url);
  S.pending.photos = [];
  els.attachImgs.innerHTML = "";
  delete els.attachImgs.dataset.status;
  els.input.placeholder = "問旅伴 AI 任何事…";
  clearLocation();
  els.attach.hidden = true;
}
els.attachClear.addEventListener("click", clearAttachment);

let autoLocTimer = null;
function startAutoLocation() {
  const tick = async () => {
    try {
      const p = await getPosition();
      S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: "location", ...p }));
    } catch {}
  };
  tick();
  clearInterval(autoLocTimer);
  autoLocTimer = setInterval(tick, 5 * 60 * 1000);
}
function stopAutoLocation() {
  clearInterval(autoLocTimer);
  autoLocTimer = null;
}

// ================= 狀態（頂部、面板） =================

function setState(state) {
  S.state = state;
  renderPins(state.pins);
  // 常用句存一份在手機，沒網路也能打開、念出來
  if (state.documents) {
    try {
      localStorage.setItem("tta-docs", JSON.stringify(state.documents));
      localStorage.setItem("tta-doc-folders", JSON.stringify(state.docFolders ?? []));
    } catch {}
  }
  if (state.phrases) {
    try {
      localStorage.setItem("tta-phrases", JSON.stringify(state.phrases));
    } catch {}
    if (els.translator.open && TR.tab === "phrases") renderPhraseList();
  }
  const now = jst(Date.now()).toISOString().slice(0, 10);
  const t = state.trip;
  const day = Math.floor((Date.parse(now + "T00:00:00Z") - Date.parse(t.startDate + "T00:00:00Z")) / 86400e3) + 1;
  els.todayTitle.textContent = t.title;
  els.dayBadge.textContent = day < 1 ? `倒數 ${1 - day} 天` : now <= t.endDate ? `Day ${day}` : "旅程結束";
  renderNextCard(state, now);
  // 正在編輯日記時不重畫，免得打到一半的字被別人的動作洗掉
  if (S.panel && !["settings", "diary-edit"].includes(S.panel)) renderPanel();
  const usage = document.querySelector("#gemini-usage");
  if (usage) usage.textContent = geminiUsageText(state.gemini);
}

/** 「下一站」票券卡：出發前顯示出發日與第一天行程，旅途中顯示今天的行程，回國後隱藏 */
function renderNextCard(state, now) {
  const t = state.trip;
  const it = state.itinerary || [];
  let label, title, sub;
  if (now < t.startDate) {
    const first = it.find((d) => d.date === t.startDate);
    label = "下一站";
    title = `${dateLabel(t.startDate)} 出發`;
    sub = first?.detail || first?.title || t.accommodation || "";
  } else if (now <= t.endDate) {
    const today = it.find((d) => d.date === now);
    label = `今天・${dateLabel(now)}`;
    title = today?.title || "自由活動";
    sub = today?.detail || today?.status || "";
  } else {
    els.nextCard.hidden = els.ncToggle.hidden = true;
    return;
  }
  els.nextCard.innerHTML = `<span class="nc-main"><span class="nc-label">${escapeHtml(label)}</span><span class="nc-title">${escapeHtml(title)}</span>${sub ? `<span class="nc-sub">${escapeHtml(sub)}</span>` : ""}</span><span class="nc-side">${svg("calendar")}行程</span>`;
  els.ncToggle.hidden = false;
  showNextCard(pref("tta-show-next"));
}

// 「下一站」卡片預設收起，按標題列的「下一站」才顯示，再按一次收起
function showNextCard(show) {
  els.nextCard.hidden = !show;
  els.ncToggle.setAttribute("aria-pressed", String(show));
}
els.ncToggle.addEventListener("click", () => {
  const show = els.nextCard.hidden;
  pref("tta-show-next", show);
  showNextCard(show);
});
els.nextCard.addEventListener("click", () => openPanel("itinerary"));

function geminiUsageText(g) {
  if (!g) return "";
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  let s = `本分鐘 ${g.rpm}/${g.rpmLimit} 次、${k(g.tpm)}/${k(g.tpmLimit)} tokens｜今日 ${g.rpd}/${g.rpdLimit} 次`;
  if (g.cooldownSec) s += `｜冷卻中 ${g.cooldownSec} 秒（期間改用備援模型）`;
  return s;
}

// ---------- 底部分頁列：聊天以外的分頁是蓋在聊天上方的整頁面板 ----------

const TAB_OF = { itinerary: "itinerary", expenses: "expenses", settings: "settings" };

function setTab(tab) {
  const buttons = [...els.tabbar.querySelectorAll("button")];
  // 分頁列上沒有的頁面（例如行程）算在工具箱底下
  if (!buttons.some((b) => b.dataset.tab === tab && !b.hidden)) tab = "hub";
  buttons.forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

els.tabbar.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.tab === "chat") {
      if (els.translator.open) closeTranslator();
      if (els.panel.open) els.panel.close();
      else scrollToBottom(true);
      return;
    }
    if (b.dataset.tab === "translator") return openTranslator();
    openPanel(b.dataset.tab);
  }),
);
els.panelClose.addEventListener("click", () => els.panel.close());
els.panel.addEventListener("close", () => {
  S.panel = null;
  // close 事件是非同步的：從面板直接切到翻譯時，別把分頁列標回聊天
  setTab(els.translator.open ? "translator" : "chat");
});

function openPanel(name) {
  if (els.translator.open) closeTranslator();
  S.panel = name;
  renderPanel();
  setTab(TAB_OF[name] ?? "hub");
  if (name === "settings" && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: "get_state" }));
  if (!els.panel.open) els.panel.show();
  els.panel.scrollTop = 0;
}

// 打開時就先抓好圖檔：iOS 的分享面板必須在點擊當下叫出，等下載完才叫會被擋
let viewerBlob = null;
function openViewer(src) {
  els.viewerImg.src = src;
  els.viewerDl.lastElementChild.textContent = "下載";
  viewerBlob = fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
  viewerBlob.catch(() => {});
  els.viewer.showModal();
}
els.viewer.addEventListener("click", () => els.viewer.close());
els.viewerDl.addEventListener("click", async (e) => {
  e.stopPropagation();
  const label = els.viewerDl.lastElementChild;
  let blob;
  try {
    blob = await viewerBlob;
  } catch {
    label.textContent = "下載失敗";
    return;
  }
  const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/\+.*/, "");
  const file = new File([blob], `東京旅伴-${Date.now()}.${ext}`, { type: blob.type });
  // 手機走分享面板，才能選「儲存影像」存進相簿；電腦直接下載檔案
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

function action(payload) {
  wsSend({ type: "action", ...payload });
}

/** 分頁標題用霞鶩文楷，不帶 emoji（各頁面原本的標題有 emoji，在這裡統一拿掉） */
function renderPanel() {
  renderPanelInner();
  els.panelTitle.textContent = els.panelTitle.textContent.replace(/^[^\p{L}\p{N}]+/u, "");
}

function renderPanelInner() {
  const st = S.state;
  const b = els.panelBody;
  if (!st) {
    // 離線時只有工具箱與票券能用（票券照片有快取）
    if (S.panel === "hub" || S.panel === "tickets" || S.panel === "guide") return renderToolPanel(null, b);
    els.panelTitle.textContent = "📴 離線中";
    b.innerHTML = `<div class="card small muted">目前沒有網路，這個功能暫時不能用。翻譯常用句和票券保管箱離線也能看。</div>`;
    return;
  }
  if (S.panel === "photos") return renderPhotosPanel(b);
  if (["hub", "guide", "map", "checklist", "tickets", "reminders", "diary", "diary-edit"].includes(S.panel)) return renderToolPanel(st, b);
  switch (S.panel) {
    case "itinerary": {
      els.panelTitle.textContent = "📅 行程";
      const now = jst(Date.now()).toISOString().slice(0, 10);
      b.innerHTML = st.itinerary
        .map((d) => {
          const date = new Date(d.date + "T00:00:00Z");
          return `<div class="card ${d.date === now ? "today" : ""}" data-date="${d.date}">
            <div class="row between"><strong>${date.getUTCMonth() + 1}/${date.getUTCDate()}（${"日一二三四五六"[date.getUTCDay()]}）</strong>
            <button class="btn small" data-edit="${d.date}">✏️ 修改</button></div>
            <h3 style="margin-top:6px">${escapeHtml(d.title)}</h3>
            ${d.detail ? `<div class="small muted">${escapeHtml(d.detail)}</div>` : ""}
            ${d.status ? `<div style="margin-top:6px"><span class="tag">${escapeHtml(d.status)}</span></div>` : ""}
            <div class="small muted" style="margin-top:6px">最後修改：${escapeHtml(d.updated_by || "")}</div>
          </div>`;
        })
        .join("") + `<p class="small muted">也可以直接在聊天中說「把 10/8 改成去淺草」，AI 會幫你更新並記住。</p>`;
      b.querySelectorAll("[data-edit]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const d = st.itinerary.find((x) => x.date === btn.dataset.edit);
          const card = btn.closest(".card");
          card.innerHTML = `<form class="form">
            <strong>${d.date}</strong>
            <input name="title" value="${escapeHtml(d.title)}" placeholder="標題" />
            <textarea name="detail" rows="3" placeholder="細節">${escapeHtml(d.detail)}</textarea>
            <input name="status" value="${escapeHtml(d.status)}" placeholder="狀態，例如 ✅ 已購票" />
            <div class="row"><button class="btn primary-sm">儲存</button><button type="button" class="btn" data-cancel>取消</button></div>
          </form>`;
          card.querySelector("[data-cancel]").addEventListener("click", renderPanel);
          card.querySelector("form").addEventListener("submit", (e) => {
            e.preventDefault();
            const f = new FormData(e.target);
            action({ action: "update_itinerary", date: d.date, title: f.get("title"), detail: f.get("detail"), status: f.get("status") });
          });
        }),
      );
      break;
    }
    case "expenses": {
      els.panelTitle.textContent = "💰 記帳分帳";
      const ex = st.expenses;
      const members = st.members.length ? st.members : [S.me.name];
      b.innerHTML = `
        <div class="card"><div class="small muted">總花費（${ex.count} 筆）</div>
          <div class="big">${yen(ex.total_jpy)}</div><div class="muted">約 NT$${ex.total_twd.toLocaleString()}</div>
          ${ex.count ? `<a class="btn small" href="/api/expenses.csv" download style="margin-top:8px">⬇️ 下載帳目（CSV）</a>` : ""}</div>
        <div class="card"><h3>每人</h3>
          ${ex.balance.map((p) => `<div class="item small"><span>${escapeHtml(p.name)}</span><span>付 ${yen(p.paid)}｜應付 ${yen(p.share)}｜<b style="color:${p.net >= 0 ? "#17a398" : "var(--red)"}">${p.net >= 0 ? "+" : ""}${yen(p.net)}</b></span></div>`).join("") || `<div class="small muted">還沒有帳目</div>`}
          ${ex.transfers.length ? `<h3 style="margin-top:10px">結算建議</h3>${ex.transfers.map((t) => `<div class="small">👉 ${escapeHtml(t.from)} 給 ${escapeHtml(t.to)} <b>${yen(t.jpy)}</b></div>`).join("")}` : ""}
        </div>
        <div class="card"><h3>新增一筆</h3>
          <form class="form" id="exp-form">
            <input name="description" placeholder="項目，例如 晚餐 拉麵" required />
            <div class="row"><input name="amount" type="number" inputmode="decimal" step="any" placeholder="金額" required />
              <select name="currency" style="max-width:100px"><option>JPY</option><option>TWD</option></select></div>
            <div class="row"><span class="small" style="white-space:nowrap">誰付的</span><select name="payer">${members.map((m) => `<option ${m === S.me.name ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}</select></div>
            <select name="category">${["餐飲", "交通", "門票", "購物", "住宿", "其他"].map((c) => `<option>${c}</option>`).join("")}</select>
            <div class="small muted">分給誰</div>
            <div class="checks">${members.map((m) => `<label><input type="checkbox" name="split" value="${escapeHtml(m)}" checked /> ${escapeHtml(m)}</label>`).join("")}</div>
            <button class="btn primary-sm">記下來</button>
          </form>
          <p class="small muted">也可以直接在聊天說「晚餐 8400 日圓我付的」。</p>
        </div>
        <div class="card"><h3>明細</h3><div class="list">
          ${ex.items.slice().reverse().map((it) => `<div class="item small"><div><b>${escapeHtml(it.description)}</b><div class="muted">${it.date.slice(5)}｜${escapeHtml(it.category)}｜${escapeHtml(it.payer)} 付｜分給 ${it.split_among.map(escapeHtml).join("、")}</div></div>
            <div style="text-align:right">${yen(it.jpy)}<div class="muted">NT$${it.twd.toLocaleString()}</div><button class="btn danger small" data-del-exp="${it.id}">刪除</button></div></div>`).join("") || `<div class="small muted">還沒有帳目</div>`}
        </div></div>`;
      b.querySelector("#exp-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        action({
          action: "add_expense",
          expense: {
            description: f.get("description"), amount: Number(f.get("amount")), currency: f.get("currency"),
            payer: f.get("payer"), category: f.get("category"), split_among: f.getAll("split"),
          },
        });
      });
      b.querySelectorAll("[data-del-exp]").forEach((btn) =>
        btn.addEventListener("click", () => confirm("確定刪除這筆？") && action({ action: "delete_expense", id: Number(btn.dataset.delExp) })),
      );
      break;
    }
    case "memories": {
      els.panelTitle.textContent = "🧠 長期記憶";
      b.innerHTML = `
        <p class="small muted">不用手動輸入：大家聊天時，AI 每隔幾則訊息就會自動記下偏好、決定、預訂與待辦，過時的會自動刪掉，越用越懂你們。這裡也可以手動補充或刪除。</p>
        ${st.summary ? `<div class="card"><h3>📖 AI 對這趟旅程的理解</h3><div class="small" style="white-space:pre-wrap">${escapeHtml(st.summary)}</div></div>` : ""}
        <div class="card"><form class="form" id="mem-form">
          <textarea name="content" rows="2" placeholder="例如：妹妹對蝦子過敏；門鎖密碼 1234" required></textarea>
          <div class="row"><select name="category">${["偏好", "決定", "預訂", "資訊", "待辦"].map((c) => `<option>${c}</option>`).join("")}</select>
          <button class="btn primary-sm">新增記憶</button></div>
        </form></div>
        <div class="card"><div class="list">
          ${st.memories.slice().reverse().map((m) => `<div class="item small"><div><span class="tag">${escapeHtml(m.category)}</span> ${escapeHtml(m.content)}<div class="muted">#${m.id}｜${escapeHtml(m.author)}｜${dayText(m.ts)}</div></div>
            <button class="btn danger small" data-del-mem="${m.id}">刪除</button></div>`).join("") || `<div class="small muted">還沒有記憶</div>`}
        </div></div>`;
      b.querySelector("#mem-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        action({ action: "add_memory", content: f.get("content"), category: f.get("category") });
      });
      b.querySelectorAll("[data-del-mem]").forEach((btn) =>
        btn.addEventListener("click", () => confirm("確定刪除這條記憶？") && action({ action: "delete_memory", id: Number(btn.dataset.delMem) })),
      );
      break;
    }
    case "settings": {
      els.panelTitle.textContent = "⚙️ 設定";
      const s = S.settings;
      const auto = localStorage.getItem("tta-autoloc") === "1";
      b.innerHTML = `
        <div class="card"><div class="row between"><div><b>${escapeHtml(S.me.name)}</b>${S.me.admin ? ' <span class="tag">管理員</span>' : ""}</div>
          <button class="btn" id="logout">登出</button></div></div>
        <div class="card"><label class="row between"><span>自動分享我的位置給 AI<br><span class="small muted">每 5 分鐘更新，問「附近」時更準</span></span>
          <input type="checkbox" id="autoloc" ${auto ? "checked" : ""} /></label></div>
        <div class="card small">
          <div>AI 模型：<b>${s.provider === "workers-ai" ? `Workers AI（${escapeHtml(s.workersModel)}）` : `Gemini（${escapeHtml(s.geminiModel)}）`}</b></div>
          <div>回覆方式：<b>${s.replyMode === "mention" ? "只回覆 @AI 的訊息" : "每則訊息都回覆"}</b></div>
          <div>網路搜尋：${s.hasTavily ? "✅ Tavily" : "⚠️ 未設定 TAVILY_API_KEY"}｜Gemini：${s.hasGemini ? (s.geminiKey ? "✅ 管理員換上的金鑰" : "✅") : "⚠️ 未設定"}</div>
          <div>Gemini 用量：<span id="gemini-usage">${escapeHtml(geminiUsageText(st.gemini))}</span></div>
        </div>
        ${S.me.admin ? `
        <div class="card"><h3>管理員設定</h3>
          <div class="small muted">主要模型（出錯或額度冷卻時，會自動改用另一個）</div>
          <div class="seg" id="seg-provider">
            <label><input type="radio" name="provider" value="gemini" ${s.provider !== "workers-ai" ? "checked" : ""} />${escapeHtml(s.geminiModel)}</label>
            <label><input type="radio" name="provider" value="workers-ai" ${s.provider === "workers-ai" ? "checked" : ""} />${escapeHtml(String(s.workersModel).split("/").pop())}（Workers AI）</label>
          </div>
          <div class="small muted" style="margin-top:10px">AI 回覆時機</div>
          <div class="seg" id="seg-mode">
            <label><input type="radio" name="mode" value="all" ${s.replyMode !== "mention" ? "checked" : ""} />每則都回</label>
            <label><input type="radio" name="mode" value="mention" ${s.replyMode === "mention" ? "checked" : ""} />只回 @AI</label>
          </div>
          <div class="small muted" style="margin-top:10px">旅伴名單（記帳預設平分對象，用逗號分隔）</div>
          <form class="row" id="travelers-form"><input name="t" value="${escapeHtml(s.travelers || "")}" placeholder="爸爸, 媽媽, 哥哥, 妹妹" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)" /><button class="btn primary-sm">儲存</button></form>
          <p class="small muted" style="margin-top:10px">所有聊天紀錄都會永久保存，AI 會自動回想以前聊過的內容。</p>
          <div class="small muted" style="margin-top:10px">自動通知（旅程期間，東京時間）</div>
          <label class="row between small"><span>☀️ 每天 07:00 早報</span><input type="checkbox" data-auto="autoBrief" ${s.autoBrief ? "checked" : ""} /></label>
          <label class="row between small"><span>📔 每天 22:00 旅遊日記</span><input type="checkbox" data-auto="autoDiary" ${s.autoDiary ? "checked" : ""} /></label>
          <label class="row between small"><span>🆘 地震、颱風、強風豪雨通知</span><input type="checkbox" data-auto="autoAlerts" ${s.autoAlerts ? "checked" : ""} /></label>
          <div class="row" style="gap:6px;margin-top:6px">
            <button class="btn small" id="brief-now">現在發一次早報</button>
            <button class="btn small" id="diary-now">現在寫今天的日記</button>
          </div>
        </div>
        <div class="card"><h3>🤖 Gemini 金鑰</h3>
          <div class="small muted">目前使用：<b>${s.geminiKey ? `換上的金鑰 ${escapeHtml(s.geminiKey)}` : s.geminiDefault ? "預設金鑰" : "未設定"}</b></div>
          <div class="small muted" style="margin-top:4px">額度用完時，用<b>另一個 Google 帳號</b>到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> 申請新金鑰貼上，馬上生效。同一個帳號多建幾把不會多額度。</div>
          <form class="row" id="gemini-key-form" style="margin-top:8px"><input name="k" placeholder="AIza…" autocomplete="off" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)" /><button class="btn primary-sm">換上</button></form>
          ${s.geminiKey && s.geminiDefault ? `<button class="btn small" id="gemini-key-reset" style="margin-top:6px">改回預設金鑰</button>` : ""}
          <p class="small muted" style="margin-top:6px">🔐 金鑰加密保存，只有伺服器用得到，畫面上看不到完整內容。</p>
        </div>
        <div class="card"><h3>🧹 清除資料</h3>
          <p class="small muted">測試結束、正式使用前，或換一趟新行程時使用。只會清除勾選的項目，<b>清除後無法復原</b>。</p>
          <form class="form" id="reset-form">
            <div class="checks">
              <label><input type="checkbox" name="chat" /> 聊天紀錄（含照片、位置）</label>
              <label><input type="checkbox" name="memory" /> 長期記憶與摘要</label>
              <label><input type="checkbox" name="expenses" /> 帳目</label>
              <label><input type="checkbox" name="itinerary" /> 行程還原成預設</label>
              <label><input type="checkbox" name="tools" /> 清單、提醒、票券、日記</label>
            </div>
            <button class="btn danger">清除勾選的資料</button>
          </form>
        </div>` : ""}`;
      b.querySelector("#logout").addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST" });
        location.reload();
      });
      b.querySelector("#autoloc").addEventListener("change", (e) => {
        localStorage.setItem("tta-autoloc", e.target.checked ? "1" : "0");
        e.target.checked ? startAutoLocation() : stopAutoLocation();
      });
      b.querySelectorAll("#seg-provider input").forEach((r) => r.addEventListener("change", () => action({ action: "settings", provider: r.value })));
      b.querySelectorAll("#seg-mode input").forEach((r) => r.addEventListener("change", () => action({ action: "settings", replyMode: r.value })));
      b.querySelector("#travelers-form")?.addEventListener("submit", (e) => {
        e.preventDefault();
        action({ action: "settings", travelers: new FormData(e.target).get("t") });
      });
      b.querySelectorAll("[data-auto]").forEach((x) => x.addEventListener("change", () => action({ action: "settings", [x.dataset.auto]: x.checked })));
      b.querySelector("#gemini-key-form")?.addEventListener("submit", (e) => {
        e.preventDefault();
        const k = e.target.k.value.trim();
        if (!k) return;
        e.target.querySelector("button").textContent = "檢查中…";
        action({ action: "gemini_key", key: k });
      });
      b.querySelector("#gemini-key-reset")?.addEventListener("click", () => confirm("改回預設的 Gemini 金鑰？") && action({ action: "gemini_key", key: "" }));
      b.querySelector("#brief-now")?.addEventListener("click", (e) => {
        e.target.textContent = "產生中…";
        action({ action: "brief_now" });
        els.panel.close();
      });
      b.querySelector("#diary-now")?.addEventListener("click", (e) => {
        e.target.textContent = "產生中…";
        action({ action: "diary_now" });
        els.panel.close();
      });
      b.querySelector("#reset-form")?.addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const names = { chat: "聊天紀錄", memory: "長期記憶與摘要", expenses: "帳目", itinerary: "行程（還原成預設）", tools: "清單、提醒、票券、日記" };
        const picked = Object.keys(names).filter((k) => f.get(k));
        if (!picked.length) return alert("請至少勾選一項");
        const typed = prompt(`即將清除：${picked.map((k) => names[k]).join("、")}\n所有人的資料都會被清除，無法復原。\n\n確定的話請輸入「清除」`);
        if (typed?.trim() !== "清除") return;
        action({ action: "reset", ...Object.fromEntries(picked.map((k) => [k, true])) });
        e.target.reset();
      });
      break;
    }
  }
}

// ================= 工具箱分頁 =================

const TOOL_CARDS = [
  ["itinerary", "calendar", "行程", "每天的安排，可以修改"],
  ["tickets", "ticket", "票券保管箱", "門票、訂位憑證，離線可看"],
  ["map", "users", "家人位置", "看大家在哪、走散求救"],
  ["checklist", "list", "共用清單", "行李、購物、待辦"],
  ["reminders", "bell", "提醒", "時間到在群組通知"],
  ["diary", "book", "旅遊日記", "每晚自動寫、匯出相簿"],
  ["photos", "camera", "相片", "每天的照片，存到手機"],
];

function renderToolPanel(st, b) {
  switch (S.panel) {
    case "hub": {
      els.panelTitle.textContent = "工具箱";
      b.innerHTML = `
        <div class="tb-grid">${TOOL_CARDS.map(([id, icon, name, desc]) => `<button class="tb-card" data-go="${id}"><span class="tb-icon">${svg(icon)}</span><b>${name}</b><span class="small muted">${desc}</span></button>`).join("")}</div>
        <div class="tb-list">
          <button data-go="memories">${svg("bookmark")}<span>長期記憶 <span class="small muted">AI 記得的偏好與決定</span></span><span class="chev">${svg("chev")}</span></button>
          <button data-go="guide">${svg("help")}<span>使用說明 <span class="small muted">每個功能怎麼用</span></span><span class="chev">${svg("chev")}</span></button>
        </div>`;
      b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => (x.dataset.go === "translator" ? openTranslator() : openPanel(x.dataset.go))));
      break;
    }
    case "guide":
      renderGuidePanel(b);
      break;
    case "map":
      renderMapPanel(st, b);
      break;
    case "checklist":
      renderChecklistPanel(st, b);
      break;
    case "tickets":
      renderTicketsPanel(st, b);
      break;
    case "reminders":
      renderRemindersPanel(st, b);
      break;
    case "diary":
      renderDiaryPanel(st, b);
      break;
    case "diary-edit":
      renderDiaryEditor(st, b);
      break;
  }
}

const backToHub = () => `<button class="btn small" data-go-hub>← 工具箱</button>`;
function bindBack(b) {
  b.querySelector("[data-go-hub]")?.addEventListener("click", () => openPanel("hub"));
}

// ---------- 📖 使用說明 ----------

// [圖示, 名稱, 一句話, 步驟（可含 HTML）, 範例問法]
const GUIDE = [
  ["☀️", "每日早報", "每天早上自動發，不用操作", [
    "旅程期間（10/3–10/10）每天<b>東京時間 07:00</b> 左右，AI 會在群組發一則早報。",
    "內容有：今天的行程與建議出門時間、天氣和穿著、要不要帶傘、今天的提醒與待辦。",
    "如果有地震、颱風或豪雨，會放在最前面提醒。",
    "其他時間想看，直接問就好。",
  ], ["今天的行程和天氣？"]],
  ["⏰", "提醒", "時間到在群組通知全家", [
    "在聊天說「<b>幾月幾號 幾點 提醒大家…</b>」，AI 會設好提醒。",
    "也可以到下方「工具箱」→ 提醒，選日期時間、打內容，按「新增提醒」。",
    "時間到了，AI 會在群組發訊息通知全家。時間一律是<b>東京時間</b>（比台灣快 1 小時）。",
    "在 ⏰ 提醒頁可以看到還沒發的提醒，也可以刪除。",
  ], ["10/4 早上 9:30 提醒大家出門去藤子博物館", "有哪些提醒？"]],
  ["🆘", "地震／颱風警報", "有狀況自動通知，不用操作", [
    "從出發前一天到回國，系統每 5 分鐘檢查一次日本氣象廳的資料。",
    "<b>關東震度 3 以上</b>的地震、東京周邊的海嘯、新颱風、隔天的強風豪雨，會自動在群組發警報。",
    "警報裡附有緊急電話：警察 110、救護車／消防 119、日本觀光局中文熱線 050-3816-2787。",
    "想確認最近的狀況，也可以直接問。",
  ], ["最近東京有地震或颱風嗎？會影響行程嗎？"]],
  ["🚕", "計程車估價", "叫車前先知道大概多少錢", [
    "直接問「從哪裡到哪裡，計程車要多少錢」。",
    "AI 會回答距離、車程時間、大概的車資範圍。",
    "深夜（22:00–05:00）有 20% 加成，會自動依現在的時間計算。",
    "2 大 2 小可以坐一台一般計程車。",
  ], ["從住宿叫車到東京迪士尼海洋要多少錢？"]],
  ["🚆", "電車狀況", "出門前查有沒有延誤、停駛", [
    "按輸入框左邊的「＋」→「<b>電車狀況</b>」，或直接問某條線。",
    "查的是 Yahoo!路線 的即時運行資訊，會告訴你有沒有延誤、停駛與原因。",
    "如果停駛，可以接著問「那要怎麼改走？」。",
  ], ["有樂町線、山手線現在有延誤嗎？"]],
  ["🧾", "收據記帳", "拍收據，AI 幫你記帳", [
    "按輸入框左邊的「＋」→「<b>收據</b>」→ 拍照或選收據照片。",
    "輸入框會自動填好「幫我把這張收據記帳（我付的）」；如果是別人付的，改成「媽媽付的」再送出。",
    "AI 會讀出店名、金額，記到 💰 記帳分帳裡。",
    "沒有收據也可以用打字的。按 💰 可以看帳目，AI 也能算誰該給誰多少。",
  ], ["午餐拉麵 3200 日圓，爸爸付的", "目前花了多少錢？大家要怎麼分？"]],
  ["✅", "共用清單", "購物、行李、待辦，全家同步", [
    "到下方「工具箱」→ 共用清單，分成<b>購物、行李、待辦</b>三頁。",
    "一行打一項，可以填「給誰」；完成後打勾，全家的畫面都會同步。",
    "也可以在聊天請 AI 加：要明確說「<b>加入清單</b>」才會加，只是說想買或問推薦不會自動加。",
  ], ["把皮卡丘玩偶加入購物清單，給哥哥", "護照已經帶好了，幫我打勾"]],
  ["🎫", "票券保管箱", "門票、訂位確認，沒網路也能看", [
    "到下方「工具箱」→ 票券保管箱，輸入名稱、選照片，按「上傳」。",
    "也可以在聊天傳照片，說「存成票券」。",
    "要用的時候點圖片放大，給工作人員掃 QR Code。",
    "<b>打開過一次之後，沒網路也能看</b>。建議出發前先把每張都點開一次。",
  ], ["給我看藤子博物館的門票"]],
  ["🗺", "家人位置地圖", "看大家在哪，走散一鍵求救", [
    "到下方「工具箱」→ 家人位置，地圖上會顯示每個人最後的位置和住宿 🏠。",
    "按「📍 更新我的位置」分享你現在的位置；在下方「設定」開「自動分享位置」，就會每 5 分鐘自動更新。",
    "走散了就按「<b>🆘 我走散了</b>」，你的位置會傳到群組，全家畫面會跳出紅色提示（Android 還會震動），點一下就能看地圖。",
    "AI 也會幫忙找好認的集合地點。",
  ], ["大家現在在哪裡？"]],
  ["📔", "旅遊日記", "每晚自動寫，可匯出相簿", [
    "旅程期間每晚<b>東京時間 22:00</b>，AI 會用當天的聊天和照片寫一篇日記，發到群組。",
    "白天多傳照片、聊聊發生了什麼事，日記就會寫得越豐富。",
    "到下方「工具箱」→ 旅遊日記 可以看每一天的日記。",
    "按「📖 打開相簿」可以列印或存成 PDF，回國後留作紀念。",
  ], []],
];

function renderGuidePanel(b) {
  els.panelTitle.textContent = "📖 使用說明";
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">點開每個功能看怎麼用。範例問法點一下會填進輸入框，確認後再按送出。</p>
    ${GUIDE.map(([icon, name, tagline, steps, examples]) => `<details class="card guide">
      <summary><span class="guide-icon">${icon}</span><span><b>${name}</b><span class="small muted">${tagline}</span></span></summary>
      <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      ${examples.length ? `<div class="guide-try">${examples.map((q) => `<button type="button" data-try="${escapeHtml(q)}">💬 ${escapeHtml(q)}</button>`).join("")}</div>` : ""}
    </details>`).join("")}`;
  bindBack(b);
  b.querySelectorAll("[data-try]").forEach((x) =>
    x.addEventListener("click", () => {
      els.input.value = x.dataset.try;
      els.input.dispatchEvent(new Event("input"));
      els.panel.close();
      els.input.focus();
    }),
  );
}

// ---------- 🗺 家人位置地圖 ----------

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
    js.onload = resolve;
    js.onerror = () => {
      leafletLoading = null;
      reject(new Error("地圖載入失敗"));
    };
    document.head.appendChild(js);
  });
  return leafletLoading;
}

let leafletMap = null;
function renderMapPanel(st, b) {
  els.panelTitle.textContent = "🗺 家人位置";
  const locs = st.locations ?? [];
  b.innerHTML = `
    ${backToHub()}
    <div id="family-map" class="family-map"></div>
    <div class="list card">
      ${locs.length
        ? locs.map((l) => `<div class="item small"><span><b>${escapeHtml(l.name)}</b>　${escapeHtml(l.area || "")}</span><span class="muted">${Math.max(0, Math.round((Date.now() - l.ts) / 60000))} 分鐘前</span></div>`).join("")
        : `<div class="small muted">還沒有人分享位置。按下面的按鈕分享，或在下方「設定」開啟「自動分享位置」。</div>`}
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" id="map-share" style="flex:1">📍 更新我的位置</button>
      <button class="btn danger sos-btn" id="map-sos" style="flex:1">🆘 我走散了</button>
    </div>
    <p class="small muted">打開這一頁時，每個家人的手機會自動回報一次位置：開著 App 的人幾秒內就會更新，沒開的人下次打開 App 時補報。</p>
    <p class="small muted">按「🆘 我走散了」會把你的位置傳到群組，全家手機都會震動提醒，AI 也會幫忙安排集合地點。</p>`;
  bindBack(b);
  if (!S.locateAsked || Date.now() - S.locateAsked > 60_000) {
    S.locateAsked = Date.now();
    wsSend({ type: "locate_all" });
    getPosition().then((p) => wsSend({ type: "location", ...p })).catch(() => {});
  }
  $("#map-share").addEventListener("click", async () => {
    try {
      const p = await getPosition();
      wsSend({ type: "location", ...p });
      setTimeout(() => wsSend({ type: "get_state" }), 2500);
      $("#map-share").textContent = "✅ 已更新";
    } catch (err) {
      alert(err.message);
    }
  });
  $("#map-sos").addEventListener("click", async () => {
    if (!confirm("確定要通知全家你走散了嗎？")) return;
    let loc = null;
    try {
      loc = await getPosition();
    } catch {}
    wsSend({ type: "send", text: "🆘 我跟大家走散了，請幫忙！", location: loc });
    els.panel.close();
  });
  loadLeaflet()
    .then(() => {
      const el = $("#family-map");
      if (!el || !window.L) return;
      leafletMap?.remove();
      const acc = st.trip?.accommodationCoords;
      const points = locs.map((l) => [l.lat, l.lon]);
      leafletMap = L.map(el, { zoomControl: true }).setView(points[0] ?? [35.7345, 139.6925], 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(leafletMap);
      locs.forEach((l) => {
        L.circleMarker([l.lat, l.lon], { radius: 10, color: "#fff", weight: 3, fillColor: colorFor(l.name), fillOpacity: 1 })
          .addTo(leafletMap)
          .bindTooltip(`${l.name}（${Math.round((Date.now() - l.ts) / 60000)} 分鐘前）`, { permanent: true, direction: "top" });
      });
      if (acc) L.marker([acc.lat, acc.lon]).addTo(leafletMap).bindTooltip("🏠 住宿");
      if (points.length > 1) leafletMap.fitBounds(points, { padding: [40, 40] });
      setTimeout(() => leafletMap?.invalidateSize(), 200);
    })
    .catch(() => {
      const el = $("#family-map");
      if (el) el.innerHTML = `<div class="small muted" style="padding:16px">地圖載入失敗，請確認網路</div>`;
    });
}

// 家人在找人：自動回報一次位置（同一次請求只回報一次）
async function reportLocationFor(req) {
  try {
    if (Number(localStorage.getItem("tta-located")) >= req.ts) return;
    localStorage.setItem("tta-located", String(req.ts));
  } catch {}
  try {
    const p = await getPosition();
    wsSend({ type: "location", ...p });
    flashNote(`📍 ${req.by} 在找家人，已回報你的位置`);
  } catch {
    flashNote(`📍 ${req.by} 在找家人，但這支手機沒開定位權限`);
  }
}

function flashNote(text) {
  let el = document.querySelector(".flash-note");
  if (!el) {
    el = document.createElement("div");
    el.className = "flash-note";
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(flashNote.t);
  flashNote.t = setTimeout(() => el.classList.remove("on"), 4000);
}

function showSos(msg) {
  navigator.vibrate?.([300, 150, 300, 150, 600]);
  const banner = $("#sos-banner");
  banner.innerHTML = `🆘 <b>${escapeHtml(msg.author)}</b> 走散了！點這裡看位置`;
  banner.hidden = false;
  banner.onclick = () => {
    banner.hidden = true;
    wsSend({ type: "get_state" });
    openPanel("map");
  };
  setTimeout(() => (banner.hidden = true), 60_000);
}

// ---------- ✅ 清單 ----------

let checklistTab = "購物";
function renderChecklistPanel(st, b) {
  els.panelTitle.textContent = "✅ 清單";
  const all = st.checklist ?? [];
  const items = all.filter((c) => c.list === checklistTab);
  const left = items.filter((c) => !c.done).length;
  b.innerHTML = `
    ${backToHub()}
    <div class="tr-dir">${["購物", "行李", "待辦"].map((t) => `<button data-tab="${t}" class="${t === checklistTab ? "active" : ""}">${t}（${all.filter((c) => c.list === t && !c.done).length}）</button>`).join("")}</div>
    <div class="card"><div class="list">
      ${items.length
        ? items.map((c) => `<label class="item check-item ${c.done ? "done" : ""}">
            <span><input type="checkbox" data-id="${c.id}" ${c.done ? "checked" : ""} /> ${escapeHtml(c.item)}${c.for ? ` <span class="tag">${escapeHtml(c.for)}</span>` : ""}${c.done_by ? `<span class="small muted">（${escapeHtml(c.done_by)} ✓）</span>` : ""}</span>
            <button class="btn danger small" data-del="${c.id}" type="button">✕</button></label>`).join("")
        : `<div class="small muted">還沒有項目</div>`}
    </div><div class="small muted" style="margin-top:6px">剩 ${left} 項。也可以在聊天說「把皮卡丘玩偶加入購物清單」「護照帶了」，AI 會幫你更新。</div></div>
    <div class="card"><form class="form" id="ck-form">
      <textarea name="item" rows="2" placeholder="一行一項，例如：&#10;皮卡丘玩偶&#10;無印良品收納盒" required></textarea>
      <div class="row"><input name="forWhom" placeholder="給誰（可留空）" style="flex:1" /><button class="btn primary-sm">加入${checklistTab}</button></div>
    </form></div>`;
  bindBack(b);
  b.querySelectorAll("[data-tab]").forEach((x) =>
    x.addEventListener("click", () => {
      checklistTab = x.dataset.tab;
      renderPanel();
    }),
  );
  b.querySelectorAll("input[type=checkbox][data-id]").forEach((x) => x.addEventListener("change", () => action({ action: "checklist_toggle", id: Number(x.dataset.id), done: x.checked })));
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這一項？") && action({ action: "checklist_delete", id: Number(x.dataset.del) })));
  b.querySelector("#ck-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    action({ action: "checklist_add", list: checklistTab, item: f.get("item"), forWhom: f.get("forWhom") });
  });
}

// ---------- 🎫 票券保管箱（可以分資料夾，沒放進資料夾的在最外層） ----------

function renderTicketsPanel(st, b) {
  els.panelTitle.textContent = "🎫 票券保管箱";
  const docs = st?.documents ?? cachedJson("tta-docs") ?? [];
  const folders = st?.docFolders ?? cachedJson("tta-doc-folders") ?? [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  // 正在看的資料夾被別人刪掉了：回最外層
  if (S.docFolder != null && !byId.has(S.docFolder)) S.docFolder = null;
  const here = S.docFolder ?? null;
  const trail = [];
  for (let f = byId.get(here); f && !trail.includes(f); f = byId.get(f.parent)) trail.unshift(f);
  const hereName = trail.at(-1)?.name ?? "";
  const byName = (a, c) => a.name.localeCompare(c.name, "zh-Hant");
  const subs = folders.filter((f) => (f.parent ?? null) === here).sort(byName);
  const items = docs.filter((d) => (d.folder ?? null) === here);
  // 資料夾自己加上裡面所有子資料夾
  const subtree = (id) => {
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) if (ids.has(f.parent) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
    }
    return ids;
  };
  const count = (id) => {
    const ids = subtree(id);
    return docs.filter((d) => ids.has(d.folder)).length;
  };
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">門票、訂位確認、QR Code 存在這裡，全家都看得到；<b>打開過一次之後，沒網路也能看</b>。可以建資料夾分類，沒放進資料夾的就在最外層。也可以在聊天傳照片說「存成票券」。</p>
    <nav class="doc-crumbs"><button type="button" data-go="">🎫 全部</button>${trail.map((f) => `<span>›</span><button type="button" data-go="${f.id}">📁 ${escapeHtml(f.name)}</button>`).join("")}</nav>
    ${st ? `<div class="doc-tools">
      <button type="button" class="btn small" id="doc-add">${S.docUpload ? "收起上傳" : "＋ 上傳票券"}</button>
      <button type="button" class="btn small" id="folder-new">＋ 新資料夾</button>
      ${here != null ? `<button type="button" class="btn small" id="folder-rename">改名</button><button type="button" class="btn small" id="folder-move">移動資料夾</button><button type="button" class="btn danger small" id="folder-del">刪除資料夾</button>` : ""}
    </div>
    ${S.docUpload ? `<div class="card"><form class="form" id="doc-form">
      <div class="small muted">上傳到：${here != null ? `📁 ${escapeHtml(hereName)}` : "最外層"}</div>
      <input name="title" placeholder="名稱，例如：藤子博物館門票 10/4 11:00" required />
      <input name="note" placeholder="備註（可留空）" />
      <input name="photo" type="file" accept="image/*" required />
      <button class="btn primary-sm" id="doc-save">上傳</button>
    </form></div>` : ""}` : ""}
    <div class="doc-grid">
      ${subs.map((f) => `<button type="button" class="card doc-folder" data-go="${f.id}"><span class="doc-folder-icon">📁</span><b>${escapeHtml(f.name)}</b><span class="small muted">${count(f.id)} 張</span></button>`).join("")}
      ${items.map((d) => `<div class="card doc">
          <img src="${escapeHtml(d.photo)}" loading="lazy" alt="" />
          <b>${escapeHtml(d.title)}</b>${d.note ? `<div class="small muted">${escapeHtml(d.note)}</div>` : ""}
          <div class="small muted">${escapeHtml(d.author)}</div>
          ${st ? `<div class="doc-btns"><button type="button" class="btn small" data-move="${d.id}">移動</button><button type="button" class="btn danger small" data-del="${d.id}">刪除</button></div>` : ""}
        </div>`).join("")}
      ${subs.length || items.length ? "" : `<div class="card small muted">${here != null ? "這個資料夾是空的" : "還沒有票券"}</div>`}
    </div>`;
  bindBack(b);
  // 預先載入所有票券照片（包含資料夾裡的），讓離線快取有東西可看
  docs.forEach((d) => fetch(d.photo).catch(() => {}));
  b.querySelectorAll("[data-go]").forEach((x) =>
    x.addEventListener("click", () => {
      S.docFolder = x.dataset.go === "" ? null : Number(x.dataset.go);
      renderPanel();
    }),
  );
  b.querySelectorAll(".doc img").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => confirm("刪除這張票券？") && action({ action: "document_delete", id: Number(x.dataset.del) })));
  b.querySelectorAll("[data-move]").forEach((x) =>
    x.addEventListener("click", async () => {
      const d = docs.find((y) => y.id === Number(x.dataset.move));
      const to = await pickFolder(d.title, folders, d.folder ?? null);
      if (to !== undefined) action({ action: "document_move", id: d.id, folder: to });
    }),
  );
  $("#doc-add", b)?.addEventListener("click", () => {
    S.docUpload = !S.docUpload;
    renderPanel();
  });
  $("#folder-new", b)?.addEventListener("click", () => {
    const name = prompt(here != null ? `在「${hereName}」裡新增資料夾，名稱：` : "新資料夾名稱：")?.trim();
    if (name) action({ action: "folder_create", name, parent: here });
  });
  $("#folder-rename", b)?.addEventListener("click", () => {
    const name = prompt("資料夾新名稱：", hereName)?.trim();
    if (name && name !== hereName) action({ action: "folder_rename", id: here, name });
  });
  $("#folder-move", b)?.addEventListener("click", async () => {
    // 不能搬進自己或自己裡面的資料夾
    const to = await pickFolder(`📁 ${hereName}`, folders, byId.get(here)?.parent ?? null, subtree(here));
    if (to !== undefined) action({ action: "folder_move", id: here, parent: to });
  });
  $("#folder-del", b)?.addEventListener("click", () => {
    if (!confirm(`刪除「${hereName}」資料夾？裡面的票券和資料夾會移到上一層，不會被刪掉。`)) return;
    S.docFolder = byId.get(here)?.parent ?? null;
    action({ action: "folder_delete", id: here });
  });
  b.querySelector("#doc-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const file = f.get("photo");
    if (!file || !file.size) return;
    const btn = $("#doc-save");
    btn.disabled = true;
    btn.textContent = "上傳中…";
    try {
      const blob = await resizeImage(file, 1600, 0.88);
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": blob.type }, body: blob });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
      const { id } = await res.json();
      S.docUpload = false;
      action({ action: "document_save", title: f.get("title"), note: f.get("note"), photoId: id, folder: here });
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "上傳";
    }
  });
}

/** 選資料夾的小視窗：回傳資料夾 id、null＝最外層、undefined＝取消；banned＝不能選的（自己和裡面的資料夾） */
function pickFolder(what, folders, current, banned = new Set()) {
  return new Promise((resolve) => {
    const rows = [];
    const walk = (parent, depth) => {
      for (const f of folders.filter((x) => (x.parent ?? null) === parent).sort((a, c) => a.name.localeCompare(c.name, "zh-Hant"))) {
        if (banned.has(f.id)) continue;
        rows.push({ ...f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    const opt = (id, label, depth) =>
      `<button type="button" data-to="${id ?? ""}" style="padding-left:${14 + depth * 20}px" ${id === current ? "disabled" : ""}>${label}${id === current ? "（現在在這裡）" : ""}</button>`;
    const dlg = document.createElement("dialog");
    dlg.className = "sheet";
    dlg.innerHTML = `<div class="sheet-handle"></div>
      <div class="sheet-head"><h2>移到哪裡？</h2><button type="button" class="icon" data-x aria-label="關閉">✕</button></div>
      <div class="small muted">${escapeHtml(what)}</div>
      <div class="folder-pick">${opt(null, "🎫 最外層", 0)}${rows.map((r) => opt(r.id, `📁 ${escapeHtml(r.name)}`, r.depth + 1)).join("")}</div>
      ${rows.length ? "" : `<div class="small muted">還沒有資料夾，先按「＋ 新資料夾」建立</div>`}`;
    let choice;
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("[data-x]")) return dlg.close();
      const btn = e.target.closest("[data-to]");
      if (!btn || btn.disabled) return;
      choice = btn.dataset.to === "" ? null : Number(btn.dataset.to);
      dlg.close();
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(choice);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

function cachedJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

// ---------- ⏰ 提醒 ----------

function renderRemindersPanel(st, b) {
  els.panelTitle.textContent = "⏰ 提醒";
  const rs = st.reminders ?? [];
  b.innerHTML = `
    ${backToHub()}
    <p class="small muted">時間到了會在群組發訊息通知全家（東京時間）。也可以在聊天說「10/4 早上 9:30 提醒大家出門」。</p>
    <div class="card"><div class="list">
      ${rs.length
        ? rs.map((r) => `<div class="item small"><div><b>${escapeHtml(r.time)}</b><div>${escapeHtml(r.message)}</div><div class="muted">${escapeHtml(r.by)}</div></div><button class="btn danger small" data-del="${r.id}">刪除</button></div>`).join("")
        : `<div class="small muted">沒有待發的提醒</div>`}
    </div></div>
    <div class="card"><form class="form" id="rm-form">
      <label class="small muted">日期時間（東京時間）<input name="at" type="datetime-local" required /></label>
      <input name="message" placeholder="提醒內容，例如：出門去藤子博物館！" required />
      <button class="btn primary-sm">新增提醒</button>
    </form></div>`;
  bindBack(b);
  b.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", () => action({ action: "reminder_delete", id: Number(x.dataset.del) })));
  b.querySelector("#rm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const m = String(f.get("at")).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return;
    // 輸入的是東京時間，換成 UTC 毫秒
    const due = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]);
    action({ action: "reminder_add", due, message: f.get("message") });
  });
}

// ---------- 📔 旅遊日記 ----------

// 每天一張卡片（封面照＋標題＋摘要），點進去是圖文版日記網頁，那裡可以下載 PDF、分享
function renderDiaryPanel(st, b) {
  els.panelTitle.textContent = "📔 旅遊日記";
  const ds = st.diaries ?? [];
  const share = S.settings?.share ? location.origin + S.settings.share : "";
  const start = st.trip?.startDate;
  const dayNo = (date) => (start ? Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400e3) + 1 : "");
  b.innerHTML = `
    ${backToHub()}
    <div class="card diary-top">
      <p class="small muted">旅途中每晚 22:00（東京時間）AI 會用當天的對話和照片寫一篇日記，整理成圖文版的日記網頁。</p>
      <a class="diary-main" href="/api/album" target="_blank" rel="noopener">${svg("book")}打開日記網頁</a>
      <div class="diary-row">
        <a class="btn" href="/api/album?print=1" target="_blank" rel="noopener">下載 PDF</a>
        <button type="button" class="btn" id="diary-share">分享給親友</button>
      </div>
      <div class="small muted">${share ? "分享連結已開啟：拿到連結的人不用登入就能看日記和照片。" : S.me.admin ? "分享連結還沒開啟，按「分享給親友」會先問你要不要開啟。" : "分享連結要由管理員開啟。"}</div>
      ${S.me.admin && share ? `<button type="button" class="btn small" id="diary-share-off">關閉分享連結（舊連結會失效）</button>` : ""}
    </div>
    ${ds.length
      ? ds.map((d) => {
          const photos = JSON.parse(d.photo_ids || "[]");
          const excerpt = String(d.text || "").replace(/\s+/g, " ").slice(0, 100);
          return `<div class="diary-card">
            <a href="/api/album#${escapeHtml(d.date)}" target="_blank" rel="noopener">
              ${photos[0] ? `<img src="/api/photo/${escapeHtml(photos[0])}" loading="lazy" alt="" />` : ""}
              <div class="diary-card-body">
                <div class="diary-kicker">DAY ${dayNo(d.date)}・${dateLabel(d.date)}・${photos.length} 張照片</div>
                <h3>${escapeHtml(d.title || "旅途中的一天")}</h3>
                <p>${escapeHtml(excerpt)}…</p>
              </div>
            </a>
            <div class="diary-card-btns">
              ${d.edited_by ? `<span class="small muted">${escapeHtml(d.edited_by)} 修改過</span>` : ""}
              <button type="button" class="btn small" data-edit-diary="${escapeHtml(d.date)}">編輯文字與照片</button>
              ${S.me.admin ? `<button type="button" class="btn small" data-rewrite="${escapeHtml(d.date)}" data-edited="${escapeHtml(d.edited_by || "")}">AI 重寫</button>` : ""}
            </div>
          </div>`;
        }).join("")
      : `<div class="card small muted">還沒有日記</div>`}`;
  bindBack(b);
  $("#diary-share", b).addEventListener("click", () => {
    if (share) return shareLink(share, `${st.trip?.title || "旅遊"}｜旅遊日記`);
    if (!S.me.admin) return alert("分享連結要由管理員開啟");
    if (confirm("開啟分享連結後，拿到連結的人不用登入就能看日記和照片（之後隨時可以關閉）。要開啟嗎？")) action({ action: "share_on" });
  });
  $("#diary-share-off", b)?.addEventListener("click", () => {
    if (confirm("關閉後，之前分享出去的連結都會失效。確定關閉？")) action({ action: "share_off" });
  });
  b.querySelectorAll("[data-edit-diary]").forEach((x) =>
    x.addEventListener("click", () => {
      const d = ds.find((y) => y.date === x.dataset.editDiary);
      S.diaryEdit = { date: d.date, title: d.title || "", text: d.text || "", photos: JSON.parse(d.photo_ids || "[]"), base: d.ts, editedBy: d.edited_by || "", dirty: false };
      openPanel("diary-edit");
    }),
  );
  b.querySelectorAll("[data-rewrite]").forEach((x) =>
    x.addEventListener("click", () => {
      const warn = x.dataset.edited ? `\n\n⚠️ ${x.dataset.edited} 修改過這篇，重寫會蓋掉家人改的文字和照片。` : "";
      if (!confirm(`用 ${x.dataset.rewrite.slice(5).replace("-", "/")} 的對話和照片重新寫這篇日記？（不會在群組重貼）${warn}`)) return;
      x.disabled = true;
      x.textContent = "重寫中，約需 30 秒…";
      action({ action: "diary_rewrite", date: x.dataset.rewrite });
    }),
  );
}

// 家人修改日記：標題、內文、照片（新增、移除、調順序；第一張是這天的大圖）
function renderDiaryEditor(st, b) {
  const e = S.diaryEdit;
  if (!e) return openPanel("diary");
  els.panelTitle.textContent = `編輯 ${dateLabel(e.date)} 的日記`;
  const n = e.photos.length;
  b.innerHTML = `
    <button type="button" class="btn small" id="de-back">← 旅遊日記</button>
    <div class="card diary-edit">
      <label class="small muted" for="de-title">標題</label>
      <input id="de-title" maxlength="40" value="${escapeHtml(e.title)}" />
      <label class="small muted" for="de-text">內文（段落之間空一行）</label>
      <textarea id="de-text" rows="12">${escapeHtml(e.text)}</textarea>
      <div class="small muted">照片 ${n} 張・依順序穿插在文章裡（第一張也是這天的封面），用 ◀ ▶ 調整順序</div>
      <div class="de-photos">
        ${e.photos
          .map(
            (id, i) => `<figure>
          <img src="/api/photo/${escapeHtml(id)}" loading="lazy" alt="" />
          ${i === 0 ? `<span class="de-cover">大圖</span>` : ""}
          <div class="de-ph-btns">
            <button type="button" data-mv="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="往前">◀</button>
            <button type="button" data-rm="${i}" aria-label="移除">✕</button>
            <button type="button" data-mv="${i}:1" ${i === n - 1 ? "disabled" : ""} aria-label="往後">▶</button>
          </div>
        </figure>`,
          )
          .join("")}
        <label class="de-add">${svg("plus")}<span>${e.uploading || "新增照片"}</span><input type="file" accept="image/*" multiple hidden /></label>
      </div>
      ${e.editedBy ? `<div class="small muted">上次修改：${escapeHtml(e.editedBy)}</div>` : ""}
      <div class="diary-row"><button type="button" class="btn" id="de-cancel">取消</button><button type="button" class="btn primary-sm" id="de-save">儲存</button></div>
    </div>`;
  const leave = () => {
    if (e.dirty && !confirm("還沒儲存，確定放棄這些修改？")) return;
    S.diaryEdit = null;
    openPanel("diary");
  };
  $("#de-back", b).addEventListener("click", leave);
  $("#de-cancel", b).addEventListener("click", leave);
  $("#de-title", b).addEventListener("input", (ev) => {
    e.title = ev.target.value;
    e.dirty = true;
  });
  $("#de-text", b).addEventListener("input", (ev) => {
    e.text = ev.target.value;
    e.dirty = true;
  });
  b.querySelectorAll("[data-mv]").forEach((x) =>
    x.addEventListener("click", () => {
      const [i, d] = x.dataset.mv.split(":").map(Number);
      [e.photos[i], e.photos[i + d]] = [e.photos[i + d], e.photos[i]];
      e.dirty = true;
      renderPanel();
    }),
  );
  b.querySelectorAll("[data-rm]").forEach((x) =>
    x.addEventListener("click", () => {
      e.photos.splice(Number(x.dataset.rm), 1);
      e.dirty = true;
      renderPanel();
    }),
  );
  b.querySelector(".de-add input").addEventListener("change", async (ev) => {
    const files = [...ev.target.files];
    for (const [k, file] of files.entries()) {
      e.uploading = `上傳中 ${k + 1}/${files.length}…`;
      if (S.panel === "diary-edit") renderPanel();
      try {
        const blob = await resizeImage(file, 1600, 0.85);
        const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": blob.type }, body: blob });
        if (!res.ok) throw new Error(String(res.status));
        e.photos.push((await res.json()).id);
        e.dirty = true;
      } catch {
        alert(`第 ${k + 1} 張照片上傳失敗`);
      }
    }
    e.uploading = "";
    if (S.panel === "diary-edit") renderPanel();
  });
  $("#de-save", b).addEventListener("click", (ev) => {
    if (!e.title.trim() && !e.text.trim() && !e.photos.length) return alert("日記不能全部清空");
    ev.target.disabled = true;
    ev.target.textContent = "儲存中…";
    if (!wsSend({ type: "action", action: "diary_edit", date: e.date, title: e.title, text: e.text, photos: e.photos, base: e.base })) {
      ev.target.disabled = false;
      ev.target.textContent = "儲存";
    }
  });
}

/** 手機用分享面板（LINE、訊息…），電腦或不支援時複製連結 */
function shareLink(url, title) {
  const copy = () =>
    navigator.clipboard ? navigator.clipboard.writeText(url).then(() => alert("已複製分享連結"), () => prompt("複製這個連結分享：", url)) : prompt("複製這個連結分享：", url);
  if (navigator.share) navigator.share({ title, url }).catch((e) => e.name !== "AbortError" && copy());
  else copy();
}

// ================= 中日翻譯 =================

const TR = {
  tab: "phrases",
  from: "zh", // zh = 中→日, ja = 日→中
  history: [],
  result: null, // 最近一次自己的翻譯結果
  busy: false,
  adding: false,
  rec: null,
  reqId: null,
};

function phrasesData() {
  if (S.state?.phrases) return S.state.phrases;
  try {
    return JSON.parse(localStorage.getItem("tta-phrases") || "[]");
  } catch {
    return [];
  }
}

// ---------- 語音：念出來（瀏覽器內建，免費、離線也能用） ----------

let voices = [];
function loadVoices() {
  voices = "speechSynthesis" in window ? speechSynthesis.getVoices() : [];
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

function speak(text, lang = "ja") {
  if (!("speechSynthesis" in window)) return alert("這個瀏覽器不支援朗讀");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/\n+/g, "、"));
  u.lang = lang === "ja" ? "ja-JP" : "zh-TW";
  u.rate = lang === "ja" ? 0.9 : 1;
  const v = voices.find((x) => x.lang.replace("_", "-").startsWith(lang === "ja" ? "ja" : "zh-TW")) ?? voices.find((x) => x.lang.startsWith(lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ---------- 全螢幕給對方看 ----------

let showcaseItem = null;
function showBig(item) {
  showcaseItem = item;
  $("#showcase-ja").textContent = item.ja;
  $("#showcase-kana").textContent = item.kana || "";
  $("#showcase-zh").textContent = item.zh || "";
  if (!els.showcase.open) els.showcase.showModal();
}
$("#showcase-speak").addEventListener("click", () => showcaseItem && speak(showcaseItem.ja, "ja"));
$("#showcase-close").addEventListener("click", () => els.showcase.close());

// ---------- 開關與分頁 ----------

function openTranslator() {
  if (els.panel.open) els.panel.close();
  renderTranslator();
  // 不用 showModal：modal 會讓底部分頁列點不到
  if (!els.translator.open) els.translator.show();
  setTab("translator");
}
function closeTranslator() {
  TR.rec?.stop();
  els.translator.close();
}
$("#tr-close").addEventListener("click", closeTranslator);
els.translator.addEventListener("close", () => {
  if (!els.panel.open) setTab("chat");
});
els.trTabs.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    TR.rec?.stop();
    TR.tab = b.dataset.tab;
    if (TR.tab === "history" && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: "action", action: "get_translations" }));
    renderTranslator();
  }),
);

function renderTranslator() {
  els.trTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === TR.tab));
  const b = els.trBody;
  if (TR.tab === "phrases") {
    const cats = [...new Set(phrasesData().map((p) => p.category))];
    if (!cats.includes("⭐ 我的常用句")) cats.push("⭐ 我的常用句");
    b.innerHTML = `
      <p class="small muted">點一下就用日文念出來；📺 放大給司機、店員看。全家共用，沒網路也能用。</p>
      <div id="ph-list"></div>
      <div class="card"><h3>➕ 新增常用句</h3>
        <form class="form" id="ph-form">
          <input name="zh" placeholder="輸入中文，例如：請問有推薦的菜嗎？" required />
          <div class="row">
            <select name="category">${cats.map((c) => `<option>${escapeHtml(c)}</option>`).join("")}</select>
            <button class="btn primary-sm" id="ph-add">${TR.adding ? "翻譯中…" : "新增（自動翻成日文）"}</button>
          </div>
        </form>
      </div>`;
    renderPhraseList();
    b.querySelector("#ph-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      TR.adding = true;
      e.target.querySelector("#ph-add").textContent = "翻譯中…";
      if (!wsSend({ type: "action", action: "add_phrase", zh: f.get("zh"), category: f.get("category") })) TR.adding = false;
      e.target.reset();
    });
  } else if (TR.tab === "live") {
    renderLive();
  } else {
    b.innerHTML = TR.history.length
      ? `<p class="small muted">全家的翻譯紀錄，點一下再念一次。AI 也看得到這些紀錄。</p>` +
        TR.history
          .map((t, i) => {
            const ja = t.from_lang === "zh" ? t.result : t.source;
            return `<div class="card tr-item" data-i="${i}">
              <div class="small muted">${escapeHtml(t.author)}｜${dayText(t.ts)} ${timeText(t.ts)}｜${t.from_lang === "zh" ? "中→日" : "日→中"}</div>
              <div>${escapeHtml(t.source)}</div>
              <div class="tr-out">${escapeHtml(t.result)}</div>
              <div class="row"><button class="btn small" data-speak="${i}">🔊</button><button class="btn small" data-show="${i}">📺</button></div>
            </div>`;
          })
          .join("")
      : `<div class="card small muted">還沒有翻譯紀錄</div>`;
    const item = (i) => {
      const t = TR.history[i];
      return t.from_lang === "zh" ? { ja: t.result, kana: t.reading, zh: t.source } : { ja: t.source, zh: t.result };
    };
    b.querySelectorAll("[data-speak]").forEach((x) => x.addEventListener("click", () => speak(item(x.dataset.speak).ja, "ja")));
    b.querySelectorAll("[data-show]").forEach((x) => x.addEventListener("click", () => showBig(item(x.dataset.show))));
  }
}

function renderPhraseList() {
  const list = $("#ph-list");
  if (!list) return;
  const phrases = phrasesData();
  const cats = [...new Set(phrases.map((p) => p.category))];
  list.innerHTML = cats
    .map(
      (c) => `<h3 class="ph-cat">${escapeHtml(c)}</h3><div class="ph-grid">${phrases
        .filter((p) => p.category === c)
        .map(
          (p) => `<div class="phrase" data-id="${p.id}">
            <div class="ph-zh">${escapeHtml(p.zh)}</div>
            <div class="ph-ja">${escapeHtml(p.ja)}</div>
            ${p.kana ? `<div class="ph-kana">${escapeHtml(p.kana)}</div>` : ""}
            <div class="ph-actions">
              <button class="btn small" data-show>📺 給對方看</button>
              <button class="btn small danger" data-del title="刪除">✕</button>
            </div>
          </div>`,
        )
        .join("")}</div>`,
    )
    .join("");
  list.querySelectorAll(".phrase").forEach((el) => {
    const p = phrases.find((x) => String(x.id) === el.dataset.id);
    el.addEventListener("click", () => {
      speak(p.ja, "ja");
      el.classList.add("speaking");
      setTimeout(() => el.classList.remove("speaking"), 1200);
    });
    el.querySelector("[data-show]").addEventListener("click", (e) => {
      e.stopPropagation();
      showBig(p);
      speak(p.ja, "ja");
    });
    el.querySelector("[data-del]").addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`刪除「${p.zh}」？（全家都會刪除）`)) wsSend({ type: "action", action: "delete_phrase", id: p.id });
    });
  });
}

// ---------- 即時翻譯 ----------

function renderLive() {
  const b = els.trBody;
  const zh = TR.from === "zh";
  const r = TR.result;
  b.innerHTML = `
    <div class="tr-dir">
      <button data-from="zh" class="${zh ? "active" : ""}">中文 → 日文</button>
      <button data-from="ja" class="${zh ? "" : "active"}">日文 → 中文</button>
    </div>
    <textarea id="tr-input" rows="4" placeholder="${zh ? "輸入或按 🎤 說中文" : "請對方輸入或按 🎤 說日文（日本語でどうぞ）"}"></textarea>
    <div class="row tr-controls">
      <button class="btn tr-mic" id="tr-mic">🎤 ${zh ? "說中文" : "日本語で話す"}</button>
      <button class="btn primary-sm tr-go" id="tr-go">${TR.busy ? "翻譯中…" : "翻譯"}</button>
    </div>
    ${
      r
        ? `<div class="card tr-result">
            <div class="small muted">${escapeHtml(r.source)}</div>
            <div class="tr-out big-text">${escapeHtml(r.result)}</div>
            ${r.reading ? `<div class="ph-kana">${escapeHtml(r.reading)}</div>` : ""}
            <div class="row tr-actions">
              <button class="btn" id="tr-speak">🔊 念出來</button>
              <button class="btn" id="tr-show">📺 給對方看</button>
              <button class="btn" id="tr-copy">📋 複製</button>
              <button class="btn" id="tr-swap">↔ 換對方說</button>
            </div>
          </div>`
        : `<p class="small muted">說完或打完按「翻譯」。語音輸入說完會自動翻譯。</p>`
    }`;
  b.querySelectorAll("[data-from]").forEach((x) =>
    x.addEventListener("click", () => {
      TR.rec?.stop();
      TR.from = x.dataset.from;
      renderLive();
    }),
  );
  $("#tr-mic").addEventListener("click", toggleMic);
  $("#tr-go").addEventListener("click", doTranslate);
  updateMic();
  if (r) {
    const ja = r.from_lang === "zh" ? r.result : r.source;
    $("#tr-speak").addEventListener("click", () => speak(r.result, r.from_lang === "zh" ? "ja" : "zh"));
    $("#tr-show").addEventListener("click", () => showBig(r.from_lang === "zh" ? { ja, kana: r.reading, zh: r.source } : { ja, zh: r.result }));
    $("#tr-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(r.result);
        $("#tr-copy").textContent = "✅ 已複製";
      } catch {}
    });
    $("#tr-swap").addEventListener("click", () => {
      TR.from = TR.from === "zh" ? "ja" : "zh";
      renderLive();
      toggleMic();
    });
  }
}

function doTranslate() {
  const input = $("#tr-input");
  const text = input?.value.trim();
  if (!text || TR.busy) return;
  TR.reqId = Math.random().toString(36).slice(2);
  if (!wsSend({ type: "action", action: "translate", text, from: TR.from, reqId: TR.reqId })) return;
  TR.busy = true;
  $("#tr-go").textContent = "翻譯中…";
}

function onTranslation(m) {
  TR.history.unshift(m.item);
  if (m.reqId && m.reqId === TR.reqId) {
    TR.busy = false;
    TR.result = m.item;
    if (els.translator.open && TR.tab === "live") {
      renderLive();
      // 中→日：翻好直接念給對方聽
      if (m.item.from_lang === "zh") speak(m.item.result, "ja");
    }
  } else if (els.translator.open && TR.tab === "history") {
    renderTranslator();
  }
}

function trActionDone(m) {
  if (m.action === "translate" && !m.ok) {
    TR.busy = false;
    if ($("#tr-go")) $("#tr-go").textContent = "翻譯";
  }
  if (m.action === "add_phrase") {
    TR.adding = false;
    if ($("#ph-add")) $("#ph-add").textContent = "新增（自動翻成日文）";
  }
}

// ---------- 語音輸入（瀏覽器內建） ----------

function updateMic() {
  const btn = $("#tr-mic");
  if (!btn) return;
  btn.classList.toggle("listening", !!TR.rec);
  btn.textContent = TR.rec ? "⏹ 說完了" : `🎤 ${TR.from === "zh" ? "說中文" : "日本語で話す"}`;
}

function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("這個瀏覽器不支援語音輸入，可以改用手機鍵盤上的 🎤 聽寫。");
  if (TR.rec) return TR.rec.stop();
  const input = $("#tr-input");
  const base = input.value.trim() ? input.value.trim() + " " : "";
  const rec = new SR();
  rec.lang = TR.from === "zh" ? "zh-TW" : "ja-JP";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let t = "";
    for (const r of e.results) t += r[0].transcript;
    input.value = base + t;
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") alert("請允許這個網站使用麥克風");
  };
  rec.onend = () => {
    TR.rec = null;
    updateMic();
    // 說完自動翻譯
    if (input.value.trim() && input.value.trim() !== base.trim()) doTranslate();
  };
  TR.rec = rec;
  try {
    rec.start();
  } catch {
    TR.rec = null;
  }
  updateMic();
}

// 離線快取（常用句、票券照片沒網路也能用；畫面更新也會立刻生效）
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

checkSession();

// ---------- 只看我和 AI 的對話：只顯示自己的訊息和 AI 回自己的訊息 ----------

const mineBar = Object.assign(document.createElement("div"), { className: "mine-bar", hidden: true });
mineBar.innerHTML = `<span>👤 只顯示你和 AI 的對話</span><button type="button" class="btn small">顯示全部</button>`;
els.messages.before(mineBar);
mineBar.querySelector("button").addEventListener("click", () => toggleMine(false));

/** 標出每則訊息算不算「我的」：AI 的回答有記回誰就照記的，舊訊息看前面最近的那則是誰問的 */
function markMine() {
  if (!els.messages.classList.contains("only-mine")) return;
  const me = S.me?.name;
  let asker = null;
  for (const n of els.messages.querySelectorAll(".msg")) {
    if (n.classList.contains("ai")) n.dataset.mine = !n.dataset.sys && (n.dataset.for || asker) === me ? "1" : "0";
    else {
      asker = n.dataset.author;
      n.dataset.mine = asker === me ? "1" : "0";
    }
  }
  // 整天都沒有自己的對話，那天的日期分隔線也藏起來
  for (const sep of els.messages.querySelectorAll(".day-sep")) {
    let n = sep.nextElementSibling, any = false;
    while (n && !n.classList.contains("day-sep")) {
      if (n.dataset.mine === "1") any = true;
      n = n.nextElementSibling;
    }
    sep.dataset.empty = any ? "0" : "1";
  }
}

function toggleMine(on = !els.messages.classList.contains("only-mine")) {
  els.messages.classList.toggle("only-mine", on);
  mineBar.hidden = !on;
  if (on) {
    markMine();
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  renderChips();
}

new MutationObserver(() => els.messages.classList.contains("only-mine") && requestAnimationFrame(markMine)).observe(els.messages, { childList: true });
