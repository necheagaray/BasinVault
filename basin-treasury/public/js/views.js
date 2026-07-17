import { fmtMoney, fmtDate, fmtDateShort, escapeHtml, toast, openModal, closeModal, uid, todayISO, toISO, addDays, parseISO, daysBetween } from "./util.js";
import {
  periodWeeks, computeForecast, weekIndexForDate, fixedOccurrencesInPeriod, scheduleLabel,
  FIXED_CATEGORY_ORDER, makePeriod, mergeAgingImport, applyAutoScheduleToAll, applyAutoScheduleToGroup, readOv, payrollWeeksFor,
  effectivePayableDate,
} from "./state.js";
import { parseAgingReport, parseAgingWorkbook } from "./parser.js";

/* ============================================================ helpers ============================================================ */

function editableCell(td, value, onCommit, { title = "Click to override this week's amount" } = {}) {
  td.classList.add("cell-editable");
  td.title = title;
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

function rowValue(weeksRows, rowType, cat, wi) {
  const r = weeksRows[wi];
  return {
    receivablesCollected: r.receivablesCollected,
    otherInflows: r.otherInflows,
    manual: r.manualOutflows[cat],
    fixed: r.fixedRows[cat],
    apPayables: r.apPayables,
    locDraw: r.locDraw,
  }[rowType];
}

function overrideEntry(overrides, rowType, cat, wi) {
  if (rowType === "receivablesCollected") return overrides.receivablesCollected[wi];
  if (rowType === "otherInflows") return overrides.otherInflows[wi];
  if (rowType === "manual") return overrides.manualOutflow?.[cat]?.[wi];
  if (rowType === "fixed") return overrides.fixedGroup?.[cat]?.[wi];
  if (rowType === "apPayables") return overrides.apPayables[wi];
  if (rowType === "locDraw") return overrides.locDraw[wi];
  return undefined;
}

function writeOverride(period, rowType, cat, wi, stamped) {
  const o = period.overrides;
  if (rowType === "receivablesCollected") setOrDel(o.receivablesCollected, wi, stamped);
  if (rowType === "otherInflows") setOrDel(o.otherInflows, wi, stamped);
  if (rowType === "manual") { o.manualOutflow[cat] = o.manualOutflow[cat] || {}; setOrDel(o.manualOutflow[cat], wi, stamped); }
  if (rowType === "fixed") { o.fixedGroup[cat] = o.fixedGroup[cat] || {}; setOrDel(o.fixedGroup[cat], wi, stamped); }
  if (rowType === "apPayables") setOrDel(o.apPayables, wi, stamped);
  if (rowType === "locDraw") setOrDel(o.locDraw, wi, stamped);
}

function noteKey(rowType, cat, wi) {
  const base = cat ? `${rowType}::${cat}` : rowType;
  return wi === undefined || wi === null ? base : `${base}::${wi}`;
}

function labelCell(period, label, rowType, cat, editable) {
  const labelSpan = editable
    ? `<span class="row-label-text clickable" data-row="${escapeHtml(rowType)}" data-cat="${escapeHtml(cat || "")}" title="Click to enter all 5 weeks at once">${escapeHtml(label)}</span>`
    : `<span class="row-label-text">${escapeHtml(label)}</span>`;
  return `<td>${labelSpan}</td>`;
}

function receivablesBreakdown(state, period, wi /* number or null = whole period */) {
  const matches = (r) => {
    const idx = weekIndexForDate(period, r.cfDate);
    if (idx === null) return false;
    return wi === null ? true : idx === wi;
  };

  const paid = [];
  const open = [];
  for (const r of state.receivables) {
    if (!matches(r)) continue;
    const paidSoFar = (r.payments || []).reduce((a, p) => a + p.amount, 0);
    if (r.status === "paid") {
      paid.push({ ...r, balance: r.originalBalance ?? r.balance });
    } else if (r.status === "open") {
      if (paidSoFar > 0) paid.push({ ...r, balance: paidSoFar, docNumber: `${r.docNumber || ""} (partial)` });
      open.push(r);
    }
  }

  const totalOpen = open.reduce((a, r) => a + r.balance, 0);
  const totalPaid = paid.reduce((a, r) => a + r.balance, 0);
  const totalAll = totalOpen + totalPaid;
  const pct = totalAll > 0 ? Math.round((totalPaid / totalAll) * 100) : 0;
  return { open, paid, totalOpen, totalPaid, totalAll, pct };
}

function breakdownPopupHTML(bd, label) {
  const rowsHtml = (list, cls) => list
    .slice().sort((a, b) => (a.customer || "").localeCompare(b.customer || ""))
    .map((r) => `<div class="bd-row ${cls}"><span class="bd-name">${cls === "paid" ? "✓ " : ""}${escapeHtml(r.customer)}<span class="bd-inv">${escapeHtml(r.docNumber || "")}</span></span><span class="bd-amt">${fmtMoney(r.balance)}</span></div>`)
    .join("");
  return `
    <div class="bd-header">${escapeHtml(label)}</div>
    <div class="bd-progress"><div class="bd-progress-fill" style="width:${bd.pct}%"></div></div>
    <div class="bd-summary">${fmtMoney(bd.totalPaid)} collected of ${fmtMoney(bd.totalAll)} <span class="bd-pct">(${bd.pct}%)</span></div>
    ${bd.paid.length ? `<div class="bd-section-label">Collected</div>${rowsHtml(bd.paid, "paid")}` : ""}
    ${bd.open.length ? `<div class="bd-section-label">Expected</div>${rowsHtml(bd.open, "open")}` : ""}
    ${!bd.open.length && !bd.paid.length ? `<div class="bd-empty">No invoices scheduled this week</div>` : ""}
  `;
}

function fixedBreakdown(state, period, rowType, cat, wi) {
  if (rowType === "apPayables") {
    const list = state.payables.filter((p) => p.status === "open" && weekIndexForDate(period, effectivePayableDate(state, period, p)) === wi);
    return { items: list.map((p) => ({ name: p.vendor, sub: p.docNumber + (p.payWhenPaid ? " · PWP" : ""), amount: p.balance })), total: list.reduce((a, p) => a + p.balance, 0) };
  }
  if (cat === "Payroll" || cat === "401K") {
    const isPayrollWeek = payrollWeeksFor(period).includes(wi);
    const amt = cat === "Payroll" ? (period.payroll?.amount || 0) : (period.k401?.amount || 0);
    if (isPayrollWeek && amt) return { items: [{ name: cat === "Payroll" ? "Payroll run" : "401K contribution", sub: "biweekly", amount: amt }], total: amt };
    return { items: [], total: 0 };
  }
  const items = [];
  let total = 0;
  for (const item of state.fixedPayments) {
    if (item.category !== cat || item.active === false) continue;
    for (const dateISO of fixedOccurrencesInPeriod(item, period)) {
      if (weekIndexForDate(period, dateISO) === wi) {
        items.push({ name: item.name, sub: fmtDate(dateISO), amount: item.amount });
        total += item.amount;
      }
    }
  }
  return { items, total };
}

function fixedBreakdownPopupHTML(bd, label) {
  const rowsHtml = bd.items
    .map((it) => `<div class="bd-row"><span class="bd-name">${escapeHtml(it.name)}${it.sub ? `<span class="bd-inv">${escapeHtml(it.sub)}</span>` : ""}</span><span class="bd-amt">${fmtMoney(it.amount)}</span></div>`)
    .join("");
  return `
    <div class="bd-header">${escapeHtml(label)}</div>
    <div class="bd-summary">${fmtMoney(bd.total)} total</div>
    ${bd.items.length ? rowsHtml : `<div class="bd-empty">Nothing scheduled this week</div>`}
  `;
}

function attachBreakdownHover(td, getBreakdown, getLabel, buildHTML = breakdownPopupHTML) {
  let tip = null;
  td.addEventListener("mouseenter", () => {
    const bd = getBreakdown();
    tip = document.createElement("div");
    tip.className = "breakdown-tooltip";
    tip.innerHTML = buildHTML(bd, getLabel());
    document.body.appendChild(tip);
    const r = td.getBoundingClientRect();
    let left = r.left + window.scrollX;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - tip.offsetWidth - 12;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    tip.style.left = `${left}px`;
    tip.style.top = `${r.bottom + window.scrollY + 8}px`;
  });
  td.addEventListener("mouseleave", () => { tip?.remove(); tip = null; });
}

// click-to-open version — used on the CF Forecast grid, where the hover tooltip
// was too easy to accidentally dismiss. A small icon (separate from the cell's
// own click-to-edit-amount behavior) opens a proper scrollable modal that only
// closes via the X button, not by clicking outside it.
function attachBreakdownClick(td, getBreakdown, getLabel, buildHTML = breakdownPopupHTML) {
  const icon = document.createElement("button");
  icon.type = "button";
  icon.className = "cell-detail-btn";
  icon.innerHTML = "🔍";
  icon.title = "Click for a breakdown of this amount";
  td.appendChild(icon);
  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const bd = getBreakdown();
    openModal(`
      <button type="button" class="modal-close-x" id="bd-close">✕</button>
      <div class="breakdown-modal-body">${buildHTML(bd, getLabel())}</div>
    `, {
      closeOnBackdrop: false,
      onMount: (host) => { host.querySelector("#bd-close").onclick = closeModal; },
    });
  });
}

export function renderForecast(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const calc = computeForecast(state, period);
  const weeks = calc.weeks;
  const weeksMeta = periodWeeks(period);

  document.getElementById("forecast-title").textContent = period.label;
  document.getElementById("forecast-eyebrow").textContent = `5-Week Cash Flow Forecast · Starts ${fmtDate(period.startDate)}`;
  document.getElementById("forecast-meta").textContent = `Pay runs: ${weeksMeta.map((w) => fmtDate(w.payRun)).join(", ")}`;

  const sel = document.getElementById("period-select");
  sel.innerHTML = state.periods.map((p) => `<option value="${p.id}" ${p.id === period.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("");
  sel.onchange = () => { state.activePeriodId = sel.value; store.render(); };

  const statRow = document.getElementById("forecast-stats");
  const netTotal = calc.totals.netCashflow;
  statRow.innerHTML = `
    <div class="stat-card sc-open"><div class="label">Opening Cash</div><div class="value">${fmtMoney(calc.totals.opening)}</div></div>
    <div class="stat-card sc-in"><div class="label">Total Inflows</div><div class="value green">${fmtMoney(calc.totals.totalInflows)}</div></div>
    <div class="stat-card sc-out"><div class="label">Total Outflows</div><div class="value red">${fmtMoney(calc.totals.totalOutflows)}</div></div>
    <div class="stat-card sc-net"><div class="label">Net Cash Flow</div><div class="value ${netTotal >= 0 ? "green" : "red"}">${fmtMoney(netTotal)}</div></div>
    <div class="stat-card sc-close"><div class="label">Closing Cash</div><div class="value brass">${fmtMoney(calc.totals.closing)}</div></div>
  `;

  const rcBreakdowns = weeks.map((r, wi) => receivablesBreakdown(state, period, wi));
  const rcTotalBreakdown = receivablesBreakdown(state, period, null);

  const table = document.getElementById("cf-grid");
  table.innerHTML = `
    <thead><tr><th>Line Item</th>${weekHeaderCells(weeksMeta)}<th>Total</th></tr></thead>
    <tbody>
      <tr class="section-label"><td colspan="${weeks.length + 2}">Opening Balance</td></tr>
      <tr class="opening" data-row="opening">${labelCell(period, "Opening Cash", "opening", null, false)}${weeks.map((r, wi) => wi === 0
        ? `<td class="ed opening-open" data-wi="0">${fmtMoney(r.opening)}</td>`
        : `<td>${fmtMoney(r.opening)}</td>`
      ).join("")}<td>${fmtMoney(calc.totals.opening)}</td></tr>

      <tr class="section-label sec-inflow"><td colspan="${weeks.length + 2}">Cash Inflow</td></tr>
      <tr class="inflow-row rc-row" data-row="receivablesCollected">${labelCell(period, "Receivables Collected", "receivablesCollected", null, true)}${weeks.map((r, wi) => `<td class="ed rc-cell" data-wi="${wi}">${fmtMoney(r.receivablesCollected)}<div class="rc-bar" title="${rcBreakdowns[wi].pct}% collected"><div class="rc-bar-fill" style="width:${rcBreakdowns[wi].pct}%"></div></div></td>`).join("")}<td class="rc-cell rc-total-cell">${fmtMoney(calc.totals.receivablesCollected)}<div class="rc-bar" title="${rcTotalBreakdown.pct}% collected"><div class="rc-bar-fill" style="width:${rcTotalBreakdown.pct}%"></div></div></td></tr>
      <tr class="inflow-row" data-row="otherInflows">${labelCell(period, "Other Inflows", "otherInflows", null, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.otherInflows)}</td>`).join("")}<td>${fmtMoney(calc.totals.otherInflows)}</td></tr>
      <tr class="inflow-total" data-row="totalInflows">${labelCell(period, "Total Inflows", "totalInflows", null, false)}${weeks.map((r) => `<td class="value-pos">${fmtMoney(r.totalInflows)}</td>`).join("")}<td class="value-pos">${fmtMoney(calc.totals.totalInflows)}</td></tr>

      <tr class="section-label sec-outflow-manual"><td colspan="${weeks.length + 2}">Cash Outflow — Manual</td></tr>
      ${state.manualOutflowCategories.filter((c) => c !== "Payroll").map((cat) => `
        <tr class="outflow-row" data-row="manual" data-cat="${escapeHtml(cat)}">${labelCell(period, cat, "manual", cat, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.manualOutflows[cat])}</td>`).join("")}<td>${fmtMoney(calc.totals.manualOutflows[cat])}</td></tr>
      `).join("")}

      <tr class="section-label sec-outflow-fixed"><td colspan="${weeks.length + 2}">Cash Outflow — Fixed / Scheduled</td></tr>
      ${calc.fixedCategories.map((cat) => `
        <tr class="fixed-row" data-row="fixed" data-cat="${escapeHtml(cat)}">${labelCell(period, cat, "fixed", cat, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.fixedRows[cat])}</td>`).join("")}<td>${fmtMoney(calc.totals.fixedRows[cat])}</td></tr>
      `).join("")}
      <tr class="fixed-row ap-row" data-row="apPayables">${labelCell(period, "◆ Weekly AP Payables", "apPayables", null, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.apPayables)}</td>`).join("")}<td>${fmtMoney(calc.totals.apPayables)}</td></tr>

      <tr class="outflow-total" data-row="totalOutflows">${labelCell(period, "Total Outflows", "totalOutflows", null, false)}${weeks.map((r) => `<td class="value-neg">${fmtMoney(r.totalOutflows)}</td>`).join("")}<td class="value-neg">${fmtMoney(calc.totals.totalOutflows)}</td></tr>

      <tr class="net" data-row="net">${labelCell(period, "Net Cashflow", "net", null, false)}${weeks.map((r) => `<td class="${r.netCashflow >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(r.netCashflow)}</td>`).join("")}<td class="${calc.totals.netCashflow >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(calc.totals.netCashflow)}</td></tr>

      <tr class="loc-row" data-row="locDraw">${labelCell(period, "⟲ LOC Draw / (Repayment)", "locDraw", null, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.locDraw)}</td>`).join("")}<td>${fmtMoney(calc.totals.locDraw)}</td></tr>

      <tr class="section-label"><td colspan="${weeks.length + 2}">Closing Balance</td></tr>
      <tr class="closing" data-row="closing">${labelCell(period, "Closing Cash", "closing", null, false)}${weeks.map((r) => `<td>${fmtMoney(r.closing)}</td>`).join("")}<td>${fmtMoney(calc.totals.closing)}</td></tr>

      <tr class="locbalance-row" data-row="locBalanceOpening"><td><span class="row-label-text">▣ LOC Balance</span><span class="loc-open-badge" title="Opening LOC balance entered when this forecast was created">Opening ${fmtMoney(period.locOpeningBalance || 0)}</span></td>${weeks.map((r, wi) => wi === 0
        ? `<td class="ed loc-open" data-wi="0">${fmtMoney(r.locBalance)}</td>`
        : `<td>${fmtMoney(r.locBalance)}</td>`
      ).join("")}<td>${fmtMoney(calc.totals.locBalance)}</td></tr>
    </tbody>
  `;

  // week-0 LOC opening balance is a direct field on the period, not a week override
  const locOpenTd = table.querySelector('td.loc-open');
  if (locOpenTd) {
    editableCell(locOpenTd, period.locOpeningBalance || 0, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        per.locOpeningBalance = val === null ? 0 : val;
      });
    }, { title: "This is the LOC balance as of the start of week 1, before that week's draw/(repayment). Click to set it." });
  }

  // week-0 Opening Cash is also a direct field on the period, editable any time after creation
  const openingOpenTd = table.querySelector('td.opening-open');
  if (openingOpenTd) {
    editableCell(openingOpenTd, period.openingCash || 0, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        per.openingCash = val === null ? 0 : val;
      });
    }, { title: "This period's opening cash balance, set when the forecast was created. Click to change it." });
  }

  // wire up editable cells + mark overridden + show who-badge
  table.querySelectorAll("tr[data-row] td.ed:not(.loc-open):not(.opening-open)").forEach((td) => {
    const tr = td.closest("tr");
    const rowType = tr.dataset.row;
    const wi = Number(td.dataset.wi);
    const cat = tr.dataset.cat;

    const entry = overrideEntry(period.overrides, rowType, cat, wi);
    const hasOverride = entry !== undefined;
    const who = hasOverride && typeof entry === "object" ? entry.by : null;
    const currentVal = rowValue(weeks, rowType, cat, wi);

    if (hasOverride) {
      td.classList.add("overridden");
      if (who) td.insertAdjacentHTML("beforeend", `<span class="who-badge" title="Overridden by ${escapeHtml(who)}">${escapeHtml(who)}</span>`);
    }

    editableCell(td, currentVal, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const stamped = val === null ? null : { v: val, by: store.initials(), at: new Date().toISOString() };
        writeOverride(per, rowType, cat, wi, stamped);
      });
    });
  });

  // click a row label to enter all 5 weeks at once
  table.querySelectorAll(".row-label-text.clickable").forEach((span) => {
    const rowType = span.dataset.row;
    const cat = span.dataset.cat || null;
    span.addEventListener("click", () => {
      openBulkWeekModal(store, period, weeksMeta, weeks, rowType, cat, span.textContent);
    });
  });

  // mini pencil + sticky note on every single cell in the grid
  table.querySelectorAll("tbody tr[data-row]").forEach((tr) => {
    const rowType = tr.dataset.row;
    const cat = tr.dataset.cat || null;
    const tds = Array.from(tr.children);
    tds.forEach((td, idx) => {
      const wi = idx === 0 || idx === tds.length - 1 ? (idx === 0 ? null : "total") : idx - 1;
      attachCellPencil(td, store, period, noteKey(rowType, cat, wi));
    });
  });

  // invoice breakdown + collection-progress on Receivables Collected — click the 🔍 icon
  table.querySelectorAll("tr.rc-row td.rc-cell").forEach((td) => {
    const wi = td.dataset.wi !== undefined ? Number(td.dataset.wi) : null;
    attachBreakdownClick(
      td,
      () => (wi === null ? rcTotalBreakdown : rcBreakdowns[wi]),
      () => (wi === null ? "Receivables — Full Period" : `Receivables — ${fmtDateShort(weeksMeta[wi].start)} – ${fmtDateShort(weeksMeta[wi].end)}`)
    );
  });

  // individual scheduled-payment breakdown on the Fixed / Scheduled section (incl. AP Payables) — click the 🔍 icon
  table.querySelectorAll("tr.fixed-row").forEach((tr) => {
    const rowType = tr.dataset.row;
    const cat = tr.dataset.cat || null;
    const tds = Array.from(tr.children);
    const rowLabel = rowType === "apPayables" ? "Weekly AP Payables" : cat;
    tds.forEach((td, idx) => {
      if (idx === 0) return; // label cell, nothing to break down
      const wi = idx === tds.length - 1 ? null : idx - 1; // null = Total column
      attachBreakdownClick(
        td,
        () => {
          if (wi === null) {
            let items = [], total = 0;
            for (let i = 0; i < 5; i++) { const b = fixedBreakdown(state, period, rowType, cat, i); items = items.concat(b.items); total += b.total; }
            return { items, total };
          }
          return fixedBreakdown(state, period, rowType, cat, wi);
        },
        () => `${rowLabel} — ${wi === null ? "Full Period" : `${fmtDateShort(weeksMeta[wi].start)} – ${fmtDateShort(weeksMeta[wi].end)}`}`,
        fixedBreakdownPopupHTML
      );
    });
  });
}

function attachCellPencil(td, store, period, key) {
  const hasNote = !!(period.notes && period.notes[key]);
  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = `cell-pencil ${hasNote ? "has-note" : ""}`;
  pencil.innerHTML = "✎";
  pencil.title = hasNote ? "View / edit note" : "Add a note";
  td.appendChild(pencil);

  let tooltipEl = null;
  const showTip = () => {
    document.querySelectorAll(".breakdown-tooltip").forEach((el) => el.remove()); // pencil note takes priority over the cell's breakdown popup
    const text = period.notes && period.notes[key];
    if (!text) return;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "sticky-tooltip";
    tooltipEl.textContent = text;
    document.body.appendChild(tooltipEl);
    const r = pencil.getBoundingClientRect();
    const top = r.top + window.scrollY - tooltipEl.offsetHeight - 10;
    tooltipEl.style.left = `${Math.max(8, r.left + window.scrollX - 90)}px`;
    tooltipEl.style.top = `${top < 0 ? r.bottom + window.scrollY + 8 : top}px`;
  };
  const hideTip = () => { tooltipEl?.remove(); tooltipEl = null; };

  pencil.addEventListener("mouseenter", (e) => { e.stopPropagation(); showTip(); });
  pencil.addEventListener("mouseleave", (e) => { e.stopPropagation(); hideTip(); });
  pencil.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    hideTip();
    openNoteModal(store, period, key);
  });
}

function openBulkWeekModal(store, period, weeksMeta, weeksRows, rowType, cat, label) {
  openModal(`
    <h3>${escapeHtml(label)} — enter all 5 weeks</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">Leave a box empty to fall back to the computed/scheduled amount for that week.</div>
    ${weeksMeta.map((w, wi) => `
      <div class="row">
        <label>${fmtDateShort(w.start)} – ${fmtDateShort(w.end)} <span style="opacity:.6;">(pay run ${fmtDate(w.payRun)})</span></label>
        <input type="number" class="bulk-wk" data-wi="${wi}" value="${rowValue(weeksRows, rowType, cat, wi)}" />
      </div>
    `).join("")}
    <div class="modal-actions">
      <button class="btn-ghost" id="bw-cancel">Cancel</button>
      <button class="btn-primary" id="bw-save" style="width:auto;">Save All 5 Weeks</button>
    </div>
  `, {
    onMount: (host) => {
      host.querySelector("#bw-cancel").onclick = closeModal;
      host.querySelector("#bw-save").onclick = () => {
        const inputs = host.querySelectorAll(".bulk-wk");
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          inputs.forEach((inp) => {
            const wi = Number(inp.dataset.wi);
            const raw = inp.value.trim();
            const stamped = raw === "" ? null : { v: parseFloat(raw), by: store.initials(), at: new Date().toISOString() };
            writeOverride(per, rowType, cat, wi, stamped);
          });
        });
        closeModal();
        toast("Updated all 5 weeks", "success");
      };
    },
  });
}

function openNoteModal(store, period, key) {
  const existing = (period.notes && period.notes[key]) || "";
  openModal(`
    <h3>🗒 Note</h3>
    <div class="row"><textarea id="note-text" rows="5" style="width:100%;background:var(--bg-panel-alt);border:1px solid var(--line);color:var(--text-hi);border-radius:6px;padding:10px;font-family:var(--font-body);font-size:13px;resize:vertical;">${escapeHtml(existing)}</textarea></div>
    <div class="modal-actions">
      ${existing ? `<button class="btn-ghost" id="note-del">Delete Note</button>` : ""}
      <button class="btn-ghost" id="note-cancel">Cancel</button>
      <button class="btn-primary" id="note-save" style="width:auto;">Save Note</button>
    </div>
  `, {
    onMount: (host) => {
      host.querySelector("#note-text").focus();
      host.querySelector("#note-cancel").onclick = closeModal;
      host.querySelector("#note-del")?.addEventListener("click", () => {
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          if (per.notes) delete per.notes[key];
        });
        closeModal();
      });
      host.querySelector("#note-save").onclick = () => {
        const text = host.querySelector("#note-text").value.trim();
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          per.notes = per.notes || {};
          if (text) per.notes[key] = text; else delete per.notes[key];
        });
        closeModal();
      };
    },
  });
}

function setOrDel(obj, key, val) {
  if (val === null) delete obj[key];
  else obj[key] = val;
}

/* ============================================================ ITEM-LEVEL NOTES (Receivables / Payables rows) ============================================================ */

function attachItemNotePencil(td, store, listKey, id) {
  const item = store.state[listKey].find((x) => x.id === id);
  if (!item) return;
  const hasNote = !!item.note;
  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = `cell-pencil ${hasNote ? "has-note" : ""}`;
  pencil.innerHTML = "✎";
  pencil.title = hasNote ? "View / edit note" : "Add a note";
  td.appendChild(pencil);

  let tip = null;
  const hideTip = () => { tip?.remove(); tip = null; };
  pencil.addEventListener("mouseenter", (e) => {
    e.stopPropagation();
    if (!item.note) return;
    tip = document.createElement("div");
    tip.className = "sticky-tooltip";
    tip.textContent = item.note;
    document.body.appendChild(tip);
    const r = pencil.getBoundingClientRect();
    const top = r.top + window.scrollY - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(8, r.left + window.scrollX - 90)}px`;
    tip.style.top = `${top < 0 ? r.bottom + window.scrollY + 8 : top}px`;
  });
  pencil.addEventListener("mouseleave", (e) => { e.stopPropagation(); hideTip(); });
  pencil.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    hideTip();
    openItemNoteModal(store, listKey, id);
  });
}

function openItemNoteModal(store, listKey, id) {
  const item = store.state[listKey].find((x) => x.id === id);
  if (!item) return;
  const existing = item.note || "";
  const label = listKey === "receivables" ? item.customer : item.vendor;
  openModal(`
    <h3>🗒 Note — ${escapeHtml(label || "")} ${item.docNumber ? `· ${escapeHtml(item.docNumber)}` : ""}</h3>
    <div class="row"><textarea id="note-text" rows="5" style="width:100%;background:var(--bg-panel-alt);border:1px solid var(--line);color:var(--text-hi);border-radius:6px;padding:10px;font-family:var(--font-body);font-size:13px;resize:vertical;">${escapeHtml(existing)}</textarea></div>
    <div class="modal-actions">
      ${existing ? `<button class="btn-ghost" id="note-del">Delete Note</button>` : ""}
      <button class="btn-ghost" id="note-cancel">Cancel</button>
      <button class="btn-primary" id="note-save" style="width:auto;">Save Note</button>
    </div>
  `, {
    onMount: (host) => {
      host.querySelector("#note-text").focus();
      host.querySelector("#note-cancel").onclick = closeModal;
      host.querySelector("#note-del")?.addEventListener("click", () => {
        store.mutate((s) => { const rec = s[listKey].find((x) => x.id === id); if (rec) { delete rec.note; rec.updatedAt = new Date().toISOString(); } });
        closeModal();
      });
      host.querySelector("#note-save").onclick = () => {
        const text = host.querySelector("#note-text").value.trim();
        store.mutate((s) => {
          const rec = s[listKey].find((x) => x.id === id);
          if (!rec) return;
          if (text) rec.note = text; else delete rec.note;
          rec.updatedAt = new Date().toISOString();
        });
        closeModal();
      };
    },
  });
}

/* ============================================================ RECEIVABLES ============================================================ */

let arFilter = "open", arSearch = "", arWeekFilter = null, arCustomerFilter = "";
let arSortBy = "customer", arSortDir = "asc";

// sorts by the letters in a name only — ignores job/invoice numbers, dashes,
// colons, etc. that NetSuite often appends to a customer name
function customerSortKey(name) {
  return (name || "").replace(/[^a-zA-Z\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function renderReceivables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period);

  const openList = state.receivables.filter((r) => r.status === "open");
  const totalAR = state.receivables.reduce((a, r) => a + r.balance, 0);
  const openAR = openList.reduce((a, r) => a + r.balance, 0);
  const uncertainList = openList.filter((r) => r.uncertain);
  const uncertainTotal = uncertainList.reduce((a, r) => a + r.balance, 0);

  document.getElementById("ar-meta").textContent = `${state.receivables.length} invoices · ${openList.length} open`;
  document.getElementById("ar-stats").innerHTML = `
    <div class="stat-card"><div class="label">Total AR</div><div class="value">${fmtMoney(totalAR)}</div></div>
    <div class="stat-card"><div class="label">Open / Uncollected</div><div class="value">${fmtMoney(openAR)}</div></div>
    <div class="stat-card"><div class="label">Scheduled This Period</div><div class="value green">${fmtMoney(weeks.reduce((a, w) => a + openList.filter((r) => weekIndexForDate(period, r.cfDate) === w.index).reduce((s, r) => s + r.balance, 0), 0))}</div></div>
    <div class="stat-card sc-unc"><div class="label">Uncertain</div><div class="value amber">${fmtMoney(uncertainTotal)}</div></div>
  `;

  const insightsHost = document.getElementById("ar-insights");
  insightsHost.innerHTML = `<button type="button" class="insight-btn" id="ar-insight-customers"><span class="icon">🏆</span>Top 5 Customer Balances<span class="arrow">▸</span></button>`;
  document.getElementById("ar-insight-customers").onclick = () => openTopCustomersModal(openList);

  const collectRow = document.getElementById("ar-collect-row");
  collectRow.innerHTML = weeks.map((w) => {
    const bd = receivablesBreakdown(state, period, w.index);
    const isCurrent = w.index === 0;
    const full = bd.totalAll > 0 && bd.pct >= 100;
    const filtered = arWeekFilter === w.index;
    return `<div class="collect-card ${isCurrent ? "current" : ""} ${full ? "full" : ""} ${filtered ? "filtered" : ""}" data-wi="${w.index}" title="Click the card to filter the table below · click 🔍 for a detailed breakdown">
      <div class="sand-fill" style="height:${bd.pct}%"><div class="sand-surface"></div></div>
      <div class="card-content">
        <div class="wk">${fmtDateShort(w.start)} – ${fmtDateShort(w.end)}</div>
        <div class="dt">${fmtDate(w.start)}</div>
        <div class="amt">${fmtMoney(bd.totalAll)}</div>
        <div class="tag">${isCurrent ? "Current Week" : "Scheduled"} · ${bd.pct}% collected</div>
      </div>
    </div>`;
  }).join("");
  collectRow.querySelectorAll(".collect-card").forEach((card) => {
    const wi = Number(card.dataset.wi);
    attachBreakdownClick(card, () => receivablesBreakdown(state, period, wi), () => `Receivables — ${fmtDateShort(weeks[wi].start)} – ${fmtDateShort(weeks[wi].end)}`);
    card.addEventListener("click", () => {
      arWeekFilter = arWeekFilter === wi ? null : wi;
      renderReceivables(store);
    });
  });

  document.querySelectorAll("#ar-status-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.f === arFilter);
    b.onclick = () => { arFilter = b.dataset.f; store.render(); };
  });
  document.getElementById("ar-search").value = arSearch;
  document.getElementById("ar-search").oninput = (e) => { arSearch = e.target.value.toLowerCase(); renderARRows(store, period); };

  const custSel = document.getElementById("ar-customer-filter");
  const customers = Array.from(new Set(state.receivables.map((r) => r.customer))).sort((a, b) => customerSortKey(a).localeCompare(customerSortKey(b)));
  custSel.innerHTML = `<option value="">All Customers</option>${customers.map((c) => `<option value="${escapeHtml(c)}" ${c === arCustomerFilter ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}`;
  custSel.onchange = () => { arCustomerFilter = custSel.value; renderARRows(store, period); };

  document.getElementById("ar-import-btn").onclick = () => document.getElementById("file-input-ar").click();
  document.getElementById("ar-add-btn").onclick = () => openManualInvoiceModal(store, "AR");
  document.getElementById("ar-clear-btn").onclick = () => {
    if (!state.receivables.length) { toast("Receivables are already empty", "info"); return; }
    if (!confirm(`Delete all ${state.receivables.length} receivable invoices? This can't be undone. Customer auto-schedule settings will be kept.`)) return;
    store.mutate((s) => { s.receivables = []; });
    toast("All receivables cleared — customer auto-schedule settings kept", "success");
  };

  renderARRows(store, period);
}

function openPaymentHistoryModal(store, id) {
  const rec = store.state.receivables.find((x) => x.id === id);
  if (!rec) return;
  const payments = (rec.payments || []).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const paidSoFar = payments.reduce((a, p) => a + p.amount, 0);
  openModal(`
    <button type="button" class="modal-close-x" id="hist-close">✕</button>
    <h3>Payment History</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">${escapeHtml(rec.customer || "")} · ${escapeHtml(rec.docNumber || "")}<br/>
      ${fmtMoney(paidSoFar)} paid of ${fmtMoney(rec.originalBalance ?? rec.balance ?? 0)} · ${fmtMoney(rec.balance ?? 0)} still owed</div>
    <div class="breakdown-modal-body">
      ${payments.length ? payments.map((p, i) => `
        <div class="vendor-rank"><span>${fmtDate(p.date)}</span><span class="amt">${fmtMoney(p.amount)} <button type="button" class="mini-btn remove-payment" data-idx="${i}" style="margin-left:8px;">✕ remove</button></span></div>
      `).join("") : `<div class="meta">No payments recorded yet.</div>`}
    </div>
  `, {
    closeOnBackdrop: false,
    onMount: (host) => {
      host.querySelector("#hist-close").onclick = closeModal;
      host.querySelectorAll(".remove-payment").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.idx);
          const target = payments[idx];
          store.mutate((s) => {
            const item = s.receivables.find((x) => x.id === id);
            if (!item || !item.payments) return;
            const pos = item.payments.indexOf(target);
            if (pos === -1) return;
            item.payments.splice(pos, 1);
            const paid = item.payments.reduce((a, p) => a + p.amount, 0);
            item.balance = Math.max(0, Math.round(((item.originalBalance ?? item.balance) - paid) * 100) / 100);
            if (item.balance > 0) item.status = "open";
            item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
          });
          toast("Payment removed", "success");
          closeModal();
          openPaymentHistoryModal(store, id);
        });
      });
    },
  });
}

function openRecordPaymentModal(store, id) {
  const rec = store.state.receivables.find((x) => x.id === id);
  if (!rec) return;
  const paidSoFar = (rec.payments || []).reduce((a, p) => a + p.amount, 0);
  openModal(`
    <button type="button" class="modal-close-x" id="pay-close">✕</button>
    <h3>💲 Record Payment</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">${escapeHtml(rec.customer)} · ${escapeHtml(rec.docNumber || "")}<br/>Balance due: <strong style="color:var(--text-hi);">${fmtMoney(rec.balance)}</strong>${paidSoFar ? ` · ${fmtMoney(paidSoFar)} already paid` : ""}</div>
    <div class="row"><label>Payment Amount</label><input id="pay-amt" type="number" value="${rec.balance}" step="0.01" /></div>
    <div class="row"><label>Payment Date</label><input id="pay-date" type="date" value="${todayISO()}" /></div>
    <div class="modal-actions">
      <button class="btn-ghost" id="pay-cancel">Cancel</button>
      <button class="btn-primary" id="pay-save" style="width:auto;">Record Payment</button>
    </div>
  `, {
    onMount: (host) => {
      host.querySelector("#pay-amt").focus();
      host.querySelector("#pay-amt").select();
      host.querySelector("#pay-close").onclick = closeModal;
      host.querySelector("#pay-cancel").onclick = closeModal;
      host.querySelector("#pay-save").onclick = () => {
        const amt = parseFloat(host.querySelector("#pay-amt").value || "0");
        const date = host.querySelector("#pay-date").value || todayISO();
        if (!amt || amt <= 0) { toast("Enter a payment amount greater than $0", "error"); return; }
        store.mutate((s) => {
          const item = s.receivables.find((x) => x.id === id);
          if (!item) return;
          item.payments = item.payments || [];
          item.payments.push({ date, amount: amt });
          item.balance = Math.max(0, Math.round((item.balance - amt) * 100) / 100);
          if (item.balance <= 0) { item.balance = 0; item.status = "paid"; }
          item.lastEditBy = store.initials();
          item.updatedAt = new Date().toISOString();
        });
        closeModal();
        toast(`Recorded ${fmtMoney(amt)} payment${amt >= rec.balance ? " — invoice paid in full" : ""}`, "success");
      };
    },
  });
}

function openTopCustomersModal(openList) {
  const byCustomer = {};
  for (const r of openList) byCustomer[r.customer] = (byCustomer[r.customer] || 0) + r.balance;
  const ranked = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rows = ranked.map(([c, amt], i) => `
    <div class="vendor-rank"><span><span class="n">${i + 1}</span>${escapeHtml(c)}</span><span class="amt">${fmtMoney(amt)}</span></div>
  `).join("") || `<div class="meta">No open receivables yet.</div>`;
  openModal(`
    <button type="button" class="modal-close-x" id="insight-close">✕</button>
    <h3>🏆 Top 5 Customer Balances</h3>
    ${rows}
  `, {
    onMount: (host) => { host.querySelector("#insight-close").onclick = closeModal; },
  });
}

function renderARRows(store, period) {
  const { state } = store;
  let list = state.receivables;
  if (arFilter === "open") list = list.filter((r) => r.status === "open");
  if (arFilter === "paid") list = list.filter((r) => r.status === "paid");
  if (arSearch) list = list.filter((r) => `${r.customer} ${r.docNumber} ${r.poNumber || ""}`.toLowerCase().includes(arSearch));
  if (arWeekFilter !== null) list = list.filter((r) => weekIndexForDate(period, r.cfDate) === arWeekFilter);
  if (arCustomerFilter) list = list.filter((r) => r.customer === arCustomerFilter);
  list = list.slice().sort((a, b) => {
    let cmp;
    if (arSortBy === "date") cmp = (a.date || "").localeCompare(b.date || "");
    else cmp = customerSortKey(a.customer).localeCompare(customerSortKey(b.customer));
    if (cmp === 0) cmp = customerSortKey(a.customer).localeCompare(customerSortKey(b.customer)) || (a.date || "").localeCompare(b.date || "");
    return arSortDir === "desc" ? -cmp : cmp;
  });

  document.querySelectorAll('#ar-table th.sortable').forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === arSortBy) { arrow.textContent = arSortDir === "asc" ? "▲" : "▼"; th.classList.add("sorted"); }
    else { arrow.textContent = ""; th.classList.remove("sorted"); }
    th.onclick = () => {
      if (arSortBy === th.dataset.sort) arSortDir = arSortDir === "asc" ? "desc" : "asc";
      else { arSortBy = th.dataset.sort; arSortDir = "asc"; }
      renderARRows(store, period);
    };
  });

  const weekLabel = arWeekFilter !== null ? ` · week of ${fmtDate(periodWeeks(period)[arWeekFilter].start)} <button id="ar-week-clear" class="mini-btn" style="margin-left:6px;">✕ clear</button>` : "";
  document.getElementById("ar-count").innerHTML = `${list.length} rows${weekLabel}`;
  document.getElementById("ar-week-clear")?.addEventListener("click", () => { arWeekFilter = null; renderReceivables(store); });
  const tbody = document.getElementById("ar-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><h4>No invoices here</h4>Import your Aged AR export or add one manually.</div></td></tr>`; return; }

  tbody.innerHTML = list.map((r) => {
    const days = r.date ? Math.round((parseISO(r.cfDate || r.date) - parseISO(r.date)) / 86400000) : "";
    const whoBadge = r.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(r.lastEditBy)}">${escapeHtml(r.lastEditBy)}</span>` : "";
    const daysVal = r.uncertain ? "unc" : (r.daysOverride ?? days);
    const paidSoFar = (r.payments || []).reduce((a, p) => a + p.amount, 0);
    const hasPayments = (r.payments || []).length > 0;
    const hasPartial = paidSoFar > 0 && r.balance > 0;
    return `<tr class="${r.status === "paid" ? "paid" : ""} ${r.uncertain ? "uncertain-row" : ""}" data-id="${r.id}">
      <td class="name">${escapeHtml(r.customer)}</td>
      <td>${escapeHtml(r.txnType || "")}</td>
      <td class="mono">${escapeHtml(r.docNumber || "")}</td>
      <td class="mono">${fmtDate(r.date)}</td>
      <td class="mono">${escapeHtml(r.poNumber || "—")}</td>
      <td><input class="mini-input days-input ${r.uncertain ? "uncertain" : ""}" type="text" value="${daysVal}" title="Type a number of days, or 'unc' if the pay date is uncertain" ${r.status !== "open" ? "disabled" : ""}/></td>
      <td class="mono cf-date">${r.uncertain ? `<span class="uncertain-tag">UNCERTAIN</span>` : (r.cfDate ? fmtDate(r.cfDate) : "—")}${whoBadge}</td>
      <td class="mono">${r.date ? `${daysBetween(r.date, todayISO())}d` : "—"}</td>
      <td class="num">${fmtMoney(r.balance)}${hasPartial ? `<div class="partial-note">${fmtMoney(paidSoFar)} paid of ${fmtMoney(r.originalBalance ?? r.balance)}</div>` : ""}${hasPayments ? `<button type="button" class="payment-history-link" title="View / manage payment history">${(r.payments || []).length} payment${(r.payments || []).length === 1 ? "" : "s"} ▸</button>` : ""}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>
        ${r.status === "open" ? `<button class="mini-btn record-payment" title="Record a partial or full payment">💲 Pay</button>` : ""}
        <button class="mini-btn toggle-status" style="margin-left:4px;">${r.status === "open" ? "Mark Paid" : "Reopen"}</button>
        <button class="mini-btn del-row" style="margin-left:4px;">✕</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const rec = state.receivables.find((x) => x.id === id);
    if (!rec) return;
    attachItemNotePencil(tr.querySelector(".name"), store, "receivables", id);

    tr.querySelector(".record-payment")?.addEventListener("click", () => openRecordPaymentModal(store, id));
    tr.querySelector(".days-input")?.addEventListener("change", (e) => {
      const raw = e.target.value.trim();
      store.mutate((s) => {
        const item = s.receivables.find((x) => x.id === id);
        if (raw.toLowerCase() === "unc") {
          item.uncertain = true;
          item.daysOverride = null;
          item.cfDate = null;
        } else {
          const days = raw === "" ? null : Number(raw);
          item.uncertain = false;
          item.daysOverride = days;
          item.cfDate = (days === null || days === 0 || Number.isNaN(days)) ? null : toISO(addDays(item.date, days));
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".toggle-status")?.addEventListener("click", () => {
      store.mutate((s) => {
        const item = s.receivables.find((x) => x.id === id);
        const reopening = item.status === "paid";
        item.status = item.status === "open" ? "paid" : "open";
        if (reopening && item.originalBalance !== undefined) {
          const paidSoFar = (item.payments || []).reduce((a, p) => a + p.amount, 0);
          item.balance = Math.max(0, Math.round((item.originalBalance - paidSoFar) * 100) / 100);
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".payment-history-link")?.addEventListener("click", () => openPaymentHistoryModal(store, id));
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
      if (input.showPicker) { try { input.showPicker(); } catch { /* ignore */ } }
      input.addEventListener("blur", () => {
        store.mutate((s) => {
          const item = s.receivables.find((x) => x.id === id);
          item.cfDate = input.value || null;
          if (input.value) item.uncertain = false;
          item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
        });
      }, { once: true });
    });
  });
}

/* ============================================================ PAYABLES ============================================================ */

let apFilter = "open", apSearch = "", apVendorFilter = "", apPayrunFilter = "";
const apSelected = new Set();

export function renderPayables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period);

  const openList = state.payables.filter((p) => p.status === "open");
  const totalAP = openList.reduce((a, p) => a + p.balance, 0);
  const scheduled = openList.filter((p) => effectivePayableDate(state, period, p)).reduce((a, p) => a + p.balance, 0);
  const unscheduled = totalAP - scheduled;

  document.getElementById("ap-meta").textContent = `${openList.length} open · ${openList.filter((p) => !effectivePayableDate(state, period, p)).length} unscheduled`;
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
  document.getElementById("ap-clear-btn").onclick = () => {
    if (!state.payables.length) { toast("Payables are already empty", "info"); return; }
    if (!confirm(`Delete all ${state.payables.length} payable bills? This can't be undone. Vendor auto-schedule settings will be kept.`)) return;
    apSelected.clear();
    store.mutate((s) => { s.payables = []; });
    toast("All payables cleared — vendor auto-schedule settings kept", "success");
  };

  // vendor filter dropdown
  const vendorSel = document.getElementById("ap-vendor-filter");
  const vendors = Array.from(new Set(state.payables.map((p) => p.vendor))).sort((a, b) => a.localeCompare(b));
  vendorSel.innerHTML = `<option value="">All Vendors</option>${vendors.map((v) => `<option value="${escapeHtml(v)}" ${v === apVendorFilter ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}`;
  vendorSel.onchange = () => { apVendorFilter = vendorSel.value; renderPayables(store); };

  // pay-run filter dropdown
  const payrunSel = document.getElementById("ap-payrun-filter");
  payrunSel.innerHTML = `<option value="">All Pay Runs</option><option value="unscheduled" ${apPayrunFilter === "unscheduled" ? "selected" : ""}>— Unscheduled —</option>${weeks.map((w) => `<option value="${w.payRun}" ${w.payRun === apPayrunFilter ? "selected" : ""}>${fmtDate(w.payRun)}</option>`).join("")}`;
  payrunSel.onchange = () => { apPayrunFilter = payrunSel.value; renderPayables(store); };

  document.getElementById("ap-copy-btn").onclick = () => copyPayablesToClipboard(state, period);

  // insight buttons — Pay Run Totals + Top Vendor Balances, now popup modals instead of a side panel
  const insightsHost = document.getElementById("ap-insights");
  insightsHost.innerHTML = `
    <button type="button" class="insight-btn" id="ap-insight-payrun"><span class="icon">📅</span>Pay Run Totals<span class="arrow">▸</span></button>
    <button type="button" class="insight-btn" id="ap-insight-vendors"><span class="icon">🏆</span>Top Vendor Balances<span class="arrow">▸</span></button>
  `;
  document.getElementById("ap-insight-payrun").onclick = () => openPayrunTotalsModal(store, period, weeks, openList);
  document.getElementById("ap-insight-vendors").onclick = () => openTopVendorsModal(openList);

  renderAPRows(store, period);
}

function openPayrunTotalsModal(store, period, weeks, openList) {
  const rows = weeks.map((w) => {
    const total = openList.filter((p) => weekIndexForDate(period, effectivePayableDate(store.state, period, p)) === w.index).reduce((a, p) => a + p.balance, 0);
    const count = openList.filter((p) => weekIndexForDate(period, effectivePayableDate(store.state, period, p)) === w.index).length;
    const active = apPayrunFilter === w.payRun;
    return `<button type="button" class="vendor-rank payrun-filter-btn ${active ? "active" : ""}" data-payrun="${w.payRun}" title="Click to filter the table to this pay run">
      <span><span class="filter-icon">⏷</span>${fmtDate(w.payRun)} <span style="color:var(--text-dim)">(${count})</span></span><span class="amt">${fmtMoney(total)}</span>
    </button>`;
  }).join("");
  openModal(`
    <button type="button" class="modal-close-x" id="insight-close">✕</button>
    <h3>📅 Pay Run Totals</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">Click a pay run to filter the table to it.</div>
    ${rows}
  `, {
    onMount: (host) => {
      host.querySelector("#insight-close").onclick = closeModal;
      host.querySelectorAll(".payrun-filter-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.payrun;
          apPayrunFilter = apPayrunFilter === val ? "" : val;
          closeModal();
          renderPayables(store);
        });
      });
    },
  });
}

function openTopVendorsModal(openList) {
  const byVendor = {};
  for (const p of openList) byVendor[p.vendor] = (byVendor[p.vendor] || 0) + p.balance;
  const ranked = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rows = ranked.map(([v, amt], i) => `
    <div class="vendor-rank"><span><span class="n">${i + 1}</span>${escapeHtml(v)}</span><span class="amt">${fmtMoney(amt)}</span></div>
  `).join("") || `<div class="meta">No open payables yet.</div>`;
  openModal(`
    <button type="button" class="modal-close-x" id="insight-close">✕</button>
    <h3>🏆 Top 5 Vendor Balances</h3>
    ${rows}
  `, {
    onMount: (host) => { host.querySelector("#insight-close").onclick = closeModal; },
  });
}

function renderAPRows(store, period) {
  const { state } = store;
  const weeks = periodWeeks(period);
  let list = state.payables;
  if (apFilter === "open") list = list.filter((p) => p.status === "open");
  if (apFilter === "scheduled") list = list.filter((p) => p.status === "open" && effectivePayableDate(state, period, p));
  if (apFilter === "unscheduled") list = list.filter((p) => p.status === "open" && !effectivePayableDate(state, period, p));
  if (apSearch) list = list.filter((p) => `${p.vendor} ${p.docNumber}`.toLowerCase().includes(apSearch));
  if (apVendorFilter) list = list.filter((p) => p.vendor === apVendorFilter);
  if (apPayrunFilter === "unscheduled") list = list.filter((p) => !effectivePayableDate(state, period, p));
  else if (apPayrunFilter) list = list.filter((p) => effectivePayableDate(state, period, p) === apPayrunFilter);
  list = list.slice().sort((a, b) => (a.vendor || "").localeCompare(b.vendor || "") || (a.date || "").localeCompare(b.date || ""));

  document.getElementById("ap-count").textContent = `${list.length} rows${apSelected.size ? ` · ${apSelected.size} selected` : ""}`;
  const tbody = document.getElementById("ap-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h4>No bills here</h4>Import your Aged AP export or add one manually.</div></td></tr>`; return; }

  const openReceivables = state.receivables.filter((r) => r.status === "open").sort((a, b) => (a.customer || "").localeCompare(b.customer || ""));

  tbody.innerHTML = list.map((p) => {
    const whoBadge = p.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(p.lastEditBy)}">${escapeHtml(p.lastEditBy)}</span>` : "";
    const effDate = effectivePayableDate(state, period, p);
    const payrunCell = p.payWhenPaid
      ? `<select class="mini-select pwp-receivable-select">
          <option value="">— pick a receivable —</option>
          ${openReceivables.map((r) => `<option value="${r.id}" ${p.linkedReceivableId === r.id ? "selected" : ""}>${escapeHtml(r.customer)} — ${escapeHtml(r.docNumber || "")} — ${fmtMoney(r.balance)}${r.cfDate ? " · " + fmtDate(r.cfDate) : " · unscheduled"}</option>`).join("")}
        </select>
        <div class="pwp-result ${effDate ? "" : "unset"}">${effDate ? `→ pays ${fmtDate(effDate)}` : "→ not scheduled (receivable unscheduled)"}</div>`
      : `<select class="mini-select payrun-select">
          <option value="">— unscheduled —</option>
          ${weeks.map((w) => `<option value="${w.payRun}" ${p.cfDate === w.payRun ? "selected" : ""}>${fmtDate(w.payRun)}</option>`).join("")}
        </select>`;
    return `<tr class="${p.status === "paid" ? "paid" : ""}" data-id="${p.id}">
      <td><input type="checkbox" class="row-select" ${apSelected.has(p.id) ? "checked" : ""} /></td>
      <td class="name">${escapeHtml(p.vendor)}</td>
      <td class="mono">${escapeHtml(p.docNumber || "")}</td>
      <td class="mono">${fmtDate(p.date)}</td>
      <td class="num">${fmtMoney(p.balance)}</td>
      <td>
        <label class="pwp-toggle"><input type="checkbox" class="pwp-check" ${p.payWhenPaid ? "checked" : ""} /> Pay when paid</label>
        ${payrunCell}${whoBadge}
      </td>
      <td>
        <button class="mini-btn toggle-status">${p.status === "open" ? "Mark Paid" : "Reopen"}</button>
        <button class="mini-btn del-row" style="margin-left:4px;">✕</button>
      </td>
    </tr>`;
  }).join("");

  const selectAll = document.getElementById("ap-select-all");
  selectAll.checked = list.length > 0 && list.every((p) => apSelected.has(p.id));
  selectAll.onchange = () => {
    if (selectAll.checked) list.forEach((p) => apSelected.add(p.id));
    else list.forEach((p) => apSelected.delete(p.id));
    renderAPRows(store, period);
  };

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    attachItemNotePencil(tr.querySelector(".name"), store, "payables", id);
    tr.querySelector(".row-select")?.addEventListener("change", (e) => {
      if (e.target.checked) apSelected.add(id); else apSelected.delete(id);
      document.getElementById("ap-count").textContent = `${list.length} rows${apSelected.size ? ` · ${apSelected.size} selected` : ""}`;
      selectAll.checked = list.every((p) => apSelected.has(p.id));
    });
    tr.querySelector(".payrun-select")?.addEventListener("change", (e) => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.cfDate = e.target.value || null;
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".pwp-check")?.addEventListener("change", (e) => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.payWhenPaid = e.target.checked;
        if (!e.target.checked) item.linkedReceivableId = null;
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".pwp-receivable-select")?.addEventListener("change", (e) => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.linkedReceivableId = e.target.value || null;
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".toggle-status")?.addEventListener("click", () => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.status = item.status === "open" ? "paid" : "open";
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".del-row")?.addEventListener("click", () => {
      const rec = state.payables.find((x) => x.id === id);
      if (!confirm(`Remove bill ${rec.docNumber || ""} for ${rec.vendor}?`)) return;
      apSelected.delete(id);
      store.mutate((s) => { s.payables = s.payables.filter((x) => x.id !== id); });
    });
  });
}

async function copyPayablesToClipboard(state, period) {
  const selected = state.payables.filter((p) => apSelected.has(p.id));
  if (!selected.length) { toast("Select at least one row first (checkboxes on the left)", "error"); return; }

  const byVendor = {};
  for (const p of selected) (byVendor[p.vendor] = byVendor[p.vendor] || []).push(p);
  const vendors = Object.keys(byVendor).sort((a, b) => a.localeCompare(b));

  const lines = [];
  lines.push("PAYMENT SCHEDULE");
  lines.push(`Generated ${fmtDate(todayISO())} · ${selected.length} invoice${selected.length === 1 ? "" : "s"} · ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(["Vendor", "Invoice #", "Date", "Balance", "Pay Run"].join("\t"));

  let grandTotal = 0;
  vendors.forEach((v, vi) => {
    const invoices = byVendor[v].slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const vendorTotal = invoices.reduce((a, p) => a + p.balance, 0);
    grandTotal += vendorTotal;

    lines.push([`${v} — VENDOR TOTAL`, "", "", vendorTotal, `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`].join("\t"));
    for (const p of invoices) {
      const eff = effectivePayableDate(state, period, p);
      lines.push([
        "",
        p.docNumber || "",
        p.date ? fmtDate(p.date) : "",
        p.balance,
        eff ? `${fmtDate(eff)}${p.payWhenPaid ? " (PWP)" : ""}` : "Unscheduled",
      ].join("\t"));
    }
    if (vi < vendors.length - 1) lines.push(""); // blank spacer row between vendor groups
  });

  lines.push("");
  lines.push(["GRAND TOTAL", "", "", grandTotal, `${selected.length} invoice${selected.length === 1 ? "" : "s"} · ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}`].join("\t"));

  const text = lines.join("\n");

  const done = () => toast(`Copied payment schedule — ${selected.length} invoice${selected.length === 1 ? "" : "s"} across ${vendors.length} vendor${vendors.length === 1 ? "" : "s"} — paste into Excel, Slack, or email`, "success", 5000);

  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch {
      toast("Couldn't copy to clipboard — your browser may be blocking it", "error");
    }
  }
}

/* ============================================================ FIXED PAYMENTS ============================================================ */

/* ============================================================ STICKY OFFSET SYNC ============================================================ */
// The page itself is the only scroll container now (no nested scroll panes).
// Each view's "frozen head" (title + stats + filters) is pinned with position:sticky,
// and the table's own header needs to sit right below it — measured at render time
// since the frozen block's height varies by content/viewport width.
export function syncStickyOffsets() {
  const applyOffset = (frozenId, tableSelector) => {
    const frozen = document.getElementById(frozenId);
    const table = document.querySelector(tableSelector);
    if (!frozen || !table) return;
    const h = Math.ceil(frozen.getBoundingClientRect().height);
    table.style.setProperty("--sticky-top", `${h}px`);
  };
  applyOffset("forecast-frozen-head", "#cf-grid");
  applyOffset("ar-frozen-head", "#ar-table");

  const apFrozen = document.getElementById("ap-frozen-head");
  const apToolbar = document.getElementById("ap-toolbar");
  const apTable = document.getElementById("ap-table");
  if (apFrozen && apToolbar) {
    const frozenH = Math.ceil(apFrozen.getBoundingClientRect().height);
    apToolbar.style.top = `${frozenH}px`;
    if (apTable) {
      const toolbarH = Math.ceil(apToolbar.getBoundingClientRect().height);
      apTable.style.setProperty("--sticky-top", `${frozenH + toolbarH}px`);
    }
  }
}

export function renderFixed(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const categories = Array.from(new Set([...FIXED_CATEGORY_ORDER, ...state.fixedPayments.map((f) => f.category)]));

  const weeksMeta = periodWeeks(period);
  const payrollWeeks = payrollWeeksFor(period);
  const payrollAmt = period.payroll?.amount || 0;
  const k401Amt = period.k401?.amount || 0;
  const payrollWeekLabel = payrollWeeks.map((wi) => `Wk ${wi + 1}`).join(", ");
  const payrollPanel = `
    <div class="panel fixed-group">
      <div class="fixed-group-head">
        <h3>Payroll <span class="count">biweekly</span></h3>
        <span class="total">${fmtMoney(payrollWeeks.length * payrollAmt)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">Payroll</div>
          <div class="fsched">${payrollAmt ? `${payrollWeekLabel}` : "Not set — create a new period to set it"}</div>
        </div>
        <div class="famt">${fmtMoney(payrollAmt)}<div class="fsched">per run</div></div>
      </div>
    </div>
    <div class="panel fixed-group">
      <div class="fixed-group-head">
        <h3>401K <span class="count">biweekly</span></h3>
        <span class="total">${fmtMoney(payrollWeeks.length * k401Amt)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">401K</div>
          <div class="fsched">${k401Amt ? `${payrollWeekLabel}` : "Not set — create a new period to set it"}</div>
        </div>
        <div class="famt">${fmtMoney(k401Amt)}<div class="fsched">per run</div></div>
      </div>
    </div>
  `;

  let periodTotal = payrollWeeks.length * (payrollAmt + k401Amt);
  const host = document.getElementById("fixed-groups");
  host.innerHTML = payrollPanel + categories.filter((c) => c !== "Payroll" && c !== "401K").map((cat) => {
    const items = state.fixedPayments.filter((f) => f.category === cat);
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
        <h3>${escapeHtml(cat)}<span class="count">${items.length ? `${items.length} active · ${fmtMoney(groupTotal)} this period` : "nothing added yet"}</span></h3>
        <button class="btn-ghost add-fixed" data-cat="${escapeHtml(cat)}">+ Add</button>
      </div>
      ${rows || `<div class="empty-state" style="padding:22px;"><h4>No ${escapeHtml(cat)} items yet</h4>Click "+ Add" above to set one up.</div>`}
    </div>`;
  }).join("") + `<div class="panel fixed-group"><div class="fixed-group-head"><h3>New Category</h3>
      <button class="btn-ghost" id="add-fixed-new-cat">+ Add Item In New Category</button></div></div>`;


  host.querySelectorAll(".add-fixed").forEach((b) => b.addEventListener("click", () => openFixedModal(store, { category: b.dataset.cat })));
  document.getElementById("add-fixed-new-cat").addEventListener("click", () => openFixedModal(store, {}));
  host.querySelectorAll(".active-toggle").forEach((cb) => cb.addEventListener("change", (e) => {
    const id = e.target.closest(".fixed-item").dataset.id;
    store.mutate((s) => {
      const item = s.fixedPayments.find((f) => f.id === id);
      item.active = e.target.checked;
      item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
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
          if (isEdit) Object.assign(s.fixedPayments.find((f) => f.id === existing.id), payload, { lastEditBy: store.initials(), updatedAt: new Date().toISOString() });
          else s.fixedPayments.push({ id: uid("fx"), ...payload, lastEditBy: store.initials(), updatedAt: new Date().toISOString() });
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
  catHost.innerHTML = state.manualOutflowCategories.filter((c) => c !== "Payroll").map((c) => `
    <div class="period-row"><div class="pname">${escapeHtml(c)}</div><button class="btn-ghost del-cat" data-c="${escapeHtml(c)}">Remove</button></div>
  `).join("");
  catHost.querySelectorAll(".del-cat").forEach((b) => b.addEventListener("click", () => {
    store.mutate((s) => { s.manualOutflowCategories = s.manualOutflowCategories.filter((c) => c !== b.dataset.c); });
  }));
  document.getElementById("btn-add-category").onclick = () => {
    const name = prompt("New outflow category name");
    if (!name) return;
    if (name === "Payroll") { toast("Payroll is set per-forecast now, from the New Period form.", "error"); return; }
    store.mutate((s) => { if (!s.manualOutflowCategories.includes(name)) s.manualOutflowCategories.push(name); });
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
  host.innerHTML = list.slice(0, 3).map((h) => `
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
  const listKey = kind === "AR" ? "receivables" : "payables";
  const groupKey = kind === "AR" ? "customer" : "vendor";
  const names = Object.keys(state[schedKey]).filter((n) => n.toLowerCase().includes(search)).sort();
  if (!names.length) { host.innerHTML = `<div class="meta" style="padding:14px;">Import ${kind === "AR" ? "receivables" : "payables"} to populate this list.</div>`; return; }

  const balances = {};
  for (const item of state[listKey]) {
    if (item.status !== "open") continue;
    balances[item[groupKey]] = (balances[item[groupKey]] || 0) + item.balance;
  }

  host.innerHTML = names.map((name) => {
    const t = state[schedKey][name];
    return `<div class="auto-row" data-name="${escapeHtml(name)}">
      <span>${escapeHtml(name)}</span>
      <span class="auto-balance mono">${fmtMoney(balances[name] || 0)}</span>
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
    <div class="row"><label>Opening LOC Balance</label><input id="np-loc" type="number" value="0" /></div>
    <div class="row"><label>Payroll Amount (per pay run, as a positive number — it'll post as an outflow)</label><input id="np-payroll-amt" type="number" value="0" /></div>
    <div class="row"><label>First Payroll Falls In</label>
      <select id="np-payroll-wk">
        <option value="0">Week 1</option>
        <option value="1">Week 2</option>
        <option value="2">Week 3</option>
        <option value="3">Week 4</option>
        <option value="4">Week 5</option>
      </select>
    </div>
    <div class="desc" style="font-size:11.5px;color:var(--text-dim);margin-top:-6px;">Payroll is biweekly — the app will automatically post the same amount every 2 weeks after the week you pick.</div>
    <div class="row"><label>401K Amount (per payroll run, as a positive number)</label><input id="np-401k-amt" type="number" value="0" /></div>
    <div class="desc" style="font-size:11.5px;color:var(--text-dim);margin-top:-6px;">Posts automatically on the same weeks as Payroll.</div>
    <div class="modal-actions"><button class="btn-ghost" id="np-cancel">Cancel</button><button class="btn-primary" id="np-save" style="width:auto;">Create</button></div>
  `, {
    onMount: (host) => {
      host.querySelector("#np-cancel").onclick = closeModal;
      host.querySelector("#np-save").onclick = () => {
        const label = host.querySelector("#np-label").value.trim() || "New Period";
        const start = host.querySelector("#np-start").value;
        const opening = parseFloat(host.querySelector("#np-open").value || "0");
        const loc = parseFloat(host.querySelector("#np-loc").value || "0");
        const payrollAmt = Math.abs(parseFloat(host.querySelector("#np-payroll-amt").value || "0"));
        const payrollWk = Number(host.querySelector("#np-payroll-wk").value || "0");
        const k401Amt = Math.abs(parseFloat(host.querySelector("#np-401k-amt").value || "0"));
        if (!start) { toast("Pick a start date", "error"); return; }
        store.mutate((s) => {
          const p = makePeriod(uid("p"), label, start);
          p.openingCash = opening;
          p.locOpeningBalance = loc;
          p.payroll = { amount: payrollAmt, firstWeek: payrollWk };
          p.k401 = { amount: k401Amt };
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
            s.receivables.push({ id: uid("ar"), customer: group, txnType: "Invoice", date, docNumber: doc, poNumber: host.querySelector("#m-po").value.trim(), dueDate: null, age: 0, balance: bal, originalBalance: bal, payments: [], status: "open", cfDate: null, daysOverride: null, source: "manual" });
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
    const isBinaryWorkbook = /\.xlsx?$/i.test(file.name);
    const parsed = isBinaryWorkbook
      ? parseAgingWorkbook(await file.arrayBuffer(), kind)
      : parseAgingReport(await file.text(), kind);
    if (!parsed.length) { toast("No open invoices found in that file", "error"); return; }
    store.mutate((s) => {
      const { added, updated, paidOff } = mergeAgingImport(s, kind, parsed);
      toast(`Imported ${kind}: ${added} new, ${updated} updated, ${paidOff} marked paid`, "success", 5000);
    });
  } catch (err) {
    toast(err.message || "Import failed", "error", 6000);
  }
}
