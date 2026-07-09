// Parses a NetSuite "A/R Aging Detail" or "A/P Aging Detail" export.
// Handles the Excel SpreadsheetML (.xml) format NetSuite produces, and a
// plain CSV fallback with the same column headers. The report is a grouped
// listing (Vendor/Customer header row, its transactions, a Total row) —
// we walk rows in order and attribute each transaction to the nearest
// preceding group-header row, so it works regardless of nesting depth.

function isoFromRaw(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // fallback: try Date parsing (e.g. "6/30/2026")
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function numFromRaw(raw) {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = parseFloat(String(raw).replace(/[$,()]/g, (c) => (c === "(" ? "-" : "")).replace(/[^0-9.\-]/g, ""));
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

export function parseAgingReport(text, kind /* 'AR' | 'AP' */) {
  const looksXml = /^\s*<\?xml/.test(text) || text.includes("<Workbook");
  const rows = looksXml ? parseXmlRows(text) : parseCsvRows(text);

  const groupKey = kind === "AR" ? "customer" : "vendor";

  // find the header row dynamically
  let headerIdx = -1, colMap = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((c) => c.trim().toLowerCase());
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

  const iGroup = colMap["vendor"] ?? colMap["customer"];
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
    if (!r.length) continue;
    const c0 = (r[0] || "").trim();
    const typeVal = (r[iType] || "").trim();

    if (!typeVal) {
      // possible group header row: only first cell populated, not a Total line
      const restBlank = r.every((v, idx) => idx === 0 || !String(v).trim());
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
      date: isoFromRaw(r[iDate]),
      docNumber: (r[iDoc] || "").trim(),
      ...(kind === "AR" ? { poNumber: (r[iPO] || "").trim() } : {}),
      dueDate: isoFromRaw(r[iDue]),
      age: iAge !== undefined ? Math.round(numFromRaw(r[iAge])) : null,
      balance: numFromRaw(r[iBal]),
    });
  }

  return records;
}
