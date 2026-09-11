import { uid, toISO, parseISO, addDays, todayISO } from "./util.js";

export const WEEKS_PER_PERIOD = 6;
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

// The 5 cash accounts this app tracks. Basin Checking is the original/primary
// account — its own data shape (period.openingCash, .payroll, .overrides, etc.)
// is untouched by any of this; everything below is additive.
export const ACCOUNTS = [
  { id: "basin-checking", name: "Basin Checking", isMain: true },
  { id: "pc-checking", name: "P&C Checking", isMain: false },
  { id: "pc-savings", name: "P&C Savings", isMain: false },
  { id: "basin-savings", name: "Basin Savings", isMain: false },
  { id: "eb-savings", name: "EB Savings", isMain: false },
];

export function accountName(id) {
  return ACCOUNTS.find((a) => a.id === id)?.name || id;
}

// Fills in the new multi-account fields on a period that predates this
// feature, without touching anything it already has.
export function migratePeriod(period) {
  if (period.pcOpeningCash === undefined) period.pcOpeningCash = 0;
  if (period.ebOpeningCash === undefined) period.ebOpeningCash = 0;
  if (period.basinSavingsOpeningCash === undefined) period.basinSavingsOpeningCash = 0;
  if (period.pcSavingsOpeningCash === undefined) period.pcSavingsOpeningCash = 0;
  if (!period.pcPayroll) period.pcPayroll = { amount: 0, weeks: [] };
  if (!period.pcK401) period.pcK401 = { amount: 0, weeks: [] };
  if (!period.pcOtherOutflow) period.pcOtherOutflow = {};
  if (period.payroll && !period.payroll.weekAmounts) period.payroll.weekAmounts = {};
  if (period.k401 && !period.k401.weekAmounts) period.k401.weekAmounts = {};
  if (period.pcPayroll && !period.pcPayroll.weekAmounts) period.pcPayroll.weekAmounts = {};
  if (period.pcK401 && !period.pcK401.weekAmounts) period.pcK401.weekAmounts = {};
  if (!period.interest) period.interest = {};
  for (const acctId of ["basin-savings", "eb-savings", "pc-savings"]) {
    if (!period.interest[acctId]) period.interest[acctId] = { rate: 0, dayOfMonth: 1, avgBalance: 0 };
  }
  return period;
}

// One-time migration: the old per-period signed-field transfer system
// (basinSavingsTransfer / pcSavingsTransfer / toPcSavings, one number per
// week) gets converted into individual dated state.transfers[] records — the
// same shape a manually-entered transfer has. Safe to call every boot; it's a
// no-op once period.transfers has been removed from every period.
export function migrateTransfersToStateLevel(state) {
  if (!Array.isArray(state.transfers)) state.transfers = [];
  for (const period of state.periods) {
    if (!period.transfers || typeof period.transfers !== "object") continue;
    const weeks = periodWeeks(period);
    const migrateField = (fieldKey, fromAccount, toAccount) => {
      const map = period.transfers[fieldKey];
      if (!map) return;
      for (const wiStr of Object.keys(map)) {
        const wi = Number(wiStr);
        const week = weeks[wi];
        const entry = map[wiStr];
        const amt = entry && typeof entry === "object" ? entry.v : entry;
        if (!week || !amt) continue;
        const [from, to] = amt < 0 ? [fromAccount, toAccount] : [toAccount, fromAccount];
        state.transfers.push({
          id: uid("tr"), fromAccount: from, toAccount: to, amount: Math.round(Math.abs(amt) * 100) / 100,
          date: week.payRun, note: "Migrated from a prior version of the app", source: "manual",
          lastEditBy: (entry && entry.by) || "migration", updatedAt: (entry && entry.at) || new Date().toISOString(),
        });
      }
    };
    migrateField("basinSavingsTransfer", "basin-checking", "basin-savings");
    migrateField("pcSavingsTransfer", "basin-checking", "pc-savings");
    migrateField("toPcSavings", "pc-checking", "pc-savings");
    delete period.transfers;
  }
  for (const fp of state.fixedPayments || []) {
    if (fp.transfersToAccount && !fp.transferFrom) {
      fp.transferFrom = "basin-checking";
      fp.transferTo = fp.transfersToAccount;
    }
    delete fp.transfersToAccount;
  }
}

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
    customerAutoSchedule: {}, // { [customerName]: { days:number, auto:boolean } } — shared by Existing AR and Unbilled AR
    vendorAutoSchedule: {},
    // Records deletions ({ [listKey]: { [id]: deletedAtISO } }) so that when two
    // people's edits get merged, a deleted item doesn't silently reappear just
    // because the other copy being merged in is older and still has it.
    tombstones: { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {}, transfers: {} },
    arAsOfDate: null, // "as of" date pulled from the most recent Aged AR import's report header
    apAsOfDate: null,
    // Manual inter-company transfers — { id, fromAccount, toAccount, amount, date, note, source:'manual', lastEditBy, updatedAt }.
    // Recurring transfers are set up on a Fixed Payment instead (transferFrom/transferTo fields).
    transfers: [],
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
    // weekAmounts optionally overrides the base amount for a specific week —
    // e.g. a guy starts or stops between one payroll run and the next. Any
    // selected week not present in weekAmounts just uses the base amount.
    payroll: { amount: 0, weeks: [], weekAmounts: {} },
    k401: { amount: 0, weeks: [], weekAmounts: {} },
    notes: {},
    overrides: {
      receivablesCollected: {},
      otherInflows: {},
      manualOutflow: {}, // { [category]: { [weekIndex]: number } }
      fixedGroup: {}, // { [category]: { [weekIndex]: number } }
      apPayables: {},
      locDraw: {},
    },

    // --- P&C Checking ---
    pcOpeningCash: 0,
    pcPayroll: { amount: 0, weeks: [], weekAmounts: {} },
    pcK401: { amount: 0, weeks: [], weekAmounts: {} },
    pcOtherOutflow: {}, // { [weekIndex]: { v, by, at } } — same override shape as everything else

    // --- EB Savings / Basin Savings / P&C Savings opening balances ---
    ebOpeningCash: 0,
    basinSavingsOpeningCash: 0,
    pcSavingsOpeningCash: 0,

    // Interest on the 3 savings accounts. rate is an ANNUAL rate as a decimal
    // (2% = 0.02). Posts monthly on dayOfMonth. avgBalance is the average
    // monthly balance the user enters by hand — interest = avgBalance * (rate/12).
    interest: {
      "basin-savings": { rate: 0, dayOfMonth: 1, avgBalance: 0 },
      "eb-savings": { rate: 0, dayOfMonth: 1, avgBalance: 0 },
      "pc-savings": { rate: 0, dayOfMonth: 1, avgBalance: 0 },
    },
  };
}

export function getPeriod(state, id) {
  return state.periods.find((p) => p.id === id) || state.periods[0];
}

// Auto-schedule computes a CF date from an invoice's own date + a fixed days
// offset — with no awareness of which forecast period is actually active.
// If that lands before the current period even starts (e.g. an older invoice
// with a short days-to-pay template), default it to day 1 of the current
// forecast instead of leaving a stale in-the-past date sitting there.
function clampToCurrentPeriod(state, dateISO) {
  if (!dateISO) return dateISO;
  const current = getPeriod(state, state.activePeriodId);
  if (!current) return dateISO;
  return dateISO < current.startDate ? current.startDate : dateISO;
}

function autoPeriodLabel(startISO) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const start = parseISO(startISO);
  const end = addDays(start, 34);
  const sm = months[start.getMonth()], em = months[end.getMonth()];
  return sm === em ? sm : `${sm}-${em}`;
}

function shiftWeekMap(map, n) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    const wi = Number(k);
    if (Number.isNaN(wi)) continue;
    if (wi < n) continue; // completed weeks are dropped
    out[wi - n] = map[k];
  }
  return out;
}

function shiftOverrides(ov, n) {
  ov = ov || {};
  const out = {
    receivablesCollected: shiftWeekMap(ov.receivablesCollected, n),
    otherInflows: shiftWeekMap(ov.otherInflows, n),
    apPayables: shiftWeekMap(ov.apPayables, n),
    locDraw: shiftWeekMap(ov.locDraw, n),
    manualOutflow: {},
    fixedGroup: {},
  };
  for (const cat of Object.keys(ov.manualOutflow || {})) out.manualOutflow[cat] = shiftWeekMap(ov.manualOutflow[cat], n);
  for (const cat of Object.keys(ov.fixedGroup || {})) out.fixedGroup[cat] = shiftWeekMap(ov.fixedGroup[cat], n);
  return out;
}

function shiftNotes(notes, n) {
  const out = {};
  for (const key of Object.keys(notes || {})) {
    const m = key.match(/^(.*)::([0-9])$/);
    if (!m) { out[key] = notes[key]; continue; } // row-level / total-column notes carry over untouched
    const wi = Number(m[2]);
    if (wi < n) continue; // note was on a now-completed week — drop it with that week
    out[`${m[1]}::${wi - n}`] = notes[key];
  }
  return out;
}

function shiftWeeksArray(weeks, n) {
  return (weeks || []).filter((w) => w >= n).map((w) => w - n);
}

function shiftWeekAmounts(weekAmounts, n) {
  const out = {};
  for (const key of Object.keys(weekAmounts || {})) {
    const wi = Number(key);
    if (Number.isNaN(wi) || wi < n) continue;
    out[wi - n] = weekAmounts[key];
  }
  return out;
}

// "Roll forward" a period by n weeks: drop the first n (completed) weeks,
// shift the remaining weeks up to fill weeks 1..(5-n), and open n new weeks
// at the end. Returns a brand-new period object (the old one is left alone
// in history) — caller is responsible for pushing it into state.periods and
// making it active.
export function rollForwardPeriod(state, periodId, weeksToRoll = 1) {
  const old = state.periods.find((p) => p.id === periodId);
  if (!old) return null;
  const n = Math.max(1, Math.min(WEEKS_PER_PERIOD - 1, Math.round(weeksToRoll)));

  const calc = computeForecast(state, old);
  const pcCalc = computeSimpleAccountForecast(state, old, "pc-checking");
  const ebCalc = computeSimpleAccountForecast(state, old, "eb-savings");
  const basinSavingsCalc = computeSimpleAccountForecast(state, old, "basin-savings");
  const pcSavingsCalc = computeSimpleAccountForecast(state, old, "pc-savings");
  const newStart = toISO(addDays(old.startDate, 7 * n));
  const lastDropped = calc.weeks[n - 1]; // the last of the completed weeks being dropped

  const next = makePeriod(uid("p"), autoPeriodLabel(newStart), newStart);
  next.openingCash = Math.round(lastDropped.closing * 100) / 100;
  next.locOpeningBalance = Math.round(lastDropped.locBalance * 100) / 100;
  next.payroll = { amount: old.payroll?.amount || 0, weeks: shiftWeeksArray(old.payroll?.weeks, n), weekAmounts: shiftWeekAmounts(old.payroll?.weekAmounts, n) };
  next.k401 = { amount: old.k401?.amount || 0, weeks: shiftWeeksArray(old.k401?.weeks, n), weekAmounts: shiftWeekAmounts(old.k401?.weekAmounts, n) };
  next.overrides = shiftOverrides(old.overrides, n);
  next.notes = shiftNotes(old.notes, n);

  // the other 4 accounts — each carries forward its own closing balance,
  // payroll/401k weeks (P&C), and shifted manual entries the same way
  next.pcOpeningCash = Math.round(pcCalc.weeks[n - 1].closing * 100) / 100;
  next.ebOpeningCash = Math.round(ebCalc.weeks[n - 1].closing * 100) / 100;
  next.basinSavingsOpeningCash = Math.round(basinSavingsCalc.weeks[n - 1].closing * 100) / 100;
  next.pcSavingsOpeningCash = Math.round(pcSavingsCalc.weeks[n - 1].closing * 100) / 100;
  next.pcPayroll = { amount: old.pcPayroll?.amount || 0, weeks: shiftWeeksArray(old.pcPayroll?.weeks, n), weekAmounts: shiftWeekAmounts(old.pcPayroll?.weekAmounts, n) };
  next.pcK401 = { amount: old.pcK401?.amount || 0, weeks: shiftWeeksArray(old.pcK401?.weeks, n), weekAmounts: shiftWeekAmounts(old.pcK401?.weekAmounts, n) };
  next.pcOtherOutflow = shiftWeekMap(old.pcOtherOutflow, n);

  // Anything still open that was sitting in one of the now-dropped weeks is
  // presumed handled by now — close it out so it stops counting toward the
  // new forecast, but leave it on its tab with its CF date untouched (and its
  // balance showing the original invoice amount, not zeroed), so there's
  // still a clear record of it.
  const now = new Date().toISOString();
  let rolledOffReceivables = 0, rolledOffAmount = 0;
  for (const r of state.receivables) {
    if (r.status !== "open") continue;
    const wi = weekIndexForDate(old, r.cfDate);
    if (wi === null || wi >= n) continue;
    if (r.originalBalance === undefined) r.originalBalance = r.balance;
    rolledOffAmount += r.balance;
    r.status = "paid";
    r.updatedAt = now;
    rolledOffReceivables++;
  }
  for (const u of state.unbilledReceivables || []) {
    if (u.status !== "open") continue;
    const wi = weekIndexForDate(old, u.cfDate);
    if (wi === null || wi >= n) continue;
    u.status = "closed";
    u.updatedAt = now;
  }
  let rolledOffPayables = 0, rolledOffPayableAmount = 0;
  for (const p of state.payables) {
    if (p.status !== "open") continue;
    const wi = weekIndexForDate(old, effectivePayableDate(state, old, p));
    if (wi === null || wi >= n) continue;
    if (p.originalBalance === undefined) p.originalBalance = p.balance;
    rolledOffPayableAmount += p.balance;
    p.status = "paid";
    p.balance = 0;
    p.updatedAt = now;
    rolledOffPayables++;
  }

  return { period: next, rolledOffReceivables, rolledOffAmount, rolledOffPayables, rolledOffPayableAmount };
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
  if (d < firstStart) return 0; // overdue OPEN items land in the current/first week
  if (d > lastEnd) return null; // outside this forecast window
  for (const w of weeks) {
    if (d >= parseISO(w.start) && d <= parseISO(w.end)) return w.index;
  }
  return null;
}

// Same as weekIndexForDate, but never clamps a before-period date into week 0.
// For a closed/paid item, a date before this period just means it's outside
// this forecast's timeframe (e.g. it was rolled off in an earlier roll-forward)
// — it shouldn't reappear as if newly due. Only used for already-closed items.
export function weekIndexForDateStrict(period, dateISO) {
  if (!dateISO) return null;
  const weeks = periodWeeks(period);
  const d = parseISO(dateISO);
  const firstStart = parseISO(weeks[0].start);
  const lastEnd = parseISO(weeks[weeks.length - 1].end);
  if (d < firstStart || d > lastEnd) return null;
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
  return (period.payroll?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD).sort((a, b) => a - b);
}

export function k401WeeksFor(period) {
  return (period.k401?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD).sort((a, b) => a - b);
}

// Effective dollar amount for a specific week in a payroll/401k bucket —
// the per-week override if one's been set, otherwise the base amount.
export function weekAmountFor(bucket, wi) {
  if (!bucket) return 0;
  const override = bucket.weekAmounts?.[wi];
  return override !== undefined && override !== null ? override : (bucket.amount || 0);
}

// Combines manual state.transfers[] records and recurring transfer-flagged
// Fixed Payments (transferFrom/transferTo both set) into one picture for a
// given account: how much is coming in and going out each week, and the
// individual line items (with counterpart account) behind those totals.
// Entering a transfer once — either manually or as a Fixed Payment — is
// automatically reflected on BOTH accounts' forecasts from this single function.
export function interCompanyTransfersForAccount(state, period, accountId) {
  const inflowByWeek = Array(WEEKS_PER_PERIOD).fill(0);
  const outflowByWeek = Array(WEEKS_PER_PERIOD).fill(0);
  const itemsByWeek = Array.from({ length: WEEKS_PER_PERIOD }, () => ({ inflow: [], outflow: [] }));

  const record = (wi, direction, counterpart, amount, source, refId, note) => {
    if (wi === null || wi === undefined || !amount) return;
    const bucket = direction === "in" ? inflowByWeek : outflowByWeek;
    const itemKey = direction === "in" ? "inflow" : "outflow";
    bucket[wi] += amount;
    itemsByWeek[wi][itemKey].push({ counterpart, amount, source, id: refId, note: note || "" });
  };

  for (const t of state.transfers || []) {
    const wi = weekIndexForDate(period, t.date);
    if (wi === null) continue;
    if (t.toAccount === accountId) record(wi, "in", t.fromAccount, t.amount, "manual", t.id, t.note);
    if (t.fromAccount === accountId) record(wi, "out", t.toAccount, t.amount, "manual", t.id, t.note);
  }
  for (const fp of state.fixedPayments) {
    if (fp.active === false || !fp.transferFrom || !fp.transferTo) continue;
    for (const dateISO of fixedOccurrencesInPeriod(fp, period)) {
      const wi = weekIndexForDate(period, dateISO);
      if (wi === null) continue;
      if (fp.transferTo === accountId) record(wi, "in", fp.transferFrom, fp.amount, "fixed", fp.id, fp.name);
      if (fp.transferFrom === accountId) record(wi, "out", fp.transferTo, fp.amount, "fixed", fp.id, fp.name);
    }
  }

  return { inflowByWeek, outflowByWeek, itemsByWeek };
}

// "Pay when paid" — a payable's CF date is derived from the next pay run after
// the linked receivable's own CF date, rather than being set directly. The
// link can point at an Existing AR invoice, or an Unbilled Receivables line
// (for a payable that's pay-when-paid against revenue that isn't billed yet).
export function effectivePayableDate(state, period, payable) {
  if (!payable.payWhenPaid || !payable.linkedReceivableId) return payable.cfDate;
  if (payable.payDateOverride) return payable.payDateOverride; // manual override — still linked, just not auto-computed
  const list = payable.linkedReceivableKind === "unbilled" ? (state.unbilledReceivables || []) : state.receivables;
  const rec = list.find((r) => r.id === payable.linkedReceivableId);
  if (!rec || !rec.cfDate) return null;
  const weeks = periodWeeks(period);
  const recWeekIndex = weekIndexForDate(period, rec.cfDate);
  if (recWeekIndex === null) return null; // the receivable's date falls outside this period's window
  const nextWeek = weeks[recWeekIndex + 1]; // the pay run in the week FOLLOWING collection, not just any later pay run
  return nextWeek ? nextWeek.payRun : null;
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
    if ((r.depositAccount || "basin-checking") !== "basin-checking") continue;
    const wi = r.status === "paid" ? weekIndexForDateStrict(period, r.cfDate) : weekIndexForDate(period, r.cfDate);
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
    const eff = effectivePayableDate(state, period, p);
    const wi = p.status === "paid" ? weekIndexForDateStrict(period, eff) : weekIndexForDate(period, eff);
    if (wi !== null) scheduledPayables[wi] += (p.originalBalance ?? p.balance);
  }

  // scheduled fixed-payment totals per category per week
  const fixedCategories = Array.from(new Set([...FIXED_CATEGORY_ORDER, ...state.fixedPayments.map((f) => f.category)]));
  const scheduledFixed = {};
  for (const cat of fixedCategories) scheduledFixed[cat] = Array(WEEKS_PER_PERIOD).fill(0);

  // payroll and 401K each post on whichever weeks were manually selected for
  // this period, using that week's own amount if one's been set (otherwise the base amount)
  for (const wi of payrollWeeksFor(period)) scheduledFixed.Payroll[wi] += weekAmountFor(period.payroll, wi);
  for (const wi of k401WeeksFor(period)) scheduledFixed["401K"][wi] += weekAmountFor(period.k401, wi);

  for (const item of state.fixedPayments) {
    if (item.active === false) continue;
    if (item.category === "Payroll" || item.category === "401K") continue; // period-driven, not a recurring template
    if (item.transferFrom && item.transferTo) continue; // posts via Inter Company Transfer instead, not its category
    const occ = fixedOccurrencesInPeriod(item, period);
    for (const dateISO of occ) {
      const wi = weekIndexForDate(period, dateISO);
      if (wi !== null) scheduledFixed[item.category][wi] += item.amount;
    }
  }

  const ic = interCompanyTransfersForAccount(state, period, "basin-checking");

  const rows = weeks.map((w) => {
    const wi = w.index;
    const receivablesCollected = scheduledReceivables[wi]; // always computed from CF dates — not manually overridable
    const otherInflows = ovVal(ov, "otherInflows", wi, 0);
    const interCompanyIn = ic.inflowByWeek[wi];
    const totalInflows = receivablesCollected + otherInflows + interCompanyIn;

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
      const val = -scheduledFixed[cat][wi]; // always computed from Fixed Payments — not manually overridable
      fixedRows[cat] = val;
      fixedTotal += val;
    }

    const apPayables = -scheduledPayables[wi]; // always computed from Payables' CF dates — not manually overridable
    const interCompanyOut = -ic.outflowByWeek[wi];
    const totalOutflows = manualTotal + fixedTotal + apPayables + interCompanyOut;

    const netCashflow = totalInflows + totalOutflows;
    const locDraw = readOv(ov.locDraw?.[wi]) ?? 0;

    return {
      week: w,
      receivablesCollected, receivablesScheduled: scheduledReceivables[wi],
      otherInflows, interCompanyIn, interCompanyItems: ic.itemsByWeek[wi], totalInflows,
      manualOutflows, manualTotal,
      fixedRows, fixedTotal,
      apPayables, apScheduled: -scheduledPayables[wi],
      interCompanyOut,
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
    interCompanyIn: sum(rows.map((r) => r.interCompanyIn)),
    interCompanyOut: sum(rows.map((r) => r.interCompanyOut)),
  };

  return { weeks: rows, totals, fixedCategories };
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

// Simplified weekly cash flow for the 4 accounts besides Basin Checking — each
// has a much smaller, fixed set of line items (no Aged AR/AP-scale detail),
// so this returns a generic { inflows: [...], outflows: [...] } shape per
// week that one shared UI renderer can handle for all four.
export function computeSimpleAccountForecast(state, period, accountId) {
  const weeks = periodWeeks(period);
  const openingKey = { "pc-checking": "pcOpeningCash", "eb-savings": "ebOpeningCash", "basin-savings": "basinSavingsOpeningCash", "pc-savings": "pcSavingsOpeningCash" }[accountId];
  const scheduled = Array(WEEKS_PER_PERIOD).fill(0); // per-week "primary" scheduled inflow, meaning depends on account

  if (accountId === "pc-checking") {
    for (const r of state.receivables) {
      if ((r.depositAccount || "basin-checking") !== "pc-checking") continue;
      const wi = r.status === "paid" ? weekIndexForDateStrict(period, r.cfDate) : weekIndexForDate(period, r.cfDate);
      if (wi === null) continue;
      scheduled[wi] += (r.originalBalance ?? r.balance);
    }
  }

  const pcPayrollWeeks = (period.pcPayroll?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD);
  const pcK401Weeks = (period.pcK401?.weeks || []).filter((w) => w >= 0 && w < WEEKS_PER_PERIOD);
  const ic = interCompanyTransfersForAccount(state, period, accountId);

  const rows = weeks.map((w) => {
    const wi = w.index;
    const inflows = [];
    const outflows = [];

    if (accountId === "pc-checking") {
      inflows.push({ key: "receivablesCollected", label: "Receivables Collected", amount: scheduled[wi], editable: false });
      if (pcPayrollWeeks.includes(wi)) outflows.push({ key: "pcPayroll", label: "Payroll", amount: -weekAmountFor(period.pcPayroll, wi), editable: false });
      if (pcK401Weeks.includes(wi)) outflows.push({ key: "pcK401", label: "401K", amount: -weekAmountFor(period.pcK401, wi), editable: false });
      outflows.push({ key: "pcOtherOutflow", label: "Other Outflow", amount: readOv(period.pcOtherOutflow?.[wi]) ?? 0, editable: true });
    }

    // Every account gets exactly one Inter Company Transfer line in each
    // direction — entering a transfer once (manually, or as a recurring
    // Fixed Payment) automatically shows up on both accounts involved.
    inflows.push({ key: "interCompanyIn", label: "Inter Company Transfer", amount: ic.inflowByWeek[wi], editable: false, isTransfer: true });
    outflows.push({ key: "interCompanyOut", label: "Inter Company Transfer", amount: -ic.outflowByWeek[wi], editable: false, isTransfer: true });

    const inflowTotal = sum(inflows.map((r) => r.amount));
    const outflowTotal = sum(outflows.map((r) => r.amount));
    return { week: w, inflows, outflows, inflowTotal, outflowTotal, netCashflow: inflowTotal + outflowTotal, interCompanyItems: ic.itemsByWeek[wi] };
  });

  let opening = period[openingKey] || 0;
  for (const row of rows) {
    row.opening = opening;
    row.closing = opening + row.netCashflow;
    opening = row.closing;
  }

  return {
    weeks: rows,
    totals: {
      opening: rows[0]?.opening ?? 0,
      closing: rows[rows.length - 1]?.closing ?? 0,
      inflowTotal: sum(rows.map((r) => r.inflowTotal)),
      outflowTotal: sum(rows.map((r) => r.outflowTotal)),
      netCashflow: sum(rows.map((r) => r.netCashflow)),
    },
  };
}

// Single entry point for "give me this account's forecast" — Basin Checking
// keeps its full-detail computeForecast; everything else uses the simplified
// version above.
export function computeForecastForAccount(state, period, accountId) {
  if (accountId === "basin-checking" || !accountId) return computeForecast(state, period);
  return computeSimpleAccountForecast(state, period, accountId);
}


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

function mergeById(localArr, remoteArr, localTombstones, remoteTombstones) {
  localArr = localArr || [];
  remoteArr = remoteArr || [];
  localTombstones = localTombstones || {};
  remoteTombstones = remoteTombstones || {};
  const byId = new Map();
  for (const r of remoteArr) byId.set(r.id, r);
  for (const l of localArr) byId.set(l.id, newerOf(l, byId.get(l.id), timeOfRecord));
  // A tombstone means "I deleted this" — drop it from the merged result unless
  // the OTHER side edited it more recently than the deletion happened (in which
  // case their edit wins and the item survives, rather than silently vanishing).
  for (const [id, deletedAt] of Object.entries(localTombstones)) {
    const item = byId.get(id);
    if (!item) continue;
    const editedAt = timeOfRecord(item);
    if (editedAt > new Date(deletedAt).getTime()) continue; // genuinely newer edit from the other side — keep it
    byId.delete(id);
  }
  for (const [id, deletedAt] of Object.entries(remoteTombstones)) {
    const item = byId.get(id);
    if (!item) continue;
    const editedAt = timeOfRecord(item);
    if (editedAt > new Date(deletedAt).getTime()) continue;
    byId.delete(id);
  }
  return Array.from(byId.values());
}

function mergeTombstones(local, remote) {
  return { ...(remote || {}), ...(local || {}) };
}

// Call this whenever an item is deleted (individual delete or Clear All) so a
// concurrent merge knows it was removed on purpose, not just missing because
// the other copy being merged in is older.
export function recordTombstone(state, listKey, id) {
  if (!state.tombstones) state.tombstones = { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {} };
  if (!state.tombstones[listKey]) state.tombstones[listKey] = {};
  state.tombstones[listKey][id] = new Date().toISOString();
}

export function mergeStates(local, remote) {
  const merged = { ...remote };
  const lt = local.tombstones || {};
  const rt = remote.tombstones || {};

  merged.periods = remote.periods.map((rp) => {
    const lp = local.periods.find((p) => p.id === rp.id);
    if (!lp) return rp;
    return {
      ...rp, ...lp,
      overrides: mergeOverrides(lp.overrides, rp.overrides),
      notes: { ...rp.notes, ...lp.notes },
      pcOtherOutflow: mergeTimestampedMap(lp.pcOtherOutflow, rp.pcOtherOutflow),
    };
  });
  for (const lp of local.periods) {
    if (!merged.periods.find((p) => p.id === lp.id)) merged.periods.push(lp); // period created locally, not yet on server
  }

  merged.receivables = mergeById(local.receivables, remote.receivables, lt.receivables, rt.receivables);
  merged.unbilledReceivables = mergeById(local.unbilledReceivables || [], remote.unbilledReceivables || [], lt.unbilledReceivables, rt.unbilledReceivables);
  merged.payables = mergeById(local.payables, remote.payables, lt.payables, rt.payables);
  merged.fixedPayments = mergeById(local.fixedPayments, remote.fixedPayments, lt.fixedPayments, rt.fixedPayments);
  merged.transfers = mergeById(local.transfers || [], remote.transfers || [], lt.transfers, rt.transfers);

  merged.tombstones = {
    receivables: mergeTombstones(lt.receivables, rt.receivables),
    payables: mergeTombstones(lt.payables, rt.payables),
    fixedPayments: mergeTombstones(lt.fixedPayments, rt.fixedPayments),
    unbilledReceivables: mergeTombstones(lt.unbilledReceivables, rt.unbilledReceivables),
    transfers: mergeTombstones(lt.transfers, rt.transfers),
  };

  merged.customerAutoSchedule = { ...remote.customerAutoSchedule, ...local.customerAutoSchedule };
  merged.vendorAutoSchedule = { ...remote.vendorAutoSchedule, ...local.vendorAutoSchedule };
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
      existing.memo = rec.memo;
      if (kind === "AR") existing.poNumber = rec.poNumber;
      if (existing.balance > 0 && existing.status !== "open") existing.status = "open";
      existing.updatedAt = new Date().toISOString();
      updated++;
    } else {
      const tmpl = state[schedKey][rec[groupKey]];
      const isUncertain = kind === "AR" && tmpl?.uncertain;
      const item = {
        id: uid(kind.toLowerCase()),
        ...rec,
        originalBalance: rec.balance,
        payments: [],
        status: "open",
        cfDate: isUncertain ? null : (tmpl?.auto && rec.date ? clampToCurrentPeriod(state, toISO(addDays(rec.date, tmpl.days || 0))) : null),
        daysOverride: null,
        uncertain: isUncertain || undefined,
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
      if (!seen.has(key)) {
        if (x.originalBalance === undefined) x.originalBalance = x.balance;
        x.status = "paid";
        if (kind === "AP") x.balance = 0; // AR keeps showing the original invoice amount once paid
        x.updatedAt = new Date().toISOString();
        paidOff++;
      }
    }
  }

  // keep the auto-schedule template list in sync with whatever groups exist
  const groups = new Set(list.map((x) => x[groupKey]));
  for (const g of groups) {
    if (!state[schedKey][g]) state[schedKey][g] = { days: 30, auto: false };
  }

  return { added, updated, paidOff };
}

// Creates Unbilled Receivable lines from reviewed import specs — one call per
// batch (e.g. all the 4-week lines the user chose to include, then again for
// 8-week). Each spec: { projectNumber, project, customer, forecastWindow,
// originalBalance, billPercent, date }. balance = originalBalance * billPercent/100.
// New customers seen here get folded into the same customerAutoSchedule map
// Existing AR uses, so one "days to pay" setting covers both.
export function createUnbilledLines(state, specs) {
  let added = 0;
  for (const spec of specs) {
    if (!spec.customer || !spec.originalBalance) continue;
    if (!state.customerAutoSchedule[spec.customer]) state.customerAutoSchedule[spec.customer] = { days: 30, auto: false };
    const tmpl = state.customerAutoSchedule[spec.customer];
    const billPercent = spec.billPercent ?? 100;
    const balance = Math.round(spec.originalBalance * (billPercent / 100) * 100) / 100;
    const item = {
      id: uid("ub"),
      projectNumber: spec.projectNumber || "",
      project: spec.project || "",
      customer: spec.customer,
      forecastWindow: spec.forecastWindow || null, // "4wk" | "8wk" | null (manual entries)
      originalBalance: spec.originalBalance,
      billPercent,
      balance,
      date: spec.date || null,
      status: "open",
      cfDate: tmpl.uncertain ? null : (tmpl.auto && spec.date ? clampToCurrentPeriod(state, toISO(addDays(spec.date, tmpl.days || 0))) : null),
      daysOverride: null,
      uncertain: !!tmpl.uncertain,
      source: spec.source || "import",
    };
    state.unbilledReceivables.push(item);
    added++;
  }
  return added;
}

export const KIND_MAP = {
  AR: { listKey: "receivables", groupKey: "customer", schedKey: "customerAutoSchedule" },
  AP: { listKey: "payables", groupKey: "vendor", schedKey: "vendorAutoSchedule" },
  UNBILLED: { listKey: "unbilledReceivables", groupKey: "customer", schedKey: "customerAutoSchedule" },
};

export function applyAutoScheduleToAll(state, kind) {
  const { listKey, groupKey, schedKey } = KIND_MAP[kind];
  let count = 0;
  const now = new Date().toISOString();
  for (const x of state[listKey]) {
    if (x.status !== "open" || x.payWhenPaid) continue;
    const tmpl = state[schedKey][x[groupKey]];
    if (tmpl?.uncertain) { x.uncertain = true; x.cfDate = null; x.updatedAt = now; continue; } // uncertain always wins over auto-schedule
    if (tmpl?.auto && x.date) {
      x.cfDate = clampToCurrentPeriod(state, toISO(addDays(x.date, tmpl.days || 0)));
      x.updatedAt = now;
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
  const now = new Date().toISOString();
  for (const x of state[listKey]) {
    if (x.status !== "open" || x[groupKey] !== groupName || x.payWhenPaid) continue;
    if (tmpl.uncertain) { x.uncertain = true; x.cfDate = null; x.updatedAt = now; continue; } // uncertain always wins over auto-schedule
    if (x.date) { x.cfDate = clampToCurrentPeriod(state, toISO(addDays(x.date, tmpl.days || 0))); x.updatedAt = now; count++; }
  }
  return count;
}
