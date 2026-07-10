import { uid, toISO, parseISO, addDays, todayISO } from "./util.js";

export const WEEKS_PER_PERIOD = 5;
export const DEFAULT_OUTFLOW_CATEGORIES = ["Distributions", "Credit Card", "Sales Tax"];
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
    payables: [],
    fixedPayments: [],
    customerAutoSchedule: {}, // { [customerName]: { days:number, auto:boolean } }
    vendorAutoSchedule: {},
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
    if (r.status !== "open") continue;
    const wi = weekIndexForDate(period, r.cfDate);
    if (wi !== null) scheduledReceivables[wi] += r.balance;
  }
  for (const p of state.payables) {
    if (p.status !== "open") continue;
    const wi = weekIndexForDate(period, p.cfDate);
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
    const receivablesCollected = ovVal(ov, "receivablesCollected", wi, scheduledReceivables[wi]);
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

/* ------------------------------ AR / AP import ------------------------------ */

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
      existing.balance = rec.balance;
      existing.dueDate = rec.dueDate;
      existing.age = rec.age;
      existing.txnType = rec.txnType;
      if (kind === "AR") existing.poNumber = rec.poNumber;
      if (existing.status !== "open") { existing.status = "open"; }
      updated++;
    } else {
      const tmpl = state[schedKey][rec[groupKey]];
      const item = {
        id: uid(kind.toLowerCase()),
        ...rec,
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

export function applyAutoScheduleToAll(state, kind) {
  const listKey = kind === "AR" ? "receivables" : "payables";
  const groupKey = kind === "AR" ? "customer" : "vendor";
  const schedKey = kind === "AR" ? "customerAutoSchedule" : "vendorAutoSchedule";
  let count = 0;
  for (const x of state[listKey]) {
    if (x.status !== "open") continue;
    const tmpl = state[schedKey][x[groupKey]];
    if (tmpl?.auto && x.date) {
      x.cfDate = toISO(addDays(x.date, tmpl.days || 0));
      count++;
    }
  }
  return count;
}

export function applyAutoScheduleToGroup(state, kind, groupName) {
  const listKey = kind === "AR" ? "receivables" : "payables";
  const groupKey = kind === "AR" ? "customer" : "vendor";
  const schedKey = kind === "AR" ? "customerAutoSchedule" : "vendorAutoSchedule";
  const tmpl = state[schedKey][groupName];
  if (!tmpl) return 0;
  let count = 0;
  for (const x of state[listKey]) {
    if (x.status !== "open" || x[groupKey] !== groupName) continue;
    if (x.date) { x.cfDate = toISO(addDays(x.date, tmpl.days || 0)); count++; }
  }
  return count;
}
