import { uid, toISO, parseISO, addDays, todayISO, sum } from "./util.js";

export const WEEKS_PER_PERIOD = 13;
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
  { id: "basin-savings", name: "Basin Savings", isMain: false },
  { id: "pc-checking", name: "P&C Checking", isMain: false },
  { id: "pc-savings", name: "P&C Savings", isMain: false },
  { id: "eb-savings", name: "EB Savings", isMain: false },
];

export function accountName(id) {
  return ACCOUNTS.find((a) => a.id === id)?.name || id;
}

// The 6 Unbilled Revenue sections — a completely separate structure from the
// existing Unbilled AR (project revenue forecast) list.
export const UNBILLED_REVENUE_SECTIONS = [
  { id: "fixedPriceBacklog", label: "Fixed Price Rolling Revenue Forecast" },
  { id: "tm", label: "T&M Projections" },
  { id: "frontlog", label: "High Dollar, High Probability Frontlog" },
  { id: "smallQuickJobs", label: "Small, Quick Jobs" },
  { id: "wip", label: "WIP" },
  { id: "other", label: "Other" },
];

export function blankInvoice() { return { amount: 0, invoiceDate: null, cfDate: null }; }
export function makeUnbilledRevenueItem(section, name, invoices = []) {
  const slots = [blankInvoice(), blankInvoice(), blankInvoice()];
  invoices.forEach((inv, i) => { if (i < 3 && inv) slots[i] = { amount: inv.amount || 0, invoiceDate: inv.invoiceDate || null, cfDate: inv.cfDate || null }; });
  return { id: uid("urv"), section, name, invoices: slots, status: "open", lastEditBy: "import", updatedAt: new Date().toISOString(), source: "import" };
}

// Total of an item's 3 invoice slots.
export function unbilledRevenueItemTotal(item) {
  return (item.invoices || []).reduce((a, inv) => a + (inv.amount || 0), 0);
}

// One-time seed from the Q4 2026 Revenue Forecast Breakdown (Sept 29, 2026
// cycle) and the Sept WIP roll — every section's total here was cross-checked
// against the source document's own stated totals before being hardcoded.
// Oct/Nov/Dec invoice dates are end-of-month; WIP items are seeded with no
// invoice date yet, per the user's request to assign those by hand.
export function seedUnbilledRevenue() {
  const items = [];
  const OCT = "2026-10-31", NOV = "2026-11-30", DEC = "2026-12-31";
  const inv = (amt, date) => (amt ? { amount: amt, invoiceDate: date, cfDate: null } : null);
  const addMonthly = (section, name, oct, nov, dec) => {
    items.push(makeUnbilledRevenueItem(section, name, [inv(oct, OCT), inv(nov, NOV), inv(dec, DEC)]));
  };

  // 1. Fixed Price Revenue Backlog — 45 projects (Oct/Nov/Dec totals verified
  // against the PDF's stated $1,495,244 / $1,260,238 / $561,401)
  const fpb = [
    ["23-044 QTS — QTS - SLC1", 26388, 30403, 26388],
    ["24-002.154 Floor & Decor — Floor & Decor - N. Oklahoma City (Edmond), OK", 1405, 0, 0],
    ["24-004.12 POH+W Architects Ltd. — CarMax Lake Charles, LA", 0, 0, 0],
    ["24-023 QTS — QTS Cedar Rapids, IA", 61686, 64274, 57242],
    ["24-023.18 QTS — 6th Ave. SW & Edgewood Rd. SW Intersection Imp, Cedar Rapids", 11964, 11964, 0],
    ["24-023.19 QTS — CDR1 – Wright Bros Intersection Improvements", 4185, 1046, 0],
    ["24-042 St. Tammany Parish Procurement — Tammany Trace Bridge #7", 6075, 93806, 93806],
    ["24-067 Corgan — DFW2-DAS114", 14073, 14073, 14073],
    ["24-098 POH+W Architects Ltd. — Carmax Waco,TX", 800, 800, 1542],
    ["25-040 Copeland and Johns — UPS New Orleans Expansion", 722, 722, 0],
    ["25-075 CarMax — CarMax-Uxbridge, MA", 6221, 8271, 8271],
    ["25-078.4 CarMax — Site Entitlements", 5519, 5519, 5519],
    ["25-086 QTS — QTS - Turkey, TX", 0, 0, 0],
    ["25-086.1 QTS — QTS-WTX1-CAMPUS, Hall County, TX - Turkey, TX Civil Design", 23686, 26486, 23686],
    ["25-086.2 QTS — QTS Turkey, TX - Phase 2 - Mass Grading", 37482, 61168, 26486],
    ["25-086.12 QTS — WTX1 Offsite Road Improvements", 16529, 0, 0],
    ["25-093 CarMax — CarMax-Riverview,FL", 28555, 8566, 5711],
    ["25-100 CarMax — Carmax Wayne, NJ expansion", 0, 0, 0],
    ["25-105 Corgan — DAS114 (DC-5, DC-6, DC-7, and DC-8)", 28090, 21205, 38075],
    ["25-109 MG2 — EDGED Monroe Campus", 7209, 7209, 7209],
    ["25-110 MG2 — EDGED Mobile Campus (Pritchard)", 0, 0, 0],
    ["26-009 Digital Engineering — Parish Line Pump Station Improvements Phase 2", 52000, 13000, 13000],
    ["26-011 QTS — Mason City, IA Data Center", 156111, 232877, 95806],
    ["26-018 Corgan — QTS-DFW2 Corner Site - Wilmer, TX", 0, 0, 0],
    ["26-029 QTS — QTS-SLC1 Expansion Campus Campus Planning Eagle Mountain, UT", 0, 1600, 0],
    ["26-031 CarMax — CarMax-Brownsville, TX", 0, 0, 0],
    ["26-038 Blue Whale Development — 7 Brew - 3209 Johnson Street - Subwork", 308, 308, 0],
    ["26-039 Flavored Operations, LLC — 7 Brew - Sulphur, LA - 212 S. Cities", 8502, 17285, 10161],
    ["26-060 Rosehill Construction — Brookwood - Highway 44, Gonzales, LA", 6423, 22009, 7503],
    ["26-068 Basic Systems, Inc. — Southern Star McNew Compressor Station", 0, 56843, 56843],
    ["26-069 Corgan — QTS - DFW3 - Lancaster, TX", 0, 0, 0],
    ["26-070 QII — QII-Fort Bend Parkway, Houston, TX", 0, 0, 0],
    ["26-091 QTS — US Hwy 67, Johnson County, TX", 95432, 0, 0],
    ["26-093 Corgan — SLC2 Campus Plan - DC1-DC2 Civil Construction Drawings", 74062, 76692, 26099],
    ["26-093.1 QTS — SLC1 Expansion, SLC2 Phase 1, and SLC Phase 2 Offsite Infrastructure Improvements", 371215, 121607, 38504],
    ["26-093.2 QTS — SLC1 Expansion Phase 1 scope", 38608, 19304, 0],
    ["26-094 Diamond Z Engineering, Inc. — FedEx Parking Lot Expansion", 6212, 1538, 0],
    ["26-095 Oracle — ABI01 – Entry Enhancement Civil Design - Hrly up to $95K", 0, 0, 0],
    ["26-103 Laitram, LLC — Professional Civil Engineering and Land Surveying Services 5400 Jefferson Hwy", 5560, 3520, 0],
    ["26-112 Neo Infrastructure — 1544 & 1556 Tchoupitoulas Street New Orleans, LA 70130", 1500, 0, 0],
    ["26-116 Kohl's Department Stores, Inc. — Land Surveying services for the Seven Brew in Lafayette, LA.", 0, 1840, 490],
    ["26-118 QTS — Pre Dev. DD-Additional 380 Acres-Eagle Mountain", 50347, 26110, 1388],
    ["26-119 QII — Due Diligence and Site Investigation Approximate 2037 Acre Parcel Salco Road Church", 261975, 295375, 3600],
    ["22006 J Caldarera Company — LA Trace Subdivision Lot Study", 86400, 0, 0],
    ["24003 JP Department of PW — Seven Oaks - US 90 Street Lighting", 0, 14818, 0],
  ];
  for (const [name, o, n, d] of fpb) addMonthly("fixedPriceBacklog", name, o, n, d);

  // 2. T&M Projections — verified against $53,000 / $55,000 / $55,000
  addMonthly("tm", "6012-40 Digital Engineering — JP Sewer", 27000, 27000, 27000);
  addMonthly("tm", "Meyer projects", 6000, 8000, 8000);
  addMonthly("tm", "Other Jefferson Parish projects", 20000, 20000, 20000);

  // 3. High Dollar, High Probability Frontlog — "File# - Client — Project"
  // merged into one name field per the user's instruction. Verified against
  // $225,864 / $386,756 / $646,756 (off by $2 in Nov/Dec vs the PDF, a
  // rounding artifact in the source's own % × fee math, not a transcription error).
  // Rows with no probability/%-complete assigned yet import at $0 across all
  // 3 months, ready to fill in, per instruction.
  addMonthly("frontlog", "26M-160 - GreenSpace Ventures — Savanna Data & Power Campus, Carroll County", 0, 0, 0);
  addMonthly("frontlog", "26M-149 - QTS Data Centers — Hylton, WV DD", 0, 0, 0);
  addMonthly("frontlog", "26M-157 - Basic Systems, Inc. — EGT&S Oakleaf Centre Addition", 0, 16672, 16672);
  addMonthly("frontlog", "26M-158 - Basic Systems, Inc. — EGT&S Oakleaf Finnefrock Station", 0, 18232, 18232);
  addMonthly("frontlog", "26M-159 - Basic Systems, Inc. — EGT&S Oakleaf Perulak Station", 0, 16770, 16770);
  addMonthly("frontlog", "26M-168 - Waskey Bridges, Inc. — WhiteWater Midstream Thrasher Meter Station", 0, 0, 80000);
  addMonthly("frontlog", "26M-175 - QTS Data Centers — Walnut Cove, NC DD", 14963, 29926, 29926);
  addMonthly("frontlog", "26M-176 - QTS Data Centers — Pima County, AZ DD", 0, 0, 0);
  addMonthly("frontlog", "26M-162 - Beale Infrastructure — Muskogee County, Oklahoma", 0, 0, 0);
  addMonthly("frontlog", "26M-182 - QTS Data Centers — Knightdale, NC DD", 31457, 62914, 62914);
  addMonthly("frontlog", "26M-184 - Oracle Cloud Infrastructure — OCI – Stage 1 Desktop Due Diligence", 0, 0, 0);
  addMonthly("frontlog", "26M-178 - QTS Data Centers — Millard County DD", 47444, 94888, 94888);
  addMonthly("frontlog", "26M-179 - Woodward Design Group — Surgery Center at 3100 Metairie Road", 0, 0, 0);
  addMonthly("frontlog", "26M-185 - JRE Management — Pineville, LA 7brew", 0, 5981, 5981);
  addMonthly("frontlog", "26M-188 - Kalcon — Luzerne County, PA", 0, 0, 0);
  addMonthly("frontlog", "26M-189 - Frischertz — CPG Data Center", 0, 0, 180000);
  addMonthly("frontlog", "26M-191 - Floor & Decor — Dallas", 0, 9371, 9371);
  addMonthly("frontlog", "No # yet - QTS Data Centers — Cedar Proposal – kicked off", 132000, 132000, 132000);

  // 4. Small, Quick Jobs — verified against $50,000 / $50,000 / $50,000
  addMonthly("smallQuickJobs", "Small, Quick Jobs", 50000, 50000, 50000);

  // 5. WIP — project #, customer and name merged into one field; a single
  // unbilled-revenue amount as of end of September, no invoice date assigned
  // yet (the user will plug in invoice date + CF date by hand). Verified
  // against the WIP table's stated total, $4,510,000.20.
  const wip = [
    ["24-067 Corgan — DFW2-DAS114", 10650],
    ["25-105 Corgan — DAS114(DC5,6,7,8)", 5000],
    ["26-069 Corgan — DWF3 -Lancaster", 119050],
    ["26-093 Corgan — SLC2 Campus Plan", 889433],
    ["3011 JP — JP-Harvey Lighting", 13053],
    ["5008 JP — JP-Ames", 60375],
    ["20001 JP — JP-Stumpf", 45281],
    ["25-109 MG2 — EDGED Monroe Campus", 7209],
    ["26-092 QII — TX Hwy 89", 4500],
    ["26-117 QII — I-44 & US Route 66, Villa Ridge", 4500],
    ["25-086.1 QTS — Turkey P1", 2091309.50],
    ["26-093.1 QTS — SLC", 914780.70],
    ["26-093.2 QTS — SLC1 Expansion P1", 328164],
    ["26-118 QTS — Eagle Mountain Pre Dev DD - Additional 380", 16695],
  ];
  for (const [name, amt] of wip) {
    items.push(makeUnbilledRevenueItem("wip", name, [{ amount: amt, invoiceDate: null, cfDate: null }]));
  }

  // 6. Other — the Q4 Summary's "Other" line, verified against $75,000 / $200,000 / $400,000
  addMonthly("other", "Other", 75000, 200000, 400000);

  return items;
}

// ============================================================================
// Unbilled AR — configurable month columns, and the November 2026 data update
// ============================================================================

// What every section showed before the months became configurable (Oct/Nov/Dec).
// A section with no setting keeps showing exactly that, so untouched sections look untouched.
export const DEFAULT_UNBILLED_START_MONTH = "2026-10";

// "2026-11" + 2 -> "2027-01"
export function addMonthsYM(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
// Last day of a month as an ISO date: "2026-11" -> "2026-11-30"
export function monthEndISO(ym) {
  const [y, m] = ym.split("-").map(Number);
  return toISO(new Date(y, m, 0));
}
const YM_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// First of the three months a section's invoice columns cover. Ignores a malformed value rather than trusting it.
export function unbilledStartMonth(state, sectionId) {
  const v = state.unbilledRevenueMonths && state.unbilledRevenueMonths[sectionId];
  return YM_PATTERN.test(v || "") ? v : DEFAULT_UNBILLED_START_MONTH;
}
// The three months a section shows, e.g. ["2026-11", "2026-12", "2027-01"]
export function unbilledMonthSlots(state, sectionId) {
  const start = unbilledStartMonth(state, sectionId);
  return [0, 1, 2].map((n) => addMonthsYM(start, n));
}

// ---- The November 2026 rolling-forecast update ---------------------------------------------
// Source: the "Rolling Revenue Forecast — Nov 2026 to Jan 2027" PDF (prepared Nov 6, 2026). Every project, proposal and
// allowance in it becomes ONE line item carrying its Nov, Dec and Jan dollars — whole dollars, exactly as printed.
// Frontlog amounts are the probability-weighted ones. Generated by scripts/gen_unbilled_update_data.py.
//
// Replaces: Fixed Price, T&M, Frontlog and Small Quick Jobs.   Never touches: Other.
// WIP stays as the last update left it — the ending-October balances from the earlier workbook update. If that update was
// already applied, WIP is left exactly as it is (so any edits made since survive); if it never was, this update loads those
// same balances, so WIP ends up identical either way.
//
// NOT applied automatically: deploying this code changes no stored data. An editor reviews and confirms it on the
// Unbilled AR tab (applyUnbilledUpdate), which touches only the sections above.
export const UNBILLED_UPDATE_ID = "2026-11-rolling";
const PRIOR_UPDATE_ID = "2026-11-fp-wip"; // the earlier Fixed Price + WIP update this one builds on
const PDF_SECTIONS = ["fixedPriceBacklog", "tm", "frontlog", "smallQuickJobs"];
export const UNBILLED_UPDATE_DATA = {
  startMonth: "2026-11",
  // sections: one line item per row — [name, Nov $, Dec $, Jan $].   wip: [project #, name, ending-October balance]
// >>> UPDATE_DATA:START (generated)
  sections: {
    fixedPriceBacklog: [
      ["23-044 QTS — QTS - SLC1", 30403, 26388, 3156],
      ["24-002.154 Floor & Decor — Floor & Decor - N. Oklahoma City (Edmond), OK", 890, 0, 0],
      ["24-002.174 Floor & Decor — Floor & Decor - Tomball, TX", 4992, 1248, 0],
      ["24-023 QTS — QTS Cedar Rapids, IA", 63826, 53278, 0],
      ["24-023.18 QTS — 6th Ave. SW & Edgewood Rd. SW Intersection Imp, Cedar Rapids", 11964, 0, 0],
      ["24-023.23 QTS — CDR1 Site Infrastructure – 76th Ave. Water Main Extension Cedar Rapids, IA", 184120, 122747, 0],
      ["24-042 St. Tammany Parish — Tammany Trace Bridge #7", 93806, 93806, 0],
      ["24-067 Corgan — DFW2-DAS114", 14073, 14073, 0],
      ["24-068 Highland Associates — DFW2-DC2", 0, 0, 14271],
      ["24-069 Highland Associates — DFW2-DC3", 0, 0, 6048],
      ["24-098 POH+W Architects Ltd. — Carmax Waco,TX", 400, 1142, 1142],
      ["25-040 Copeland and Johns — UPS New Orleans Expansion", 722, 722, 0],
      ["25-075 CarMax — CarMax-Uxbridge, MA", 36230, 33155, 0],
      ["25-078.4 CarMax — Site Entitlements", 5519, 5519, 0],
      ["25-086 QTS — QTS - Turkey, TX", 0, 0, 0],
      ["25-086.1 QTS — QTS-WTX1-CAMPUS, Hall County, TX - Turkey, TX Civil Design", 26486, 23686, 23686],
      ["25-086.2 QTS — QTS Turkey, TX - Phase 2 - Mass Grading", 61168, 26486, 0],
      ["25-086.12 QTS — WTX1 Offsite Road Improvements", 8264, 0, 0],
      ["25-093 CarMax — CarMax-Riverview,FL", 5711, 0, 0],
      ["25-100 CarMax — Carmax Wayne, NJ expansion", 0, 0, 0],
      ["25-105 Corgan — DAS114 (DC-5, DC-6, DC-7, and DC-8)", 28365, 44960, 60380],
      ["25-109 MG2 — EDGED Monroe Campus", 7209, 7209, 7209],
      ["25-110 MG2 — EDGED Mobile Campus (Pritchard)", 0, 5440, 5400],
      ["26-009 Digital Engineering — Parish Line Pump Station Improvements Phase 2", 13000, 13000, 0],
      ["26-011 QTS — Mason City, IA Data Center", 20160, 0, 0],
      ["26-015 Waskey Bridges Inc. — ARM Mustang Meter Station Platform", 0, 21000, 0],
      ["26-017 QTS — QTS-DFW2 Marine - Mason Rd. Wilmer, TX", 0, 0, 0],
      ["26-018 Corgan — QTS-DFW2 Corner Site - Wilmer, TX", 0, 0, 0],
      ["26-031 CarMax — CarMax-Brownsville, TX", 0, 0, 0],
      ["26-034 Rosehill Construction — Brookwood – Highway 59 – St. Tammany", 4224, 0, 0],
      ["26-034.2 Rosehill Construction — Alta Survey", 1250, 0, 0],
      ["26-038 Blue Whale Dev. — 7 Brew - 3209 Johnson Street - Subwork", 308, 308, 0],
      ["26-039 Flavored Operations, LLC — 7 Brew - Sulphur, LA - 212 S. Cities", 25662, 6702, 3565],
      ["26-047 SCNZ Architects, LLC — Renovation of 5307 Toler - Laitram Harahan Campus", 7265, 9687, 0],
      ["26-047.1 SCNZ Architects, LLC — Renovation of 220 Plantation - Laitram Harahan Campus", 5388, 7184, 0],
      ["26-060 Rosehill Construction — Brookwood - Highway 44, Gonzales, LA", 25222, 2175, 0],
      ["26-060.1 Rosehill Construction — Alta Survey", 1250, 0, 0],
      ["26-060.2 Rosehill Construction — Permitting", 1250, 1250, 0],
      ["26-068 Basic Systems, Inc. — Southern Star McNew Compressor Station", 56842, 56842, 0],
      ["26-069 Corgan — QTS - DFW3 - Lancaster, TX", 20867, 0, 0],
      ["26-091 QTS — US Hwy 67, Johnson County, TX", 3280, 19400, 19400],
      ["26-093 Corgan — SLC2 Campus Plan - DC1-DC2 Civil Construction Drawings", 76692, 26099, 26099],
      ["26-093.1 QTS — SLC1 Expansion, SLC2 Phase 1, and SLC Phase 2 Offsite Infrastructure Improvements", 163308, 38504, 10803],
      ["26-093.2 QTS — SLC1 Expansion Phase 1 scope", 19337, 17581, 20211],
      ["26-095 Oracle — ABI01 – Entry Enhancement Civil Design - Hrly up to $95K", 0, 0, 0],
      ["26-103 Laitram, LLC — Professional Civil Engineering and Land Surveying Services 5400 Jefferson Hwy", 2040, 1020, 4080],
      ["26-116 Kohl's Department Stores, Inc. — Land Surveying services for the Seven Brew in Lafayette, LA.", 1840, 490, 0],
      ["26-118 QTS — Pre Dev. DD-Additional 380 Acres-Eagle Mountain", 0, 9772, 22920],
      ["26-119 QII — Due Diligence and Site Investigation Approximate 2037 Acre Parcel Salco Road Church", 0, 0, 0],
      ["26-124 QTS — QTS-SLC1 Day 2 Design and DC4/DC5 Revised Electric Routing Eagle Mountain, UT", 15300, 0, 0],
      ["26-125 Corgan — MV UPS BESS Standard V1.0", 0, 0, 0],
      ["26-126 JJR Construction — Calcasieu River - Survey", 0, 13804, 27608],
      ["26-126.01 JJR Construction — Calcasieu River - Civil", 0, 0, 0],
      ["26-129 Woodward Design Group — Professional Civil Engineering Services Jefferson Highway and Maine Street", 4900, 8400, 5790],
      ["26-130 Frischhertz — CPG Data Center Alexandria, LA", 48000, 48000, 48000],
      ["26-xxx QTS — Turkey Roadway Assessment", 40240, 2874, 0],
      ["22006 J Caldarera — LA Trace Subdivision Lot Study", 0, 0, 36000],
      ["New Watermark — Drug Court", 0, 37000, 0],
      ["New CarMax — Louisville Feasibility", 25000, 25000, 0],
      ["New Turkey Offsite Road Improvements — Countr…", 175000, 10000, 0],
      ["New Waterline Extension — DFW2", 0, 81250, 81250],
    ],
    tm: [
      ["6012-40 Digital Engineering — JP Sewer", 27000, 27000, 27000],
      ["Meyer projects", 5000, 5000, 5000],
      ["Other Jefferson Parish projects", 10000, 10000, 10000],
      ["26-130 Frischhertz — CPG Data Center (included in Fixed Price Revenue Backlog)", 0, 0, 0],
      ["26-095 Oracle — ABI01 Entry Enhancement", 15000, 15000, 15000],
      ["Other Rosehill T&M", 4000, 4000, 4000],
    ],
    frontlog: [
      ["26M-168 - Waskey Bridges, Inc. — WhiteWater Midstream Thrasher Meter Station", 0, 80000, 80000],
      ["26M-184 - Oracle Cloud Infrastructure — OCI – Stage 1 Desktop Due Diligence", 0, 0, 113070],
      ["26M-214 - QTS Data Centers — DFW2 Jones Lot Trailer City", 0, 47720, 47720],
      ["26M-182 - QTS Data Centers — Knightdale, NC. Pre-Development DD", 0, 0, 78643],
      ["26M-171 - Horizon Engineering, LLC — Professional Land Surveying Services", 0, 19296, 50170],
      ["26M-210 - Waskey Bridges, Inc. — Williams Huckleberry Meter Station", 0, 0, 40000],
      ["26M-206 - QTS Data Centers — McKnight Early Pre-Development DD", 0, 13125, 13125],
      ["26M-188 - Kalcon — 75 Main Road – Newport Township", 0, 9538, 9538],
      ["26M-162 - Beale Infrastructure — Muskogee County, Oklahoma DD", 0, 0, 15125],
      ["26M-185 - JRE Management — 7 Brew 3419 Monroe Highway", 0, 0, 8972],
      ["26M-179 - Woodward Design Group — Ambulance Surgery Center", 0, 0, 8871],
    ],
    smallQuickJobs: [
      ["Small, Quick Jobs", 50000, 100000, 150000],
    ],
  },
  wip: [
    ["3011", "3011 JP — JP-Harvey Lighting", 7442.76],
    ["5008", "5008 JP — JP-Ames", 15670.24],
    ["20001", "20001 JP — JP-Stumpf", 15991.41],
    ["22006", "22006 J Caldera — LA Trace Subdivision Lot Study", 64800],
    ["24-023.23", "24-023.23 QTS — CDR 76tth Ave Waterline Extension", 315668],
    ["24-067", "24-067 Corgan — DFW2-DAS114", 10650],
    ["25-086.1", "25-086.1 QTS — Turkey P1", 2116143.93],
    ["25-105", "25-105 Corgan — DAS114(DC5,6,7,8)", 5000],
    ["25-109", "25-109 MG2 — EDGED Monroe Campus", 14418],
    ["26-069", "26-069 Corgan — DWF3 -Lancaster", 208525],
    ["26-075.5", "26-075.5 QII — QII Bridgeport, Moreland, GA", 10500],
    ["26-085", "26-085 QII — Hockley Business Park, Harris County, TX", 7000],
    ["26-092", "26-092 QII — TX Hwy 89", 4500],
    ["26-093", "26-093 Corgan — SLC2 Campus Plan", 963495],
    ["26-093.1", "26-093.1 QTS — SLC", 1233491.7],
    ["26-093.2", "26-093.2 QTS — SLC1 Expansion P1", 367224],
    ["26-095", "26-095 Oracle — ABI01 – Entry Enhancement Civil Design", 39935],
    ["26-117", "26-117 QII — I-44 & US Route 66, Villa Ridge", 4500],
    ["26-118", "26-118 QTS — Eagle Mountain Pre Dev DD - Additional 380", 66780],
    ["26-119", "26-119 QII — Salco Road Chunchula", 50188],
    ["26-124", "26-124 QTS — SLC1 - Day 2 Civil Design and DC4/DC5 Electric Duct Bank Revision", 44860],
    ["26-132", "26-132 QII — Woodruff Mill Rd., Jefferson County, AL", 4500],
    ["26-139", "26-139 QII — Test Fit Buildings", 20000],
  ],
// >>> UPDATE_DATA:END
};

const r2 = (n) => Math.round(n * 100) / 100;
const priorUpdateApplied = (state) => !!(state.dataUpdates && state.dataUpdates[PRIOR_UPDATE_ID]);

export function unbilledUpdatePending(state) {
  return !(state.dataUpdates && state.dataUpdates[UNBILLED_UPDATE_ID]);
}

// The sections this update replaces right now: always the four from the PDF, plus WIP only if the earlier update that
// loaded the ending-October balances never ran (otherwise WIP is already where it should be, and stays untouched).
export function unbilledUpdateSections(state) {
  return priorUpdateApplied(state) ? [...PDF_SECTIONS] : [...PDF_SECTIONS, "wip"];
}

// A section's new rows as [name, Nov, Dec, Jan]
function updateRows(sec) {
  const d = UNBILLED_UPDATE_DATA;
  return sec === "wip" ? d.wip.map(([, name, amt]) => [name, amt, 0, 0]) : d.sections[sec];
}

// What applying the update would do to the CURRENT state — shown in the confirm dialog.
export function unbilledUpdateSummary(state) {
  const live = (state.unbilledRevenue || []).filter((i) => i.status !== "deleted");
  const label = Object.fromEntries(UNBILLED_REVENUE_SECTIONS.map((sec) => [sec.id, sec.label]));
  let schedCount = 0, schedAmount = 0; // CF dates already assigned on the items about to be replaced
  const sections = unbilledUpdateSections(state).map((sec) => {
    const old = live.filter((i) => i.section === sec);
    for (const it of old) {
      if (it.status !== "open") continue;
      for (const inv of it.invoices || []) if (inv.cfDate && inv.amount) { schedCount++; schedAmount += inv.amount; }
    }
    const rows = updateRows(sec);
    const monthTotals = [0, 1, 2].map((k) => r2(rows.reduce((a, row) => a + row[1 + k], 0)));
    return { id: sec, label: label[sec], oldCount: old.length, newCount: rows.length, monthTotals, newTotal: r2(monthTotals[0] + monthTotals[1] + monthTotals[2]) };
  });
  return {
    months: [0, 1, 2].map((n) => addMonthsYM(UNBILLED_UPDATE_DATA.startMonth, n)),
    sections,
    wipKept: priorUpdateApplied(state),
    scheduled: { count: schedCount, amount: r2(schedAmount) },
  };
}

// Replaces ONLY the sections listed by unbilledUpdateSections() (and switches only those to Nov/Dec/Jan); everything else in
// the state is left exactly as it is. New items get deterministic ids so two editors applying at the same moment converge
// instead of duplicating, and every replaced item is tombstoned so a stale browser can't bring it back. CF dates start blank,
// as for every other seeded item, so nothing new flows into Receivables Collected until you assign dates.
export function applyUnbilledUpdate(state, who = "update") {
  const d = UNBILLED_UPDATE_DATA;
  const replace = unbilledUpdateSections(state);
  const nowIso = new Date().toISOString();
  const invoiceDates = [0, 1, 2].map((n) => monthEndISO(addMonthsYM(d.startMonth, n))); // month-end, like the earlier seeds
  const slug = (v) => String(v).replace(/[^A-Za-z0-9]+/g, "_");
  const make = (section, id, name, invoices) => {
    const it = makeUnbilledRevenueItem(section, name, invoices);
    it.id = id; it.lastEditBy = who; it.updatedAt = nowIso; it.source = "import";
    return it;
  };
  const tag = { fixedPriceBacklog: "fp", tm: "tm", frontlog: "fl", smallQuickJobs: "sj" };
  const fresh = [];
  for (const sec of PDF_SECTIONS) {
    for (const [name, ...amts] of d.sections[sec]) {
      fresh.push(make(sec, `urv_2611b_${tag[sec]}_${slug(name)}`, name,
        amts.map((a, k) => (a ? { amount: a, invoiceDate: invoiceDates[k], cfDate: null } : null))));
    }
  }
  if (replace.includes("wip")) {
    for (const [num, name, amt] of d.wip) {
      // same shape WIP has always had: the balance in the first invoice slot, no dates yet (ids match the earlier update's)
      fresh.push(make("wip", `urv_2611_wip_${slug(num)}`, name, [{ amount: amt, invoiceDate: null, cfDate: null }]));
    }
  }
  const freshIds = new Set(fresh.map((i) => i.id));

  state.unbilledRevenue = state.unbilledRevenue || [];
  const keep = [], removed = [];
  for (const it of state.unbilledRevenue) (replace.includes(it.section) ? removed : keep).push(it);
  for (const it of removed) if (!freshIds.has(it.id)) recordTombstone(state, "unbilledRevenue", it.id);
  state.unbilledRevenue = [...keep, ...fresh];

  state.unbilledRevenueMonths = { ...(state.unbilledRevenueMonths || {}) };
  for (const sec of replace) state.unbilledRevenueMonths[sec] = d.startMonth;
  state.dataUpdates = { ...(state.dataUpdates || {}), [UNBILLED_UPDATE_ID]: { at: nowIso, by: who } };
  // this update includes everything the earlier one did, so that one is done too (keeps its old banner from reappearing)
  if (!state.dataUpdates[PRIOR_UPDATE_ID]) state.dataUpdates[PRIOR_UPDATE_ID] = { at: nowIso, by: who, via: UNBILLED_UPDATE_ID };
  return { removed: removed.length, added: fresh.length, sections: replace };
}

// CSV of the line items the update would replace (names, all three invoice amounts / invoice dates / CF dates), offered as a
// download before applying so any CF dates already assigned aren't lost for good.
export function unbilledBackupCsv(state) {
  const esc = (v) => { const t = v == null ? "" : String(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const label = Object.fromEntries(UNBILLED_REVENUE_SECTIONS.map((sec) => [sec.id, sec.label]));
  const replace = unbilledUpdateSections(state);
  const head = ["Section", "Name"];
  for (let k = 1; k <= 3; k++) head.push(`Inv ${k} Amount`, `Inv ${k} Invoice Date`, `Inv ${k} CF Date`);
  head.push("Total", "Last edited by");
  const rows = (state.unbilledRevenue || [])
    .filter((i) => replace.includes(i.section) && i.status !== "deleted")
    .map((it) => {
      const cells = [label[it.section] || it.section, it.name];
      for (let k = 0; k < 3; k++) { const x = (it.invoices && it.invoices[k]) || {}; cells.push(x.amount || "", x.invoiceDate || "", x.cfDate || ""); }
      cells.push(unbilledRevenueItemTotal(it), it.lastEditBy || "");
      return cells;
    });
  return [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

// Every invoice slot across every unbilled-revenue item that has a CF date
// assigned, feeding into Receivables Collected on CF Forecast — same
// contract as receivables/unbilledReceivables: only counts once a CF date
// is actually set, which here the user assigns by hand per the request.
export function unbilledRevenueOccurrencesInPeriod(state, period) {
  const out = []; // { wi, amount, itemId, section, name, invoiceIdx }
  for (const item of state.unbilledRevenue || []) {
    if (item.status !== "open") continue;
    (item.invoices || []).forEach((inv, idx) => {
      if (!inv.cfDate || !inv.amount) return;
      const wi = weekIndexForDate(period, inv.cfDate);
      if (wi === null) return;
      out.push({ wi, amount: inv.amount, itemId: item.id, section: item.section, name: item.name, invoiceIdx: idx });
    });
  }
  return out;
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
  if (!period.basinSavingsDistributions) period.basinSavingsDistributions = {};
  if (!period.projectedAP) period.projectedAP = {};
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
    // Pay When Paid memory — keyed by vendor+invoice#, survives Clear All +
    // re-import on both Payables and Receivables. { [pwpKey]: { receivableKey, kind:'ar'|'unbilled' } }
    pwpMemory: {},
    // Unbilled AR: the first of the 3 months each section's columns cover ({ [sectionId]: "YYYY-MM" }; unset = Oct/Nov/Dec),
    // and which one-time data updates have been applied ({ [updateId]: { at, by } }).
    unbilledRevenueMonths: {},
    dataUpdates: {},
    // Records deletions ({ [listKey]: { [id]: deletedAtISO } }) so that when two
    // people's edits get merged, a deleted item doesn't silently reappear just
    // because the other copy being merged in is older and still has it.
    tombstones: { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {}, transfers: {}, unbilledRevenue: {} },
    arAsOfDate: null, // "as of" date pulled from the most recent Aged AR import's report header
    apAsOfDate: null,
    // Manual inter-company transfers — { id, fromAccount, toAccount, amount, date, note, source:'manual', lastEditBy, updatedAt }.
    // Recurring transfers are set up on a Fixed Payment instead (transferFrom/transferTo fields).
    transfers: [],
    // Unbilled Revenue — a completely separate structure from unbilledReceivables,
    // organized into 6 fixed sections. Each line item can carry up to 3 invoices
    // (amount + invoice date + a CF date the user assigns), one per month of the
    // 13-week window. A CF date is what makes an invoice flow into Receivables
    // Collected on CF Forecast — until then it sits here unscheduled.
    // { id, section, name, invoices:[{amount,invoiceDate,cfDate}×3], lastEditBy, updatedAt, source }
    unbilledRevenue: [],
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

    basinSavingsDistributions: {}, // { [weekIndex]: { v, by, at } } — manual outflow, same override shape as everything else
    projectedAP: {}, // { [weekIndex]: { v, by, at } } — manual estimate for AP you don't have actual invoices for yet
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

// Interest for one of the 3 savings accounts — posts monthly on the
// configured day, computed as avgBalance * (annual rate / 12). Reuses the
// same monthly-occurrence engine Fixed Payments already use.
export function interestForAccount(state, period, accountId) {
  const perWeek = Array(WEEKS_PER_PERIOD).fill(0);
  const cfg = period.interest?.[accountId];
  if (!cfg || !cfg.rate || !cfg.avgBalance) return { perWeek, amount: 0 };
  const amount = Math.round(cfg.avgBalance * (cfg.rate / 12) * 100) / 100;
  if (!amount) return { perWeek, amount: 0 };
  const occurrences = fixedOccurrencesInPeriod({ scheduleType: "monthly", dayOfMonth: cfg.dayOfMonth || 1 }, period);
  for (const dateISO of occurrences) {
    const wi = weekIndexForDate(period, dateISO);
    if (wi !== null) perWeek[wi] += amount;
  }
  return { perWeek, amount };
}

// Week-end balances for the Home account panels: the most recent week that has
// ended, the one before it, and the week ahead. A week counts as ended once its
// last day has passed (todayStr is later than the week's end date). The forecast's
// opening cash is the balance at the end of the week *before* week 0, so it stands in
// when the period has only just begun and no forecast week has ended yet.
// `weeks` are computed forecast weeks ({ opening, closing, week:{start,end} }).
export function weekEndLadder(weeks, todayStr) {
  const none = { prior: null, last: null, ahead: null };
  if (!weeks || !weeks.length) return none;
  // endBalances[0] is the balance entering week 0; endBalances[k + 1] closes week k
  const endBalances = [
    { amount: weeks[0].opening, date: toISO(addDays(weeks[0].week.start, -1)) },
    ...weeks.map((w) => ({ amount: w.closing, date: w.week.end })),
  ];
  const at = (weekIdx) => endBalances[weekIdx + 1] || null; // weekIdx -1 = opening
  let lastWeekIdx = -1;
  weeks.forEach((w, i) => { if (w.week.end < todayStr) lastWeekIdx = i; });
  return { prior: at(lastWeekIdx - 1), last: at(lastWeekIdx), ahead: at(lastWeekIdx + 1) };
}

// Normalizes a (name, number) pair into a stable lookup key — trimmed,
// lowercased, so minor formatting differences between imports don't break
// the match.
function pwpKeyOf(a, b) {
  return `${(a || "").trim().toLowerCase()}::${(b || "").trim().toLowerCase()}`;
}

// Remembers (or forgets) which receivable a payable's Pay When Paid link
// points at, keyed by vendor+invoice# — not by id, since both sides get
// fresh random ids on every re-import. Call this whenever a payable's PWP
// link changes by hand, so the next Clear All + re-import can restore it.
export function recordPwpMemory(state, payable, receivable) {
  if (!payable.vendor || !payable.docNumber) return;
  state.pwpMemory = state.pwpMemory || {};
  const pKey = pwpKeyOf(payable.vendor, payable.docNumber);
  if (!receivable) { delete state.pwpMemory[pKey]; return; }
  const kind = payable.linkedReceivableKind === "unbilled" ? "unbilled" : "ar";
  const receivableNumber = kind === "unbilled" ? receivable.projectNumber : receivable.docNumber;
  state.pwpMemory[pKey] = { receivableKey: pwpKeyOf(receivable.customer, receivableNumber), kind };
}

// Re-applies remembered PWP links to any payable that doesn't already have
// one — called after importing either Aged AP or a receivables source, since
// whichever side completes the pair should trigger the match.
export function applyPwpMemory(state) {
  const memory = state.pwpMemory || {};
  if (!Object.keys(memory).length) return 0;
  let applied = 0;
  for (const p of state.payables) {
    if (p.status !== "open" || p.payWhenPaid) continue; // already set — a stored memory should never clobber a deliberate manual choice
    if (!p.vendor || !p.docNumber) continue;
    const mem = memory[pwpKeyOf(p.vendor, p.docNumber)];
    if (!mem) continue;
    const list = mem.kind === "unbilled" ? (state.unbilledReceivables || []) : state.receivables;
    const match = list.find((r) => {
      if (r.status !== "open") return false;
      const num = mem.kind === "unbilled" ? r.projectNumber : r.docNumber;
      return pwpKeyOf(r.customer, num) === mem.receivableKey;
    });
    if (match) {
      p.payWhenPaid = true;
      p.linkedReceivableId = match.id;
      p.linkedReceivableKind = mem.kind;
      applied++;
    }
  }
  return applied;
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
  for (const occ of unbilledRevenueOccurrencesInPeriod(state, period)) {
    scheduledReceivables[occ.wi] += occ.amount;
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
    const projectedAP = readOv(period.projectedAP?.[wi]) ?? 0; // manual estimate, for AP you don't have actual invoices for yet
    const interCompanyOut = -ic.outflowByWeek[wi];
    const totalOutflows = manualTotal + fixedTotal + apPayables + projectedAP + interCompanyOut;

    const netCashflow = totalInflows + totalOutflows;
    const locDraw = readOv(ov.locDraw?.[wi]) ?? 0;

    return {
      week: w,
      receivablesCollected, receivablesScheduled: scheduledReceivables[wi],
      otherInflows, interCompanyIn, interCompanyItems: ic.itemsByWeek[wi], totalInflows,
      manualOutflows, manualTotal,
      fixedRows, fixedTotal,
      apPayables, apScheduled: -scheduledPayables[wi], projectedAP,
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
    projectedAP: sum(rows.map((r) => r.projectedAP)),
    totalOutflows: sum(rows.map((r) => r.totalOutflows)),
    netCashflow: sum(rows.map((r) => r.netCashflow)),
    locDraw: sum(rows.map((r) => r.locDraw)),
    locBalance: rows[rows.length - 1]?.locBalance ?? (period.locOpeningBalance || 0),
    interCompanyIn: sum(rows.map((r) => r.interCompanyIn)),
    interCompanyOut: sum(rows.map((r) => r.interCompanyOut)),
  };

  return { weeks: rows, totals, fixedCategories };
}



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
  const isSavingsAccount = accountId === "basin-savings" || accountId === "eb-savings" || accountId === "pc-savings";
  const interest = isSavingsAccount ? interestForAccount(state, period, accountId) : null;

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

    if (accountId === "basin-savings") {
      outflows.push({ key: "basinSavingsDistributions", label: "Distributions", amount: readOv(period.basinSavingsDistributions?.[wi]) ?? 0, editable: true });
    }

    if (isSavingsAccount && interest.perWeek[wi]) {
      inflows.push({ key: "interestIncome", label: "Interest Income", amount: interest.perWeek[wi], editable: false });
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
  merged.unbilledRevenue = mergeById(local.unbilledRevenue || [], remote.unbilledRevenue || [], lt.unbilledRevenue, rt.unbilledRevenue);

  merged.tombstones = {
    receivables: mergeTombstones(lt.receivables, rt.receivables),
    payables: mergeTombstones(lt.payables, rt.payables),
    fixedPayments: mergeTombstones(lt.fixedPayments, rt.fixedPayments),
    unbilledReceivables: mergeTombstones(lt.unbilledReceivables, rt.unbilledReceivables),
    transfers: mergeTombstones(lt.transfers, rt.transfers),
    unbilledRevenue: mergeTombstones(lt.unbilledRevenue, rt.unbilledRevenue),
  };

  merged.customerAutoSchedule = { ...remote.customerAutoSchedule, ...local.customerAutoSchedule };
  merged.vendorAutoSchedule = { ...remote.vendorAutoSchedule, ...local.vendorAutoSchedule };
  merged.pwpMemory = { ...remote.pwpMemory, ...local.pwpMemory };
  merged.unbilledRevenueMonths = { ...remote.unbilledRevenueMonths, ...local.unbilledRevenueMonths };
  merged.dataUpdates = { ...remote.dataUpdates, ...local.dataUpdates };
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

  // whichever side just imported might complete a previously-recorded PWP
  // pairing whose other half is already sitting in state from an earlier import
  const pwpApplied = applyPwpMemory(state);

  return { added, updated, paidOff, pwpApplied };
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
