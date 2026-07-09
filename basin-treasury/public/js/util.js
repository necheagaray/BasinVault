export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function fmtMoney(n, { signed = false, cents = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  let out = `$${s}`;
  if (neg) out = `(${out})`;
  else if (signed) out = `+${out}`;
  return out;
}

export function fmtDate(d) {
  if (!d) return "—";
  const dt = typeof d === "string" ? parseISO(d) : d;
  if (!dt || Number.isNaN(dt.getTime())) return "—";
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}

export function fmtDateShort(d) {
  if (!d) return "—";
  const dt = typeof d === "string" ? parseISO(d) : d;
  if (!dt || Number.isNaN(dt.getTime())) return "—";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[dt.getMonth()]} ${dt.getDate()}`;
}

// Parse a YYYY-MM-DD string as a local date (avoids UTC off-by-one).
export function parseISO(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateOrISO, days) {
  const d = typeof dateOrISO === "string" ? parseISO(dateOrISO) : new Date(dateOrISO);
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetween(aISO, bISO) {
  const a = parseISO(aISO);
  const b = parseISO(bISO);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

export function todayISO() {
  return toISO(new Date());
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function toast(msg, type = "info", ms = 3600) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function openModal(html, { onMount } = {}) {
  const host = document.getElementById("modal-host");
  host.innerHTML = `<div class="modal-backdrop" id="__modal_bg"><div class="modal">${html}</div></div>`;
  const bg = document.getElementById("__modal_bg");
  bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
  if (onMount) onMount(host);
  return host;
}

export function closeModal() {
  const host = document.getElementById("modal-host");
  host.innerHTML = "";
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// contour-line watermark SVG generator (signature visual motif)
export function contourSVG(seed = 1, opts = {}) {
  const { w = 900, h = 300 } = opts;
  const rings = [];
  const cx = w * 0.78, cy = h * 0.15;
  for (let i = 0; i < 9; i++) {
    const r = 40 + i * 34 + (seed % 7) * 3;
    const wobble = 10 + (i % 3) * 6;
    rings.push(`<path d="${wobblyCircle(cx, cy, r, wobble, seed + i)}" fill="none" stroke="#c8a35a" stroke-width="1" opacity="${0.55 - i * 0.05}"/>`);
  }
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">${rings.join("")}</svg>`;
}

function wobblyCircle(cx, cy, r, wobble, seed) {
  const pts = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const n = Math.sin(a * 3 + seed) * wobble * 0.5 + Math.cos(a * 5 + seed * 2) * wobble * 0.3;
    const rr = r + n;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}
