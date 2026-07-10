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

// Data-center "master site plan" blueprint — decorative background for Settings.
// Hand-drafted in the style of a civil site plan: property line, building
// footprints, access roads, parking, utilities, dimension lines, north arrow,
// scale bar and a title block, all in thin blueprint linework.
export function masterPlanSVG() {
  const W = 1600, H = 1000;

  // sparse, wide-spaced graph grid — barely-there texture, not a busy grid
  const grid = [];
  for (let x = 0; x <= W; x += 160) grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="var(--brass)" stroke-width="0.5" opacity="0.10"/>`);
  for (let y = 0; y <= H; y += 160) grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="var(--brass)" stroke-width="0.5" opacity="0.10"/>`);

  // property boundary — the single strongest line, traces near the page edges
  // so it reads clearly in the margins even where panels sit on top of it
  const boundary = `<polygon points="60,60 1540,60 1540,880 460,940 60,880" fill="none" stroke="var(--brass)" stroke-width="1.1" stroke-dasharray="22 5 2 5" opacity="0.55"/>`;

  // a handful of restrained building outlines, monochrome, thin hairlines only
  function bldg(x, y, w, h, label, dashed) {
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="var(--brass)" stroke-width="0.9" opacity="0.45"${dashed ? ' stroke-dasharray="5 4"' : ""}/>
      <text x="${x + 10}" y="${y + 18}" font-family="var(--font-mono)" font-size="11" letter-spacing="1.5" fill="var(--brass)" opacity="0.5">${label}</text>
    `;
  }
  const buildings = [
    bldg(140, 140, 330, 190, "DATA HALL 01"),
    bldg(540, 140, 330, 190, "DATA HALL 02"),
    bldg(940, 140, 290, 190, "DATA HALL 03 · FUTURE", true),
  ].join("");

  // one quiet access-road gesture, not a full road network
  const road = `<path d="M 700 800 C 700 720, 700 680, 700 630 L 700 500 C 700 460, 740 440, 800 440 L 1250 440"
    fill="none" stroke="var(--brass)" stroke-width="0.9" stroke-dasharray="9 6" opacity="0.4"/>`;

  // one dimension line — a signature detail, not a full dimensioning set
  const dim = `
    <line x1="140" y1="105" x2="1270" y2="105" stroke="var(--brass)" stroke-width="0.7" opacity="0.4"/>
    <line x1="140" y1="99" x2="140" y2="111" stroke="var(--brass)" stroke-width="0.7" opacity="0.4"/>
    <line x1="1270" y1="99" x2="1270" y2="111" stroke="var(--brass)" stroke-width="0.7" opacity="0.4"/>
    <text x="705" y="94" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--brass)" opacity="0.45">1,130'-0"</text>
  `;

  // north arrow — small, quiet
  const north = `
    <g transform="translate(1460,110)" opacity="0.5">
      <circle r="22" fill="none" stroke="var(--brass)" stroke-width="0.8"/>
      <path d="M 0,-17 L 6,7 L 0,1 L -6,7 Z" fill="var(--brass)"/>
      <text x="0" y="18" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--brass)">N</text>
    </g>
  `;

  // graphic scale
  const scale = `
    <g transform="translate(90,910)" opacity="0.45">
      <rect x="0" y="0" width="36" height="4" fill="var(--brass)"/>
      <rect x="36" y="0" width="36" height="4" fill="none" stroke="var(--brass)" stroke-width="0.7"/>
      <text x="0" y="-5" font-family="var(--font-mono)" font-size="8" fill="var(--brass)">0</text>
      <text x="66" y="-5" font-family="var(--font-mono)" font-size="8" fill="var(--brass)">400 FT</text>
    </g>
  `;

  // title block — the one place we let it read clearly, tucked in a corner
  const title = `
    <g transform="translate(1180,920)" opacity="0.55">
      <line x1="0" y1="0" x2="300" y2="0" stroke="var(--brass)" stroke-width="0.7"/>
      <text x="0" y="-24" font-family="var(--font-display)" font-size="12" letter-spacing="1" fill="var(--brass)">BASIN ENGINEERING &amp; SURVEYING</text>
      <text x="0" y="-8" font-family="var(--font-mono)" font-size="8.5" letter-spacing="0.5" fill="var(--brass)">MASTER SITE PLAN — DATA CENTER CAMPUS — DWG C-100</text>
    </g>
  `;

  return `<svg class="master-plan-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
    ${grid.join("")}
    ${boundary}
    ${buildings}
    ${road}
    ${dim}
    ${north}
    ${scale}
    ${title}
  </svg>`;
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
