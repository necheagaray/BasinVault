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
// Built against Basin's actual "Revenue Forecast Export" template:
//   Row 1: title. Row 2: "...4-Week Window: MM/DD/YYYY–MM/DD/YYYY · 8-Week
//   Window: MM/DD/YYYY–MM/DD/YYYY". Row 5: headers. Row 6+: one row per
//   project, with "Projected Revenue (4 Wk)" / "(8 Wk)" as the import columns.
// --------------------------------------------------------------------------

function parseWindowDates(text) {
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}\\s*Window:\\s*([\\d/]+)\\s*[–\\-]\\s*([\\d/]+)`, "i"));
    if (!m) return { start: null, end: null };
    const toISOFromMDY = (s) => {
      const [mm, dd, yyyy] = s.split("/");
      if (!mm || !dd || !yyyy) return null;
      return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    };
    return { start: toISOFromMDY(m[1]), end: toISOFromMDY(m[2]) };
  };
  return { fourWeek: grab("4-Week"), eightWeek: grab("8-Week") };
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const lower = (rows[i] || []).map((c) => cellStr(c).toLowerCase().trim());
    if (lower.includes("project #") && lower.includes("customer")) return i;
  }
  return -1;
}

function extractForecastFromRows(rows) {
  if (!rows.length) throw new Error("That file doesn't have any rows in it.");

  const infoText = rows.slice(0, 5).map((r) => cellStr(r[0])).join(" ");
  const windows = parseWindowDates(infoText);

  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) throw new Error("Couldn't find the header row (expected columns like 'Project #' and 'Customer'). Is this the Revenue Forecast Export template?");
  const header = rows[headerIdx].map((c) => cellStr(c).toLowerCase().trim());
  const col = (name) => header.indexOf(name);
  const iNum = col("project #"), iName = col("project name"), iCust = col("customer");
  const iRev4 = col("projected revenue (4 wk)"), iRev8 = col("projected revenue (8 wk)");
  if (iNum === -1 || iCust === -1 || (iRev4 === -1 && iRev8 === -1)) {
    throw new Error("Missing expected columns (Project #, Customer, Projected Revenue (4 Wk)/(8 Wk)). Is this the Revenue Forecast Export template?");
  }

  const projects = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const projectNumber = cellStr(r[iNum]);
    if (!projectNumber) continue;
    const rev4 = iRev4 !== -1 ? cellNum(r[iRev4]) : 0;
    const rev8 = iRev8 !== -1 ? cellNum(r[iRev8]) : 0;
    if (!rev4 && !rev8) continue; // nothing projected for this project in either window yet
    projects.push({
      projectNumber,
      project: cellStr(r[iName]),
      customer: cellStr(r[iCust]),
      rev4wk: rev4,
      rev8wk: rev8,
    });
  }

  return { windows, projects };
}

export function parseRevenueForecastWorkbook(arrayBuffer) {
  return extractForecastFromRows(parseXlsxRows(arrayBuffer));
}

export function parseRevenueForecastReport(text) {
  const looksXml = /^\s*<\?xml/.test(text) || text.includes("<Workbook");
  return extractForecastFromRows(looksXml ? parseXmlRows(text) : parseCsvRows(text));
}
