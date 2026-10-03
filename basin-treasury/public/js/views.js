import { fmtMoney, fmtMoneyCompact, fmtDate, fmtDateShort, escapeHtml, toast, openModal, closeModal, uid, todayISO, toISO, addDays, parseISO, daysBetween, sum } from "./util.js";
import {
  periodWeeks, computeForecast, weekIndexForDate, weekIndexForDateStrict, fixedOccurrencesInPeriod, scheduleLabel,
  FIXED_CATEGORY_ORDER, makePeriod, mergeAgingImport, createUnbilledLines, applyAutoScheduleToAll, applyAutoScheduleToGroup, readOv, payrollWeeksFor, k401WeeksFor, weekAmountFor,
  effectivePayableDate, rollForwardPeriod, KIND_MAP, WEEKS_PER_PERIOD, recordTombstone, interestForAccount,
  UNBILLED_REVENUE_SECTIONS, makeUnbilledRevenueItem, unbilledRevenueItemTotal, blankInvoice, unbilledRevenueOccurrencesInPeriod, recordPwpMemory,
  ACCOUNTS, accountName, computeForecastForAccount, computeSimpleAccountForecast,
} from "./state.js";
import { parseAgingReport, parseAgingWorkbook, parseRevenueForecastReport, parseRevenueForecastWorkbook } from "./parser.js";

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

function openTransferModal(store, period, accountId, wi, direction, weeksMeta) {
  const { state } = store;
  const week = weeksMeta[wi];
  const otherAccounts = ACCOUNTS.filter((a) => a.id !== accountId);
  const existingManual = state.transfers.filter((t) => {
    if (weekIndexForDate(period, t.date) !== wi) return false;
    return direction === "in" ? t.toAccount === accountId : t.fromAccount === accountId;
  });

  const render = () => `
    <button type="button" class="modal-close-x" id="tr-close">✕</button>
    <h3>⇄ ${direction === "in" ? "Transfers In" : "Transfers Out"} — ${escapeHtml(accountName(accountId))}</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">${fmtDateShort(week.start)} – ${fmtDateShort(week.end)}. A transfer here shows up automatically on the other account too.</div>
    <div class="breakdown-modal-body" style="margin-bottom:14px;">
      ${existingManual.length ? existingManual.map((t) => `
        <div class="vendor-rank">
          <span>${direction === "in" ? "From" : "To"} ${escapeHtml(accountName(direction === "in" ? t.fromAccount : t.toAccount))}${t.note ? ` <span style="color:var(--text-dim);">· ${escapeHtml(t.note)}</span>` : ""}</span>
          <span class="amt">${fmtMoney(t.amount)} <button type="button" class="mini-btn tr-delete" data-id="${t.id}" style="margin-left:8px;">Delete</button></span>
        </div>
      `).join("") : `<div class="meta">No manual transfers yet this week.</div>`}
    </div>
    <div class="row"><label>Add a transfer — ${direction === "in" ? "From" : "To"} Account</label>
      <select id="tr-counterpart">${otherAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}</select>
    </div>
    <div class="row"><label>Amount</label><input id="tr-amount" type="number" step="0.01" placeholder="0.00" /></div>
    <div class="row"><label>Note (optional)</label><input id="tr-note" placeholder="e.g. Sweep idle cash" /></div>
    <div class="desc" style="font-size:11px;color:var(--text-dim);margin-top:-6px;">Need this to repeat every month? Set it up as a Fixed Payment instead, with From/To accounts.</div>
    <div class="modal-actions">
      <button class="btn-ghost" id="tr-cancel">Cancel</button>
      <button class="btn-primary" id="tr-add" style="width:auto;">Add Transfer</button>
    </div>
  `;

  const wire = (host) => {
    host.querySelector("#tr-close").onclick = closeModal;
    host.querySelector("#tr-cancel").onclick = closeModal;
    host.querySelectorAll(".tr-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        store.mutate((s) => {
          recordTombstone(s, "transfers", btn.dataset.id);
          s.transfers = s.transfers.filter((t) => t.id !== btn.dataset.id);
        });
        openTransferModal(store, period, accountId, wi, direction, weeksMeta);
      });
    });
    host.querySelector("#tr-add").onclick = () => {
      const counterpart = host.querySelector("#tr-counterpart").value;
      const amount = parseFloat(host.querySelector("#tr-amount").value || "0");
      const note = host.querySelector("#tr-note").value.trim();
      if (!amount || amount <= 0) { toast("Enter an amount greater than $0", "error"); return; }
      store.mutate((s) => {
        const rec = {
          id: uid("tr"),
          fromAccount: direction === "in" ? counterpart : accountId,
          toAccount: direction === "in" ? accountId : counterpart,
          amount: Math.round(amount * 100) / 100,
          date: week.payRun, note, source: "manual",
          lastEditBy: store.initials(), updatedAt: new Date().toISOString(),
        };
        s.transfers.push(rec);
      });
      openTransferModal(store, period, accountId, wi, direction, weeksMeta);
    };
  };

  openModal(render(), { closeOnBackdrop: false, onMount: wire });
}

function icAccountTag(items) {
  if (!items || !items.length) return "";
  const names = Array.from(new Set(items.map((it) => accountName(it.counterpart))));
  const label = names.length === 1 ? names[0] : `${names.length} accounts`;
  return `<div class="ic-account-tag" title="${escapeHtml(names.join(", "))}">${escapeHtml(label)}</div>`;
}

function rowValue(weeksRows, rowType, cat, wi) {
  const r = weeksRows[wi];
  return {
    receivablesCollected: r.receivablesCollected,
    otherInflows: r.otherInflows,
    manual: r.manualOutflows[cat],
    fixed: r.fixedRows[cat],
    apPayables: r.apPayables,
    projectedAP: r.projectedAP,
    locDraw: r.locDraw,
  }[rowType];
}

function overrideEntry(overrides, rowType, cat, wi, period) {
  if (rowType === "receivablesCollected") return overrides.receivablesCollected[wi];
  if (rowType === "otherInflows") return overrides.otherInflows[wi];
  if (rowType === "manual") return overrides.manualOutflow?.[cat]?.[wi];
  if (rowType === "fixed") return overrides.fixedGroup?.[cat]?.[wi];
  if (rowType === "apPayables") return overrides.apPayables[wi];
  if (rowType === "locDraw") return overrides.locDraw[wi];
  if (rowType === "projectedAP") return period?.projectedAP?.[wi];
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
  if (rowType === "projectedAP") { period.projectedAP = period.projectedAP || {}; setOrDel(period.projectedAP, wi, stamped); }
}

function noteKey(rowType, cat, wi) {
  const base = cat ? `${rowType}::${cat}` : rowType;
  return wi === undefined || wi === null ? base : `${base}::${wi}`;
}

function labelCell(period, label, rowType, cat, editable) {
  const labelSpan = editable
    ? `<span class="row-label-text clickable" data-row="${escapeHtml(rowType)}" data-cat="${escapeHtml(cat || "")}" title="Click to enter all ${WEEKS_PER_PERIOD} weeks at once">${escapeHtml(label)}</span>`
    : `<span class="row-label-text">${escapeHtml(label)}</span>`;
  return `<td>${labelSpan}</td>`;
}

function receivablesBreakdown(state, period, wi, accountFilter = null /* e.g. "basin-checking" to scope to just that account's own forecast */) {
  const matchesFor = (r) => {
    if (accountFilter && (r.depositAccount || "basin-checking") !== accountFilter) return false;
    const idx = r.status === "paid" ? weekIndexForDateStrict(period, r.cfDate) : weekIndexForDate(period, r.cfDate);
    if (idx === null) return false;
    return wi === null ? true : idx === wi;
  };

  const paid = [];
  const open = [];
  for (const r of state.receivables) {
    if (!matchesFor(r)) continue;
    const paidSoFar = (r.payments || []).reduce((a, p) => a + p.amount, 0);
    if (r.status === "paid") {
      paid.push({ ...r, balance: r.originalBalance ?? r.balance });
    } else if (r.status === "open") {
      if (paidSoFar > 0) paid.push({ ...r, balance: paidSoFar, docNumber: `${r.docNumber || ""} (partial)` });
      open.push(r);
    }
  }
  for (const u of state.unbilledReceivables || []) {
    if (u.status !== "open" || !matchesFor(u)) continue;
    open.push({ ...u, customer: `${u.customer} (unbilled)`, docNumber: u.project || "" });
  }

  // New Unbilled Revenue sections (Fixed Price Backlog, T&M, Frontlog, Small
  // Quick Jobs, WIP, Other) — these always flow into Basin Checking (no
  // per-item deposit account), so only include them for that account's
  // breakdown, or the unfiltered AR-tab view.
  if (!accountFilter || accountFilter === "basin-checking") {
    const secLabel = Object.fromEntries(UNBILLED_REVENUE_SECTIONS.map((s) => [s.id, s.label]));
    for (const occ of unbilledRevenueOccurrencesInPeriod(state, period)) {
      if (wi !== null && occ.wi !== wi) continue;
      const item = (state.unbilledRevenue || []).find((i) => i.id === occ.itemId);
      const inv = item?.invoices?.[occ.invoiceIdx];
      open.push({ customer: `${secLabel[occ.section] || occ.section} (unbilled revenue)`, docNumber: occ.name, date: inv?.invoiceDate, balance: occ.amount });
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
    .map((r) => `<div class="bd-row ${cls}"><span class="bd-name">${cls === "paid" ? "✓ " : ""}${escapeHtml(r.customer)}<span class="bd-inv">${escapeHtml(r.docNumber || "")}${r.date ? ` · ${fmtDate(r.date)}` : ""}</span></span><span class="bd-amt">${fmtMoney(r.balance)}</span></div>`)
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

function apPayablesBreakdown(state, period, wi) {
  const matches = (p) => {
    const eff = effectivePayableDate(state, period, p);
    const idx = p.status === "paid" ? weekIndexForDateStrict(period, eff) : weekIndexForDate(period, eff);
    return idx === wi;
  };
  const paidByVendor = {}, openByVendor = {};
  for (const p of state.payables) {
    if (!matches(p)) continue;
    const bucket = p.status === "paid" ? paidByVendor : openByVendor;
    bucket[p.vendor] = (bucket[p.vendor] || 0) + (p.originalBalance ?? p.balance);
  }
  const toList = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({ name, amount }));
  const paid = toList(paidByVendor);
  const open = toList(openByVendor);
  const totalPaid = paid.reduce((a, x) => a + x.amount, 0);
  const totalOpen = open.reduce((a, x) => a + x.amount, 0);
  const totalAll = totalPaid + totalOpen;
  const pct = totalAll > 0 ? Math.round((totalPaid / totalAll) * 100) : 0;
  return { paid, open, totalPaid, totalOpen, totalAll, pct };
}

function apPayablesBreakdownPopupHTML(bd, label) {
  const rowsHtml = (list, cls) => list
    .map((v) => `<div class="bd-row ${cls}"><span class="bd-name">${cls === "paid" ? "✓ " : ""}${escapeHtml(v.name)}</span><span class="bd-amt">${fmtMoney(v.amount)}</span></div>`)
    .join("");
  return `
    <div class="bd-header">${escapeHtml(label)}</div>
    <div class="bd-progress"><div class="bd-progress-fill" style="width:${bd.pct}%"></div></div>
    <div class="bd-summary">${fmtMoney(bd.totalPaid)} paid of ${fmtMoney(bd.totalAll)} <span class="bd-pct">(${bd.pct}%)</span></div>
    ${bd.paid.length ? `<div class="bd-section-label">Paid</div>${rowsHtml(bd.paid, "paid")}` : ""}
    ${bd.open.length ? `<div class="bd-section-label">Not Yet Paid</div>${rowsHtml(bd.open, "open")}` : ""}
    ${!bd.open.length && !bd.paid.length ? `<div class="bd-empty">No payables scheduled this week</div>` : ""}
  `;
}

function fixedBreakdown(state, period, rowType, cat, wi) {
  if (rowType === "apPayables") {
    // used for the "Total" column call site, which sums breakdowns across all 5
    // weeks — the per-week cells use apPayablesBreakdown (vendor-grouped, paid/unpaid) instead
    const list = state.payables.filter((p) => weekIndexForDate(period, effectivePayableDate(state, period, p)) === wi);
    return { items: list.map((p) => ({ name: p.vendor, sub: p.docNumber + (p.payWhenPaid ? " · PWP" : ""), amount: (p.originalBalance ?? p.balance) })), total: list.reduce((a, p) => a + (p.originalBalance ?? p.balance), 0) };
  }
  if (cat === "Payroll" || cat === "401K") {
    const bucket = cat === "Payroll" ? period.payroll : period.k401;
    const isScheduledWeek = cat === "Payroll" ? payrollWeeksFor(period).includes(wi) : k401WeeksFor(period).includes(wi);
    const amt = weekAmountFor(bucket, wi);
    const isOverride = bucket?.weekAmounts?.[wi] !== undefined && bucket.weekAmounts[wi] !== null;
    if (isScheduledWeek && amt) return { items: [{ name: cat === "Payroll" ? "Payroll run" : "401K contribution", sub: isOverride ? "custom amount this week" : "selected week", amount: amt }], total: amt };
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



// Recomputes Basin Checking's totals over just the weeks currently being
// viewed, so "Total" always matches whatever week-columns are on screen
// instead of silently including weeks the 6-week view hides.
function sliceTotals(weeks) {
  const manualCats = new Set();
  const fixedCats = new Set();
  weeks.forEach((w) => {
    Object.keys(w.manualOutflows || {}).forEach((c) => manualCats.add(c));
    Object.keys(w.fixedRows || {}).forEach((c) => fixedCats.add(c));
  });
  return {
    opening: weeks[0]?.opening ?? 0,
    closing: weeks[weeks.length - 1]?.closing ?? 0,
    receivablesCollected: sum(weeks.map((r) => r.receivablesCollected)),
    otherInflows: sum(weeks.map((r) => r.otherInflows)),
    totalInflows: sum(weeks.map((r) => r.totalInflows)),
    manualOutflows: Object.fromEntries(Array.from(manualCats).map((c) => [c, sum(weeks.map((r) => r.manualOutflows[c] || 0))])),
    manualTotal: sum(weeks.map((r) => r.manualTotal)),
    fixedRows: Object.fromEntries(Array.from(fixedCats).map((c) => [c, sum(weeks.map((r) => r.fixedRows[c] || 0))])),
    fixedTotal: sum(weeks.map((r) => r.fixedTotal)),
    apPayables: sum(weeks.map((r) => r.apPayables)),
    projectedAP: sum(weeks.map((r) => r.projectedAP)),
    totalOutflows: sum(weeks.map((r) => r.totalOutflows)),
    netCashflow: sum(weeks.map((r) => r.netCashflow)),
    locDraw: sum(weeks.map((r) => r.locDraw)),
    locBalance: weeks[weeks.length - 1]?.locBalance ?? 0,
    interCompanyIn: sum(weeks.map((r) => r.interCompanyIn)),
    interCompanyOut: sum(weeks.map((r) => r.interCompanyOut)),
  };
}

// Same idea, for the 4 simplified accounts.
// Builds the chart HTML plus the point geometry, so the caller can wire up
// hover-anywhere-snaps-to-nearest-point behavior afterward (a plain string
// can't carry JS listeners, and native per-dot <title> tooltips require a
// precise hover directly on a tiny circle, which is what this replaces).
function urvSparklineSVG(values, weeksMeta, chartId, opts = {}) {
  const showAxes = !!opts.showAxes;
  // extra room reserved for the $1M gridline labels (left) and month labels (bottom)
  const axisPadLeft = showAxes ? 48 : 0;
  const axisPadBottom = showAxes ? 18 : 0;
  const W = opts.W || 280, H = opts.H || 72;
  const padX = (opts.padX ?? 8) + axisPadLeft, padY = opts.padY ?? 10;
  const plotBottom = H - padY - axisPadBottom;
  const n = values.length;
  // fromZero:false scales min-to-max instead of 0-to-max — matters for large,
  // relatively stable balances, where scaling from zero would flatten real
  // week-to-week variation into a nearly invisible line.
  const lo = opts.fromZero === false ? Math.min(...values) : 0;
  const hi = Math.max(...values, lo + 1); // avoid divide-by-zero when flat
  const range = hi - lo;
  const stepX = n > 1 ? (W - padX - (opts.padX ?? 8)) / (n - 1) : 0;
  // opts.annotations: [{ wi, amount, label }] — e.g. a distribution that
  // week. Rendered as a small downward marker under that point, and folded
  // into the hover tooltip so it's unmistakably an outflow pulling the
  // balance down, not just a dip in the line.
  const annByWi = {};
  for (const a of opts.annotations || []) annByWi[a.wi] = a;
  const fmt = opts.compact ? fmtMoneyCompact : fmtMoney;
  const points = values.map((v, i) => ({
    x: padX + i * stepX,
    y: plotBottom - ((v - lo) / range) * (plotBottom - padY),
    v, i,
    label: weeksMeta[i] ? `Week of ${fmtDateShort(weeksMeta[i].start)}` : `Week ${i + 1}`,
    annotation: annByWi[i] || null,
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const baseline = plotBottom;
  const areaD = `${pathD} L${points[points.length - 1].x.toFixed(1)},${baseline} L${points[0].x.toFixed(1)},${baseline} Z`;
  const dots = points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="urv-chart-dot" data-idx="${p.i}"/>`).join("");
  const markers = points.filter((p) => p.annotation).map((p) => `
    <g class="urv-outflow-marker" transform="translate(${p.x.toFixed(1)},${(p.y + 11).toFixed(1)})" title="${escapeHtml(p.annotation.label)}: -${fmt(p.annotation.amount)}">
      <circle r="7" class="urv-outflow-marker-bg"/>
      <path d="M-2.5,-2.5 L0,2.5 L2.5,-2.5" class="urv-outflow-marker-arrow"/>
    </g>`).join("");

  // $1M gridlines on the left, month markers along the bottom — opt-in only.
  let axesHtml = "";
  if (showAxes) {
    const STEP = 1000000;
    const gridLines = [];
    const firstLine = Math.ceil(lo / STEP) * STEP;
    for (let v = firstLine; v <= hi; v += STEP) {
      const y = plotBottom - ((v - lo) / range) * (plotBottom - padY);
      gridLines.push(`
        <line x1="${padX}" y1="${y.toFixed(1)}" x2="${W - (opts.padX ?? 8)}" y2="${y.toFixed(1)}" class="urv-axis-gridline"/>
        <text x="${(padX - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="urv-axis-label">$${Math.round(v / 1000000)}M</text>`);
    }
    const monthLabels = points.filter((p, i) => {
      const wk = weeksMeta[i];
      if (!wk) return false;
      const d = parseISO(wk.start);
      const prevWk = weeksMeta[i - 1];
      return i === 0 || (prevWk && parseISO(prevWk.start).getMonth() !== d.getMonth());
    }).map((p) => {
      const d = parseISO(weeksMeta[p.i].start);
      const label = d.toLocaleDateString("en-US", { month: "short" });
      return `<text x="${p.x.toFixed(1)}" y="${(plotBottom + 13).toFixed(1)}" text-anchor="middle" class="urv-axis-label">${label}</text>`;
    }).join("");
    axesHtml = `<g class="urv-axes">${gridLines.join("")}${monthLabels}</g>`;
  }

  const html = `<div class="urv-chart-wrap" data-chart="${chartId}">
    <svg viewBox="0 0 ${W} ${H}" class="urv-sparkline" preserveAspectRatio="none">
      ${axesHtml}
      <path d="${areaD}" class="urv-chart-area"/>
      <path d="${pathD}" class="urv-chart-line"/>
      <line class="urv-chart-vline" x1="0" y1="${padY - 4}" x2="0" y2="${baseline}"/>
      ${dots}
      ${markers}
      <rect class="urv-chart-hitbox" x="${padX - (opts.padX ?? 8)}" y="0" width="${W - padX + (opts.padX ?? 8)}" height="${H}" data-chart="${chartId}"/>
    </svg>
    <div class="urv-chart-tooltip" id="urv-tooltip-${chartId}"></div>
  </div>`;
  return { html, points, W, H };
}

// Combined Inflow/Outflow/Net chart — three series sharing one set of axes
// and a zero-line, so they read as one visual rather than three separate charts.
// One bar per week — Net cashflow only. Green above the zero-line when
// positive, red below when negative. Nothing else competing for attention;
// hover reveals the Inflow/Outflow split behind that week's number.
function cfNetBarChartSVG(weeklyInflow, weeklyOutflow, weeklyNet, weeksMeta, chartId, opts = {}) {
  const W = opts.W || 900, H = opts.H || 190, padX = opts.padX ?? 18, padY = opts.padY ?? 16;
  const n = weeklyNet.length;
  const maxMag = Math.max(...weeklyNet.map(Math.abs), 1);
  const lo = -maxMag, hi = maxMag, range = hi - lo;
  const stepX = n > 1 ? (W - padX * 2) / (n - 1) : 0;
  const yFor = (v) => H - padY - ((v - lo) / range) * (H - padY * 2);
  const zeroY = yFor(0);
  const barW = Math.max(10, Math.min(44, stepX * 0.6));

  const weekLabel = (i) => weeksMeta[i] ? `Week of ${fmtDateShort(weeksMeta[i].start)}` : `Week ${i + 1}`;

  const bars = weeklyNet.map((net, i) => {
    const x = padX + i * stepX;
    const y = yFor(net);
    const cls = net >= 0 ? "cf-net-bar-pos" : "cf-net-bar-neg";
    return `<rect x="${(x - barW / 2).toFixed(1)}" y="${Math.min(y, zeroY).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, Math.abs(zeroY - y)).toFixed(1)}" class="cf-net-bar ${cls}" data-idx="${i}"/>`;
  }).join("");

  const html = `<div class="urv-chart-wrap cf-combo-wrap" data-chart="${chartId}">
    <svg viewBox="0 0 ${W} ${H}" class="urv-sparkline cf-combo-svg" preserveAspectRatio="none">
      <line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${W - padX}" y2="${zeroY.toFixed(1)}" class="cf-combo-zero"/>
      ${bars}
      <line class="urv-chart-vline" x1="0" y1="${padY - 4}" x2="0" y2="${H - padY}"/>
      <rect class="urv-chart-hitbox" x="0" y="0" width="${W}" height="${H}" data-chart="${chartId}"/>
    </svg>
  </div>`;
  const points = weeklyNet.map((net, i) => ({ i, inflow: weeklyInflow[i], outflow: weeklyOutflow[i], net, x: padX + i * stepX, label: weekLabel(i) }));
  return { html, W, H, points };
}

// Hover wiring — updates a FIXED info readout (never clips or overlaps,
// unlike a tooltip that follows the cursor) with all three values for
// whichever week is nearest the cursor.
function wireCfComboHover(host, chartId, points, W, infoElId, compact) {
  const wrap = host.querySelector(`.urv-chart-wrap[data-chart="${chartId}"]`);
  const infoEl = document.getElementById(infoElId);
  if (!wrap || !infoEl) return;
  const svg = wrap.querySelector(".urv-sparkline");
  const hitbox = wrap.querySelector(".urv-chart-hitbox");
  const vline = wrap.querySelector(".urv-chart-vline");
  const fmt = compact ? fmtMoneyCompact : fmtMoney;
  const defaultHtml = infoEl.innerHTML;

  const showNearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * W;
    let nearest = points[0], minDist = Infinity;
    for (const p of points) { const d = Math.abs(p.x - svgX); if (d < minDist) { minDist = d; nearest = p; } }
    svg.querySelectorAll(".cf-net-bar").forEach((b) => b.classList.toggle("active", Number(b.dataset.idx) === nearest.i));
    vline.setAttribute("x1", nearest.x); vline.setAttribute("x2", nearest.x);
    vline.style.display = "block";
    infoEl.innerHTML = `<span class="cf-hover-week">${escapeHtml(nearest.label)}</span>
      <span class="cf-combo-legend-item"><span class="dot" style="background:var(--green);"></span>In <b class="green">${fmt(nearest.inflow)}</b></span>
      <span class="cf-combo-legend-item"><span class="dot" style="background:var(--red);"></span>Out <b class="red">${fmt(nearest.outflow)}</b></span>
      <span class="cf-combo-legend-item"><span class="dot" style="background:var(--brass-bright);"></span>Net <b class="${nearest.net >= 0 ? "green" : "red"}">${fmt(nearest.net)}</b></span>`;
  };
  const hide = () => {
    svg.querySelectorAll(".cf-net-bar").forEach((b) => b.classList.remove("active"));
    vline.style.display = "none";
    infoEl.innerHTML = defaultHtml;
  };
  hitbox.addEventListener("mousemove", (e) => showNearest(e.clientX));
  hitbox.addEventListener("mouseleave", hide);
}

// Hover anywhere over a chart's hitbox and snap to whichever week's point is
// nearest the cursor's x position — no need to land precisely on a dot.
function moneyBagSVG(pct, idSuffix) {
  const clipId = `bagclip-${idSuffix}`;
  const bagPath = "M36,22 C20,30 8,50 10,70 C12,92 30,106 50,106 C70,106 88,92 90,70 C92,50 80,30 64,22 L36,22 Z";
  const tiePath = "M42,13 Q50,6 58,13 L64,22 L36,22 Z";
  const clampedPct = Math.max(0, Math.min(100, pct));
  const fillY = 106 - (106 - 16) * (clampedPct / 100); // rises from the bottom (106) toward the neck (16) as pct climbs
  return `<svg viewBox="0 0 100 112" class="money-bag-svg">
    <defs><clipPath id="${clipId}"><path d="${bagPath}"/></clipPath></defs>
    <path d="${bagPath}" class="bag-outline"/>
    <g clip-path="url(#${clipId})">
      <rect x="0" y="${fillY.toFixed(1)}" width="100" height="112" class="bag-fill"/>
      <rect x="0" y="${(fillY - 3).toFixed(1)}" width="100" height="3" class="bag-fill-shimmer"/>
    </g>
    <path d="${bagPath}" class="bag-outline-top"/>
    <path d="${tiePath}" class="bag-tie"/>
    <text x="50" y="72" text-anchor="middle" class="bag-dollar">$</text>
  </svg>`;
}

function wireUrvChartHover(host, chartId, points, W, opts = {}) {
  const wrap = host.querySelector(`.urv-chart-wrap[data-chart="${chartId}"]`);
  if (!wrap) return;
  const svg = wrap.querySelector(".urv-sparkline");
  const hitbox = wrap.querySelector(".urv-chart-hitbox");
  const vline = wrap.querySelector(".urv-chart-vline");
  const tooltip = wrap.querySelector(`#urv-tooltip-${chartId}`);
  const fmt = opts.compact ? fmtMoneyCompact : fmtMoney;

  const showNearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * W;
    let nearest = points[0], minDist = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - svgX);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    svg.querySelectorAll(".urv-chart-dot").forEach((d) => d.classList.toggle("active", Number(d.dataset.idx) === nearest.i));
    vline.setAttribute("x1", nearest.x); vline.setAttribute("x2", nearest.x);
    vline.style.display = "block";
    const base = `${nearest.label}: ${fmt(nearest.v)}`;
    tooltip.textContent = nearest.annotation ? `${base}  ·  ${nearest.annotation.label}: -${fmt(nearest.annotation.amount)} (outflow)` : base;
    tooltip.classList.toggle("has-outflow", !!nearest.annotation);
    tooltip.style.left = `${(nearest.x / W) * 100}%`;
    tooltip.style.display = "block";
  };
  const hide = () => {
    svg.querySelectorAll(".urv-chart-dot").forEach((d) => d.classList.remove("active"));
    vline.style.display = "none";
    tooltip.style.display = "none";
  };
  hitbox.addEventListener("mousemove", (e) => showNearest(e.clientX));
  hitbox.addEventListener("mouseleave", hide);
}

// Revamped CF Forecast KPI row — icons, a color accent bar per card, and a
// small embedded trend line showing the weekly shape behind each total
// (Opening Cash is a single starting value, so it skips the chart).
function renderCfKpiCards(containerId, chartPrefix, weeksMeta, weekly, totals) {
  const host = document.getElementById(containerId);
  if (!host) return;
  const netTotal = totals.net;
  const miniChart = (values, key, fromZero) => urvSparklineSVG(values, weeksMeta, `${chartPrefix}-${key}`, { W: 150, H: 36, padX: 3, padY: 4, fromZero });

  const closeChart = miniChart(weekly.closing, "close", false);
  const comboChart = cfNetBarChartSVG(weekly.inflow, weekly.outflow, weekly.net, weeksMeta, `${chartPrefix}-combo`, { W: 620, H: 170, padX: 14, padY: 14 });
  const legendId = `${chartPrefix}-combo-legend`;

  const distTotal = sum(weekly.distribution || []);
  const distChart = miniChart((weekly.distribution || []).map((v) => Math.abs(v)), "dist", true);

  host.innerHTML = `
    <div class="stat-card kpi-card sc-open">
      <div class="kpi-icon">◇</div>
      <div class="kpi-body"><div class="label">Opening Cash</div><div class="value">${fmtMoney(totals.opening)}</div></div>
    </div>
    <div class="stat-card kpi-card cf-combo-card">
      <div class="cf-combo-legend" id="${legendId}">
        <span class="cf-combo-legend-item"><span class="dot" style="background:var(--green);"></span>Inflows <b class="green">${fmtMoney(totals.inflow)}</b></span>
        <span class="cf-combo-legend-item"><span class="dot" style="background:var(--red);"></span>Outflows <b class="red">${fmtMoney(totals.outflow)}</b></span>
        <span class="cf-combo-legend-item"><span class="dot" style="background:var(--brass-bright);"></span>Net <b class="${netTotal >= 0 ? "green" : "red"}">${fmtMoney(netTotal)}</b></span>
      </div>
      ${comboChart.html}
    </div>
    <div class="stat-card kpi-card sc-close">
      <div class="kpi-icon">◆</div>
      <div class="kpi-body"><div class="label">Closing Cash</div><div class="value brass">${fmtMoney(totals.closing)}</div></div>
      <div class="kpi-mini-chart">${closeChart.html}</div>
    </div>
    <div class="stat-card kpi-card sc-unc">
      <div class="kpi-icon">↓</div>
      <div class="kpi-body"><div class="label">Distributions</div><div class="value amber">${fmtMoney(distTotal)}</div></div>
      <div class="kpi-mini-chart">${distChart.html}</div>
    </div>
  `;
  wireCfComboHover(host, `${chartPrefix}-combo`, comboChart.points, comboChart.W, legendId, true);
  wireUrvChartHover(host, `${chartPrefix}-close`, closeChart.points, closeChart.W);
  wireUrvChartHover(host, `${chartPrefix}-dist`, distChart.points, distChart.W);
}

function sliceSimpleTotals(weeks) {
  return {
    opening: weeks[0]?.opening ?? 0,
    closing: weeks[weeks.length - 1]?.closing ?? 0,
    inflowTotal: sum(weeks.map((w) => w.inflowTotal)),
    outflowTotal: sum(weeks.map((w) => w.outflowTotal)),
    netCashflow: sum(weeks.map((w) => w.netCashflow)),
  };
}

const SIMPLE_OPENING_KEY = { "pc-checking": "pcOpeningCash", "eb-savings": "ebOpeningCash", "basin-savings": "basinSavingsOpeningCash", "pc-savings": "pcSavingsOpeningCash" };

function writeSimpleTransferField(period, accountId, key, wi, stamped) {
  if (key === "pcOtherOutflow") { period.pcOtherOutflow = period.pcOtherOutflow || {}; setOrDel(period.pcOtherOutflow, wi, stamped); }
  if (key === "basinSavingsDistributions") { period.basinSavingsDistributions = period.basinSavingsDistributions || {}; setOrDel(period.basinSavingsDistributions, wi, stamped); }
}

function renderSimpleAccountForecast(store, period, accountId) {
  const { state } = store;
  const calc = computeSimpleAccountForecast(state, period, accountId);
  const weeks = calc.weeks.slice(0, cfViewWeeks);
  const weeksMeta = periodWeeks(period).slice(0, cfViewWeeks);
  calc.totals = sliceSimpleTotals(weeks);
  const name = accountName(accountId);
  const openingKey = SIMPLE_OPENING_KEY[accountId];

  document.getElementById("forecast-title").textContent = `${name} — ${period.label}`;
  document.getElementById("forecast-eyebrow").textContent = `${cfViewWeeks}-Week View · Starts ${fmtDate(period.startDate)}`;
  document.getElementById("forecast-meta").textContent = accountId === "eb-savings"
    ? "No activity except the monthly transfer in from Basin Checking."
    : `Pay runs: ${weeksMeta.map((w) => fmtDate(w.payRun)).join(", ")}`;

  renderCfKpiCards("forecast-stats", "simple", weeksMeta, {
    inflow: weeks.map((w) => w.inflowTotal),
    outflow: weeks.map((w) => w.outflowTotal),
    net: weeks.map((w) => w.netCashflow),
    closing: weeks.map((w) => w.closing),
    distribution: weeks.map((w) => w.outflows.find((o) => o.key === "basinSavingsDistributions")?.amount || 0),
  }, {
    opening: calc.totals.opening, inflow: calc.totals.inflowTotal, outflow: calc.totals.outflowTotal,
    net: calc.totals.netCashflow, closing: calc.totals.closing,
  });

  // union of row keys that appear in ANY week, so every week shows the same rows even if a value is 0
  const inflowKeys = [], outflowKeys = [];
  weeks.forEach((w) => {
    w.inflows.forEach((r) => { if (!inflowKeys.find((k) => k.key === r.key)) inflowKeys.push(r); });
    w.outflows.forEach((r) => { if (!outflowKeys.find((k) => k.key === r.key)) outflowKeys.push(r); });
  });

  const rowHtml = (rowMeta, bucket, extraClass) => {
    const label = rowMeta.label;
    const cells = weeks.map((w, wi) => {
      const item = w[bucket].find((r) => r.key === rowMeta.key);
      const val = item ? item.amount : 0;
      const tag = rowMeta.isTransfer ? icAccountTag(w.interCompanyItems?.[bucket === "inflows" ? "inflow" : "outflow"] || []) : "";
      return rowMeta.editable ? `<td class="ed" data-wi="${wi}" data-key="${rowMeta.key}">${fmtMoney(val)}</td>` : `<td>${fmtMoney(val)}${tag}</td>`;
    }).join("");
    const total = sum(weeks.map((w) => (w[bucket].find((r) => r.key === rowMeta.key)?.amount) || 0));
    return `<tr class="${extraClass}" data-simple-row="${rowMeta.key}"><td><span class="row-label-text">${escapeHtml(label)}</span></td>${cells}<td>${fmtMoney(total)}</td></tr>`;
  };

  const table = document.getElementById("cf-grid");
  table.innerHTML = `
    <thead><tr><th>Line Item</th>${weekHeaderCells(weeksMeta)}<th>Total</th></tr></thead>
    <tbody>
      <tr class="section-label"><td colspan="${weeks.length + 2}">Opening Balance</td></tr>
      <tr class="opening"><td><span class="row-label-text">Opening Cash</span></td>${weeks.map((r, wi) => wi === 0 ? `<td class="ed opening-open" data-wi="0">${fmtMoney(r.opening)}</td>` : `<td>${fmtMoney(r.opening)}</td>`).join("")}<td>${fmtMoney(calc.totals.opening)}</td></tr>

      <tr class="section-label sec-inflow"><td colspan="${weeks.length + 2}">Cash Inflow</td></tr>
      ${inflowKeys.map((rk) => rowHtml(rk, "inflows", "inflow-row")).join("")}

      <tr class="section-label sec-outflow-fixed"><td colspan="${weeks.length + 2}">Cash Outflow</td></tr>
      ${outflowKeys.map((rk) => rowHtml(rk, "outflows", "fixed-row")).join("")}

      <tr class="net"><td><span class="row-label-text">Net Cashflow</span></td>${weeks.map((r) => `<td class="${r.netCashflow >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(r.netCashflow)}</td>`).join("")}<td class="${netTotal >= 0 ? "value-pos" : "value-neg"}">${fmtMoney(netTotal)}</td></tr>

      <tr class="section-label"><td colspan="${weeks.length + 2}">Closing Balance</td></tr>
      <tr class="closing"><td><span class="row-label-text">Closing Cash</span></td>${weeks.map((r) => `<td>${fmtMoney(r.closing)}</td>`).join("")}<td>${fmtMoney(calc.totals.closing)}</td></tr>
    </tbody>
  `;

  // wire the Opening Cash cell (week 1 only)
  table.querySelector("td.opening-open")?.addEventListener("click", function handler() {
    editableCell(this, period[openingKey] || 0, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        per[openingKey] = val ?? 0;
      });
    }, { title: `Click to set ${name}'s opening cash for this period` });
    this.removeEventListener("click", handler);
  }, { once: true });

  // wire every editable inflow/outflow cell
  table.querySelectorAll("td.ed[data-key]").forEach((td) => {
    const key = td.dataset.key;
    const wi = Number(td.dataset.wi);
    const bucket = inflowKeys.find((k) => k.key === key) ? "inflows" : "outflows";
    const item = weeks[wi][bucket].find((r) => r.key === key);
    editableCell(td, item ? item.amount : 0, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const stamped = val === null ? null : { v: val, by: store.initials(), at: new Date().toISOString() };
        writeSimpleTransferField(per, accountId, key, wi, stamped);
      });
    });
  });

  table.querySelectorAll('tr[data-simple-row="interCompanyIn"] td, tr[data-simple-row="interCompanyOut"] td').forEach((td, idx, list) => {
    // skip the label cell (first column) and the Total column (last)
    const tr = td.closest("tr");
    const cellIndex = Array.from(tr.children).indexOf(td);
    if (cellIndex === 0 || cellIndex === tr.children.length - 1) return;
    const wi = cellIndex - 1;
    const direction = tr.dataset.simpleRow === "interCompanyIn" ? "in" : "out";
    td.style.cursor = "pointer";
    td.addEventListener("click", () => openTransferModal(store, period, accountId, wi, direction, weeksMeta));
  });

  requestAnimationFrame(syncStickyOffsets);
}

export function renderHome(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeksMetaForChart = periodWeeks(period).slice(0, cfViewWeeks);
  document.getElementById("home-meta").textContent = `${period.label} · ${cfViewWeeks}-week view · Starts ${fmtDate(period.startDate)}`;

  document.querySelectorAll(".weeks-toggle-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.weeks) === cfViewWeeks));
  document.querySelectorAll("#home-weeks-toggle-group .weeks-toggle-btn").forEach((b) => {
    b.onclick = () => {
      setGlobalViewWeeks(Number(b.dataset.weeks));
      document.querySelectorAll(".weeks-toggle-btn").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.weeks) === cfViewWeeks));
      store.render();
    };
  });

  const calcFor = (id) => {
    const full = id === "basin-checking" ? computeForecast(state, period) : computeSimpleAccountForecast(state, period, id);
    const weeks = full.weeks.slice(0, cfViewWeeks);
    const totals = id === "basin-checking" ? sliceTotals(weeks) : sliceSimpleTotals(weeks);
    return { weeks, totals };
  };

  const combinedHost = document.getElementById("home-combined-chart");
  if (combinedHost) {
    const includedIds = ["basin-checking", "basin-savings", "pc-checking", "pc-savings"]; // excludes eb-savings per request
    const perAccountWeeks = includedIds.map((id) => calcFor(id).weeks);
    const nWeeks = perAccountWeeks[0]?.length || 0;
    const combinedClosing = Array.from({ length: nWeeks }, (_, wi) => sum(perAccountWeeks.map((w) => w[wi]?.closing || 0)));
    const combinedOpening = sum(perAccountWeeks.map((w) => w[0]?.opening || 0));
    const closingNow = combinedClosing[combinedClosing.length - 1] || combinedOpening;
    const netChange = closingNow - combinedOpening;

    // Distributions pull the combined balance down — mark them explicitly as
    // outflows on the chart rather than letting them just look like a dip.
    const distributionAnnotations = [];
    for (let wi = 0; wi < cfViewWeeks; wi++) {
      const v = period.basinSavingsDistributions?.[wi]?.v;
      if (v) distributionAnnotations.push({ wi, amount: Math.abs(v), label: "Distribution" });
    }

    const chart = urvSparklineSVG(combinedClosing, weeksMetaForChart, "home-combined", {
      W: 900, H: 150, padX: 14, padY: 14, fromZero: false, compact: true, annotations: distributionAnnotations, showAxes: true,
    });

    combinedHost.innerHTML = `
      <div class="panel home-combined-card">
        <div class="home-combined-head">
          <div>
            <div class="home-combined-label">Combined Cash Position</div>
            <div class="home-combined-sub">Basin Checking + Basin Savings + P&amp;C Checking + P&amp;C Savings — excludes EB Savings${distributionAnnotations.length ? ` · <span class="outflow-legend"><span class="outflow-legend-dot"></span>Distributions (outflow)</span>` : ""}</div>
          </div>
          <div class="home-combined-figures">
            <div><span class="label">Opening</span><span class="value">${fmtMoney(combinedOpening)}</span></div>
            <div><span class="label">Net Change</span><span class="value ${netChange >= 0 ? "green" : "red"}">${fmtMoney(netChange, { signed: true })}</span></div>
            <div><span class="label">Closing</span><span class="value brass">${fmtMoney(closingNow)}</span></div>
          </div>
        </div>
        ${chart.html}
      </div>`;
    wireUrvChartHover(combinedHost, "home-combined", chart.points, chart.W, { compact: true });
  }

  const cardCharts = []; // wired up after the whole grid's innerHTML is set
  const cardHtml = (acct, extraClass = "") => {
    const calc = calcFor(acct.id);
    const netTotal = calc.totals.netCashflow;
    const openingDate = calc.weeks[0]?.week?.start;
    const closingDate = calc.weeks[calc.weeks.length - 1]?.week?.end;
    const chartId = `home-acct-${acct.id}`;
    const weeklyClosing = calc.weeks.map((w) => w.closing);
    const chart = urvSparklineSVG(weeklyClosing, weeksMetaForChart, chartId, { W: 280, H: 50, padX: 2, padY: 6, fromZero: false, compact: true });
    cardCharts.push({ chartId, points: chart.points, W: chart.W });
    return `
      <div class="panel account-card ${acct.isMain ? "main-account" : ""} ${extraClass}" data-account="${acct.id}" role="button" tabindex="0" style="grid-area:${acct.id};">
        ${acct.isMain ? `<div class="main-account-badge">★ MAIN OPERATING ACCOUNT</div>` : ""}
        <div class="account-card-name">${escapeHtml(acct.name)}</div>
        <div class="account-card-figures-row">
          <div class="acf-item"><div class="label">Opening<span class="as-of-date">${openingDate ? fmtDateShort(openingDate) : ""}</span></div><div class="value">${fmtMoney(calc.totals.opening)}</div></div>
          <div class="acf-item"><div class="label">Net Change</div><div class="value ${netTotal >= 0 ? "green" : "red"}">${fmtMoney(netTotal, { signed: true })}</div></div>
          <div class="acf-item"><div class="label">Closing<span class="as-of-date">${closingDate ? fmtDateShort(closingDate) : ""}</span></div><div class="value brass">${fmtMoney(calc.totals.closing)}</div></div>
        </div>
        <div class="account-card-chart">${chart.html}</div>
        <div class="account-card-cta">View ${escapeHtml(acct.name)} Forecast ▸</div>
      </div>`;
  };

  const byId = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]));

  document.getElementById("home-accounts").innerHTML = `
    <div class="home-account-layout">
      ${cardHtml(byId["basin-checking"], "layout-basin-checking")}
      ${cardHtml(byId["basin-savings"], "layout-basin-savings")}
      ${cardHtml(byId["pc-checking"], "layout-pc-checking")}
      ${cardHtml(byId["pc-savings"], "layout-pc-savings")}
      ${cardHtml(byId["eb-savings"], "layout-eb-savings")}
    </div>
  `;

  document.querySelectorAll(".account-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedAccountId = card.dataset.account;
      store.activeView = "forecast";
      store.render();
    });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") card.click(); });
  });
  const accountsHost = document.getElementById("home-accounts");
  for (const c of cardCharts) wireUrvChartHover(accountsHost, c.chartId, c.points, c.W, { compact: true });

  renderHomeSummaries(store, period);
}

function renderHomeSummaries(store, period) {
  const { state } = store;
  const weeksMeta = periodWeeks(period).slice(0, cfViewWeeks);

  // weekly closing balance for every account, end of each week
  const calcFor = (id) => (id === "basin-checking" ? computeForecast(state, period) : computeSimpleAccountForecast(state, period, id));
  const closingsFor = (id) => calcFor(id).weeks.slice(0, cfViewWeeks).map((w) => w.closing);
  const openingFor = (id) => calcFor(id).weeks[0].opening;
  const byId = Object.fromEntries(ACCOUNTS.map((a) => [a.id, closingsFor(a.id)]));
  const openingById = Object.fromEntries(ACCOUNTS.map((a) => [a.id, openingFor(a.id)]));

  const acctRow = (id, label, isMain) => `<tr class="${isMain ? "home-balance-main" : ""}">
    <td>${isMain ? "★ " : ""}${escapeHtml(label)}</td>
    <td class="num home-balance-opening-col">${fmtMoney(openingById[id])}</td>
    ${byId[id].map((v) => `<td class="num">${fmtMoney(v)}</td>`).join("")}
  </tr>`;

  const totalRow = (label, ids) => `<tr class="home-balance-total">
    <td>${escapeHtml(label)}</td>
    <td class="num home-balance-opening-col">${fmtMoney(sum(ids.map((id) => openingById[id])))}</td>
    ${weeksMeta.map((w, wi) => `<td class="num">${fmtMoney(sum(ids.map((id) => byId[id][wi])))}</td>`).join("")}
  </tr>`;

  const groupTable = (rowsHtml) => `
    <table class="data-table home-balance-table">
      <thead><tr><th>Account</th><th class="num home-balance-opening-col">Opening</th>${weeksMeta.map((w) => `<th class="num">${fmtDateShort(w.end)}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  const groupHeader = (icon, title, dotClass) => `<div class="balance-group-header"><span class="balance-group-dot ${dotClass}"></span>${icon} ${escapeHtml(title)}</div>`;

  const basinGroupHtml = `
    <div class="panel balance-group-panel balance-group-basin" style="grid-area:basin;">
      ${groupHeader("🏦", "Basin Group", "dot-brass")}
      ${groupTable(acctRow("basin-checking", "Basin Checking", true) + acctRow("basin-savings", "Basin Savings", false) + totalRow("Basin Total", ["basin-checking", "basin-savings"]))}
    </div>`;

  const pcGroupHtml = `
    <div class="panel balance-group-panel balance-group-pc" style="grid-area:pc;">
      ${groupHeader("🏗️", "P&C Group", "dot-cyan")}
      ${groupTable(acctRow("pc-checking", "P&C Checking", false) + acctRow("pc-savings", "P&C Savings", false) + totalRow("P&C Total", ["pc-checking", "pc-savings"]))}
    </div>`;

  const ebWeeklyList = `
    <div class="balance-eb-week balance-eb-opening">
      <span class="balance-eb-week-label">Opening</span>
      <span class="balance-eb-week-value">${fmtMoney(openingById["eb-savings"])}</span>
    </div>
    ${weeksMeta.map((w, wi) => `
    <div class="balance-eb-week">
      <span class="balance-eb-week-label">${fmtDateShort(w.end)}</span>
      <span class="balance-eb-week-value">${fmtMoney(byId["eb-savings"][wi])}</span>
    </div>`).join("")}`;

  const ebGroupHtml = `
    <div class="panel balance-group-panel balance-group-eb" style="grid-area:eb;">
      ${groupHeader("💰", "EB Savings", "dot-violet")}
      <div class="balance-eb-weekly-list">${ebWeeklyList}</div>
    </div>`;

  document.getElementById("home-balances").innerHTML = `
    <div class="balance-section-eyebrow">Account Balances — End of Each Week</div>
    <div class="home-balance-layout">
      ${basinGroupHtml}
      ${pcGroupHtml}
      ${ebGroupHtml}
    </div>
  `;
}

export function renderForecast(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeksMetaFull = periodWeeks(period); // always all 13 — Roll Forward needs the true full period regardless of what's being viewed

  const acctSel = document.getElementById("account-select");
  acctSel.innerHTML = ACCOUNTS.map((a) => `<option value="${a.id}" ${a.id === selectedAccountId ? "selected" : ""}>${a.isMain ? "★ " : ""}${escapeHtml(a.name)}${a.isMain ? " (Main)" : ""}</option>`).join("");
  acctSel.onchange = () => { selectedAccountId = acctSel.value; store.render(); };

  const periodLabelEl = document.getElementById("period-label");
  if (periodLabelEl) periodLabelEl.textContent = period.label;

  document.getElementById("btn-roll-forward").onclick = () => openRollForwardModal(store, period, computeForecast(state, period), weeksMetaFull);

  if (selectedAccountId !== "basin-checking") {
    renderSimpleAccountForecast(store, period, selectedAccountId);
    return;
  }

  const calc = computeForecast(state, period);
  const weeks = calc.weeks.slice(0, cfViewWeeks);
  const weeksMeta = weeksMetaFull.slice(0, cfViewWeeks);
  calc.totals = sliceTotals(weeks); // every calc.totals.X reference below now reflects just the viewed weeks

  document.getElementById("forecast-title").textContent = period.label;
  document.getElementById("forecast-eyebrow").textContent = `${cfViewWeeks}-Week View · Starts ${fmtDate(period.startDate)}`;
  document.getElementById("forecast-meta").textContent = `Pay runs: ${weeksMeta.map((w) => fmtDate(w.payRun)).join(", ")}`;

  renderCfKpiCards("forecast-stats", "main", weeksMeta, {
    inflow: weeks.map((w) => w.totalInflows),
    outflow: weeks.map((w) => w.totalOutflows),
    net: weeks.map((w) => w.netCashflow),
    closing: weeks.map((w) => w.closing),
    distribution: weeks.map((w) => w.manualOutflows?.Distributions ?? 0),
  }, {
    opening: calc.totals.opening, inflow: calc.totals.totalInflows, outflow: calc.totals.totalOutflows,
    net: calc.totals.netCashflow, closing: calc.totals.closing,
  });

  const rcBreakdowns = weeks.map((r, wi) => receivablesBreakdown(state, period, wi, "basin-checking"));
  const rcTotalBreakdown = receivablesBreakdown(state, period, null, "basin-checking");

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
      <tr class="inflow-row rc-row" data-row="receivablesCollected">${labelCell(period, "Receivables Collected", "receivablesCollected", null, false)}${weeks.map((r, wi) => `<td class="rc-cell" data-wi="${wi}" title="Computed from receivables' CF dates — not manually editable">${fmtMoney(r.receivablesCollected)}<div class="rc-bar" title="${rcBreakdowns[wi].pct}% collected"><div class="rc-bar-fill" style="width:${rcBreakdowns[wi].pct}%"></div></div></td>`).join("")}<td class="rc-cell rc-total-cell" title="Computed from receivables' CF dates — not manually editable">${fmtMoney(calc.totals.receivablesCollected)}<div class="rc-bar" title="${rcTotalBreakdown.pct}% collected"><div class="rc-bar-fill" style="width:${rcTotalBreakdown.pct}%"></div></div></td></tr>
      <tr class="inflow-row" data-row="otherInflows">${labelCell(period, "Other Inflows", "otherInflows", null, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.otherInflows)}</td>`).join("")}<td>${fmtMoney(calc.totals.otherInflows)}</td></tr>
      <tr class="inflow-row ic-row" data-row="interCompanyIn">${labelCell(period, "⇄ Inter Company Transfer", "interCompanyIn", null, false)}${weeks.map((r, wi) => `<td data-wi="${wi}" title="Computed from Transfers — not manually editable">${fmtMoney(r.interCompanyIn)}${icAccountTag(r.interCompanyItems.inflow)}</td>`).join("")}<td title="Computed from Transfers — not manually editable">${fmtMoney(calc.totals.interCompanyIn)}</td></tr>
      <tr class="inflow-total" data-row="totalInflows">${labelCell(period, "Total Inflows", "totalInflows", null, false)}${weeks.map((r) => `<td class="value-pos">${fmtMoney(r.totalInflows)}</td>`).join("")}<td class="value-pos">${fmtMoney(calc.totals.totalInflows)}</td></tr>

      <tr class="section-label sec-outflow-manual"><td colspan="${weeks.length + 2}">Cash Outflow — Manual</td></tr>
      ${state.manualOutflowCategories.filter((c) => c !== "Payroll").map((cat) => `
        <tr class="outflow-row" data-row="manual" data-cat="${escapeHtml(cat)}">${labelCell(period, cat, "manual", cat, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.manualOutflows[cat])}</td>`).join("")}<td>${fmtMoney(calc.totals.manualOutflows[cat])}</td></tr>
      `).join("")}

      <tr class="section-label sec-outflow-fixed"><td colspan="${weeks.length + 2}">Cash Outflow — Fixed / Scheduled</td></tr>
      ${calc.fixedCategories.map((cat) => `
        <tr class="fixed-row" data-row="fixed" data-cat="${escapeHtml(cat)}">${labelCell(period, cat, "fixed", cat, false)}${weeks.map((r, wi) => `<td data-wi="${wi}" title="Computed from Fixed Payments — not manually editable">${fmtMoney(r.fixedRows[cat])}</td>`).join("")}<td title="Computed from Fixed Payments — not manually editable">${fmtMoney(calc.totals.fixedRows[cat])}</td></tr>
      `).join("")}
      <tr class="fixed-row ap-row" data-row="apPayables">${labelCell(period, "◆ Weekly AP Payables", "apPayables", null, false)}${weeks.map((r, wi) => `<td data-wi="${wi}" title="Computed from payables' CF dates — not manually editable">${fmtMoney(r.apPayables)}</td>`).join("")}<td title="Computed from payables' CF dates — not manually editable">${fmtMoney(calc.totals.apPayables)}</td></tr>
      <tr class="fixed-row" data-row="projectedAP">${labelCell(period, "Projected AP", "projectedAP", null, true)}${weeks.map((r, wi) => `<td class="ed" data-wi="${wi}">${fmtMoney(r.projectedAP)}</td>`).join("")}<td>${fmtMoney(calc.totals.projectedAP)}</td></tr>
      <tr class="fixed-row ic-row" data-row="interCompanyOut">${labelCell(period, "⇄ Inter Company Transfer", "interCompanyOut", null, false)}${weeks.map((r, wi) => `<td data-wi="${wi}" title="Computed from Transfers — not manually editable">${fmtMoney(r.interCompanyOut)}${icAccountTag(r.interCompanyItems.outflow)}</td>`).join("")}<td title="Computed from Transfers — not manually editable">${fmtMoney(calc.totals.interCompanyOut)}</td></tr>

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

    const entry = overrideEntry(period.overrides, rowType, cat, wi, period);
    const hasOverride = entry !== undefined;
    const who = hasOverride && typeof entry === "object" ? entry.by : null;
    const currentVal = rowValue(weeks, rowType, cat, wi);

    if (hasOverride) {
      td.classList.add("overridden");
      if (who) td.insertAdjacentHTML("beforeend", `<span class="who-badge" title="Overridden by ${escapeHtml(who)}">${escapeHtml(who)}</span>`);
      td.insertAdjacentHTML("beforeend", `<button type="button" class="reset-override-btn" title="This cell is a manual override — click to revert to the computed value">↺</button>`);
    }

    editableCell(td, currentVal, (val) => {
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const stamped = val === null ? null : { v: val, by: store.initials(), at: new Date().toISOString() };
        writeOverride(per, rowType, cat, wi, stamped);
      });
    });

    td.querySelector(".reset-override-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        writeOverride(per, rowType, cat, wi, null);
      });
    });
  });

  // Inter Company Transfer cells — click to view/add/delete transfers for that week
  table.querySelectorAll('tr[data-row="interCompanyIn"] td[data-wi], tr[data-row="interCompanyOut"] td[data-wi]').forEach((td) => {
    const tr = td.closest("tr");
    const direction = tr.dataset.row === "interCompanyIn" ? "in" : "out";
    const wi = Number(td.dataset.wi);
    td.style.cursor = "pointer";
    td.addEventListener("click", () => openTransferModal(store, period, "basin-checking", wi, direction, weeksMeta));
  });

  // click a row label to enter all weeks at once
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
      const label = () => `${rowLabel} — ${wi === null ? "Full Period" : `${fmtDateShort(weeksMeta[wi].start)} – ${fmtDateShort(weeksMeta[wi].end)}`}`;

      if (rowType === "apPayables" && wi !== null) {
        attachBreakdownClick(td, () => apPayablesBreakdown(state, period, wi), label, apPayablesBreakdownPopupHTML);
        return;
      }
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
        label,
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
    <h3>${escapeHtml(label)} — enter all ${weeksMeta.length} weeks</h3>
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">Leave a box empty to fall back to the computed/scheduled amount for that week.</div>
    ${weeksMeta.map((w, wi) => `
      <div class="row">
        <label>${fmtDateShort(w.start)} – ${fmtDateShort(w.end)} <span style="opacity:.6;">(pay run ${fmtDate(w.payRun)})</span></label>
        <input type="number" class="bulk-wk" data-wi="${wi}" value="${rowValue(weeksRows, rowType, cat, wi)}" />
      </div>
    `).join("")}
    <div class="modal-actions">
      <button class="btn-ghost" id="bw-cancel">Cancel</button>
      <button class="btn-primary" id="bw-save" style="width:auto;">Save All ${weeksMeta.length} Weeks</button>
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
        toast(`Updated all ${weeksMeta.length} weeks`, "success");
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
  const label = item.customer || item.vendor || item.project;
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

let selectedAccountId = "basin-checking";
// Global 6/13 week view toggle, shared by every page — the period is always
// 13 weeks internally; this only controls how many weeks are displayed.
// Lives here (not main.js) so every render function in this file can read it
// directly; main.js drives it via setGlobalViewWeeks from the topbar buttons.
export let cfViewWeeks = 6;
const urvCollapsedSections = new Set(); // section ids currently collapsed — empty by default, so every section starts expanded
export function setGlobalViewWeeks(n) { cfViewWeeks = n === 13 ? 13 : 6; }

let arFilter = "open", arSearch = "", arWeekFilter = null, arCustomerFilter = "";
const arSelected = new Set();
let arSortBy = "customer", arSortDir = "asc";

// sorts by the letters in a name only — ignores job/invoice numbers, dashes,
// colons, etc. that NetSuite often appends to a customer name
function customerSortKey(name) {
  return (name || "").replace(/[^a-zA-Z\s]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function renderReceivables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period).slice(0, cfViewWeeks);

  const openList = state.receivables.filter((r) => r.status === "open");
  const totalAR = state.receivables.reduce((a, r) => a + r.balance, 0);
  const openAR = openList.reduce((a, r) => a + r.balance, 0);
  const uncertainList = openList.filter((r) => r.uncertain);
  const uncertainTotal = uncertainList.reduce((a, r) => a + r.balance, 0);

  document.getElementById("ar-meta").textContent = `${state.receivables.length} invoices · ${openList.length} open`;
  const weeklyScheduled = weeks.map((w) => openList.filter((r) => weekIndexForDate(period, r.cfDate) === w.index).reduce((s, r) => s + r.balance, 0));
  const scheduledTotal = sum(weeklyScheduled);
  const schedChart = urvSparklineSVG(weeklyScheduled, weeks, "ar-sched", { W: 150, H: 36, padX: 3, padY: 4, fromZero: true });
  document.getElementById("ar-stats").innerHTML = `
    <div class="stat-card kpi-card sc-close"><div class="kpi-icon">▤</div><div class="kpi-body"><div class="label">Total AR</div><div class="value brass">${fmtMoney(totalAR)}</div></div></div>
    <div class="stat-card kpi-card sc-loc"><div class="kpi-icon">○</div><div class="kpi-body"><div class="label">Open / Uncollected</div><div class="value indigo">${fmtMoney(openAR)}</div></div></div>
    <div class="stat-card kpi-card sc-in"><div class="kpi-icon">↗</div><div class="kpi-body"><div class="label">Scheduled This Period</div><div class="value green">${fmtMoney(scheduledTotal)}</div></div><div class="kpi-mini-chart">${schedChart.html}</div></div>
    <div class="stat-card kpi-card sc-unc"><div class="kpi-icon">!</div><div class="kpi-body"><div class="label">Uncertain</div><div class="value amber">${fmtMoney(uncertainTotal)}</div></div></div>
  `;
  wireUrvChartHover(document.getElementById("ar-stats"), "ar-sched", schedChart.points, schedChart.W);

  const insightsHost = document.getElementById("ar-insights");
  insightsHost.innerHTML = `<button type="button" class="insight-btn" id="ar-insight-customers"><span class="icon">🏆</span>Top 5 Customer Balances<span class="arrow">▸</span></button>`;
  document.getElementById("ar-insight-customers").onclick = () => openTopCustomersModal(openList);

  const collectRow = document.getElementById("ar-collect-row");
  collectRow.innerHTML = weeks.map((w) => {
    const bd = receivablesBreakdown(state, period, w.index);
    const isCurrent = w.index === 0;
    const full = bd.totalAll > 0 && bd.pct >= 100;
    const filtered = arWeekFilter === w.index;
    return `<div class="collect-card money-bag-card ${isCurrent ? "current" : ""} ${full ? "full" : ""} ${filtered ? "filtered" : ""}" data-wi="${w.index}" title="Click the card to filter the table below · click 🔍 for a detailed breakdown">
      <div class="bag-wrap">${moneyBagSVG(bd.pct, w.index)}</div>
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
  document.getElementById("ar-copy-btn").onclick = () => copyReceivablesToClipboard(state);
  document.getElementById("ar-clear-btn").onclick = () => {
    if (!state.receivables.length) { toast("Receivables are already empty", "info"); return; }
    if (!confirm(`Delete all ${state.receivables.length} receivable invoices? This can't be undone. Customer auto-schedule settings will be kept.`)) return;
    store.mutate((s) => { s.receivables.forEach((x) => recordTombstone(s, "receivables", x.id)); s.receivables = []; });
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
        <div class="vendor-rank payment-row" data-idx="${i}">
          <span>${fmtDate(p.date)}</span>
          <span class="amt">${fmtMoney(p.amount)}
            <button type="button" class="mini-btn edit-payment" data-idx="${i}" style="margin-left:8px;">✎ edit</button>
            <button type="button" class="mini-btn remove-payment" data-idx="${i}" style="margin-left:4px;">✕ remove</button>
          </span>
        </div>
      `).join("") : `<div class="meta">No payments recorded yet.</div>`}
    </div>
  `, {
    closeOnBackdrop: false,
    onMount: (host) => {
      host.querySelector("#hist-close").onclick = closeModal;
      const recompute = (item) => {
        const paid = item.payments.reduce((a, p) => a + p.amount, 0);
        const remaining = Math.max(0, Math.round(((item.originalBalance ?? item.balance) - paid) * 100) / 100);
        if (remaining > 0) { item.balance = remaining; item.status = "open"; }
        else { item.balance = item.originalBalance ?? item.balance; item.status = "paid"; }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      };
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
            recompute(item);
          });
          toast("Payment removed", "success");
          closeModal();
          openPaymentHistoryModal(store, id);
        });
      });
      host.querySelectorAll(".edit-payment").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.idx);
          const target = payments[idx];
          const row = host.querySelector(`.payment-row[data-idx="${idx}"]`);
          row.innerHTML = `
            <input type="date" class="mini-input edit-pay-date" value="${target.date || ""}" />
            <span class="amt"><input type="number" step="0.01" class="mini-input edit-pay-amt" value="${target.amount}" style="width:80px;" />
              <button type="button" class="mini-btn save-edit-payment" style="margin-left:6px;">Save</button>
            </span>
          `;
          row.querySelector(".save-edit-payment").addEventListener("click", () => {
            const newAmt = parseFloat(row.querySelector(".edit-pay-amt").value);
            const newDate = row.querySelector(".edit-pay-date").value || target.date;
            if (Number.isNaN(newAmt) || newAmt <= 0) { toast("Enter a valid payment amount", "error"); return; }
            store.mutate((s) => {
              const item = s.receivables.find((x) => x.id === id);
              if (!item || !item.payments) return;
              const pos = item.payments.indexOf(target);
              if (pos === -1) return;
              item.payments[pos] = { date: newDate, amount: newAmt };
              recompute(item);
            });
            toast("Payment updated", "success");
            closeModal();
            openPaymentHistoryModal(store, id);
          });
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
    <div class="desc" style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">${escapeHtml(rec.customer)} · ${escapeHtml(rec.docNumber || "")}<br/>Balance due: <strong style="color:var(--text-hi);">${fmtMoney(rec.balance)}</strong>${paidSoFar ? ` · ${fmtMoney(paidSoFar)} already paid` : ""}<br/><span style="font-size:11px;">A partial payment splits this into a paid line and a separate open line for what's still owed.</span></div>
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
        let wasSplit = false, remaining = 0;
        store.mutate((s) => {
          const item = s.receivables.find((x) => x.id === id);
          if (!item) return;
          if (amt >= item.balance) {
            // full payment (or overpayment) — close this line out, no split needed
            item.payments = item.payments || [];
            item.payments.push({ date, amount: amt });
            if (item.originalBalance === undefined) item.originalBalance = item.balance;
            item.balance = item.originalBalance; // show the original invoice amount, not $0
            item.status = "paid";
            item.lastEditBy = store.initials();
            item.updatedAt = new Date().toISOString();
          } else {
            // partial — split into a closed "paid" line and a smaller open "remaining" line,
            // so the unpaid portion can be scheduled or closed independently of this payment
            wasSplit = true;
            remaining = Math.round((item.balance - amt) * 100) / 100;
            const paidLine = { ...item };
            delete paidLine.note; // keep any note on the still-open remaining line, not duplicated
            paidLine.id = uid("ar");
            paidLine.docNumber = `${item.docNumber || ""} (Partial Pmt)`.trim();
            paidLine.balance = amt;
            paidLine.originalBalance = amt;
            paidLine.payments = [{ date, amount: amt }];
            paidLine.status = "paid";
            paidLine.lastEditBy = store.initials();
            paidLine.updatedAt = new Date().toISOString();

            item.balance = remaining;
            item.originalBalance = remaining; // this line is now effectively its own fresh open balance
            item.payments = [];
            item.lastEditBy = store.initials();
            item.updatedAt = new Date().toISOString();

            s.receivables.push(paidLine);
          }
        });
        closeModal();
        toast(wasSplit ? `Split: ${fmtMoney(amt)} paid, ${fmtMoney(remaining)} still open on a separate line` : `Recorded ${fmtMoney(amt)} payment — invoice paid in full`, "success");
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
  document.getElementById("ar-count").innerHTML = `${list.length} rows${arSelected.size ? ` · ${arSelected.size} selected` : ""}${weekLabel}`;
  document.getElementById("ar-week-clear")?.addEventListener("click", () => { arWeekFilter = null; renderReceivables(store); });
  const tbody = document.getElementById("ar-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="13"><div class="empty-state"><h4>No invoices here</h4>Import your Aged AR export or add one manually.</div></td></tr>`; return; }

  tbody.innerHTML = list.map((r) => {
    const days = r.date ? Math.round((parseISO(r.cfDate || r.date) - parseISO(r.date)) / 86400000) : "";
    const whoBadge = r.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(r.lastEditBy)}">${escapeHtml(r.lastEditBy)}</span>` : "";
    const daysVal = r.uncertain ? "unc" : (r.daysOverride ?? days);
    const paidSoFar = (r.payments || []).reduce((a, p) => a + p.amount, 0);
    const hasPayments = (r.payments || []).length > 0;
    const hasPartial = paidSoFar > 0 && r.balance > 0;
    return `<tr class="${r.status === "paid" ? "paid" : ""} ${r.uncertain ? "uncertain-row" : ""}" data-id="${r.id}">
      <td><input type="checkbox" class="row-select" ${arSelected.has(r.id) ? "checked" : ""} /></td>
      <td class="name">${escapeHtml(r.customer)}</td>
      <td>${escapeHtml(r.txnType || "")}</td>
      <td class="mono">${escapeHtml(r.docNumber || "")}</td>
      <td class="mono">${fmtDate(r.date)}</td>
      <td class="mono">${escapeHtml(r.poNumber || "—")}</td>
      <td><input class="mini-input days-input ${r.uncertain ? "uncertain" : ""}" type="text" value="${daysVal}" title="Type a number of days, or 'unc' if the pay date is uncertain" ${r.status !== "open" ? "disabled" : ""}/></td>
      <td class="mono cf-date">${r.uncertain ? `<span class="uncertain-tag">UNCERTAIN</span>` : (r.cfDate ? fmtDate(r.cfDate) : "—")}${whoBadge}</td>
      <td>
        <select class="mini-select deposit-account-select">
          <option value="basin-checking" ${(r.depositAccount || "basin-checking") === "basin-checking" ? "selected" : ""}>Basin Checking</option>
          <option value="pc-checking" ${r.depositAccount === "pc-checking" ? "selected" : ""}>P&amp;C Checking</option>
        </select>
      </td>
      <td class="mono">${r.date ? `${daysBetween(r.date, todayISO())}d` : "—"}</td>
      <td class="num balance-cell" title="Click to correct this invoice's balance directly">${fmtMoney(r.balance)}${hasPartial ? `<div class="partial-note">${fmtMoney(paidSoFar)} paid of ${fmtMoney(r.originalBalance ?? r.balance)}</div>` : ""}${hasPayments ? `<button type="button" class="payment-history-link" title="View / manage payment history">${(r.payments || []).length} payment${(r.payments || []).length === 1 ? "" : "s"} ▸</button>` : ""}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>
        ${r.status === "open" ? `<button class="mini-btn record-payment" title="Record a partial or full payment">💲 Pay</button>` : ""}
        <button class="mini-btn toggle-status" style="margin-left:4px;">${r.status === "open" ? "Mark Paid" : "Reopen"}</button>
        <button class="mini-btn del-row" style="margin-left:4px;">✕</button>
      </td>
    </tr>`;
  }).join("");

  const selectAll = document.getElementById("ar-select-all");
  selectAll.checked = list.length > 0 && list.every((r) => arSelected.has(r.id));
  selectAll.onchange = () => {
    if (selectAll.checked) list.forEach((r) => arSelected.add(r.id));
    else list.forEach((r) => arSelected.delete(r.id));
    renderARRows(store, period);
  };

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const rec = state.receivables.find((x) => x.id === id);
    if (!rec) return;
    tr.querySelector(".row-select")?.addEventListener("change", (e) => {
      if (e.target.checked) arSelected.add(id); else arSelected.delete(id);
      document.getElementById("ar-count").innerHTML = `${list.length} rows${arSelected.size ? ` · ${arSelected.size} selected` : ""}${weekLabel}`;
      selectAll.checked = list.every((r) => arSelected.has(r.id));
    });
    attachItemNotePencil(tr.querySelector(".name"), store, "receivables", id);

    tr.querySelector(".record-payment")?.addEventListener("click", () => openRecordPaymentModal(store, id));
    tr.querySelector(".deposit-account-select")?.addEventListener("change", (e) => {
      store.mutate((s) => {
        const item = s.receivables.find((x) => x.id === id);
        item.depositAccount = e.target.value;
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
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
        } else if (!reopening) {
          // marking paid — show the original invoice amount, not $0, so it's
          // still clear how much the invoice was for
          if (item.originalBalance === undefined) item.originalBalance = item.balance;
          item.balance = item.originalBalance;
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".payment-history-link")?.addEventListener("click", (e) => { e.stopPropagation(); openPaymentHistoryModal(store, id); });
    tr.querySelector(".balance-cell")?.addEventListener("click", (e) => {
      if (e.target.closest(".payment-history-link")) return;
      const td = tr.querySelector(".balance-cell");
      const current = state.receivables.find((x) => x.id === id)?.balance ?? 0;
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.className = "mini-input"; input.style.width = "100px"; input.style.textAlign = "right";
      input.value = current;
      td.innerHTML = ""; td.appendChild(input); input.focus(); input.select();
      const commit = () => {
        const val = parseFloat(input.value);
        store.mutate((s) => {
          const item = s.receivables.find((x) => x.id === id);
          if (!item || Number.isNaN(val) || val < 0) return;
          const paidSoFar = (item.payments || []).reduce((a, p) => a + p.amount, 0);
          if (val <= 0 && item.status === "open") {
            // typing 0 as a shortcut for "mark paid" — keep showing what the invoice was for
            item.originalBalance = item.originalBalance ?? item.balance;
            item.balance = item.originalBalance;
            item.status = "paid";
          } else {
            item.balance = Math.round(val * 100) / 100;
            item.originalBalance = Math.round((item.balance + paidSoFar) * 100) / 100;
          }
          item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
        });
      };
      input.addEventListener("keydown", (e2) => { if (e2.key === "Enter") input.blur(); if (e2.key === "Escape") { input.value = current; input.blur(); } });
      input.addEventListener("blur", commit, { once: true });
    });
    tr.querySelector(".del-row")?.addEventListener("click", () => {
      if (!confirm(`Remove invoice ${rec.docNumber || ""} for ${rec.customer}?`)) return;
      store.mutate((s) => { recordTombstone(s, "receivables", id); s.receivables = s.receivables.filter((x) => x.id !== id); });
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

/* ============================================================ UNBILLED RECEIVABLES ============================================================ */


const BILL_PERCENTS = [25, 50, 75, 90, 100, 110];

export function renderUnbilled(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  // The old project-revenue-forecast list (Total Unbilled / Open / Scheduled
  // stats, Top 5 Customers, search/filter table) has been removed from this
  // page per request — it wasn't being used. Its underlying data
  // (state.unbilledReceivables) and its contribution to Receivables Collected
  // on CF Forecast are untouched; only this page's UI for it is gone.
  renderUnbilledRevenueSections(store, period);
}

function urvInvoiceCell(item, idx) {
  const inv = item.invoices[idx] || blankInvoice();
  const id = item.id;
  if (!inv.amount) {
    return `<td class="urv-inv-cell urv-inv-empty-cell" data-id="${id}" data-idx="${idx}"><span class="urv-add-invoice" data-id="${id}" data-idx="${idx}">+ add invoice</span></td>`;
  }
  const days = (inv.invoiceDate && inv.cfDate) ? Math.round((parseISO(inv.cfDate) - parseISO(inv.invoiceDate)) / 86400000) : "";
  return `<td class="urv-inv-cell" data-id="${id}" data-idx="${idx}">
    <div class="urv-amt-edit" data-id="${id}" data-idx="${idx}" title="Click to edit the amount">${fmtMoney(inv.amount)}</div>
    <div class="urv-inv-row"><span class="urv-inv-label">Inv:</span> <span class="urv-date-edit urv-invdate-edit" data-id="${id}" data-idx="${idx}" title="Click to change the invoice date">${inv.invoiceDate ? fmtDate(inv.invoiceDate) : "— set —"}</span></div>
    <div class="urv-inv-row"><input class="mini-input urv-days-input" data-id="${id}" data-idx="${idx}" type="text" placeholder="days" value="${days}" title="Days after the invoice date — sets the CF date automatically" /><span class="urv-inv-label">d → CF</span></div>
    <div class="urv-inv-row"><span class="urv-inv-label">CF:</span> <span class="urv-date-edit urv-cfdate-edit ${!inv.cfDate ? "urv-cf-unset" : ""}" data-id="${id}" data-idx="${idx}" title="Click to pick the CF date directly">${inv.cfDate ? fmtDate(inv.cfDate) : "— assign —"}</span></div>
  </td>`;
}

function renderUnbilledRevenueSections(store, period) {
  const { state } = store;
  const host = document.getElementById("urv-sections");
  if (!host) return;
  const list = state.unbilledRevenue || [];

  // Breakdown: a line chart per section, one point per week, scoped to
  // whichever view — 6 or 13 weeks — is currently active. Hover anywhere over
  // a chart (not just precisely on a dot) and it snaps to the nearest week;
  // the period total sits below each chart.
  const breakdownHost = document.getElementById("urv-breakdown");
  if (breakdownHost) {
    const weeksMeta = periodWeeks(period).slice(0, cfViewWeeks);
    const occurrences = unbilledRevenueOccurrencesInPeriod(state, period).filter((occ) => occ.wi < cfViewWeeks);
    const weeklyBySection = {};
    for (const sec of UNBILLED_REVENUE_SECTIONS) weeklyBySection[sec.id] = Array(cfViewWeeks).fill(0);
    for (const occ of occurrences) weeklyBySection[occ.section][occ.wi] += occ.amount;

    const charts = []; // { chartId, points, W } — wired up after innerHTML is set
    breakdownHost.innerHTML = UNBILLED_REVENUE_SECTIONS.map((sec) => {
      const weekly = weeklyBySection[sec.id];
      const periodTotal = sum(weekly);
      const chartId = `urv-${sec.id}`;
      const chart = urvSparklineSVG(weekly, weeksMeta, chartId);
      charts.push({ chartId, points: chart.points, W: chart.W });
      return `
      <div class="urv-chart-card">
        <div class="label">${escapeHtml(sec.label)}</div>
        ${chart.html}
        <div class="urv-chart-total">${fmtMoney(periodTotal)}</div>
        <div class="urv-chart-sub">scheduled over ${cfViewWeeks} weeks</div>
      </div>`;
    }).join("");
    for (const c of charts) wireUrvChartHover(breakdownHost, c.chartId, c.points, c.W);
  }

  host.innerHTML = UNBILLED_REVENUE_SECTIONS.map((sec) => {
    const items = list.filter((i) => i.section === sec.id && i.status !== "deleted");
    const sectionTotal = sum(items.map((i) => unbilledRevenueItemTotal(i)));
    const rows = items.map((item) => `
      <tr data-id="${item.id}">
        <td><span class="urv-name-text" data-id="${item.id}">${escapeHtml(item.name)}</span></td>
        ${[0, 1, 2].map((idx) => urvInvoiceCell(item, idx)).join("")}
        <td class="num">${fmtMoney(unbilledRevenueItemTotal(item))}</td>
        <td><button type="button" class="mini-btn urv-delete" data-id="${item.id}" title="Delete this line item">🗑</button></td>
      </tr>`).join("");

    const isCollapsed = urvCollapsedSections.has(sec.id);
    return `
      <div class="panel urv-section">
        <div class="fixed-group-head urv-section-head" data-section="${sec.id}">
          <h3><button type="button" class="urv-collapse-btn" data-section="${sec.id}" title="${isCollapsed ? "Expand" : "Collapse"}">${isCollapsed ? "▸" : "▾"}</button>${escapeHtml(sec.label)} <span class="count">${items.length} item${items.length === 1 ? "" : "s"}</span></h3>
          <span class="total">${fmtMoney(sectionTotal)}</span>
        </div>
        ${isCollapsed ? "" : `
        <div class="table-scroll">
          <table class="data-table urv-table">
            <thead>
              <tr><th></th><th class="urv-month-label">OCT</th><th class="urv-month-label">NOV</th><th class="urv-month-label">DEC</th><th></th><th></th></tr>
              <tr><th>Name</th><th>Invoice 1</th><th>Invoice 2</th><th>Invoice 3</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="6" class="meta" style="padding:14px;">No line items yet.</td></tr>`}</tbody>
          </table>
        </div>
        <div style="padding:12px 16px;"><button type="button" class="btn-ghost urv-add-item" data-section="${sec.id}">+ Add Line Item</button></div>
        `}
      </div>`;
  }).join("");

  host.querySelectorAll(".urv-collapse-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const secId = btn.dataset.section;
      if (urvCollapsedSections.has(secId)) urvCollapsedSections.delete(secId);
      else urvCollapsedSections.add(secId);
      renderUnbilledRevenueSections(store, period);
    });
  });

  const findItem = (id) => store.state.unbilledRevenue.find((i) => i.id === id);
  const touch = (it) => { it.lastEditBy = store.initials(); it.updatedAt = new Date().toISOString(); };

  // "+ add invoice" — inline, no modal: type an amount and the slot is created
  host.querySelectorAll(".urv-add-invoice").forEach((span) => {
    span.addEventListener("click", () => {
      const { id, idx } = span.dataset;
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.className = "mini-input"; input.placeholder = "0.00"; input.style.width = "90px";
      const td = span.closest("td");
      td.innerHTML = ""; td.appendChild(input); input.focus();
      const commit = () => {
        const amt = parseFloat(input.value || "0");
        if (amt > 0) {
          store.mutate((s) => {
            const it = s.unbilledRevenue.find((i) => i.id === id);
            it.invoices[Number(idx)] = { amount: Math.round(amt * 100) / 100, invoiceDate: null, cfDate: null };
            touch(it);
          });
        } else {
          renderUnbilledRevenueSections(store, period); // nothing entered — just redraw back to empty state
        }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      input.addEventListener("blur", commit, { once: true });
    });
  });

  // amount — click to edit inline
  host.querySelectorAll(".urv-amt-edit").forEach((div) => {
    div.addEventListener("click", () => {
      const { id, idx } = div.dataset;
      const it0 = findItem(id);
      const current = it0.invoices[Number(idx)].amount;
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.className = "mini-input"; input.value = current; input.style.width = "90px";
      div.innerHTML = ""; div.appendChild(input); input.focus(); input.select();
      const commit = () => {
        const val = parseFloat(input.value || "0");
        store.mutate((s) => {
          const it = s.unbilledRevenue.find((i) => i.id === id);
          it.invoices[Number(idx)].amount = Math.max(0, Math.round((val || 0) * 100) / 100);
          touch(it);
        });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = current; input.blur(); } });
      input.addEventListener("blur", commit, { once: true });
    });
  });

  // invoice date — click to pick from a native calendar, same pattern as Existing AR
  host.querySelectorAll(".urv-invdate-edit").forEach((span) => {
    span.addEventListener("click", () => {
      const { id, idx } = span.dataset;
      const it0 = findItem(id);
      const input = document.createElement("input");
      input.type = "date"; input.className = "mini-input"; input.style.width = "128px";
      input.value = it0.invoices[Number(idx)].invoiceDate || "";
      span.innerHTML = ""; span.appendChild(input); input.focus();
      if (input.showPicker) { try { input.showPicker(); } catch { /* ignore */ } }
      input.addEventListener("blur", () => {
        store.mutate((s) => {
          const it = s.unbilledRevenue.find((i) => i.id === id);
          it.invoices[Number(idx)].invoiceDate = input.value || null;
          touch(it);
        });
      }, { once: true });
    });
  });

  // CF date — same calendar pattern, directly, no need to go through "days" if you just know the date
  host.querySelectorAll(".urv-cfdate-edit").forEach((span) => {
    span.addEventListener("click", () => {
      const { id, idx } = span.dataset;
      const it0 = findItem(id);
      const input = document.createElement("input");
      input.type = "date"; input.className = "mini-input"; input.style.width = "128px";
      input.value = it0.invoices[Number(idx)].cfDate || "";
      span.innerHTML = ""; span.appendChild(input); input.focus();
      if (input.showPicker) { try { input.showPicker(); } catch { /* ignore */ } }
      input.addEventListener("blur", () => {
        store.mutate((s) => {
          const it = s.unbilledRevenue.find((i) => i.id === id);
          it.invoices[Number(idx)].cfDate = input.value || null;
          touch(it);
        });
      }, { once: true });
    });
  });

  // days-after-invoice-date — same convenience Existing AR has, sets CF date automatically
  host.querySelectorAll(".urv-days-input").forEach((input) => {
    input.addEventListener("change", () => {
      const { id, idx } = input.dataset;
      const raw = input.value.trim();
      store.mutate((s) => {
        const it = s.unbilledRevenue.find((i) => i.id === id);
        const inv = it.invoices[Number(idx)];
        if (raw === "") { return; } // leave CF date untouched if cleared
        const days = Number(raw);
        if (Number.isNaN(days) || !inv.invoiceDate) { toast("Set the invoice date first, then enter days", "error"); return; }
        inv.cfDate = toISO(addDays(inv.invoiceDate, days));
        touch(it);
      });
    });
  });

  host.querySelectorAll(".urv-name-text").forEach((span) => {
    span.addEventListener("click", () => openUrvRenameModal(store, span.dataset.id));
  });
  host.querySelectorAll(".urv-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this line item? This can't be undone.")) return;
      store.mutate((s) => {
        recordTombstone(s, "unbilledRevenue", btn.dataset.id);
        s.unbilledRevenue = s.unbilledRevenue.filter((i) => i.id !== btn.dataset.id);
      });
    });
  });
  host.querySelectorAll(".urv-add-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.mutate((s) => {
        s.unbilledRevenue = s.unbilledRevenue || [];
        const item = makeUnbilledRevenueItem(btn.dataset.section, "New line item");
        item.source = "manual"; item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
        s.unbilledRevenue.push(item);
      });
    });
  });
}

function openUrvRenameModal(store, itemId) {
  const item = store.state.unbilledRevenue.find((i) => i.id === itemId);
  if (!item) return;
  openModal(`
    <button type="button" class="modal-close-x" id="urn-close">✕</button>
    <h3>Rename Line Item</h3>
    <div class="row"><label>Name</label><input id="urn-name" value="${escapeHtml(item.name)}" /></div>
    <div class="modal-actions">
      <button class="btn-ghost" id="urn-cancel">Cancel</button>
      <button class="btn-primary" id="urn-save" style="width:auto;">Save</button>
    </div>
  `, {
    onMount: (host) => {
      host.querySelector("#urn-close").onclick = closeModal;
      host.querySelector("#urn-cancel").onclick = closeModal;
      host.querySelector("#urn-save").onclick = () => {
        const name = host.querySelector("#urn-name").value.trim();
        if (!name) { toast("Name is required", "error"); return; }
        store.mutate((s) => {
          const it = s.unbilledRevenue.find((i) => i.id === itemId);
          it.name = name; it.lastEditBy = store.initials(); it.updatedAt = new Date().toISOString();
        });
        closeModal();
      };
    },
  });
}

function openUnbilledImportReviewModal(store, parsedResult) {
  const { windows, projects } = parsedResult;
  const total4 = projects.reduce((a, p) => a + (p.rev4wk || 0), 0);
  const total8 = projects.reduce((a, p) => a + (p.rev8wk || 0), 0);
  const has4 = projects.some((p) => p.rev4wk > 0);
  const has8 = projects.some((p) => p.rev8wk > 0);

  openModal(`
    <button type="button" class="modal-close-x" id="ubr-close">✕</button>
    <h3>Import Revenue Forecast</h3>
    <div class="desc" style="font-size:12.5px;color:var(--text-mid);margin-bottom:14px;line-height:1.6;">
      Found <strong style="color:var(--text-hi);">${projects.length}</strong> projects with a forecasted amount.
      Choose which window(s) to bring in as Unbilled Receivable lines — checking both creates two lines per project.
      You can fine-tune the invoice date, bill %, or amount on individual lines afterward.
    </div>

    <div class="panel" style="padding:14px;margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px;">
        <input type="checkbox" id="ubr-include-4wk" ${has4 ? "checked" : ""} ${has4 ? "" : "disabled"}/>
        4-Week Forecast — ${projects.filter((p) => p.rev4wk > 0).length} projects · ${fmtMoney(total4)} total
      </label>
      <div class="row" style="margin:0 0 6px;"><label>Invoice Date for these lines</label><input type="date" id="ubr-date-4wk" value="${windows.fourWeek.end || todayISO()}" /></div>
      <div class="row" style="margin:0;"><label>Bill %</label><select id="ubr-pct-4wk">${BILL_PERCENTS.map((p) => `<option value="${p}" ${p === 100 ? "selected" : ""}>${p}%</option>`).join("")}</select></div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px;">
      <label style="display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px;">
        <input type="checkbox" id="ubr-include-8wk" ${has8 ? "checked" : ""} ${has8 ? "" : "disabled"}/>
        8-Week Forecast — ${projects.filter((p) => p.rev8wk > 0).length} projects · ${fmtMoney(total8)} total
      </label>
      <div class="row" style="margin:0 0 6px;"><label>Invoice Date for these lines</label><input type="date" id="ubr-date-8wk" value="${windows.eightWeek.end || todayISO()}" /></div>
      <div class="row" style="margin:0;"><label>Bill %</label><select id="ubr-pct-8wk">${BILL_PERCENTS.map((p) => `<option value="${p}" ${p === 100 ? "selected" : ""}>${p}%</option>`).join("")}</select></div>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" id="ubr-cancel">Cancel</button>
      <button class="btn-primary" id="ubr-confirm" style="width:auto;">Import</button>
    </div>
  `, {
    closeOnBackdrop: false,
    onMount: (host) => {
      host.querySelector("#ubr-close").onclick = closeModal;
      host.querySelector("#ubr-cancel").onclick = closeModal;
      host.querySelector("#ubr-confirm").onclick = () => {
        const include4 = host.querySelector("#ubr-include-4wk").checked;
        const include8 = host.querySelector("#ubr-include-8wk").checked;
        const date4 = host.querySelector("#ubr-date-4wk").value;
        const date8 = host.querySelector("#ubr-date-8wk").value;
        const pct4 = Number(host.querySelector("#ubr-pct-4wk").value);
        const pct8 = Number(host.querySelector("#ubr-pct-8wk").value);
        if (!include4 && !include8) { toast("Check at least one window to import", "error"); return; }

        const specs = [];
        for (const p of projects) {
          if (include4 && p.rev4wk > 0) {
            specs.push({ projectNumber: p.projectNumber, project: p.project, customer: p.customer, forecastWindow: "4wk", originalBalance: p.rev4wk, billPercent: pct4, date: date4 });
          }
          if (include8 && p.rev8wk > 0) {
            specs.push({ projectNumber: p.projectNumber, project: p.project, customer: p.customer, forecastWindow: "8wk", originalBalance: p.rev8wk, billPercent: pct8, date: date8 });
          }
        }
        store.mutate((s) => {
          const added = createUnbilledLines(s, specs);
          toast(`Imported ${added} unbilled revenue line${added === 1 ? "" : "s"}`, "success", 5000);
        });
        closeModal();
      };
    },
  });
}

/* ============================================================ PAYABLES ============================================================ */

let apFilter = "open", apSearch = "", apVendorFilter = "", apPayrunFilter = "";
const apSelected = new Set();

// Drag-to-resize table columns, with the resulting widths saved so they
// persist between visits. Safe to call on every render — guards against
// re-wiring the same table's listeners more than once, and re-applies saved
// widths each time in case the column set changed.
function wireResizableColumns(table) {
  if (!table) return;
  const storageKey = `colwidths:${table.id}`;
  const cols = table.querySelectorAll("colgroup col[data-col]");
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { /* ignore corrupt data */ }
  cols.forEach((col) => { if (saved[col.dataset.col]) col.style.width = `${saved[col.dataset.col]}px`; });

  if (table.dataset.resizeWired) return;
  table.dataset.resizeWired = "1";

  table.querySelectorAll("th .col-resize-handle").forEach((handle, idx) => {
    const col = cols[idx];
    if (!col) return;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = col.getBoundingClientRect().width;
      handle.classList.add("resizing");
      const onMove = (ev) => {
        const next = Math.max(50, startWidth + (ev.clientX - startX));
        col.style.width = `${next}px`;
      };
      const onUp = () => {
        handle.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        let current = {};
        try { current = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { /* ignore */ }
        current[col.dataset.col] = Math.round(col.getBoundingClientRect().width);
        localStorage.setItem(storageKey, JSON.stringify(current));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

export function renderPayables(store) {
  const { state } = store;
  const period = state.periods.find((p) => p.id === state.activePeriodId) || state.periods[0];
  const weeks = periodWeeks(period).slice(0, cfViewWeeks);

  const openList = state.payables.filter((p) => p.status === "open");
  const totalAP = openList.reduce((a, p) => a + p.balance, 0);
  const scheduled = openList.filter((p) => effectivePayableDate(state, period, p)).reduce((a, p) => a + p.balance, 0);
  const unscheduled = totalAP - scheduled;

  document.getElementById("ap-meta").textContent = `${openList.length} open · ${openList.filter((p) => !effectivePayableDate(state, period, p)).length} unscheduled`;
  const weeklyApScheduled = weeks.map((w) => openList.filter((p) => weekIndexForDate(period, effectivePayableDate(state, period, p)) === w.index).reduce((a, p) => a + p.balance, 0));
  const apSchedChart = urvSparklineSVG(weeklyApScheduled, weeks, "ap-sched", { W: 150, H: 36, padX: 3, padY: 4, fromZero: true });
  document.getElementById("ap-stats").innerHTML = `
    <div class="stat-card kpi-card sc-close"><div class="kpi-icon">▤</div><div class="kpi-body"><div class="label">Open AP</div><div class="value brass">${fmtMoney(totalAP)}</div></div></div>
    <div class="stat-card kpi-card sc-out"><div class="kpi-icon">↘</div><div class="kpi-body"><div class="label">Scheduled</div><div class="value green">${fmtMoney(scheduled)}</div></div><div class="kpi-mini-chart">${apSchedChart.html}</div></div>
    <div class="stat-card kpi-card sc-unc"><div class="kpi-icon">!</div><div class="kpi-body"><div class="label">Unscheduled</div><div class="value amber">${fmtMoney(unscheduled)}</div></div></div>
  `;
  wireUrvChartHover(document.getElementById("ap-stats"), "ap-sched", apSchedChart.points, apSchedChart.W);

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
    store.mutate((s) => { s.payables.forEach((x) => recordTombstone(s, "payables", x.id)); s.payables = []; });
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
  wireResizableColumns(document.getElementById("ap-table"));
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
  const weeks = periodWeeks(period).slice(0, cfViewWeeks);
  let list = state.payables;
  if (apFilter === "open") list = list.filter((p) => p.status === "open");
  if (apFilter === "scheduled") list = list.filter((p) => p.status === "open" && effectivePayableDate(state, period, p));
  if (apFilter === "unscheduled") list = list.filter((p) => p.status === "open" && !effectivePayableDate(state, period, p));
  if (apSearch) list = list.filter((p) => `${p.vendor} ${p.docNumber} ${p.memo || ""}`.toLowerCase().includes(apSearch));
  if (apVendorFilter) list = list.filter((p) => p.vendor === apVendorFilter);
  if (apPayrunFilter === "unscheduled") list = list.filter((p) => !effectivePayableDate(state, period, p));
  else if (apPayrunFilter) list = list.filter((p) => effectivePayableDate(state, period, p) === apPayrunFilter);
  list = list.slice().sort((a, b) => (a.vendor || "").localeCompare(b.vendor || "") || (a.date || "").localeCompare(b.date || ""));

  document.getElementById("ap-count").textContent = `${list.length} rows${apSelected.size ? ` · ${apSelected.size} selected` : ""}`;
  const tbody = document.getElementById("ap-tbody");
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h4>No bills here</h4>Import your Aged AP export or add one manually.</div></td></tr>`; return; }

  const openReceivables = state.receivables.filter((r) => r.status === "open").sort((a, b) => (a.docNumber || "").localeCompare(b.docNumber || "", undefined, { numeric: true }));
  const openUnbilled = (state.unbilledReceivables || []).filter((u) => u.status === "open").sort((a, b) => (a.projectNumber || "").localeCompare(b.projectNumber || "", undefined, { numeric: true }));

  tbody.innerHTML = list.map((p) => {
    const whoBadge = p.lastEditBy ? `<span class="who-inline" title="Last edited by ${escapeHtml(p.lastEditBy)}">${escapeHtml(p.lastEditBy)}</span>` : "";
    const effDate = effectivePayableDate(state, period, p);
    const linkedValue = p.payWhenPaid && p.linkedReceivableId ? `${p.linkedReceivableKind === "unbilled" ? "unbilled" : "ar"}:${p.linkedReceivableId}` : "";
    const payrunCell = p.payWhenPaid
      ? `<select class="mini-select pwp-receivable-select">
          <option value="">— pick a receivable —</option>
          <optgroup label="Existing AR">
            ${openReceivables.map((r) => `<option value="ar:${r.id}" ${linkedValue === `ar:${r.id}` ? "selected" : ""}>${escapeHtml(r.docNumber || "(no #)")} — ${escapeHtml(r.customer)} — ${fmtMoney(r.balance)}${r.cfDate ? " · " + fmtDate(r.cfDate) : " · unscheduled"}</option>`).join("")}
          </optgroup>
          <optgroup label="Unbilled (not yet invoiced)">
            ${openUnbilled.map((u) => `<option value="unbilled:${u.id}" ${linkedValue === `unbilled:${u.id}` ? "selected" : ""}>${escapeHtml(u.projectNumber || "(no #)")} — ${escapeHtml(u.customer)} — ${fmtMoney(u.balance)}${u.cfDate ? " · " + fmtDate(u.cfDate) : " · unscheduled"}</option>`).join("")}
          </optgroup>
        </select>
        <div class="pwp-result ${effDate ? "" : "unset"} ${p.payDateOverride ? "is-override" : ""}">
          <span class="pwp-date-text" title="Click to manually set this payable's pay date instead">${effDate ? `→ pays ${fmtDate(effDate)}` : "→ not scheduled (receivable unscheduled)"}</span>
          ${p.payDateOverride ? `<button type="button" class="pwp-reset" title="Reset to auto-scheduled (the pay run the week after the receivable is collected)">↺</button>` : ""}
        </div>`
      : `<select class="mini-select payrun-select">
          <option value="">— unscheduled —</option>
          ${weeks.map((w) => `<option value="${w.payRun}" ${p.cfDate === w.payRun ? "selected" : ""}>${fmtDate(w.payRun)}</option>`).join("")}
        </select>`;
    return `<tr class="${p.status === "paid" ? "paid" : ""}" data-id="${p.id}">
      <td><input type="checkbox" class="row-select" ${apSelected.has(p.id) ? "checked" : ""} /></td>
      <td class="name">${escapeHtml(p.vendor)}</td>
      <td class="mono">${escapeHtml(p.docNumber || "")}</td>
      <td class="mono">${fmtDate(p.date)}</td>
      <td class="memo-cell" title="${escapeHtml(p.memo || "")}">${escapeHtml(p.memo || "—")}</td>
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
        if (!e.target.checked) {
          item.linkedReceivableId = null; item.linkedReceivableKind = null; item.payDateOverride = null;
          recordPwpMemory(s, item, null); // unchecking clears the remembered link too
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".pwp-receivable-select")?.addEventListener("change", (e) => {
      const [kind, recId] = e.target.value ? e.target.value.split(":") : [null, null];
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.linkedReceivableId = recId || null;
        item.linkedReceivableKind = kind === "unbilled" ? "unbilled" : "ar";
        if (recId) {
          const list = item.linkedReceivableKind === "unbilled" ? (s.unbilledReceivables || []) : s.receivables;
          recordPwpMemory(s, item, list.find((r) => r.id === recId) || null);
        } else {
          recordPwpMemory(s, item, null);
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".pwp-date-text")?.addEventListener("click", () => {
      const item0 = state.payables.find((x) => x.id === id);
      const cellEffDate = effectivePayableDate(state, period, item0);
      const input = document.createElement("input");
      input.type = "date"; input.className = "mini-input";
      input.value = item0.payDateOverride || cellEffDate || "";
      const wrap = tr.querySelector(".pwp-result");
      wrap.innerHTML = ""; wrap.appendChild(input); input.focus();
      const commit = () => {
        const val = input.value || null;
        store.mutate((s) => {
          const item = s.payables.find((x) => x.id === id);
          item.payDateOverride = val;
          item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
        });
      };
      input.addEventListener("keydown", (e2) => { if (e2.key === "Enter") input.blur(); });
      input.addEventListener("blur", commit, { once: true });
    });
    tr.querySelector(".pwp-reset")?.addEventListener("click", (e) => {
      e.stopPropagation();
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        item.payDateOverride = null;
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".toggle-status")?.addEventListener("click", () => {
      store.mutate((s) => {
        const item = s.payables.find((x) => x.id === id);
        const reopening = item.status === "paid";
        item.status = item.status === "open" ? "paid" : "open";
        if (reopening && item.originalBalance !== undefined) {
          item.balance = item.originalBalance;
        } else if (!reopening) {
          if (item.originalBalance === undefined) item.originalBalance = item.balance;
          item.balance = 0;
        }
        item.lastEditBy = store.initials(); item.updatedAt = new Date().toISOString();
      });
    });
    tr.querySelector(".del-row")?.addEventListener("click", () => {
      const rec = state.payables.find((x) => x.id === id);
      if (!confirm(`Remove bill ${rec.docNumber || ""} for ${rec.vendor}?`)) return;
      apSelected.delete(id);
      store.mutate((s) => { recordTombstone(s, "payables", id); s.payables = s.payables.filter((x) => x.id !== id); });
    });
  });
}

async function copyPayablesToClipboard(state, period) {
  const selected = state.payables.filter((p) => apSelected.has(p.id));
  if (!selected.length) { toast("Select at least one row first (checkboxes on the left)", "error"); return; }

  const byVendor = {};
  for (const p of selected) (byVendor[p.vendor] = byVendor[p.vendor] || []).push(p);
  const vendors = Object.keys(byVendor).sort((a, b) => customerSortKey(a).localeCompare(customerSortKey(b)));
  const multi = vendors.length > 1;
  const exact = (n) => fmtMoney(n, { cents: true }); // exact to the cent — this becomes the actual payment basis

  // Same approach as the Receivables copy: a real <table> with inline styles
  // on the clipboard as text/html, since email clients render pasted content
  // in a proportional font and plain-text column padding won't line up there.
  const th = `padding:7px 12px;text-align:left;font-size:12px;font-family:Arial,Helvetica,sans-serif;color:#555;text-transform:uppercase;letter-spacing:0.03em;border-bottom:2px solid #333;`;
  const thNum = th + `text-align:right;`;
  const td = `padding:7px 12px;font-size:13px;font-family:Arial,Helvetica,sans-serif;color:#222;border-bottom:1px solid #e2e2e2;`;
  const tdNum = td + `text-align:right;font-variant-numeric:tabular-nums;`;
  const tdTotal = `padding:8px 12px;font-size:13px;font-weight:700;font-family:Arial,Helvetica,sans-serif;color:#111;background:#f5f5f5;border-top:1px solid #ccc;border-bottom:1px solid #ccc;`;
  const tdTotalNum = tdTotal + `text-align:right;`;

  let grandTotal = 0;
  const bodyRows = [];
  vendors.forEach((v) => {
    const invoices = byVendor[v].slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const vendorTotal = invoices.reduce((a, p) => a + p.balance, 0);
    grandTotal += vendorTotal;

    if (multi) {
      bodyRows.push(`<tr>
        <td style="${tdTotal}" colspan="3">${escapeHtml(v)} — Total (${invoices.length} invoice${invoices.length === 1 ? "" : "s"})</td>
        <td style="${tdTotalNum}">${exact(vendorTotal)}</td>
      </tr>`);
    }
    for (const p of invoices) {
      const eff = effectivePayableDate(state, period, p);
      const payRun = eff ? `${fmtDate(eff)}${p.payWhenPaid ? " (PWP)" : ""}` : "Unscheduled";
      bodyRows.push(`<tr>
        <td style="${td}">${escapeHtml(multi ? "" : v)}</td>
        <td style="${td}">${escapeHtml(p.docNumber || "—")}</td>
        <td style="${td}">${p.date ? fmtDate(p.date) : "—"} <span style="color:#888;">· ${escapeHtml(payRun)}</span></td>
        <td style="${tdNum}">${exact(p.balance)}</td>
      </tr>`);
    }
  });
  if (multi) {
    bodyRows.push(`<tr>
      <td style="${tdTotal}" colspan="3">Grand Total (${selected.length} invoice${selected.length === 1 ? "" : "s"} · ${vendors.length} vendors)</td>
      <td style="${tdTotalNum}">${exact(grandTotal)}</td>
    </tr>`);
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;">
      <table style="border-collapse:collapse;width:100%;max-width:640px;">
        <thead>
          <tr>
            <th style="${th}">Vendor</th>
            <th style="${th}">Invoice #</th>
            <th style="${th}">Date · Pay Run</th>
            <th style="${thNum}">Balance</th>
          </tr>
        </thead>
        <tbody>${bodyRows.join("")}</tbody>
      </table>
    </div>`;

  const plainLines = [["Vendor", "Invoice #", "Date", "Pay Run", "Balance"].join("\t")];
  vendors.forEach((v) => {
    const invoices = byVendor[v].slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    for (const p of invoices) {
      const eff = effectivePayableDate(state, period, p);
      plainLines.push([v, p.docNumber || "—", p.date ? fmtDate(p.date) : "", eff ? fmtDate(eff) : "Unscheduled", exact(p.balance)].join("\t"));
    }
  });
  const plainText = plainLines.join("\n");

  const done = () => toast(`Copied payment schedule — ${selected.length} invoice${selected.length === 1 ? "" : "s"} across ${vendors.length} vendor${vendors.length === 1 ? "" : "s"} — paste into an email as a formatted table`, "success", 5000);

  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plainText);
    }
    done();
  } catch {
    try {
      await navigator.clipboard.writeText(plainText);
      done();
    } catch {
      toast("Couldn't copy to clipboard — your browser may be blocking it", "error");
    }
  }
}

async function copyReceivablesToClipboard(state) {
  const selected = state.receivables.filter((r) => arSelected.has(r.id));
  if (!selected.length) { toast("Select at least one row first (checkboxes on the left)", "error"); return; }

  const byCustomer = {};
  for (const r of selected) (byCustomer[r.customer] = byCustomer[r.customer] || []).push(r);
  const customers = Object.keys(byCustomer).sort((a, b) => customerSortKey(a).localeCompare(customerSortKey(b)));
  const multi = customers.length > 1;

  // Email clients (Outlook, Gmail, Apple Mail, etc.) render pasted content in
  // whatever proportional font the message already uses — plain-text spacing
  // can't line up there. So this builds an actual <table> with inline styles
  // (email HTML has to be inline; <style> blocks get stripped by most clients)
  // and puts it on the clipboard as real text/html, with a plain-text version
  // alongside as a fallback for anywhere that only accepts plain text.
  const th = `padding:7px 12px;text-align:left;font-size:12px;font-family:Arial,Helvetica,sans-serif;color:#555;text-transform:uppercase;letter-spacing:0.03em;border-bottom:2px solid #333;`;
  const thNum = th + `text-align:right;`;
  const td = `padding:7px 12px;font-size:13px;font-family:Arial,Helvetica,sans-serif;color:#222;border-bottom:1px solid #e2e2e2;`;
  const tdNum = td + `text-align:right;font-variant-numeric:tabular-nums;`;
  const tdTotal = `padding:8px 12px;font-size:13px;font-weight:700;font-family:Arial,Helvetica,sans-serif;color:#111;background:#f5f5f5;border-top:1px solid #ccc;border-bottom:1px solid #ccc;`;
  const tdTotalNum = tdTotal + `text-align:right;`;

  let grandTotal = 0;
  const bodyRows = [];
  customers.forEach((c) => {
    const invoices = byCustomer[c].slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const customerTotal = invoices.reduce((a, r) => a + r.balance, 0);
    grandTotal += customerTotal;

    if (multi) {
      bodyRows.push(`<tr>
        <td style="${tdTotal}" colspan="4">${escapeHtml(c)} — Total</td>
        <td style="${tdTotalNum}">${fmtMoney(customerTotal, { cents: true })}</td>
      </tr>`);
    }
    for (const r of invoices) {
      bodyRows.push(`<tr>
        <td style="${td}">${escapeHtml(multi ? "" : c)}</td>
        <td style="${td}">${escapeHtml(r.poNumber || "—")}</td>
        <td style="${td}">${r.date ? fmtDate(r.date) : "—"}</td>
        <td style="${td}">${escapeHtml(r.docNumber || "—")}</td>
        <td style="${tdNum}">${fmtMoney(r.balance, { cents: true })}</td>
      </tr>`);
    }
  });
  if (multi) {
    bodyRows.push(`<tr>
      <td style="${tdTotal}" colspan="4">Grand Total</td>
      <td style="${tdTotalNum}">${fmtMoney(grandTotal, { cents: true })}</td>
    </tr>`);
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;">
      <table style="border-collapse:collapse;width:100%;max-width:640px;">
        <thead>
          <tr>
            <th style="${th}">Customer</th>
            <th style="${th}">PO #</th>
            <th style="${th}">Invoice Date</th>
            <th style="${th}">Invoice #</th>
            <th style="${thNum}">Balance</th>
          </tr>
        </thead>
        <tbody>${bodyRows.join("")}</tbody>
      </table>
    </div>`;

  // plain-text fallback (tab-separated — fine for pasting into a spreadsheet;
  // just not what we're optimizing for here)
  const plainLines = [["Customer", "PO #", "Invoice Date", "Invoice #", "Balance"].join("\t")];
  customers.forEach((c) => {
    const invoices = byCustomer[c].slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    for (const r of invoices) {
      plainLines.push([c, r.poNumber || "—", r.date ? fmtDate(r.date) : "", r.docNumber || "", fmtMoney(r.balance, { cents: true })].join("\t"));
    }
  });
  const plainText = plainLines.join("\n");

  const done = () => toast(`Copied ${selected.length} receivable${selected.length === 1 ? "" : "s"} across ${customers.length} customer${customers.length === 1 ? "" : "s"} — paste into an email as a formatted table`, "success", 5000);

  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plainText);
    }
    done();
  } catch {
    try {
      await navigator.clipboard.writeText(plainText);
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
  applyOffset("ub-frozen-head", "#ub-table");

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
  const k401Weeks = k401WeeksFor(period);
  const payrollAmt = period.payroll?.amount || 0;
  const k401Amt = period.k401?.amount || 0;

  const weekPicker = (kind, bucket, selectedWeeks) => `
    <div class="week-picker" data-kind="${kind}">
      ${Array.from({ length: WEEKS_PER_PERIOD }, (_, wi) => wi).map((wi) => `<button type="button" class="week-toggle ${selectedWeeks.includes(wi) ? "on" : ""}" data-wi="${wi}">Wk ${wi + 1}</button>`).join("")}
    </div>
    ${selectedWeeks.length ? `
    <div class="week-amounts-row" data-kind="${kind}">
      ${selectedWeeks.map((wi) => {
        const amt = weekAmountFor(bucket, wi);
        const isOverride = bucket?.weekAmounts?.[wi] !== undefined && bucket.weekAmounts[wi] !== null;
        return `<div class="week-amount-chip ${isOverride ? "is-override" : ""}">
          <span class="wac-label">Wk ${wi + 1}</span>
          <span class="wac-amt" data-wi="${wi}" title="Click to set a different amount just for this week">${fmtMoney(amt)}</span>
          ${isOverride ? `<button type="button" class="wac-reset" data-wi="${wi}" title="Reset this week back to the default amount">↺</button>` : ""}
        </div>`;
      }).join("")}
    </div>` : ""}`;

  const payrollTotal = payrollWeeks.reduce((a, wi) => a + weekAmountFor(period.payroll, wi), 0);
  const k401Total = k401Weeks.reduce((a, wi) => a + weekAmountFor(period.k401, wi), 0);

  const payrollPanel = `
    <div class="panel fixed-group">
      <div class="fixed-group-head">
        <h3>Payroll <span class="count">${payrollWeeks.length} run${payrollWeeks.length === 1 ? "" : "s"} this period</span></h3>
        <span class="total">${fmtMoney(payrollTotal)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">Payroll</div>
          <div class="fsched">Default amount — click a week below to toggle it on/off, or set that week's own amount</div>
        </div>
        <div class="famt fixed-amt-edit" data-kind="payroll" title="Click to edit the default amount">${fmtMoney(payrollAmt)}<div class="fsched">per run</div></div>
      </div>
      ${weekPicker("payroll", period.payroll, payrollWeeks)}
    </div>
    <div class="panel fixed-group">
      <div class="fixed-group-head">
        <h3>401K <span class="count">${k401Weeks.length} run${k401Weeks.length === 1 ? "" : "s"} this period</span></h3>
        <span class="total">${fmtMoney(k401Total)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">401K</div>
          <div class="fsched">Default amount — click a week below to toggle it on/off, or set that week's own amount</div>
        </div>
        <div class="famt fixed-amt-edit" data-kind="k401" title="Click to edit the default amount">${fmtMoney(k401Amt)}<div class="fsched">per run</div></div>
      </div>
      ${weekPicker("k401", period.k401, k401Weeks)}
    </div>
  `;

  const pcPayrollWeeks = (period.pcPayroll?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD);
  const pcK401Weeks2 = (period.pcK401?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD);
  const pcPayrollAmt = period.pcPayroll?.amount || 0;
  const pcK401Amt = period.pcK401?.amount || 0;
  const pcPayrollTotal = pcPayrollWeeks.reduce((a, wi) => a + weekAmountFor(period.pcPayroll, wi), 0);
  const pcK401Total = pcK401Weeks2.reduce((a, wi) => a + weekAmountFor(period.pcK401, wi), 0);

  const pcPayrollPanel = `
    <div class="panel fixed-group" style="border-top:2px solid var(--indigo);">
      <div class="fixed-group-head">
        <h3>P&amp;C Payroll <span class="count">${pcPayrollWeeks.length} run${pcPayrollWeeks.length === 1 ? "" : "s"} this period</span></h3>
        <span class="total">${fmtMoney(pcPayrollTotal)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">P&amp;C Payroll</div>
          <div class="fsched">Outflow from P&amp;C Checking · click a week to toggle it, or set that week's own amount</div>
        </div>
        <div class="famt fixed-amt-edit" data-kind="pcPayroll" title="Click to edit the default amount">${fmtMoney(pcPayrollAmt)}<div class="fsched">per run</div></div>
      </div>
      ${weekPicker("pcPayroll", period.pcPayroll, pcPayrollWeeks)}
    </div>
    <div class="panel fixed-group" style="border-top:2px solid var(--indigo);">
      <div class="fixed-group-head">
        <h3>P&amp;C 401K <span class="count">${pcK401Weeks2.length} run${pcK401Weeks2.length === 1 ? "" : "s"} this period</span></h3>
        <span class="total">${fmtMoney(pcK401Total)} this period</span>
      </div>
      <div class="fixed-item" style="grid-template-columns:1fr 120px;">
        <div>
          <div class="fname">P&amp;C 401K</div>
          <div class="fsched">Outflow from P&amp;C Checking · click a week to toggle it, or set that week's own amount</div>
        </div>
        <div class="famt fixed-amt-edit" data-kind="pcK401" title="Click to edit the default amount">${fmtMoney(pcK401Amt)}<div class="fsched">per run</div></div>
      </div>
      ${weekPicker("pcK401", period.pcK401, pcK401Weeks2)}
    </div>
  `;

  const interestAccounts = [
    { id: "basin-savings", name: "Basin Savings", color: "var(--brass)" },
    { id: "eb-savings", name: "EB Savings", color: "var(--violet)" },
    { id: "pc-savings", name: "P&C Savings", color: "var(--cyan)" },
  ];
  const interestPanel = interestAccounts.map((acct) => {
    const cfg = period.interest?.[acct.id] || { rate: 0, dayOfMonth: 1, avgBalance: 0 };
    const { amount: monthlyInterest } = interestForAccount(state, period, acct.id);
    return `
      <div class="panel fixed-group interest-panel" style="border-top:2px solid ${acct.color};" data-interest-acct="${acct.id}">
        <div class="fixed-group-head">
          <h3>${escapeHtml(acct.name)} Interest</h3>
          <span class="total">${fmtMoney(monthlyInterest)} / posting</span>
        </div>
        <div class="interest-inputs-row">
          <div class="interest-field">
            <label>Annual Rate</label>
            <div class="interest-field-input"><input type="number" step="0.01" min="0" class="mini-input interest-rate-input" value="${((cfg.rate || 0) * 100).toFixed(2)}" />%</div>
          </div>
          <div class="interest-field">
            <label>Posts on Day</label>
            <input type="number" min="1" max="31" class="mini-input interest-dom-input" value="${cfg.dayOfMonth || 1}" />
          </div>
          <div class="interest-field">
            <label>Avg Monthly Balance</label>
            <input type="number" step="0.01" min="0" class="mini-input interest-avgbal-input" value="${cfg.avgBalance || 0}" />
          </div>
        </div>
        <div class="fsched" style="padding:0 16px 14px;">Interest = Avg Monthly Balance × (Annual Rate ÷ 12) = ${fmtMoney(monthlyInterest)} each time it posts</div>
      </div>`;
  }).join("");

  let periodTotal = payrollWeeks.length * payrollAmt + k401Weeks.length * k401Amt;
  const host = document.getElementById("fixed-groups");
  host.innerHTML = payrollPanel + pcPayrollPanel + interestPanel + categories.filter((c) => c !== "Payroll" && c !== "401K").map((cat) => {
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
          <div class="fname">${escapeHtml(item.name)}${item.transferFrom && item.transferTo ? ` <span class="window-badge" title="Recurring transfer: ${escapeHtml(accountName(item.transferFrom))} → ${escapeHtml(accountName(item.transferTo))}">⇄ ${escapeHtml(accountName(item.transferFrom))} → ${escapeHtml(accountName(item.transferTo))}</span>` : ""}${whoBadge}</div>
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


  const bucketFor = (per, kind) => ({ payroll: per.payroll, k401: per.k401, pcPayroll: per.pcPayroll, pcK401: per.pcK401 }[kind]);

  host.querySelectorAll(".week-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.closest(".week-picker").dataset.kind; // "payroll" | "k401" | "pcPayroll" | "pcK401"
      const wi = Number(btn.dataset.wi);
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const bucket = bucketFor(per, kind);
        bucket.weeks = bucket.weeks || [];
        const idx = bucket.weeks.indexOf(wi);
        if (idx === -1) bucket.weeks.push(wi); else bucket.weeks.splice(idx, 1);
      });
    });
  });
  host.querySelectorAll(".fixed-amt-edit").forEach((cell) => {
    cell.addEventListener("click", () => {
      const kind = cell.dataset.kind;
      const current = bucketFor(period, kind)?.amount || 0;
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.className = "mini-input"; input.style.width = "100px"; input.style.textAlign = "right";
      input.value = current;
      cell.innerHTML = ""; cell.appendChild(input); input.focus(); input.select();
      const commit = () => {
        const val = parseFloat(input.value);
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          const bucket = bucketFor(per, kind);
          if (!Number.isNaN(val) && val >= 0) bucket.amount = Math.round(val * 100) / 100;
        });
      };
      input.addEventListener("keydown", (e2) => { if (e2.key === "Enter") input.blur(); if (e2.key === "Escape") { input.value = current; input.blur(); } });
      input.addEventListener("blur", commit, { once: true });
    });
  });
  host.querySelectorAll(".wac-amt").forEach((cell) => {
    cell.addEventListener("click", () => {
      const kind = cell.closest(".week-amounts-row").dataset.kind;
      const wi = Number(cell.dataset.wi);
      const current = weekAmountFor(bucketFor(period, kind), wi);
      const input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.className = "mini-input"; input.style.width = "88px"; input.style.textAlign = "right";
      input.value = current;
      cell.innerHTML = ""; cell.appendChild(input); input.focus(); input.select();
      const commit = () => {
        const val = parseFloat(input.value);
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          const bucket = bucketFor(per, kind);
          if (!Number.isNaN(val) && val >= 0) {
            bucket.weekAmounts = bucket.weekAmounts || {};
            bucket.weekAmounts[wi] = Math.round(val * 100) / 100;
          }
        });
      };
      input.addEventListener("keydown", (e2) => { if (e2.key === "Enter") input.blur(); if (e2.key === "Escape") { input.value = current; input.blur(); } });
      input.addEventListener("blur", commit, { once: true });
    });
  });
  host.querySelectorAll(".wac-reset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const kind = btn.closest(".week-amounts-row").dataset.kind;
      const wi = Number(btn.dataset.wi);
      store.mutate((s) => {
        const per = s.periods.find((p) => p.id === period.id);
        const bucket = bucketFor(per, kind);
        if (bucket.weekAmounts) delete bucket.weekAmounts[wi];
      });
    });
  });

  host.querySelectorAll(".interest-panel").forEach((panel) => {
    const acctId = panel.dataset.interestAcct;
    const commit = (cssSuffix, fieldName, transform) => {
      const input = panel.querySelector(`.interest-${cssSuffix}-input`);
      input.addEventListener("change", () => {
        const raw = parseFloat(input.value || "0");
        store.mutate((s) => {
          const per = s.periods.find((p) => p.id === period.id);
          per.interest = per.interest || {};
          per.interest[acctId] = per.interest[acctId] || { rate: 0, dayOfMonth: 1, avgBalance: 0 };
          const val = Number.isNaN(raw) ? 0 : raw;
          per.interest[acctId][fieldName] = transform ? transform(val) : val;
        });
      });
    };
    commit("rate", "rate", (v) => Math.max(0, v) / 100); // entered as a percent, stored as a decimal
    commit("dom", "dayOfMonth", (v) => Math.min(31, Math.max(1, Math.round(v) || 1)));
    commit("avgbal", "avgBalance", (v) => Math.max(0, v));
  });

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
    store.mutate((s) => { recordTombstone(s, "fixedPayments", id); s.fixedPayments = s.fixedPayments.filter((f) => f.id !== id); });
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
    <div class="row"><label>This is a recurring transfer between accounts</label>
      <div style="display:flex; gap:8px; align-items:center;">
        <select id="f-transfer-from" style="flex:1;">
          <option value="">— not a transfer —</option>
          ${ACCOUNTS.map((a) => `<option value="${a.id}" ${existing.transferFrom === a.id ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
        </select>
        <span style="color:var(--text-dim);">→</span>
        <select id="f-transfer-to" style="flex:1;">
          <option value="">—</option>
          ${ACCOUNTS.map((a) => `<option value="${a.id}" ${existing.transferTo === a.id ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="desc" style="font-size:11.5px;color:var(--text-dim);margin-top:-6px;">If this payment is actually a recurring transfer between two accounts (like a monthly sweep to savings), pick From and To here — it'll show up as an "Inter Company Transfer" outflow on the From account and inflow on the To account, instead of posting to its category.</div>
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
        store.mutate((s) => { recordTombstone(s, "fixedPayments", existing.id); s.fixedPayments = s.fixedPayments.filter((f) => f.id !== existing.id); });
        closeModal();
      });
      host.querySelector("#f-save").onclick = () => {
        const cat = host.querySelector("#f-cat").value.trim();
        const name = host.querySelector("#f-name").value.trim();
        const amount = parseFloat(host.querySelector("#f-amt").value || "0");
        if (!cat || !name) { toast("Category and name are required", "error"); return; }
        const transferFrom = host.querySelector("#f-transfer-from").value || null;
        const transferTo = host.querySelector("#f-transfer-to").value || null;
        if (transferFrom && transferTo && transferFrom === transferTo) { toast("From and To accounts can't be the same", "error"); return; }
        const payload = {
          category: cat, name, amount,
          scheduleType: schedSel.value,
          dayOfMonth: Number(host.querySelector("#f-dom").value || 1),
          weekday: Number(host.querySelector("#f-dow").value || 4),
          endDate: host.querySelector("#f-end").value || null,
          transferFrom: transferFrom && transferTo ? transferFrom : null,
          transferTo: transferFrom && transferTo ? transferTo : null,
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

  renderAutoScheduleTable(store, ["AR", "UNBILLED"], document.getElementById("ar-auto-list"));
  renderAutoScheduleTable(store, "AP", document.getElementById("ap-auto-list"));
  document.getElementById("ar-auto-search").oninput = (e) => renderAutoScheduleTable(store, ["AR", "UNBILLED"], document.getElementById("ar-auto-list"), e.target.value.toLowerCase());
  document.getElementById("ap-auto-search").oninput = (e) => renderAutoScheduleTable(store, "AP", document.getElementById("ap-auto-list"), e.target.value.toLowerCase());
  document.getElementById("ar-auto-apply-all").onclick = () => {
    store.mutate((s) => {
      const n = applyAutoScheduleToAll(s, "AR") + applyAutoScheduleToAll(s, "UNBILLED");
      toast(`Updated CF date on ${n} open item${n === 1 ? "" : "s"} across every customer with Auto turned on`, "success");
    });
  };
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

function renderAutoScheduleTable(store, kinds, host, search = "") {
  const { state } = store;
  if (typeof kinds === "string") kinds = [kinds];
  const { schedKey } = KIND_MAP[kinds[0]];
  const noun = { AR: "receivables", AP: "payables", UNBILLED: "unbilled lines" };
  const showUncertain = kinds.includes("AR"); // uncertain-invoice-date is an AR/Unbilled concept, not AP
  const names = Object.keys(state[schedKey]).filter((n) => n.toLowerCase().includes(search)).sort((a, b) => customerSortKey(a).localeCompare(customerSortKey(b)));
  if (!names.length) { host.innerHTML = `<div class="meta" style="padding:14px;">Import ${kinds.map((k) => noun[k]).join(" or ")} to populate this list.</div>`; return; }

  const balances = {};
  for (const kind of kinds) {
    const { listKey, groupKey } = KIND_MAP[kind];
    for (const item of state[listKey]) {
      if (item.status !== "open") continue;
      balances[item[groupKey]] = (balances[item[groupKey]] || 0) + item.balance;
    }
  }

  host.innerHTML = names.map((name) => {
    const t = state[schedKey][name];
    return `<div class="auto-row ${showUncertain ? "with-unc" : ""}" data-name="${escapeHtml(name)}">
      <span>${escapeHtml(name)}</span>
      <span class="auto-balance mono">${fmtMoney(balances[name] || 0)}</span>
      <input class="mini-input days-in" type="number" value="${t.days}" />
      <span class="toggle ${t.auto ? "on" : ""}"><span class="dot"></span></span>
      ${showUncertain ? `<span class="toggle unc-toggle ${t.uncertain ? "on" : ""}" title="Mark every open invoice for this customer as uncertain"><span class="dot"></span></span>` : ""}
      <button class="mini-btn apply-now">Apply</button>
    </div>`;
  }).join("");
  host.querySelectorAll(".auto-row").forEach((row) => {
    const name = row.dataset.name;
    row.querySelector(".days-in").addEventListener("change", (e) => {
      store.mutate((s) => { s[schedKey][name].days = Number(e.target.value || 0); });
    });
    row.querySelector(".toggle:not(.unc-toggle)").addEventListener("click", () => {
      store.mutate((s) => { s[schedKey][name].auto = !s[schedKey][name].auto; });
    });
    row.querySelector(".unc-toggle")?.addEventListener("click", () => {
      store.mutate((s) => {
        const t = s[schedKey][name];
        t.uncertain = !t.uncertain;
        const now = new Date().toISOString();
        let n = 0;
        for (const kind of kinds) {
          const { listKey, groupKey } = KIND_MAP[kind];
          for (const item of s[listKey]) {
            if (item.status !== "open" || item[groupKey] !== name) continue;
            if (t.uncertain) {
              item.uncertain = true;
              item.cfDate = null;
              item.daysOverride = null;
            } else {
              item.uncertain = false;
            }
            item.updatedAt = now;
            n++;
          }
        }
        toast(t.uncertain ? `Marked ${n} open item${n === 1 ? "" : "s"} for ${name} as uncertain` : `Cleared uncertain on ${n} open item${n === 1 ? "" : "s"} for ${name}`, "success");
      });
    });
    row.querySelector(".apply-now").addEventListener("click", () => {
      store.mutate((s) => {
        const n = kinds.reduce((sum, kind) => sum + applyAutoScheduleToGroup(s, kind, name), 0);
        toast(`Updated CF date on ${n} open item${n === 1 ? "" : "s"} for ${name}`, "success");
      });
    });
  });
}

function openRollForwardModal(store, period, calc, weeksMeta) {
  const buildPreview = (n) => {
    const newStart = toISO(addDays(period.startDate, 7 * n));
    const newOpening = calc.weeks[n - 1].closing;
    const newLoc = calc.weeks[n - 1].locBalance;
    const droppedRange = n === 1
      ? `Week 1 (${fmtDateShort(weeksMeta[0].start)}–${fmtDateShort(weeksMeta[0].end)})`
      : `Weeks 1–${n} (${fmtDateShort(weeksMeta[0].start)}–${fmtDateShort(weeksMeta[n - 1].end)})`;
    const remaining = 5 - n;
    return `
      This starts a new forecast on <strong style="color:var(--text-hi);">${fmtDate(newStart)}</strong>.
      ${droppedRange} ${n === 1 ? "is" : "are"} dropped, the remaining ${remaining} week${remaining === 1 ? "" : "s"} shift up to become week${remaining === 1 ? "" : "s"} 1–${remaining}, and ${n} new week${n === 1 ? "" : "s"} open${n === 1 ? "s" : ""} at the end.
      <br/><br/>
      Opening Cash carries forward as <strong style="color:var(--green);">${fmtMoney(newOpening)}</strong> (the closing balance at the end of week ${n}), and LOC Balance carries forward as <strong style="color:var(--indigo);">${fmtMoney(newLoc)}</strong>.
      Notes and CF dates on the surviving weeks shift with them; notes on the dropped weeks go with them. Receivables and payables aren't touched — anything still open just re-buckets into the new week 1 automatically.
      <br/><br/>
      The current period (<strong style="color:var(--text-hi);">${escapeHtml(period.label)}</strong>) is kept in your period history, not deleted.
    `;
  };

  openModal(`
    <button type="button" class="modal-close-x" id="rf-close">✕</button>
    <h3>⟳ Roll Forward</h3>
    <div class="row"><label>Weeks to roll forward</label>
      <select id="rf-weeks">
        ${Array.from({ length: WEEKS_PER_PERIOD - 1 }, (_, i) => i + 1).map((n) => `<option value="${n}">${n} week${n === 1 ? "" : "s"}</option>`).join("")}
      </select>
    </div>
    <div class="desc" id="rf-preview" style="font-size:12.5px;color:var(--text-mid);margin-bottom:14px;line-height:1.6;">${buildPreview(1)}</div>
    <div class="row"><label>New Period Label</label><input id="rf-label" value="" placeholder="auto-generated if left blank" /></div>
    <div class="modal-actions">
      <button class="btn-ghost" id="rf-cancel">Cancel</button>
      <button class="btn-primary" id="rf-confirm" style="width:auto;">Roll Forward</button>
    </div>
  `, {
    closeOnBackdrop: false,
    onMount: (host) => {
      host.querySelector("#rf-close").onclick = closeModal;
      host.querySelector("#rf-cancel").onclick = closeModal;
      host.querySelector("#rf-weeks").addEventListener("change", (e) => {
        host.querySelector("#rf-preview").innerHTML = buildPreview(Number(e.target.value));
      });
      host.querySelector("#rf-confirm").onclick = () => {
        const weeksToRoll = Number(host.querySelector("#rf-weeks").value);
        const customLabel = host.querySelector("#rf-label").value.trim();
        let result = null;
        store.mutate((s) => {
          result = rollForwardPeriod(s, period.id, weeksToRoll);
          if (!result) return;
          if (customLabel) result.period.label = customLabel;
          s.periods.push(result.period);
          s.activePeriodId = result.period.id;
        });
        closeModal();
        const bits = [`Rolled forward ${weeksToRoll} week${weeksToRoll === 1 ? "" : "s"}`];
        if (result?.rolledOffReceivables) bits.push(`${result.rolledOffReceivables} receivable${result.rolledOffReceivables === 1 ? "" : "s"} (${fmtMoney(result.rolledOffAmount)}) marked paid from dropped weeks`);
        if (result?.rolledOffPayables) bits.push(`${result.rolledOffPayables} payable${result.rolledOffPayables === 1 ? "" : "s"} (${fmtMoney(result.rolledOffPayableAmount)}) marked paid`);
        toast(bits.join(" — "), "success", 6000);
      };
    },
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
    <div class="row"><label>401K Amount (per payroll run, as a positive number)</label><input id="np-401k-amt" type="number" value="0" /></div>
    <div class="desc" style="font-size:11.5px;color:var(--text-dim);margin-top:-6px;">Pick which weeks (1–5) each of these actually falls on over on the Fixed Payments tab, right after creating this period — same place you can change it later too.</div>
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
        const k401Amt = Math.abs(parseFloat(host.querySelector("#np-401k-amt").value || "0"));
        if (!start) { toast("Pick a start date", "error"); return; }
        store.mutate((s) => {
          const p = makePeriod(uid("p"), label, start);
          p.openingCash = opening;
          p.locOpeningBalance = loc;
          p.payroll = { amount: payrollAmt, weeks: [] };
          p.k401 = { amount: k401Amt, weeks: [] };
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
  const ubInput = document.getElementById("file-input-ub");
  arInput.addEventListener("change", () => handleImportFile(store, arInput, "AR"));
  apInput.addEventListener("change", () => handleImportFile(store, apInput, "AP"));
  ubInput.addEventListener("change", () => handleUnbilledImportFile(store, ubInput));
}

async function handleImportFile(store, input, kind) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const isBinaryWorkbook = /\.xlsx?$/i.test(file.name);
    const { records: parsed, asOfDate } = isBinaryWorkbook
      ? parseAgingWorkbook(await file.arrayBuffer(), kind)
      : parseAgingReport(await file.text(), kind);
    if (!parsed.length) { toast("No open invoices found in that file", "error"); return; }
    store.mutate((s) => {
      const { added, updated, paidOff } = mergeAgingImport(s, kind, parsed);
      if (asOfDate) { if (kind === "AR") s.arAsOfDate = asOfDate; else s.apAsOfDate = asOfDate; }
      toast(`Imported ${kind}: ${added} new, ${updated} updated, ${paidOff} marked paid`, "success", 5000);
    });
  } catch (err) {
    toast(err.message || "Import failed", "error", 6000);
  }
}

async function handleUnbilledImportFile(store, input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const isBinaryWorkbook = /\.xlsx?$/i.test(file.name);
    const parsed = isBinaryWorkbook
      ? parseRevenueForecastWorkbook(await file.arrayBuffer())
      : parseRevenueForecastReport(await file.text());
    if (!parsed.projects.length) { toast("No projects with a forecasted amount found in that file", "error"); return; }
    openUnbilledImportReviewModal(store, parsed);
  } catch (err) {
    toast(err.message || "Import failed", "error", 7000);
  }
}
