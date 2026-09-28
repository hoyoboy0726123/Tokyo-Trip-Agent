// 東京旅伴 前端：登入、即時群聊（WebSocket）、照片、定位、行程／記帳／記憶面板
const $ = (s) => document.querySelector(s);
const els = {
  login: $("#login"), loginForm: $("#login-form"), loginName: $("#login-name"), loginPassword: $("#login-password"), loginError: $("#login-error"),
  app: $("#app"), messages: $("#messages"), loadMore: $("#load-more"), conn: $("#conn"),
  dayBadge: $("#day-badge"), todayTitle: $("#today-title"), online: $("#online"),
  input: $("#input"), sendForm: $("#send-form"), sendBtn: $("#send-btn"), photoInput: $("#photo-input"), locBtn: $("#loc-btn"),
  attach: $("#attach"), attachImg: $("#attach-img"), attachLoc: $("#attach-loc"), attachClear: $("#attach-clear"),
  panel: $("#panel"), panelTitle: $("#panel-title"), panelBody: $("#panel-body"), panelClose: $("#panel-close"),
  viewer: $("#viewer"), viewerImg: $("#viewer-img"),
};

const S = {
  me: null, aiName: "旅伴 AI", settings: {}, state: null, ws: null, retry: 0,
  oldest: null, pending: { photo: null, photoUrl: null, location: null },
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

function md(text) {
  if (window.marked && window.DOMPurify) {
    const html = DOMPurify.sanitize(marked.parse(text ?? "", { breaks: true }));
    return html.replace(/<a /g, '<a target="_blank" rel="noopener" ');
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

// ================= 登入 =================

async function checkSession() {
  const res = await fetch("/api/me");
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
      const me = await fetch("/api/me");
      if (me.status === 401) return location.reload();
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
      S.me = m.me;
      S.aiName = m.aiName;
      S.settings = m.settings;
      setState(m.state);
      els.messages.querySelectorAll(".msg, .day-sep").forEach((n) => n.remove());
      S.lastDay = null;
      S.live.clear();
      m.messages.forEach((msg) => appendMessage(msg));
      S.oldest = m.messages[0]?.ts ?? null;
      els.loadMore.hidden = m.messages.length < 60;
      scrollToBottom(true);
      break;
    case "message":
      appendMessage(m.message);
      scrollToBottom(m.message.author === S.me.name);
      break;
    case "older":
      prependMessages(m.messages);
      break;
    case "presence":
      els.online.textContent = `🟢 ${m.online.join("、")}`;
      break;
    case "settings":
      S.settings = m.settings;
      if (S.panel === "settings") renderPanel();
      break;
    case "state":
      setState(m.state);
      break;
    case "cleared":
      els.messages.querySelectorAll(".msg, .day-sep").forEach((n) => n.remove());
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
    case "ai_done":
      aiDone(m);
      break;
    case "action_result":
      if (!m.ok && m.error) alert(m.error);
      break;
  }
}

// ================= 訊息渲染 =================

function messageNode(msg) {
  const isAI = msg.role === "assistant";
  const isMe = !isAI && msg.author === S.me?.name;
  const node = document.createElement("div");
  node.className = `msg ${isAI ? "ai" : isMe ? "me" : "other"}`;
  node.dataset.id = msg.id;
  const avatar = isAI ? `<div class="avatar" style="background:var(--red)">🗼</div>` : `<div class="avatar" style="background:${colorFor(msg.author)}">${escapeHtml([...msg.author][0])}</div>`;
  let body = "";
  if (msg.photo) body += `<img class="photo" src="${msg.photo}" loading="lazy" alt="照片" />`;
  if (msg.location) {
    const url = `https://www.google.com/maps/search/?api=1&query=${msg.location.lat},${msg.location.lon}`;
    body += `<div class="loc-card">📍 <a href="${url}" target="_blank" rel="noopener">分享了目前位置</a></div>`;
  }
  if (msg.text) body += isAI ? md(msg.text) : escapeHtml(msg.text).replace(/\n/g, "<br>");
  const tools = msg.meta?.tools?.length ? msg.meta.tools.map((t) => `<span class="tool-chip">${escapeHtml(t)}</span>`).join("") : "";
  const provider = isAI && msg.meta?.provider ? (msg.meta.provider === "gemini" ? "Gemini" : "Workers AI") : "";
  node.innerHTML = `${isMe ? "" : avatar}
    <div class="bubble-wrap">
      ${isMe ? "" : `<div class="name">${escapeHtml(msg.author)}</div>`}
      <div class="bubble">${body}</div>
      <div class="meta">${timeText(msg.ts)}${provider ? ` · ${provider}` : ""} ${tools}</div>
    </div>`;
  node.querySelectorAll("img.photo").forEach((img) => img.addEventListener("click", () => openViewer(img.src)));
  return node;
}

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
  els.messages.appendChild(messageNode(msg));
}

function prependMessages(list) {
  if (!list.length) {
    els.loadMore.hidden = true;
    return;
  }
  const prevHeight = els.messages.scrollHeight;
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
  els.loadMore.hidden = list.length < 50;
  els.messages.scrollTop = els.messages.scrollHeight - prevHeight;
}

els.loadMore.addEventListener("click", () => wsSend({ type: "load_more", before: S.oldest }));

function nearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 160;
}

function scrollToBottom(force) {
  if (force || nearBottom()) requestAnimationFrame(() => (els.messages.scrollTop = els.messages.scrollHeight));
}

// ---------- AI 即時生成 ----------

function aiStart(m) {
  let live = S.live.get(m.id);
  if (!live) {
    const stick = nearBottom();
    const node = messageNode({ id: m.id, ts: Date.now(), author: S.aiName, role: "assistant", text: "", meta: null });
    const bubble = node.querySelector(".bubble");
    bubble.innerHTML = `<div class="tools-live"></div><div class="ai-text"><span class="typing"><span></span><span></span><span></span></span></div>`;
    const sep = daySeparator(Date.now());
    if (sep) els.messages.appendChild(sep);
    els.messages.appendChild(node);
    live = { node, text: "", raf: 0 };
    S.live.set(m.id, live);
    scrollToBottom(stick);
  }
  live.node.querySelector(".meta").textContent = `${m.provider === "gemini" ? "Gemini" : "Workers AI"} 思考中…`;
}

function aiTool(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  const chip = document.createElement("span");
  chip.className = "tool-chip";
  chip.textContent = m.label;
  live.node.querySelector(".tools-live").appendChild(chip);
  scrollToBottom(false);
}

function aiDelta(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text += m.delta;
  if (live.raf) return;
  live.raf = requestAnimationFrame(() => {
    live.raf = 0;
    const stick = nearBottom();
    live.node.querySelector(".ai-text").innerHTML = md(live.text);
    scrollToBottom(stick);
  });
}

function aiRetry(m) {
  const live = S.live.get(m.id);
  if (!live) return;
  live.text = "";
  live.node.querySelector(".ai-text").innerHTML = `<span class="muted small">主要模型出錯，改用備援模型…</span>`;
}

function aiDone(m) {
  const live = S.live.get(m.id);
  const stick = nearBottom();
  const node = messageNode(m.message);
  if (live) {
    cancelAnimationFrame(live.raf);
    live.node.replaceWith(node);
    S.live.delete(m.id);
  } else {
    appendMessage(m.message);
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
  const { photo, location: loc } = S.pending;
  if (!text && !photo && !loc) return;
  els.sendBtn.disabled = true;
  try {
    let photoId = null;
    if (photo) {
      const res = await fetch("/api/photo", { method: "POST", headers: { "content-type": photo.type }, body: photo });
      if (!res.ok) throw new Error(`照片上傳失敗（${res.status}）`);
      photoId = (await res.json()).id;
    }
    if (wsSend({ type: "send", text, photoId, location: loc })) {
      els.input.value = "";
      autoGrow();
      clearAttachment();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    els.sendBtn.disabled = false;
  }
});

document.querySelectorAll("#chips button").forEach((b) =>
  b.addEventListener("click", () => {
    els.input.value = b.dataset.q;
    if (b.dataset.q.includes("附近") || b.dataset.q.includes("回住宿")) attachLocation(true);
    else els.sendForm.requestSubmit();
  }),
);

// ---------- 照片 ----------

els.photoInput.addEventListener("change", async () => {
  const file = els.photoInput.files?.[0];
  els.photoInput.value = "";
  if (!file) return;
  try {
    const blob = await resizeImage(file, 1280, 0.82);
    S.pending.photo = blob;
    if (S.pending.photoUrl) URL.revokeObjectURL(S.pending.photoUrl);
    S.pending.photoUrl = URL.createObjectURL(blob);
    els.attachImg.src = S.pending.photoUrl;
    els.attach.hidden = false;
    els.input.placeholder = "要問什麼？例如：這是什麼、幫我翻譯、比價";
    els.input.focus();
  } catch {
    alert("無法讀取這張照片");
  }
});

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
  els.locBtn.classList.add("active");
  els.attachLoc.textContent = "📍 定位中…";
  els.attach.hidden = false;
  try {
    S.pending.location = await getPosition();
    els.attachLoc.textContent = `📍 已附上位置（±${S.pending.location.accuracy}m）`;
    if (thenSend) els.sendForm.requestSubmit();
  } catch (err) {
    els.attachLoc.textContent = "";
    els.locBtn.classList.remove("active");
    if (!S.pending.photo) els.attach.hidden = true;
    alert(err.message);
    if (thenSend && els.input.value) els.sendForm.requestSubmit();
  }
}

els.locBtn.addEventListener("click", () => {
  if (S.pending.location) return clearLocation();
  attachLocation(false);
});

function clearLocation() {
  S.pending.location = null;
  els.locBtn.classList.remove("active");
  els.attachLoc.textContent = "";
  if (!S.pending.photo) els.attach.hidden = true;
}

function clearAttachment() {
  S.pending.photo = null;
  if (S.pending.photoUrl) URL.revokeObjectURL(S.pending.photoUrl);
  S.pending.photoUrl = null;
  els.attachImg.removeAttribute("src");
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
  const now = jst(Date.now()).toISOString().slice(0, 10);
  const start = new Date(state.trip.startDate + "T00:00:00Z");
  const day = Math.floor((new Date(now + "T00:00:00Z") - start) / 86400e3) + 1;
  const today = state.itinerary.find((d) => d.date === now);
  if (day < 1) {
    els.dayBadge.textContent = `倒數 ${1 - day} 天`;
    els.todayTitle.textContent = state.trip.title;
  } else if (today) {
    els.dayBadge.textContent = `Day ${day}`;
    els.todayTitle.textContent = today.title;
  } else {
    els.dayBadge.textContent = "🏠";
    els.todayTitle.textContent = "旅程結束，歡迎回家！";
  }
  if (S.panel && S.panel !== "settings") renderPanel();
}

document.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.panel)));
els.panelClose.addEventListener("click", () => els.panel.close());
els.panel.addEventListener("close", () => (S.panel = null));
els.panel.addEventListener("click", (e) => e.target === els.panel && els.panel.close());

function openPanel(name) {
  S.panel = name;
  renderPanel();
  if (!els.panel.open) els.panel.showModal();
}

function openViewer(src) {
  els.viewerImg.src = src;
  els.viewer.showModal();
}
els.viewer.addEventListener("click", () => els.viewer.close());

function action(payload) {
  wsSend({ type: "action", ...payload });
}

function renderPanel() {
  const st = S.state;
  const b = els.panelBody;
  if (!st) return;
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
          <div class="big">${yen(ex.total_jpy)}</div><div class="muted">約 NT$${ex.total_twd.toLocaleString()}</div></div>
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
        <p class="small muted">AI 會記得這些事，並每隔一段對話自動整理重點。行程變更也會永久保存。</p>
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
          <div>網路搜尋：${s.hasTavily ? "✅ Tavily" : "⚠️ 未設定 TAVILY_API_KEY"}｜Gemini：${s.hasGemini ? "✅" : "⚠️ 未設定"}</div>
        </div>
        ${S.me.admin ? `
        <div class="card"><h3>管理員設定</h3>
          <div class="small muted">AI 模型（出錯時會自動改用另一個）</div>
          <div class="seg" id="seg-provider">
            <label><input type="radio" name="provider" value="gemini" ${s.provider !== "workers-ai" ? "checked" : ""} />Gemini</label>
            <label><input type="radio" name="provider" value="workers-ai" ${s.provider === "workers-ai" ? "checked" : ""} />Workers AI</label>
          </div>
          <div class="small muted" style="margin-top:10px">AI 回覆時機</div>
          <div class="seg" id="seg-mode">
            <label><input type="radio" name="mode" value="all" ${s.replyMode !== "mention" ? "checked" : ""} />每則都回</label>
            <label><input type="radio" name="mode" value="mention" ${s.replyMode === "mention" ? "checked" : ""} />只回 @AI</label>
          </div>
          <div class="small muted" style="margin-top:10px">旅伴名單（記帳預設平分對象，用逗號分隔）</div>
          <form class="row" id="travelers-form"><input name="t" value="${escapeHtml(s.travelers || "")}" placeholder="爸爸, 媽媽, 哥哥, 妹妹" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)" /><button class="btn primary-sm">儲存</button></form>
          <button class="btn danger" id="clear-chat" style="margin-top:14px">清除所有聊天紀錄</button>
          <p class="small muted">清除聊天不會刪除行程、記憶與帳目。</p>
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
      b.querySelector("#clear-chat")?.addEventListener("click", () => confirm("確定清除所有人的聊天紀錄？") && action({ action: "clear_chat" }));
      break;
    }
  }
}

checkSession();
