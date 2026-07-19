import { uid, toISO, parseISO, addDays, todayISO } from "./util.js";

export const WEEKS_PER_PERIOD = 5;
export const DEFAULT_OUTFLOW_CATEGORIES = ["Distributions", "Credit Card", "Sales Tax", "Other"];
export const FIXED_CATEGORY_ORDER = [
  "Payroll",
  "401K",
  "Rent/Biz Insurance",
  "Utilities",
  "Benefits",
  "Debt",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function defaultState() {
  const start = mostRecentSunday();
  return {
    version: 0,
    updatedAt: null,
    updatedBy: null,
    activePeriodId: "p1",
    periods: [makePeriod("p1", "Opening Period", toISO(start))],
    manualOutflowCategories: [...DEFAULT_OUTFLOW_CATEGORIES],
    receivables: [],
    unbilledReceivables: [], // project-revenue-forecast lines — not yet in NetSuite's Aged AR
    payables: [],
    fixedPayments: [],
    customerAutoSchedule: {}, // { [customerName]: { days:number, auto:boolean } }
    vendorAutoSchedule: {},
    projectAutoSchedule: {}, // same idea, keyed by project name, for unbilled receivables
  };
}

function mostRecentSunday(d = new Date()) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - dt.getDay());
  dt.setHours(0, 0, 0, 0);
  return dt;
}

export function makePeriod(id, label, startISO) {
  return {
    id,
    label,
    startDate: startISO,
    openingCash: 0,
    locOpeningBalance: 0,
    payroll: { amount: 0, firstWeek: 0 },
    k401: { amount: 0 },
    notes: {},
    overrides: {
      receivablesCollected: {},
      otherInflows: {},
      manualOutflow: {}, // { [category]: { [weekIndex]: number } }
      fixedGroup: {}, // { [category]: { [weekIndex]: number } }
      apPayables: {},
      locDraw: {},
    },
  };
}

export function getPeriod(state, id) {
  return state.periods.find((p) => p.id === id) || state.periods[0];
}

function autoPeriodLabel(startISO) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const start = parseISO(startISO);
  const end = addDays(start, 34);
  const sm = months[start.getMonth()], em = months[end.getMonth()];
  return sm === em ? sm : `${sm}-${em}`;
}

function shiftWeekMap(map) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    const wi = Number(k);
    if (Number.isNaN(wi)) continue;
    if (wi === 0) continue; // the completed week is dropped
    out[wi - 1] = map[k];
  }
  return out;
}

function shiftOverrides(ov) {
  ov = ov || {};
  const out = {
    receivablesCollected: shiftWeekMap(ov.receivablesCollected),
    otherInflows: shiftWeekMap(ov.otherInflows),
    apPayables: shiftWeekMap(ov.apPayables),
    locDraw: shiftWeekMap(ov.locDraw),
    manualOutflow: {},
    fixedGroup: {},
  };
  for (const cat of Object.keys(ov.manualOutflow || {})) out.manualOutflow[cat] = shiftWeekMap(ov.manualOutflow[cat]);
  for (const cat of Object.keys(ov.fixedGroup || {})) out.fixedGroup[cat] = shiftWeekMap(ov.fixedGroup[cat]);
  return out;
}

function shiftNotes(notes) {
  const out = {};
  for (const key of Object.keys(notes || {})) {
    const m = key.match(/^(.*)::([0-4])$/);
    if (!m) { out[key] = notes[key]; continue; } // row-level / total-column notes carry over untouched
    const wi = Number(m[2]);
    if (wi === 0) continue; // note was on the completed week — drop it with that week
    out[`${m[1]}::${wi - 1}`] = notes[key];
  }
  return out;
}

// "Roll forward" a period: drop the completed first week, shift weeks 2-5 up
// to become weeks 1-4, and open a new week 5 at the end. Returns a brand-new
// period object (the old one is left alone in history) — caller is responsible
// for pushing it into state.periods and making it active.
export function rollForwardPeriod(state, periodId) {
  const old = state.periods.find((p) => p.id === periodId);
  if (!old) return null;

  const calc = computeForecast(state, old);
  const newStart = toISO(addDays(old.startDate, 7));
  const oldPayrollWeeks = payrollWeeksFor(old);

  const next = makePeriod(uid("p"), autoPeriodLabel(newStart), newStart);
  next.openingCash = Math.round(calc.weeks[0].closing * 100) / 100;
  next.locOpeningBalance = Math.round(calc.weeks[0].locBalance * 100) / 100;
  next.payroll = { amount: old.payroll?.amount || 0, firstWeek: oldPayrollWeeks.includes(1) ? 0 : 1 };
  next.k401 = { amount: old.k401?.amount || 0 };
  next.overrides = shiftOverrides(old.overrides);
  next.notes = shiftNotes(old.notes);

  return next;
}

export function periodWeeks(period) {
  const start = parseISO(period.startDate);
  const weeks = [];
  for (let i = 0; i < WEEKS_PER_PERIOD; i++) {
    const wStart = addDays(start, i * 7);
    const wEnd = addDays(start, i * 7 + 6);
    const payRun = addDays(start, i * 7 + 4); // Thursday of that week
    weeks.push({ index: i, start: toISO(wStart), end: toISO(wEnd), payRun: toISO(payRun) });
  }
  return weeks;
}

export function weekIndexForDate(period, dateISO) {
  if (!dateISO) return null;
  const weeks = periodWeeks(period);
  const d = parseISO(dateISO);
  const firstStart = parseISO(weeks[0].start);
  const lastEnd = parseISO(weeks[weeks.length - 1].end);
  if (d < firstStart) return 0; // overdue items land in the current/first week
  if (d > lastEnd) return null; // outside this forecast window
  for (const w of weeks) {
    if (d >= parseISO(w.start) && d <= parseISO(w.end)) return w.index;
  }
  return null;
}

/* ---------------------------- fixed payments ---------------------------- */

export function fixedOccurrencesInPeriod(item, period) {
  const weeks = periodWeeks(period);
  const winStart = parseISO(weeks[0].start);
  const winEnd = parseISO(weeks[weeks.length - 1].end);
  const occurrences = [];
  const endLimit = item.endDate ? parseISO(item.endDate) : null;

  if (item.scheduleType === "weekly") {
    const targetDow = item.weekday ?? 4; // default Thursday
    let d = new Date(winStart);
    while (d <= winEnd) {
      if (d.getDay() === targetDow && (!endLimit || d <= endLimit)) occurrences.push(toISO(d));
      d = addDays(d, 1);
    }
  } else {
    // monthly: fires on dayOfMonth for every month touched by the window
    let cursor = new Date(winStart.getFullYear(), winStart.getMonth(), 1);
    const limit = new Date(winEnd.getFullYear(), winEnd.getMonth(), 1);
    while (cursor <= limit) {
      const dom = Math.min(item.dayOfMonth || 1, daysInMonth(cursor.getFullYear(), cursor.getMonth()));
      const occ = new Date(cursor.getFullYear(), cursor.getMonth(), dom);
      if (occ >= winStart && occ <= winEnd && (!endLimit || occ <= endLimit)) occurrences.push(toISO(occ));
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  return occurrences;
}

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

export function payrollWeeksFor(period) {
  const weeks = [];
  const firstWeek = period.payroll?.firstWeek ?? 0;
  for (let wi = firstWeek; wi < WEEKS_PER_PERIOD; wi += 2) weeks.push(wi);
  return weeks;
}

// "Pay when paid" — a payable's CF date is derived from the next pay run after
// the linked receivable's own CF date, rather than being set directly.
export function effectivePayableDate(state, period, payable) {
  if (!payable.payWhenPaid || !payable.linkedReceivableId) return payable.cfDate;
  const rec = state.receivables.find((r) => r.id === payable.linkedReceivableId);
  if (!rec || !rec.cfDate) return null;
  const weeks = periodWeeks(period);
  const recDate = parseISO(rec.cfDate);
  const next = weeks.find((w) => parseISO(w.payRun) > recDate);
  return next ? next.payRun : null;
}

export function scheduleLabel(item) {
  if (item.scheduleType === "weekly") return `Weekly · Every ${WEEKDAYS[item.weekday ?? 4]}`;
  return `Monthly · Day ${item.dayOfMonth || 1}`;
}

/* ------------------------------ computation ------------------------------ */

export function readOv(entry) {
  if (entry === undefined || entry === null) return undefined;
  return typeof entry === "object" ? entry.v : entry;
}

function ovVal(bucket, key, wi, fallback) {
  const raw = bucket?.[key]?.[wi];
  const v = readOv(raw);
  return v === undefined || v === null || v === "" ? fallback : v;
}

export function computeForecast(state, period) {
  const weeks = periodWeeks(period);
  const ov = period.overrides;
  // "Payroll" moved to the Fixed section (period-driven, biweekly) — strip any stray
  // leftover from older saved data so it doesn't show twice.
  const manualCats = state.manualOutflowCategories.filter((c) => c !== "Payroll");

  // scheduled (computed) amounts per week, before overrides
  const scheduledReceivables = Array(WEEKS_PER_PERIOD).fill(0);
  const scheduledPayables = Array(WEEKS_PER_PERIOD).fill(0);
  for (const r of state.receivables) {
    const wi = weekIndexForDate(period, r.cfDate);
    if (wi === null) continue;
    scheduledReceivables[wi] += (r.originalBalance ?? r.balance);
  }
  for (const u of state.unbilledReceivables || []) {
    if (u.status !== "open") continue; // closed = no longer a valid forecast, not "collected"
    const wi = weekIndexForDate(period, u.cfDate);
    if (wi === null) continue;
    scheduledReceivables[wi] += (u.originalBalance ?? u.balance);
  }
  for (const p of state.payables) {
    if (p.status !== "open") continue;
    const wi = weekIndexForDate(period, effectivePayableDate(state, period, p));
    if (wi !== null) scheduledPayables[wi] += p.balance;
  }

  // scheduled fixed-payment totals per category per week
  const fixedCategories = Array.from(new Set([...FIXED_CATEGORY_ORDER, ...state.fixedPayments.map((f) => f.category)]));
  const scheduledFixed = {};
  for (const cat of fixedCategories) scheduledFixed[cat] = Array(WEEKS_PER_PERIOD).fill(0);

  // payroll is period-specific (biweekly starting from the week chosen when the forecast was created)
  const payrollAmount = period.payroll?.amount || 0;
  const k401Amount = period.k401?.amount || 0;
  if (payrollAmount || k401Amount) {
    for (const wi of payrollWeeksFor(period)) {
      if (payrollAmount) scheduledFixed.Payroll[wi] += payrollAmount;
      if (k401Amount) scheduledFixed["401K"][wi] += k401Amount;
    }
  }

  for (const item of state.fixedPayments) {
    if (item.active === false) continue;
    if (item.category === "Payroll" || item.category === "401K") continue; // period-driven, not a recurring template
    const occ = fixedOccurrencesInPeriod(item, period);
    for (const dateISO of occ) {
      const wi = weekIndexForDate(period, dateISO);
      if (wi !== null) scheduledFixed[item.category][wi] += item.amount;
    }
  }

  const rows = weeks.map((w) => {
    const wi = w.index;
    const receivablesCollected = scheduledReceivables[wi]; // always computed from CF dates — not manually overridable
    const otherInflows = ovVal(ov, "otherInflows", wi, 0);
    const totalInflows = receivablesCollected + otherInflows;

    const manualOutflows = {};
    let manualTotal = 0;
    for (const cat of manualCats) {
      const v = readOv(ov.manualOutflow?.[cat]?.[wi]) ?? 0;
      manualOutflows[cat] = v;
      manualTotal += v;
    }

    const fixedRows = {};
    let fixedTotal = 0;
    for (const cat of fixedCategories) {
      const raw = readOv(ov.fixedGroup?.[cat]?.[wi]);
      const val = raw === undefined || raw === null || raw === "" ? -scheduledFixed[cat][wi] : raw;
      fixedRows[cat] = val;
      fixedTotal += val;
    }

    const apPayables = ovVal(ov, "apPayables", wi, -scheduledPayables[wi]);
    const totalOutflows = manualTotal + fixedTotal + apPayables;

    const netCashflow = totalInflows + totalOutflows;
    const locDraw = readOv(ov.locDraw?.[wi]) ?? 0;

    return {
      week: w,
      receivablesCollected, receivablesScheduled: scheduledReceivables[wi],
      otherInflows, totalInflows,
      manualOutflows, manualTotal,
      fixedRows, fixedTotal,
      apPayables, apScheduled: -scheduledPayables[wi],
      totalOutflows, netCashflow, locDraw,
    };
  });

  // running opening / closing balances
  let opening = period.openingCash || 0;
  for (const row of rows) {
    row.opening = opening;
    row.closing = opening + row.netCashflow + row.locDraw;
    opening = row.closing;
  }

  // running LOC balance — you enter the balance as of the start of week 1
  // (before that week's activity); each week's displayed balance is the
  // running total AFTER that week's own draw/(repayment) is applied,
  // exactly like Opening/Closing Cash.
  let locBal = period.locOpeningBalance || 0;
  rows.forEach((row) => {
    locBal += row.locDraw;
    row.locBalance = locBal;
  });

  const totals = {
    opening: rows[0]?.opening ?? 0,
    closing: rows[rows.length - 1]?.closing ?? 0,
    receivablesCollected: sum(rows.map((r) => r.receivablesCollected)),
    otherInflows: sum(rows.map((r) => r.otherInflows)),
    totalInflows: sum(rows.map((r) => r.totalInflows)),
    manualOutflows: Object.fromEntries(manualCats.map((c) => [c, sum(rows.map((r) => r.manualOutflows[c]))])),
    manualTotal: sum(rows.map((r) => r.manualTotal)),
    fixedRows: Object.fromEntries(fixedCategories.map((c) => [c, sum(rows.map((r) => r.fixedRows[c]))])),
    fixedTotal: sum(rows.map((r) => r.fixedTotal)),
    apPayables: sum(rows.map((r) => r.apPayables)),
    totalOutflows: sum(rows.map((r) => r.totalOutflows)),
    netCashflow: sum(rows.map((r) => r.netCashflow)),
    locDraw: sum(rows.map((r) => r.locDraw)),
    locBalance: rows[rows.length - 1]?.locBalance ?? (period.locOpeningBalance || 0),
  };

  return { weeks: rows, totals, fixedCategories };
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/* ------------------------------ multi-user merge ------------------------------ */
// Two people can be editing at once. Rather than blindly overwriting the whole
// saved blob (last-write-wins at the document level, which silently drops
// whichever person saved first), we merge field-by-field: CF-grid overrides
// use their own {v,by,at} timestamps, and AR/AP/Fixed-payment records use an
// `updatedAt` stamp, so whichever edit actually happened more recently wins —
// not whichever save request happened to land on the server last.

function newerOf(a, b, getTime) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return getTime(a) >= getTime(b) ? a : b;
}

function timeOfOverrideEntry(entry) {
  return entry && typeof entry === "object" && entry.at ? new Date(entry.at).getTime() : 0;
}

function mergeTimestampedMap(localMap, remoteMap) {
  localMap = localMap || {};
  remoteMap = remoteMap || {};
  const keys = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
  const out = {};
  for (const k of keys) out[k] = newerOf(localMap[k], remoteMap[k], timeOfOverrideEntry);
  return out;
}

function mergeOverrides(localOv, remoteOv) {
  localOv = localOv || {};
  remoteOv = remoteOv || {};
  const merged = { ...remoteOv };
  for (const key of ["receivablesCollected", "otherInflows", "apPayables", "locDraw"]) {
    merged[key] = mergeTimestampedMap(localOv[key], remoteOv[key]);
  }
  for (const key of ["manualOutflow", "fixedGroup"]) {
    const cats = new Set([...Object.keys(localOv[key] || {}), ...Object.keys(remoteOv[key] || {})]);
    merged[key] = {};
    for (const cat of cats) merged[key][cat] = mergeTimestampedMap((localOv[key] || {})[cat], (remoteOv[key] || {})[cat]);
  }
  return merged;
}

function timeOfRecord(r) {
  return r && r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
}

function mergeById(localArr, remoteArr) {
  localArr = localArr || [];
  remoteArr = remoteArr || [];
  const byId = new Map();
  for (const r of remoteArr) byId.set(r.id, r);
  for (const l of localArr) byId.set(l.id, newerOf(l, byId.get(l.id), timeOfRecord));
  return Array.from(byId.values());
}

export function mergeStates(local, remote) {
  const merged = { ...remote };

  merged.periods = remote.periods.map((rp) => {
    const lp = local.periods.find((p) => p.id === rp.id);
    if (!lp) return rp;
    return { ...rp, ...lp, overrides: mergeOverrides(lp.overrides, rp.overrides), notes: { ...rp.notes, ...lp.notes } };
  });
  for (const lp of local.periods) {
    if (!merged.periods.find((p) => p.id === lp.id)) merged.periods.push(lp); // period created locally, not yet on server
  }

  merged.receivables = mergeById(local.receivables, remote.receivables);
  merged.unbilledReceivables = mergeById(local.unbilledReceivables || [], remote.unbilledReceivables || []);
  merged.payables = mergeById(local.payables, remote.payables);
  merged.fixedPayments = mergeById(local.fixedPayments, remote.fixedPayments);

  merged.customerAutoSchedule = { ...remote.customerAutoSchedule, ...local.customerAutoSchedule };
  merged.vendorAutoSchedule = { ...remote.vendorAutoSchedule, ...local.vendorAutoSchedule };
  merged.projectAutoSchedule = { ...(remote.projectAutoSchedule || {}), ...(local.projectAutoSchedule || {}) };
  merged.manualOutflowCategories = Array.from(new Set([...(remote.manualOutflowCategories || []), ...(local.manualOutflowCategories || [])]));
  merged.activePeriodId = local.activePeriodId || remote.activePeriodId;

  return merged;
}

export function mergeAgingImport(state, kind, parsed) {
  const listKey = kind === "AR" ? "receivables" : "payables";
  const groupKey = kind === "AR" ? "customer" : "vendor";
  const schedKey = kind === "AR" ? "customerAutoSchedule" : "vendorAutoSchedule";
  const list = state[listKey];
  const seen = new Set();
  let added = 0, updated = 0, paidOff = 0;

  for (const rec of parsed) {
    const key = `${rec[groupKey]}::${rec.docNumber}::${rec.date}`;
    seen.add(key);
    const existing = list.find((x) => `${x[groupKey]}::${x.docNumber}::${x.date}` === key);
    if (existing) {
      // once a partial payment has been recorded locally, this app is the source of
      // truth for the remaining balance — a fresh import shouldn't silently undo it
      const hasLocalPayments = existing.payments && existing.payments.length > 0;
      if (!hasLocalPayments) existing.balance = rec.balance;
      if (existing.originalBalance === undefined) existing.originalBalance = rec.balance;
      existing.dueDate = rec.dueDate;
      existing.age = rec.age;
      existing.txnType = rec.txnType;
      if (kind === "AR") existing.poNumber = rec.poNumber;
      if (existing.balance > 0 && existing.status !== "open") existing.status = "open";
      updated++;
    } else {
      const tmpl = state[schedKey][rec[groupKey]];
      const item = {
        id: uid(kind.toLowerCase()),
        ...rec,
        originalBalance: rec.balance,
        payments: [],
        status: "open",
        cfDate: tmpl?.auto && rec.date ? toISO(addDays(rec.date, tmpl.days || 0)) : null,
        daysOverride: null,
        source: "import",
      };
      list.push(item);
      added++;
    }
  }

  // anything previously open & imported, but absent from this new export, is presumed paid/cleared
  for (const x of list) {
    if (x.status === "open" && x.source === "import") {
      const key = `${x[groupKey]}::${x.docNumber}::${x.date}`;
      if (!seen.has(key)) { x.status = "paid"; paidOff++; }
    }
  }

  // keep the auto-schedule template list in sync with whatever groups exist
  const groups = new Set(list.map((x) => x[groupKey]));
  for (const g of groups) {
    if (!state[schedKey][g]) state[schedKey][g] = { days: 30, auto: false };
  }

  return { added, updated, paidOff };
}

// Unbilled Receivables don't have a stable natural key to match against on
// re-import the way NetSuite invoices do (no doc number), so — for now —
// import always adds fresh lines rather than updating existing ones. Once
// the real project-forecast file format is settled, this can be tightened
// to match/update by project the same way mergeAgingImport does for AR/AP.
export function mergeUnbilledImport(state, parsed) {
  let added = 0;
  for (const rec of parsed) {
    const tmpl = state.projectAutoSchedule[rec.project];
    if (!state.projectAutoSchedule[rec.project]) state.projectAutoSchedule[rec.project] = { days: 30, auto: false };
    const item = {
      id: uid("ub"),
      project: rec.project,
      description: rec.description || "",
      date: rec.date,
      balance: rec.amount,
      originalBalance: rec.amount,
      status: "open",
      cfDate: rec.cfDate || (tmpl?.auto && rec.date ? toISO(addDays(rec.date, tmpl.days || 0)) : null),
      daysOverride: null,
      uncertain: false,
      source: "import",
    };
    state.unbilledReceivables.push(item);
    added++;
  }
  return { added };
}

export const KIND_MAP = {
  AR: { listKey: "receivables", groupKey: "customer", schedKey: "customerAutoSchedule" },
  AP: { listKey: "payables", groupKey: "vendor", schedKey: "vendorAutoSchedule" },
  UNBILLED: { listKey: "unbilledReceivables", groupKey: "project", schedKey: "projectAutoSchedule" },
};

export function applyAutoScheduleToAll(state, kind) {
  const { listKey, groupKey, schedKey } = KIND_MAP[kind];
  let count = 0;
  for (const x of state[listKey]) {
    if (x.status !== "open" || x.payWhenPaid) continue;
    const tmpl = state[schedKey][x[groupKey]];
    if (tmpl?.auto && x.date) {
      x.cfDate = toISO(addDays(x.date, tmpl.days || 0));
      count++;
    }
  }
  return count;
}

export function applyAutoScheduleToGroup(state, kind, groupName) {
  const { listKey, groupKey, schedKey } = KIND_MAP[kind];
  const tmpl = state[schedKey][groupName];
  if (!tmpl) return 0;
  let count = 0;
  for (const x of state[listKey]) {
    if (x.status !== "open" || x[groupKey] !== groupName || x.payWhenPaid) continue;
    if (x.date) { x.cfDate = toISO(addDays(x.date, tmpl.days || 0)); count++; }
  }
  return count;
}
