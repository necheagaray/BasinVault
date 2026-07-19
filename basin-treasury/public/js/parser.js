// Parses a NetSuite "A/R Aging Detail" or "A/P Aging Detail" export.
// Handles three formats NetSuite can produce: the Excel SpreadsheetML (.xml)
// export, a native .xlsx workbook (via SheetJS, loaded globally as `XLSX`),
// and a plain .csv with the same column headers. The report is a grouped
// listing (Vendor/Customer header row, its transactions, a Total row) —
// we walk rows in order and attribute each transaction to the nearest
// preceding group-header row, so it works regardless of nesting depth.

function cellStr(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function cellDateISO(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function cellNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[$,()]/g, (c) => (c === "(" ? "-" : "")).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

function parseXmlRows(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error("That file doesn't look like a valid NetSuite export (XML parse error).");
  const rowEls = Array.from(doc.getElementsByTagName("Row"));
  return rowEls.map((row) => {
    const cellEls = Array.from(row.children).filter((c) => c.tagName === "Cell");
    return cellEls.map((cell) => {
      const dataEl = Array.from(cell.children).find((c) => c.tagName === "Data");
      return dataEl ? dataEl.textContent.trim() : "";
    });
  });
}

function parseCsvRows(text) {
  // minimal CSV parser (handles quoted fields)
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseXlsxRows(arrayBuffer) {
  if (typeof XLSX === "undefined") {
    throw new Error("The spreadsheet reader didn't load — check your connection and try again.");
  }
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("That workbook doesn't have any sheets.");
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
}

function extractRecords(rows, kind /* 'AR' | 'AP' */) {
  const groupKey = kind === "AR" ? "customer" : "vendor";

  // find the header row dynamically
  let headerIdx = -1, colMap = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((c) => cellStr(c).toLowerCase());
    if ((r[0] === "vendor" || r[0] === "customer") && r[1] === "transaction type") {
      headerIdx = i;
      colMap = {};
      r.forEach((label, idx) => { if (label) colMap[label] = idx; });
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error("Couldn't find the header row (expected columns like Vendor/Customer, Transaction Type, Date…). Is this a NetSuite Aging Detail export?");
  }

  const iType = colMap["transaction type"];
  const iDate = colMap["date"];
  const iDoc = colMap["document number"];
  const iPO = colMap["p.o. no."] ?? colMap["po #"] ?? colMap["p.o. #"];
  const iDue = colMap["due date"];
  const iAge = colMap["age"];
  const iBal = colMap["open balance"];

  const records = [];
  let currentGroup = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const c0 = cellStr(r[0]);
    const typeVal = cellStr(r[iType]);

    if (!typeVal) {
      // possible group header row: only first cell populated, not a Total line
      const restBlank = r.every((v, idx) => idx === 0 || !cellStr(v));
      if (c0 && restBlank && !/^total\b/i.test(c0)) {
        currentGroup = c0;
      }
      continue; // not a transaction row
    }

    if (!currentGroup || /^total\b/i.test(c0)) continue;
    if (/^-\s*no (vendor|customer)\s*-$/i.test(currentGroup)) continue;

    records.push({
      [groupKey]: currentGroup,
      txnType: typeVal,
      date: cellDateISO(r[iDate]),
      docNumber: cellStr(r[iDoc]),
      ...(kind === "AR" ? { poNumber: cellStr(r[iPO]) } : {}),
      dueDate: cellDateISO(r[iDue]),
      age: iAge !== undefined ? Math.round(cellNum(r[iAge])) : null,
      balance: cellNum(r[iBal]),
    });
  }

  return records;
}

// text-based formats: NetSuite's SpreadsheetML .xml export, or a .csv with the same headers
export function parseAgingReport(text, kind) {
  const looksXml = /^\s*<\?xml/.test(text) || text.includes("<Workbook");
  const rows = looksXml ? parseXmlRows(text) : parseCsvRows(text);
  return extractRecords(rows, kind);
}

// native .xlsx workbook
export function parseAgingWorkbook(arrayBuffer, kind) {
  const rows = parseXlsxRows(arrayBuffer);
  return extractRecords(rows, kind);
}

// --------------------------------------------------------------------------
// Project revenue forecast → Unbilled Receivables
// There's no fixed NetSuite format for this (it's a custom report you'll
// provide), so instead of matching exact columns like the Aging reports do,
// this looks for the header row and does best-effort matching against common
// column-name variants. Once you share a real sample, this can be tightened
// to match it exactly the same way the Aging parser does.
// --------------------------------------------------------------------------

const HEADER_ALIASES = {
  project: ["project", "project name", "job", "job name", "job #", "project #", "customer:project"],
  description: ["description", "job description", "scope", "project description", "notes"],
  date: ["date", "invoice date", "forecast date", "billing date", "expected invoice date"],
  cfDate: ["cf date", "expected date", "collection date", "expected collection date", "pay date"],
  amount: ["amount", "revenue", "forecast amount", "projected revenue", "projected amount", "balance", "value"],
};

function findColumn(headerRow, aliases) {
  const lower = headerRow.map((h) => cellStr(h).toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  // loose fallback: any header that *contains* one of the alias words
  for (let i = 0; i < lower.length; i++) {
    if (aliases.some((a) => lower[i].includes(a))) return i;
  }
  return -1;
}

function extractUnbilledRecords(rows) {
  if (!rows.length) throw new Error("That file doesn't have any rows in it.");
  // find the first row that looks like a header (has a project-ish and amount-ish column)
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const iProject = findColumn(rows[i], HEADER_ALIASES.project);
    const iAmount = findColumn(rows[i], HEADER_ALIASES.amount);
    if (iProject !== -1 && iAmount !== -1) {
      headerIdx = i;
      cols = {
        project: iProject,
        description: findColumn(rows[i], HEADER_ALIASES.description),
        date: findColumn(rows[i], HEADER_ALIASES.date),
        cfDate: findColumn(rows[i], HEADER_ALIASES.cfDate),
        amount: iAmount,
      };
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error("Couldn't find a header row with a project/job column and an amount column. Check the file's column names.");
  }

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const project = cellStr(r[cols.project]);
    if (!project) continue;
    const amount = cellNum(r[cols.amount]);
    if (!amount) continue;
    records.push({
      project,
      description: cols.description !== -1 ? cellStr(r[cols.description]) : "",
      date: cols.date !== -1 ? cellDateISO(r[cols.date]) : null,
      cfDate: cols.cfDate !== -1 ? cellDateISO(r[cols.cfDate]) : null,
      amount,
    });
  }
  return records;
}

export function parseProjectForecastReport(text) {
  const looksXml = /^\s*<\?xml/.test(text) || text.includes("<Workbook");
  const rows = looksXml ? parseXmlRows(text) : parseCsvRows(text);
  return extractUnbilledRecords(rows);
}

export function parseProjectForecastWorkbook(arrayBuffer) {
  const rows = parseXlsxRows(arrayBuffer);
  return extractUnbilledRecords(rows);
}
