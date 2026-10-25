// dashboard.js -- facility contact cards, Telegram transcript drawer, price quotes.

const $ = (sel) => document.querySelector(sel);

let facilities = [];
let filter = "telegram";
let openId = null;
let chatTimer = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = (s) => String(s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const inr = (n) => (n == null ? "–" : "₹" + Number(n).toLocaleString("en-IN"));
// bot messages are sent as plain text, so strip the markdown markers they contain
const clean = (s) => String(s ?? "").replace(/\*\*/g, "").replace(/`/g, "");
const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const isTelegram = (f) => f.source === "telegram" || f.telegram_chat_id != null;

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function loadFacilities() {
  try {
    const r = await fetch("/api/dashboard/facilities");
    facilities = await r.json();
    render();
  } catch (e) {
    console.error("failed to load facilities", e);
  }
}

function visible() {
  const q = $("#search").value.trim().toLowerCase();
  return facilities.filter((f) => {
    if (filter === "telegram" && !isTelegram(f)) return false;
    if (!q) return true;
    const hay = [f.name, f.id, f.cluster, f.industry, f.phone, f.telegram_username,
      ...(f.outputs || []).map((o) => o.material), ...(f.inputs || []).map((i) => i.material)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function matRow(dir, m) {
  const price = dir === "sells"
    ? `${inr(m.ask_price_inr_per_t)} <span class="card-sub">(floor ${inr(m.floor_price_inr_per_t)})</span>`
    : `${inr(m.target_price_inr_per_t)} <span class="card-sub">(max ${inr(m.ceiling_price_inr_per_t)})</span>`;
  return `<div class="mat"><span><span class="dir">${dir === "sells" ? "▲ sells" : "▼ buys"}</span>${esc(pretty(m.material))} · ${m.qty_t_per_month ?? "?"} t/mo</span><span class="price">${price}</span></div>`;
}

function render() {
  const list = visible();
  const tg = facilities.filter(isTelegram);
  const dayAgo = Date.now() - 86400000;
  $("#stats").innerHTML = [
    ["Telegram registrations", tg.length],
    ["New (24h)", tg.filter((f) => f.registered_at && new Date(f.registered_at).getTime() > dayAgo).length],
    ["With phone", tg.filter((f) => f.phone).length],
    ["Quoted", tg.filter((f) => f.last_quote).length],
    ["All facilities", facilities.length],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");

  $("#empty").hidden = list.length > 0;
  $("#cards").innerHTML = list.map((f) => {
    const isNew = f.registered_at && new Date(f.registered_at).getTime() > dayAgo;
    const mats = [...(f.outputs || []).map((o) => matRow("sells", o)), ...(f.inputs || []).map((i) => matRow("buys", i))];
    return `
      <div class="card" data-id="${esc(f.id)}">
        <div class="card-head">
          <div class="avatar">${esc(initials(f.name))}</div>
          <div>
            <div class="card-title">${esc(f.name || f.id)}</div>
            <div class="card-sub">${esc(f.cluster || "")} · ${esc(pretty(f.industry))}</div>
          </div>
        </div>
        <div class="contact">
          ${f.phone ? `<span class="phone">📞 ${esc(f.phone)}</span>` : `<span class="muted">No phone on file</span>`}
          ${f.telegram_username ? `<span class="muted">@${esc(f.telegram_username)}</span>` : ""}
        </div>
        <div class="tags">
          ${isNew ? `<span class="tag new">NEW</span>` : ""}
          ${f.urgency ? `<span class="tag ${esc(f.urgency)}">${esc(f.urgency)} urgency</span>` : ""}
          <span class="tag">${f.hazard_license ? "hazard licensed" : "no hazard license"}</span>
          ${isTelegram(f) ? `<span class="tag">via Telegram</span>` : ""}
        </div>
        <div class="mats">${mats.join("") || `<div class="card-sub">No materials listed</div>`}</div>
        <div class="card-foot">
          <span>${f.registered_at ? "Registered " + timeAgo(f.registered_at) : esc(f.id)}</span>
          ${f.last_quote ? `<span class="quoted">Quoted ${inr(f.last_quote.amount_inr_per_t)}/t</span>` : `<span>${f.message_count || 0} msgs</span>`}
        </div>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------- Drawer
function openDrawer(id) {
  const f = facilities.find((x) => x.id === id);
  if (!f) return;
  openId = id;
  $("#d-name").textContent = f.name || f.id;
  $("#d-sub").textContent = `${f.id} · ${f.cluster || ""} · ${pretty(f.industry)}`;
  $("#d-meta").innerHTML = `
    <div><span>Phone</span><b class="phone">${esc(f.phone || "–")}</b></div>
    <div><span>Telegram</span>${f.telegram_username ? "@" + esc(f.telegram_username) : esc(f.telegram_chat_id ?? "–")}</div>
    <div><span>Persona</span>${esc(f.persona || "–")}</div>
    <div><span>Location</span>${f.lat != null ? `${Number(f.lat).toFixed(3)}, ${Number(f.lon).toFixed(3)}` : "–"}</div>`;

  const mats = [...(f.outputs || []).map((o) => ["sells", o]), ...(f.inputs || []).map((i) => ["buys", i])];
  $("#q-material").innerHTML = mats.length
    ? mats.map(([d, m]) => `<option value="${esc(m.material)}">${d === "sells" ? "Sells" : "Buys"}: ${esc(pretty(m.material))}</option>`).join("")
    : `<option value="">General offer</option>`;
  $("#q-amount").value = "";
  $("#q-note").value = "";
  setStatus("");
  const canSend = isTelegram(f);
  $("#q-send").disabled = !canSend;
  if (!canSend) setStatus("Not registered via Telegram, so there is no chat to message.", "err");

  $("#drawer").hidden = false;
  $("#drawer-bg").hidden = false;
  $("#chat").innerHTML = `<div class="none">Loading…</div>`;
  loadChat(true);
  clearInterval(chatTimer);
  chatTimer = setInterval(() => loadChat(false), 4000);
}

function closeDrawer() {
  openId = null;
  clearInterval(chatTimer);
  $("#drawer").hidden = true;
  $("#drawer-bg").hidden = true;
}

let lastCount = -1;
async function loadChat(scroll) {
  if (!openId) return;
  const id = openId;
  try {
    const r = await fetch(`/api/dashboard/facilities/${encodeURIComponent(id)}/conversation`);
    const data = await r.json();
    if (id !== openId) return;
    const msgs = data.messages || [];
    if (!scroll && msgs.length === lastCount) return;
    lastCount = msgs.length;
    const chat = $("#chat");
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.innerHTML = msgs.length
      ? msgs.map((m) => {
          const who = m.from === "user" ? "Facility" : m.from === "dashboard" ? "Price offer (dashboard)" : "Bot";
          return `<div class="msg ${esc(m.from)} ${esc(m.kind)}"><div class="who">${who}</div>${esc(clean(m.text))}<time>${new Date(m.ts).toLocaleString()}</time></div>`;
        }).join("")
      : `<div class="none">No conversation recorded for this facility.</div>`;
    if (scroll || atBottom) chat.scrollTop = chat.scrollHeight;
  } catch (e) {
    console.error("failed to load conversation", e);
  }
}

function setStatus(text, cls = "") {
  const el = $("#q-status");
  el.textContent = text;
  el.className = "q-status " + cls;
}

async function sendQuote(ev) {
  ev.preventDefault();
  if (!openId) return;
  const amount = parseFloat($("#q-amount").value);
  if (!(amount > 0)) return setStatus("Enter a positive amount.", "err");
  const btn = $("#q-send");
  btn.disabled = true;
  setStatus("Sending…");
  try {
    const r = await fetch(`/api/dashboard/facilities/${encodeURIComponent(openId)}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_inr_per_t: amount, material: $("#q-material").value || null, note: $("#q-note").value.trim() || null }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || r.statusText);
    setStatus(`Sent ${inr(amount)}/t to the facility on Telegram.`, "ok");
    $("#q-amount").value = "";
    $("#q-note").value = "";
    await loadChat(true);
    loadFacilities();
  } catch (e) {
    setStatus("Failed: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- Wiring
$("#cards").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openDrawer(card.dataset.id);
});
$("#d-close").addEventListener("click", closeDrawer);
$("#drawer-bg").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
$("#quote-form").addEventListener("submit", sendQuote);
$("#search").addEventListener("input", render);
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  filter = b.dataset.filter;
  render();
}));

loadFacilities();
setInterval(loadFacilities, 10000);
