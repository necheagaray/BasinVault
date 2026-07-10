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
  const lines = [];

  // faint graph-paper grid
  for (let x = 0; x <= W; x += 40) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="var(--line)" stroke-width="0.5" opacity="0.35"/>`);
  for (let y = 0; y <= H; y += 40) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="var(--line)" stroke-width="0.5" opacity="0.35"/>`);

  // property boundary (phantom line: long-dash / dot)
  const boundary = `<polygon points="80,80 1500,80 1500,850 600,920 80,850" fill="none" stroke="var(--brass)" stroke-width="1.6" stroke-dasharray="26 6 3 6"/>`;

  // perimeter security fence, inset
  const fence = `<rect x="140" y="140" width="1320" height="650" fill="none" stroke="var(--cyan)" stroke-width="1" stroke-dasharray="2 5" opacity="0.6"/>`;

  // buildings
  function bldg(x, y, w, h, label, opts = {}) {
    const dashed = opts.future ? ` stroke-dasharray="6 4"` : "";
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--brass)" fill-opacity="0.04" stroke="var(--brass-bright)" stroke-width="1.3"${dashed}/>
      <text x="${x + w / 2}" y="${y + h / 2 - 4}" text-anchor="middle" font-family="var(--font-mono)" font-size="13" letter-spacing="1.5" fill="var(--brass-bright)">${label}</text>
      ${opts.sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" letter-spacing="1" fill="var(--text-dim)">${opts.sub}</text>` : ""}
    `;
  }

  const buildings = [
    bldg(200, 200, 380, 220, "DATA HALL 01", { sub: "36,000 SF" }),
    bldg(650, 200, 380, 220, "DATA HALL 02", { sub: "36,000 SF" }),
    bldg(1100, 200, 330, 220, "DATA HALL 03", { sub: "FUTURE PHASE", future: true }),
    bldg(200, 470, 220, 120, "ADMIN / OPS"),
    bldg(470, 470, 140, 100, "SUBSTATION"),
    bldg(650, 470, 260, 100, "GENERATOR YARD"),
  ].join("");

  // generator units inside the yard
  const gens = [];
  for (let i = 0; i < 6; i++) {
    gens.push(`<rect x="${664 + i * 40}" y="500" width="26" height="46" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>`);
  }

  // cooling plant cluster
  const cooling = [];
  const cx0 = 1080, cy0 = 500;
  [[0, 0], [40, 0], [80, 0], [20, 40], [60, 40]].forEach(([dx, dy]) => {
    cooling.push(`<circle cx="${cx0 + dx}" cy="${cy0 + dy}" r="15" fill="none" stroke="var(--cyan)" stroke-width="1.2"/>`);
  });
  cooling.push(`<text x="${cx0 + 40}" y="${cy0 + 78}" text-anchor="middle" font-family="var(--font-mono)" font-size="11" letter-spacing="1" fill="var(--cyan)">COOLING PLANT</text>`);

  // stormwater detention pond
  const pond = `
    <path d="M 150 700 C 130 740, 160 800, 230 810 C 300 820, 340 780, 320 740 C 300 700, 220 690, 150 700 Z"
      fill="var(--cyan)" fill-opacity="0.05" stroke="var(--cyan)" stroke-width="1"/>
    <text x="235" y="756" text-anchor="middle" font-family="var(--font-mono)" font-size="10" letter-spacing="0.5" fill="var(--cyan)">STORMWATER${"\u00A0"}DETENTION</text>
  `;

  // parking grid
  const parking = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 10; col++) {
      parking.push(`<rect x="${960 + col * 24}" y="${640 + row * 46}" width="20" height="40" fill="none" stroke="var(--text-dim)" stroke-width="0.7" opacity="0.7"/>`);
    }
  }
  const parkingLabel = `<text x="1080" y="800" text-anchor="middle" font-family="var(--font-mono)" font-size="11" letter-spacing="1" fill="var(--text-dim)">PARKING</text>`;

  // access road (centerline, dashed) with a loop around the building cluster
  const road = `
    <path d="M 790 920 C 790 860, 790 830, 790 800 L 790 620 C 790 560, 850 540, 950 540 L 1350 540 C 1400 540, 1420 560, 1420 600 L 1420 700"
      fill="none" stroke="var(--brass)" stroke-width="1" stroke-dasharray="10 6" opacity="0.8"/>
    <circle cx="790" cy="900" r="34" fill="none" stroke="var(--brass)" stroke-width="1" stroke-dasharray="10 6" opacity="0.8"/>
  `;

  // underground conduit routing from substation to each hall
  const conduit = `
    <path d="M 540 470 L 540 420 L 390 420 L 390 220" fill="none" stroke="var(--violet)" stroke-width="0.9" stroke-dasharray="3 4" opacity="0.7"/>
    <path d="M 540 470 L 540 420 L 840 420 L 840 220" fill="none" stroke="var(--violet)" stroke-width="0.9" stroke-dasharray="3 4" opacity="0.7"/>
  `;

  // dimension lines
  function dimH(x1, x2, y, label) {
    return `
      <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <line x1="${x1}" y1="${y - 6}" x2="${x1}" y2="${y + 6}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <line x1="${x2}" y1="${y - 6}" x2="${x2}" y2="${y + 6}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-dim)">${label}</text>
    `;
  }
  function dimV(y1, y2, x, label) {
    return `
      <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <line x1="${x - 6}" y1="${y1}" x2="${x + 6}" y2="${y1}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <line x1="${x - 6}" y1="${y2}" x2="${x + 6}" y2="${y2}" stroke="var(--text-dim)" stroke-width="0.8"/>
      <text x="${x - 10}" y="${(y1 + y2) / 2}" text-anchor="end" font-family="var(--font-mono)" font-size="10" fill="var(--text-dim)" transform="rotate(-90 ${x - 10} ${(y1 + y2) / 2})">${label}</text>
    `;
  }
  const dims = dimH(80, 1500, 55, `1,420'-0"`) + dimV(80, 850, 45, `770'-0"`);

  // north arrow
  const north = `
    <g transform="translate(1440,130)">
      <circle r="30" fill="none" stroke="var(--brass)" stroke-width="1"/>
      <path d="M 0,-24 L 8,10 L 0,2 L -8,10 Z" fill="var(--brass-bright)"/>
      <text x="0" y="24" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--brass-bright)">N</text>
    </g>
  `;

  // graphic scale bar
  const scale = `
    <g transform="translate(120,900)">
      <rect x="0" y="0" width="40" height="6" fill="var(--brass)" opacity="0.5"/>
      <rect x="40" y="0" width="40" height="6" fill="none" stroke="var(--brass)" stroke-width="0.8"/>
      <rect x="80" y="0" width="80" height="6" fill="var(--brass)" opacity="0.5"/>
      <text x="0" y="-6" font-family="var(--font-mono)" font-size="9" fill="var(--text-dim)">0</text>
      <text x="76" y="-6" font-family="var(--font-mono)" font-size="9" fill="var(--text-dim)">200</text>
      <text x="152" y="-6" font-family="var(--font-mono)" font-size="9" fill="var(--text-dim)">400 FT</text>
    </g>
  `;

  // title block
  const title = `
    <g transform="translate(1180,870)">
      <rect x="0" y="0" width="320" height="90" fill="var(--bg-panel)" fill-opacity="0.3" stroke="var(--brass)" stroke-width="1"/>
      <line x1="0" y1="26" x2="320" y2="26" stroke="var(--brass)" stroke-width="0.7"/>
      <text x="10" y="18" font-family="var(--font-display)" font-size="13" letter-spacing="1" fill="var(--brass-bright)">BASIN ENGINEERING &amp; SURVEYING</text>
      <text x="10" y="42" font-family="var(--font-mono)" font-size="10" letter-spacing="0.5" fill="var(--text-mid)">MASTER SITE PLAN — DATA CENTER CAMPUS</text>
      <text x="10" y="58" font-family="var(--font-mono)" font-size="9" letter-spacing="0.5" fill="var(--text-dim)">PRELIMINARY — NOT FOR CONSTRUCTION</text>
      <text x="10" y="78" font-family="var(--font-mono)" font-size="9" fill="var(--text-dim)">SCALE 1"=200'   DWG NO. C-100</text>
    </g>
  `;

  return `<svg class="master-plan-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
    ${lines.join("")}
    ${boundary}
    ${fence}
    ${buildings}
    ${gens.join("")}
    ${cooling.join("")}
    ${pond}
    ${parking.join("")}
    ${parkingLabel}
    ${road}
    ${conduit}
    ${dims}
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
