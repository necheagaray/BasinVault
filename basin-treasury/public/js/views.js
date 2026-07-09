import { fmtMoney, fmtDate, fmtDateShort, escapeHtml, toast, openModal, closeModal, uid, todayISO, toISO, addDays, parseISO } from "./util.js";
import {
  periodWeeks, computeForecast, weekIndexForDate, fixedOccurrencesInPeriod, scheduleLabel,
  FIXED_CATEGORY_ORDER, makePeriod, mergeAgingImport, applyAutoScheduleToAll, applyAutoScheduleToGroup, readOv,
} from "./state.js";
import { parseAgingReport } from "./parser.js";

/* ============================================================ helpers ============================================================ */

function editableCell(td, value, onCommit, { allowNegativeAsIs = false } = {}) {
  td.classList.add("cell-editable");
  td.title = "Click to override this week's amount";
  td.addEventListener("click", () => {
    if (td.querySelector("input")) return;
    const raw = value ?? 0;
    td.innerHTML = `<input class="cell-input mono" type="number" step="1" value="${raw}" />`;
    const input = td.querySelector("input");
    input.focus();
    input.select();
    const commit = () => {
      const v = input.value.trim();
      onCommit(v === "" ? null : parseFloat(v));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = raw; input.blur(); }
    });
    input.addEventListener("blur", commit, { once: true });
  });
}

function weekHeaderCells(weeks) {
  return weeks.map((w) => `<th>${fmtDateShort(w.start)} – ${fmtDateShort(w.end)}<span class="wk-range">Pay run ${fmtDate(w.payRun)}</span></th>`).join("");
}

/* ============================================================ CF FORECAST ============================================================ */

export function renderForecast(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const calc = computeForecast(state, period);
  const weeks = calc.weeks;

  document.getElementById("forecast-title").textContent = period.label;
  document.getElementById("forecast-eyebrow").textContent = `5-Week Cash Flow Forecast · Starts ${fmtDate(period.startDate)}`;
  document.getElementById("forecast-meta").textContent = `Pay runs: ${periodWeeks(period).map((w) => fmtDate(w.payRun)).join(", ")}`;

  const sel = document.getElementById("period-select");
  sel.innerHTML = state.periods.map((p) => `<option value="${p.id}" ${p.id === period.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("");
  sel.onchange = () => { state.activePeriodId = sel.value; store.render(); };

  const statRow = document.getElementById("forecast-stats");
  const netTotal = calc.totals.netCashflow;
  statRow.innerHTML = `
    <div class="stat-card"><div class="label">Opening Cash</div><div class="value">${fmtMoney(calc.totals.opening)}</div></div>
    <div class="stat-card"><div class="label">Total Inflows</div><div class="value green">${fmtMoney(calc.totals.totalInflows)}</div></div>
    <div class="stat-card"><div class="label">Total Outflows</div><div class="value red">${fmtMoney(calc.totals.totalOutflows)}</div></div>
    <div class="stat-card"><div class="label">Net Cash Flow</div><div class="value ${netTotal >= 0 ? "green" : "red"}">${fmtMoney(netTotal)}</div></div>
    <div class="stat-card"><div class="label">Closing Cash</div><div class="value brass">${fmtMoney(calc.totals.closing)}</div></div>
  `;

  const table = document.getElementById("cf-grid");
  table.innerHTML = `
    <thead><tr><th>Line Item</th>${weekHeaderCells(periodWeeks(period))}<th>Total</th></tr></thead>
    <tbody>
      <tr class="section-label"><td colspan="${weeks.length + 2}">Opening Balance</td></tr>
      <tr class="opening" data-row="opening"><td>Opening Cash</td>${weeks.map((r) => `<td>${fmtMoney(r.opening)}</td>`).join("")}<td>${fmtMoney(calc.totals.opening)}</td></tr>

      <tr class="section-label"><td colspan="${weeks.length + 2}">Cash Inflow</td></tr>
      <tr class="inflow-row" data-row="receivablesCollected"><td>Receivables Collected</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.receivablesCollected)}</td>`).join("")}<td>${fmtMoney(calc.totals.receivablesCollected)}</td></tr>
      <tr class="inflow-row" data-row="otherInflows"><td>Other Inflows</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.otherInflows)}</td>`).join("")}<td>${fmtMoney(calc.totals.otherInflows)}</td></tr>
      <tr class="inflow-total"><td>Total Inflows</td>${weeks.map((r) => `<td class="value-pos">${fmtMoney(r.totalInflows)}</td>`).join("")}<td class="value-pos">${fmtMoney(calc.totals.totalInflows)}</td></tr>

      <tr class="section-label"><td colspan="${weeks.length + 2}">Cash Outflow — Manual</td></tr>
      ${state.manualOutflowCategories.map((cat) => `
        <tr class="outflow-row" data-row="manual" data-cat="${escapeHtml(cat)}"><td>${escapeHtml(cat)}</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.manualOutflows[cat])}</td>`).join("")}<td>${fmtMoney(calc.totals.manualOutflows[cat])}</td></tr>
      `).join("")}

      <tr class="section-label"><td colspan="${weeks.length + 2}">Cash Outflow — Fixed / Scheduled</td></tr>
      ${calc.fixedCategories.map((cat) => `
        <tr class="fixed-row" data-row="fixed" data-cat="${escapeHtml(cat)}"><td>${escapeHtml(cat)}</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.fixedRows[cat])}</td>`).join("")}<td>${fmtMoney(calc.totals.fixedRows[cat])}</td></tr>
      `).join("")}
      <tr class="fixed-row" data-row="apPayables"><td>◆ Weekly AP Payables</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.apPayables)}</td>`).join("")}<td>${fmtMoney(calc.totals.apPayables)}</td></tr>

      <tr class="outflow-total"><td>Total Outflows</td>${weeks.map((r) => `<td class="value-neg">${fmtMoney(r.totalOutflows)}</td>`).join("")}<td class="value-neg">${fmtMoney(calc.totals.totalOutflows)}</td></tr>

      <tr class="net"><td>Net Cashflow</td>${weeks.map((r) => `<td class="${r.netCashflow >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(r.netCashflow)}</td>`).join("")}<td class="${calc.totals.netCashflow >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(calc.totals.netCashflow)}</td></tr>

      <tr data-row="locDraw"><td>LOC Draw / (Repayment)</td>${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.locDraw)}</td>`).join("")}<td>${fmtMoney(calc.totals.locDraw)}</td></tr>

      <tr class="section-label"><td colspan="${weeks.length + 2}">Closing Balance</td></tr>
      <tr class="closing"><td>Closing Cash</td>${weeks.map((r) => `<td>${fmtMoney(r.closing)}</td>`).join("")}<td>${fmtMoney(calc.totals.closing)}</td></tr>
    </tbody>
  `;

  // wire up editable cells + mark overridden + show who-badge
  table.querySelectorAll("tr[data-row] td.ed").forEach((td) => {
    const tr = td.closest("tr");
    const rowType = tr.dataset.row;
    const wi = Number(td.dataset.wi);
    const cat = tr.dataset.cat;
    const ov = period.overrides;

    let entry;
    if (rowType === "receivablesCollected") entry = ov.receivablesCollected[wi];
    if (rowType === "otherInflows") entry = ov.otherInflows[wi];
    if (rowType === "manual") entry = ov.manualOutflow?.[cat]?.[wi];
    if (rowType === "fixed") entry = ov.fixedGroup?.[cat]?.[wi];
    if (rowType === "apPayables") entry = ov.apPayables[wi];
    if (rowType === "locDraw") entry = ov.locDraw[wi];

    const hasOverride = entry !== undefined;
    const who = hasOverride && typeof entry === "object" ? entry.by : null;
    const currentVal = {
      receivablesCollected: weeks[wi].receivablesCollected,
      otherInflows: weeks[wi].otherInflows,
      manual: weeks[wi].manualOutflows[cat],
      fixed: weeks[wi].fixedRows[cat],
      apPayables: weeks[wi].apPayables,
      locDraw: weeks[wi].locDraw,
    }[rowType];

    if (hasOverride) {
      td.classList.add("overridden");
      if (who) td.insertAdjacentHTML("beforeend", `<span class="who-badge" title="Overridden by ${escapeHtml(who)}">${escapeHtml(who)}</span>`);
    }

    editableCell(td, currentVal, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const o = per.overrides;
        const stamped = val === null ? null : { v: val, by: store.initials(), at: new Date().toISOString() };
        if (rowType === "receivablesCollected") setOrDel(o.receivablesCollected, wi, stamped);
        if (rowType === "otherInflows") setOrDel(o.otherInflows, wi, stamped);
        if (rowType === "manual") { o.manualOutflow[cat] = o.manualOutflow[cat] || {}; setOrDel(o.manualOutflow[cat], wi, stamped); }
        if (rowType === "fixed") { o.fixedGroup[cat] = o.fixedGroup[cat] || {}; setOrDel(o.fixedGroup[cat], wi, stamped); }
        if (rowType === "apPayables") setOrDel(o.apPayables, wi, stamped);
        if (rowType === "locDraw") setOrDel(o.locDraw, wi, stamped);
      });
    });
  });
}

function setOrDel(obj, key, val) {
  if (val === null) delete obj[key];
  else obj[key] = val;
}

/* ============================================================ RECEIVABLES ============================================================ */

let arFilter = "open", arSearch = "";

export function renderReceivables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period);

  const openList = state.receivables.filter((r) => r.status === "open");
  const totalAR = state.receivables.reduce((a, r) => a + r.balance, 0);
  const openAR = openList.reduce((a, r) => a + r.balance, 0);
  const today = todayISO();
  const overdue = openList.filter((r) => r.dueDate && r.dueDate < today).reduce((a, r) => a + r.balance, 0);

  document.getElementById("ar-meta").textContent = `${state.receivables.length} invoices · ${openList.length} open`;
  document.getElementById("ar-stats").innerHTML = `
    <div class="stat-card"><div class="label">Total AR</div><div class="value">${fmtMoney(totalAR)}</div></div>
    <div class="stat-card"><div class="label">Open / Uncollected</div><div class="value">${fmtMoney(openAR)}</div></div>
    <div class="stat-card"><div class="label">Past Due</div><div class="value red">${fmtMoney(overdue)}</div></div>
    <div class="stat-card"><div class="label">Scheduled This Period</div><div class="value green">${fmtMoney(weeks.reduce((a, w) => a + openList.filter((r) => weekIndexForDate(period, r.cfDate) === w.index).reduce((s, r) => s + r.balance, 0), 0))}</div></div>
  `;

  const collectRow = document.getElementById("ar-collect-row");
  collectRow.innerHTML = weeks.map((w) => {
    const total = openList.filter((r) => weekIndexForDate(period, r.cfDate) === w.index).reduce((a, r) => a + r.balance, 0);
    const isCurrent = w.index === 0;
    return `<div class="collect-card ${isCurrent ? "current" : ""}">
      <div class="wk">${fmtDateShort(w.start)} – ${fmtDateShort(w.end)}</div>
      <div class="dt">${fmtDate(w.start)}</div>
      <div class="amt">${fmtMoney(total)}</div>
      <div class="tag">${isCurrent ? "Current Week" : "Scheduled"}</div>
    </div>`;
  }).join("");

  document.querySelectorAll("#ar-status-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.f === arFilter);
    b.onclick = () => { arFilter = b.dataset.f; store.render(); };
  });
  document.getElementById("ar-search").value = arSearch;
  document.getElementById("ar-search").oninput = (e) => { arSearch = e.target.value.toLowerCase(); renderARRows(store, period); };

  document.getElementById("ar-import-btn").onclick = () => document.getElementById("file-input-ar").click();
  document.getElementById("ar-add-btn").onclick = () => openManualInvoiceModal(store, "AR");

  renderARRows(store, period);
}

function renderARRows(store, period) {
  const { state } = store;
  let list = state.receivables;
  if (arFilter === "open") list = list.filter((r) => r.status === "open");
  if (arFilter === "paid") list = list.filter((r) => r.status === "paid");
  if (arSearch) list = list.filter((r) => `${r.customer} ${r.docNumber} ${r.poNumber || ""}`.toLowerCase().includes(arSearch));
  list = list.slice().sort((a, b) => (a.customer || "").localeCompare(b.customer || "") || (a.date || "").localeCompare(b.date || ""));

  document.getElementById("ar-count").textContent = `${list.length} rows`;
  const tbody = document.getElementById("ar-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><h4>No invoices here</h4>Import your Aged AR export or add one manually.</div></td></tr>`; return; }
  const today = todayISO();

  tbody.innerHTML = list.map((r) => {
    const overdue = r.status === "open" && r.dueDate && r.dueDate < today;
    const days = r.date ? Math.round((parseISO(r.cfDate || r.date) - parseISO(r.date)) / 86400000) : "";
    const whoBadge = r.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(r.lastEditBy)}">${escapeHtml(r.lastEditBy)}</span>` : "";
    return `<tr class="${r.status === "paid" ? "paid" : ""}" data-id="${r.id}">
      <td class="name">${escapeHtml(r.customer)}</td>
      <td>${escapeHtml(r.txnType || "")}</td>
      <td class="mono">${escapeHtml(r.docNumber || "")}</td>
      <td class="mono">${fmtDate(r.date)}</td>
      <td class="mono">${escapeHtml(r.poNumber || "—")}</td>
      <td><input class="mini-input days-input" type="number" value="${r.daysOverride ?? days}" ${r.status !== "open" ? "disabled" : ""}/></td>
      <td class="mono cf-date">${r.cfDate ? fmtDate(r.cfDate) : "—"}${whoBadge}</td>
      <td class="mono">${r.age ?? "—"}${r.age ? "d" : ""}</td>
      <td class="num">${fmtMoney(r.balance)}</td>
      <td><span class="badge ${overdue ? "overdue" : r.status}">${overdue ? "past due" : r.status}</span></td>
      <td>
        <button class="mini-btn toggle-status">${r.status === "open" ? "Mark Paid" : "Reopen"}</button>
        <button class="mini-btn del-row" style="margin-left:4px;">✕</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const rec = state.receivables.find((x) => x.id === id);
    if (!rec) return;

    tr.querySelector(".days-input")?.addEventListener("change", (e) => {
      const days = e.target.value === "" ? null : Number(e.target.value);
      store.mutate((s) => {
        const item = s.receivables.find((x) => x.id === id);
        item.daysOverride = days;
        item.cfDate = days === null ? item.cfDate : toISO(addDays(item.date, days));
        item.lastEditBy = store.initials();
      });
    });
    tr.querySelector(".toggle-status")?.addEventListener("click", () => {
      store.mutate((s) => {
        const item = s.receivables.find((x) => x.id === id);
        item.status = item.status === "open" ? "paid" : "open";
        item.lastEditBy = store.initials();
      });
    });
    tr.querySelector(".del-row")?.addEventListener("click", () => {
      if (!confirm(`Remove invoice ${rec.docNumber || ""} for ${rec.customer}?`)) return;
      store.mutate((s) => { s.receivables = s.receivables.filter((x) => x.id !== id); });
    });
    tr.querySelector(".cf-date")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "date"; input.className = "mini-input"; input.style.width = "128px";
      input.value = rec.cfDate || "";
      const td = tr.querySelector(".cf-date");
      td.innerHTML = ""; td.appendChild(input); input.focus();
      input.addEventListener("blur", () => {
        store.mutate((s) => {
          const item = s.receivables.find((x) => x.id === id);
          item.cfDate = input.value || null;
          item.lastEditBy = store.initials();
        });
      }, { once: true });
    });
  });
}

/* ============================================================ PAYABLES ============================================================ */

let apFilter = "open", apSearch = "";

export function renderPayables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period);

  const openList = state.payables.filter((p) => p.status === "open");
  const totalAP = openList.reduce((a, p) => a + p.balance, 0);
  const scheduled = openList.filter((p) => p.cfDate).reduce((a, p) => a + p.balance, 0);
  const unscheduled = totalAP - scheduled;

  document.getElementById("ap-meta").textContent = `${openList.length} open · ${openList.filter((p) => !p.cfDate).length} unscheduled`;
  document.getElementById("ap-stats").innerHTML = `
    <div class="stat-card"><div class="label">Open AP</div><div class="value">${fmtMoney(totalAP)}</div></div>
    <div class="stat-card"><div class="label">Scheduled</div><div class="value green">${fmtMoney(scheduled)}</div></div>
    <div class="stat-card"><div class="label">Unscheduled</div><div class="value red">${fmtMoney(unscheduled)}</div></div>
  `;

  document.querySelectorAll("#ap-status-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.f === apFilter);
    b.onclick = () => { apFilter = b.dataset.f; store.render(); };
  });
  document.getElementById("ap-search").value = apSearch;
  document.getElementById("ap-search").oninput = (e) => { apSearch = e.target.value.toLowerCase(); renderAPRows(store, period); };
  document.getElementById("ap-import-btn").onclick = () => document.getElementById("file-input-ap").click();
  document.getElementById("ap-add-btn").onclick = () => openManualInvoiceModal(store, "AP");

  // pay run totals
  const payrunHost = document.getElementById("ap-payrun-totals");
  payrunHost.innerHTML = weeks.map((w) => {
    const total = openList.filter((p) => weekIndexForDate(period, p.cfDate) === w.index).reduce((a, p) => a + p.balance, 0);
    const count = openList.filter((p) => weekIndexForDate(period, p.cfDate) === w.index).length;
    return `<div class="vendor-rank"><span>${fmtDate(w.payRun)} <span style="color:var(--text-dim)">(${count})</span></span><span class="amt">${fmtMoney(total)}</span></div>`;
  }).join("");

  // top vendor balances
  const byVendor = {};
  for (const p of openList) byVendor[p.vendor] = (byVendor[p.vendor] || 0) + p.balance;
  const ranked = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 8);
  document.getElementById("ap-vendor-rank").innerHTML = ranked.map(([v, amt], i) => `
    <div class="vendor-rank"><span><span class="n">${i + 1}</span>${escapeHtml(v)}</span><span class="amt">${fmtMoney(amt)}</span></div>
  `).join("") || `<div class="meta">No open payables yet.</div>`;

  renderAPRows(store, period);
}

function renderAPRows(store, period) {
  const { state } = store;
  const weeks = periodWeeks(period);
  let list = state.payables;
  if (apFilter === "open") list = list.filter((p) => p.status === "open");
  if (apFilter === "scheduled") list = list.filter((p) => p.status === "open" && p.cfDate);
  if (apFilter === "unscheduled") list = list.filter((p) => p.status === "open" && !p.cfDate);
  if (apSearch) list = list.filter((p) => `${p.vendor} ${p.docNumber}`.toLowerCase().includes(apSearch));
  list = list.slice().sort((a, b) => (a.vendor || "").localeCompare(b.vendor || "") || (a.date || "").localeCompare(b.date || ""));

  document.getElementById("ap-count").textContent = `${list.length} rows`;
  const tbody = document.getElementById("ap-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h4>No bills here</h4>Import your Aged AP export or add one manually.</div></td></tr>`; return; }

  tbody.innerHTML = list.map((p) => {
    const overdue = p.status === "open" && p.dueDate && p.dueDate < todayISO();
    const whoBadge = p.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(p.lastEditBy)}">${escapeHtml(p.lastEditBy)}</span>` : "";
    return `<tr class="${p.status === "paid" ? "paid" : ""}" data-id="${p.id}">
      <td class="name">${escapeHtml(p.vendor)}</td>
      <td class="mono">${escapeHtml(p.docNumber || "")}</td>
      <td class="mono">${fmtDate(p.date)}</td>
      <td class="mono">${fmtDate(p.dueDate)}</td>
      <td class="num">${fmtMoney(p.balance)}</td>
      <td>
        <select class="mini-select payrun-select">
          <option value="">— unscheduled —</option>
          ${weeks.map((w) => `<option value="${w.payRun}" ${p.cfDate === w.payRun ? "selected" : ""}>${fmtDate(w.payRun)}</option>`).join("")}
        </select>${whoBadge}
      </td>
      <td><span class="badge ${overdue ? "overdue" : p.status}">${overdue ? "past due" : p.status}</span></td>
      <td>
        <button class="mini-btn toggle-status">${p.status === "open" ? "Mark Paid" : "Reopen"}</button>
        <button class="mini-btn del-row" style="margin-left:4px;">✕</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector(".payrun-select")?.addEventListener("change", (e) => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.cfDate = e.target.value || null;
        item.lastEditBy = store.initials();
      });
    });
    tr.querySelector(".toggle-status")?.addEventListener("click", () => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.status = item.status === "open" ? "paid" : "open";
        item.lastEditBy = store.initials();
      });
    });
    tr.querySelector(".del-row")?.addEventListener("click", () => {
      const rec = state.payables.find((x) => x.id === id);
      if (!confirm(`Remove bill ${rec.docNumber || ""} for ${rec.vendor}?`)) return;
      store.mutate((s) => { s.payables = s.payables.filter((x) => x.id !== id); });
    });
  });
}

/* ============================================================ FIXED PAYMENTS ============================================================ */

export function renderFixed(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const categories = Array.from(new Set([...FIXED_CATEGORY_ORDER, ...state.fixedPayments.map((f) => f.category)]));

  let periodTotal = 0;
  const host = document.getElementById("fixed-groups");
  host.innerHTML = categories.map((cat) => {
    const items = state.fixedPayments.filter((f) => f.category === cat);
    if (!items.length) return "";
    let groupTotal = 0;
    const rows = items.map((item) => {
      const occ = item.active === false ? [] : fixedOccurrencesInPeriod(item, period);
      const total = occ.length * item.amount;
      groupTotal += total;
      const whoBadge = item.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(item.lastEditBy)}">${escapeHtml(item.lastEditBy)}</span>` : "";
      return `<div class="fixed-item" data-id="${item.id}">
        <input type="checkbox" class="active-toggle" ${item.active !== false ? "checked" : ""} />
        <div>
          <div class="fname">${escapeHtml(item.name)}${whoBadge}</div>
          <div class="fsched">${scheduleLabel(item)} ${occ.length ? `· ${occ.length}x this period: ${occ.map(fmtDateShort).join(" · ")}` : "· none this period"}${item.endDate ? ` · ends ${fmtDate(item.endDate)}` : ""}</div>
        </div>
        <div class="famt">${fmtMoney(total)}<div class="fsched">${fmtMoney(item.amount)} each</div></div>
        <div class="factions">
          <button class="mini-btn edit-fixed">Edit</button>
          <button class="mini-btn del-fixed">✕</button>
        </div>
      </div>`;
    }).join("");
    periodTotal += groupTotal;
    return `<div class="panel fixed-group">
      <div class="fixed-group-head">
        <h3>${escapeHtml(cat)}<span class="count">${items.length} active · ${fmtMoney(groupTotal)} this period</span></h3>
        <button class="btn-ghost add-fixed" data-cat="${escapeHtml(cat)}">+ Add</button>
      </div>
      ${rows}
    </div>`;
  }).join("") + `<div class="panel fixed-group"><div class="fixed-group-head"><h3>New Category</h3>
      <button class="btn-ghost" id="add-fixed-new-cat">+ Add Item In New Category</button></div></div>`;

  document.getElementById("fixed-period-total").textContent = fmtMoney(periodTotal);

  host.querySelectorAll(".add-fixed").forEach((b) => b.addEventListener("click", () => openFixedModal(store, { category: b.dataset.cat })));
  document.getElementById("add-fixed-new-cat").addEventListener("click", () => openFixedModal(store, {}));
  host.querySelectorAll(".active-toggle").forEach((cb) => cb.addEventListener("change", (e) => {
    const id = e.target.closest(".fixed-item").dataset.id;
    store.mutate((s) => {
      const item = s.fixedPayments.find((f) => f.id === id);
      item.active = e.target.checked;
      item.lastEditBy = store.initials();
    });
  }));
  host.querySelectorAll(".edit-fixed").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest(".fixed-item").dataset.id;
    openFixedModal(store, state.fixedPayments.find((f) => f.id === id));
  }));
  host.querySelectorAll(".del-fixed").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest(".fixed-item").dataset.id;
    const item = state.fixedPayments.find((f) => f.id === id);
    if (!confirm(`Remove "${item.name}"?`)) return;
    store.mutate((s) => { s.fixedPayments = s.fixedPayments.filter((f) => f.id !== id); });
  }));
}

function openFixedModal(store, existing) {
  const isEdit = !!existing.id;
  openModal(`
    <h3>${isEdit ? "Edit" : "Add"} Fixed Payment</h3>
    <div class="row"><label>Category</label><input id="f-cat" value="${escapeHtml(existing.category || "")}" placeholder="e.g. Insurance" /></div>
    <div class="row"><label>Name</label><input id="f-name" value="${escapeHtml(existing.name || "")}" placeholder="e.g. State Farm" /></div>
    <div class="row"><label>Amount</label><input id="f-amt" type="number" value="${existing.amount ?? ""}" /></div>
    <div class="row"><label>Schedule</label>
      <select id="f-sched">
        <option value="monthly" ${(!existing.scheduleType || existing.scheduleType === "monthly") ? "selected" : ""}>Monthly (day of month)</option>
        <option value="weekly" ${existing.scheduleType === "weekly" ? "selected" : ""}>Weekly (day of week)</option>
      </select>
    </div>
    <div class="row" id="f-dom-row"><label>Day of Month</label><input id="f-dom" type="number" min="1" max="31" value="${existing.dayOfMonth || 1}" /></div>
    <div class="row" id="f-dow-row" style="display:none;"><label>Weekday</label>
      <select id="f-dow">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d,i)=>`<option value="${i}" ${(existing.weekday ?? 4) === i ? "selected" : ""}>${d}</option>`).join("")}</select>
    </div>
    <div class="row"><label>End Date (optional)</label><input id="f-end" type="date" value="${existing.endDate || ""}" /></div>
    <div class="modal-actions">
      ${isEdit ? `<button class="btn-ghost" id="f-del">Delete</button>` : ""}
      <button class="btn-ghost" id="f-cancel">Cancel</button>
      <button class="btn-primary" id="f-save" style="width:auto;">Save</button>
    </div>
  `, {
    onMount: (host) => {
      const schedSel = host.querySelector("#f-sched");
      const domRow = host.querySelector("#f-dom-row"), dowRow = host.querySelector("#f-dow-row");
      const sync = () => { domRow.style.display = schedSel.value === "monthly" ? "" : "none"; dowRow.style.display = schedSel.value === "weekly" ? "" : "none"; };
      schedSel.addEventListener("change", sync); sync();
      host.querySelector("#f-cancel").onclick = closeModal;
      host.querySelector("#f-del")?.addEventListener("click", () => {
        if (!confirm("Delete this fixed payment?")) return;
        store.mutate((s) => { s.fixedPayments = s.fixedPayments.filter((f) => f.id !== existing.id); });
        closeModal();
      });
      host.querySelector("#f-save").onclick = () => {
        const cat = host.querySelector("#f-cat").value.trim();
        const name = host.querySelector("#f-name").value.trim();
        const amount = parseFloat(host.querySelector("#f-amt").value || "0");
        if (!cat || !name) { toast("Category and name are required", "error"); return; }
        const payload = {
          category: cat, name, amount,
          scheduleType: schedSel.value,
          dayOfMonth: Number(host.querySelector("#f-dom").value || 1),
          weekday: Number(host.querySelector("#f-dow").value || 4),
          endDate: host.querySelector("#f-end").value || null,
          active: existing.active !== false,
        };
        store.mutate((s) => {
          if (isEdit) Object.assign(s.fixedPayments.find((f) => f.id === existing.id), payload, { lastEditBy: store.initials() });
          else s.fixedPayments.push({ id: uid("fx"), ...payload, lastEditBy: store.initials() });
        });
        closeModal();
      };
    },
  });
}

/* ============================================================ SETTINGS ============================================================ */

export function renderSettings(store) {
  const { state } = store;

  document.getElementById("sync-status-detail").textContent = state.updatedAt
    ? `Last synced ${new Date(state.updatedAt).toLocaleString()} · by ${state.updatedBy || "—"} · version ${state.version}`
    : "Not yet synced";
  document.getElementById("btn-push-now").onclick = () => store.pushNow();
  document.getElementById("btn-pull-now").onclick = () => store.pullNow();

  // periods
  const periodsHost = document.getElementById("periods-list");
  periodsHost.innerHTML = state.periods.slice().reverse().map((p) => {
    const weeks = periodWeeks(p);
    const active = p.id === state.activePeriodId;
    return `<div class="period-row ${active ? "active" : ""}" data-id="${p.id}">
      <div>
        <div class="pname">${escapeHtml(p.label)} ${active ? '<span class="tag-active">Active — all users see this</span>' : ""}</div>
        <div class="pmeta">Starts ${fmtDate(p.startDate)} · Pay runs: ${weeks.map((w) => fmtDate(w.payRun)).join(", ")}</div>
      </div>
      <div style="display:flex; gap:8px;">
        ${active ? "" : `<button class="btn-ghost set-active">Set Active for All</button>`}
        <button class="btn-ghost rename-period">Rename</button>
        <button class="btn-ghost del-period">Delete</button>
      </div>
    </div>`;
  }).join("");
  periodsHost.querySelectorAll(".period-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".set-active")?.addEventListener("click", () => store.mutate((s) => { s.activePeriodId = id; }));
    row.querySelector(".rename-period")?.addEventListener("click", () => {
      const p = state.periods.find((x) => x.id === id);
      const name = prompt("Period label", p.label);
      if (name) store.mutate((s) => { s.periods.find((x) => x.id === id).label = name; });
    });
    row.querySelector(".del-period")?.addEventListener("click", () => {
      if (state.periods.length <= 1) { toast("You need at least one period", "error"); return; }
      if (!confirm("Delete this period? This cannot be undone.")) return;
      store.mutate((s) => {
        s.periods = s.periods.filter((x) => x.id !== id);
        if (s.activePeriodId === id) s.activePeriodId = s.periods[s.periods.length - 1].id;
      });
    });
  });
  document.getElementById("btn-new-period").onclick = () => openNewPeriodModal(store);

  // history
  renderHistory(store);

  // outflow categories
  const catHost = document.getElementById("outflow-categories");
  catHost.innerHTML = state.manualOutflowCategories.map((c) => `
    <div class="period-row"><div class="pname">${escapeHtml(c)}</div><button class="btn-ghost del-cat" data-c="${escapeHtml(c)}">Remove</button></div>
  `).join("");
  catHost.querySelectorAll(".del-cat").forEach((b) => b.addEventListener("click", () => {
    store.mutate((s) => { s.manualOutflowCategories = s.manualOutflowCategories.filter((c) => c !== b.dataset.c); });
  }));
  document.getElementById("btn-add-category").onclick = () => {
    const name = prompt("New outflow category name");
    if (name) store.mutate((s) => { if (!s.manualOutflowCategories.includes(name)) s.manualOutflowCategories.push(name); });
  };

  renderAutoScheduleTable(store, "AR", document.getElementById("ar-auto-list"));
  renderAutoScheduleTable(store, "AP", document.getElementById("ap-auto-list"));
  document.getElementById("ar-auto-search").oninput = (e) => renderAutoScheduleTable(store, "AR", document.getElementById("ar-auto-list"), e.target.value.toLowerCase());
  document.getElementById("ap-auto-search").oninput = (e) => renderAutoScheduleTable(store, "AP", document.getElementById("ap-auto-list"), e.target.value.toLowerCase());
}

function renderHistory(store) {
  const host = document.getElementById("history-list");
  if (!store.historyCache) { host.innerHTML = `<div class="meta">Loading…</div>`; store.loadHistory(); return; }
  const list = store.historyCache;
  if (!list.length) { host.innerHTML = `<div class="meta">No saved versions yet.</div>`; return; }
  host.innerHTML = list.slice(0, 15).map((h) => `
    <div class="period-row"><div>
      <div class="pname">Version ${h.version}</div>
      <div class="pmeta">${new Date(h.savedAt).toLocaleString()} · by ${h.savedBy}</div>
    </div><button class="btn-ghost restore-snap" data-key="${h.key}">Restore</button></div>
  `).join("");
  host.querySelectorAll(".restore-snap").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Restore this version? Your current data will be overwritten and pushed to both users.")) return;
    await store.restoreSnapshot(b.dataset.key);
  }));
}

function renderAutoScheduleTable(store, kind, host, search = "") {
  const { state } = store;
  const schedKey = kind === "AR" ? "customerAutoSchedule" : "vendorAutoSchedule";
  const names = Object.keys(state[schedKey]).filter((n) => n.toLowerCase().includes(search)).sort();
  if (!names.length) { host.innerHTML = `<div class="meta" style="padding:14px;">Import ${kind === "AR" ? "receivables" : "payables"} to populate this list.</div>`; return; }
  host.innerHTML = names.map((name) => {
    const t = state[schedKey][name];
    return `<div class="auto-row" data-name="${escapeHtml(name)}">
      <span>${escapeHtml(name)}</span>
      <input class="mini-input days-in" type="number" value="${t.days}" />
      <span class="toggle ${t.auto ? "on" : ""}"><span class="dot"></span></span>
      <button class="mini-btn apply-now">Apply</button>
    </div>`;
  }).join("");
  host.querySelectorAll(".auto-row").forEach((row) => {
    const name = row.dataset.name;
    row.querySelector(".days-in").addEventListener("change", (e) => {
      store.mutate((s) => { s[schedKey][name].days = Number(e.target.value || 0); });
    });
    row.querySelector(".toggle").addEventListener("click", () => {
      store.mutate((s) => { s[schedKey][name].auto = !s[schedKey][name].auto; });
    });
    row.querySelector(".apply-now").addEventListener("click", () => {
      store.mutate((s) => {
        const n = kind === "AR" ? applyAutoScheduleToGroup(s, "AR", name) : applyAutoScheduleToGroup(s, "AP", name);
        toast(`Updated CF date on ${n} open item${n === 1 ? "" : "s"} for ${name}`, "success");
      });
    });
  });
}

function openNewPeriodModal(store) {
  const today = todayISO();
  openModal(`
    <h3>New Forecast Period</h3>
    <div class="row"><label>Label</label><input id="np-label" placeholder="e.g. July 26" /></div>
    <div class="row"><label>Start Date (should be a Sunday)</label><input id="np-start" type="date" value="${today}" /></div>
    <div class="row"><label>Opening Cash</label><input id="np-open" type="number" value="0" /></div>
    <div class="modal-actions"><button class="btn-ghost" id="np-cancel">Cancel</button><button class="btn-primary" id="np-save" style="width:auto;">Create</button></div>
  `, {
    onMount: (host) => {
      host.querySelector("#np-cancel").onclick = closeModal;
      host.querySelector("#np-save").onclick = () => {
        const label = host.querySelector("#np-label").value.trim() || "New Period";
        const start = host.querySelector("#np-start").value;
        const opening = parseFloat(host.querySelector("#np-open").value || "0");
        if (!start) { toast("Pick a start date", "error"); return; }
        store.mutate((s) => {
          const p = makePeriod(uid("p"), label, start);
          p.openingCash = opening;
          s.periods.push(p);
          s.activePeriodId = p.id;
        });
        closeModal();
      };
    },
  });
}

function openManualInvoiceModal(store, kind) {
  const isAR = kind === "AR";
  openModal(`
    <h3>Add ${isAR ? "Receivable" : "Payable"}</h3>
    <div class="row"><label>${isAR ? "Customer" : "Vendor"}</label><input id="m-group" /></div>
    <div class="row"><label>Invoice / Doc #</label><input id="m-doc" /></div>
    <div class="row"><label>Date</label><input id="m-date" type="date" value="${todayISO()}" /></div>
    ${isAR ? `<div class="row"><label>PO #</label><input id="m-po" /></div>` : `<div class="row"><label>Due Date</label><input id="m-due" type="date" /></div>`}
    <div class="row"><label>Balance</label><input id="m-bal" type="number" /></div>
    <div class="modal-actions"><button class="btn-ghost" id="m-cancel">Cancel</button><button class="btn-primary" id="m-save" style="width:auto;">Add</button></div>
  `, {
    onMount: (host) => {
      host.querySelector("#m-cancel").onclick = closeModal;
      host.querySelector("#m-save").onclick = () => {
        const group = host.querySelector("#m-group").value.trim();
        const doc = host.querySelector("#m-doc").value.trim();
        const date = host.querySelector("#m-date").value;
        const bal = parseFloat(host.querySelector("#m-bal").value || "0");
        if (!group || !date) { toast("Fill in the required fields", "error"); return; }
        store.mutate((s) => {
          if (isAR) {
            s.receivables.push({ id: uid("ar"), customer: group, txnType: "Invoice", date, docNumber: doc, poNumber: host.querySelector("#m-po").value.trim(), dueDate: null, age: 0, balance: bal, status: "open", cfDate: null, daysOverride: null, source: "manual" });
            if (!s.customerAutoSchedule[group]) s.customerAutoSchedule[group] = { days: 30, auto: false };
          } else {
            s.payables.push({ id: uid("ap"), vendor: group, txnType: "Bill", date, docNumber: doc, dueDate: host.querySelector("#m-due").value || null, age: 0, balance: bal, status: "open", cfDate: null, source: "manual" });
            if (!s.vendorAutoSchedule[group]) s.vendorAutoSchedule[group] = { days: 30, auto: false };
          }
        });
        closeModal();
      };
    },
  });
}

/* ============================================================ IMPORT ============================================================ */

export function wireImportInputs(store) {
  const arInput = document.getElementById("file-input-ar");
  const apInput = document.getElementById("file-input-ap");
  arInput.addEventListener("change", () => handleImportFile(store, arInput, "AR"));
  apInput.addEventListener("change", () => handleImportFile(store, apInput, "AP"));
}

async function handleImportFile(store, input, kind) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseAgingReport(text, kind);
    if (!parsed.length) { toast("No open invoices found in that file", "error"); return; }
    store.mutate((s) => {
      const { added, updated, paidOff } = mergeAgingImport(s, kind, parsed);
      toast(`Imported ${kind}: ${added} new, ${updated} updated, ${paidOff} marked paid`, "success", 5000);
    });
  } catch (err) {
    toast(err.message || "Import failed", "error", 6000);
  }
}
