"""Builds the data block for the Unbilled AR update in public/js/state.js.

  sections  <- the Rolling Revenue Forecast PDF (Fixed Price, T&M, Frontlog, Small Quick Jobs), read by
               text POSITION, not reading order (the PDF's own text order scrambles the Frontlog columns)
  wip       <- the ending-October balance per project from the project master's WIP roll-forward

usage:  python3 gen_unbilled_update_data.py  <Rolling_Revenue_Forecast.pdf>  <2026ProjectMaster.xlsx>  [out.js]
needs:  pip install pdfplumber openpyxl
Paste the output between the UPDATE_DATA:START / UPDATE_DATA:END markers in public/js/state.js.
A reconciliation against the PDF's own printed totals is written to stderr.
"""
import sys, re, json, warnings
from decimal import Decimal, ROUND_HALF_UP
import pdfplumber, openpyxl
from openpyxl.utils import column_index_from_string as CI
warnings.filterwarnings("ignore")

PDF = sys.argv[1] if len(sys.argv) > 1 else "Rolling_Revenue_Forecast_Nov2026-Jan2027.pdf"
MASTER = sys.argv[2] if len(sys.argv) > 2 else "2026ProjectMaster.xlsx"
OUT = sys.argv[3] if len(sys.argv) > 3 else "unbilled_update_data_block.js"

# The PDF cuts long names off with "…". These are the full names, taken from the app's earlier data, the project master and the
# billing workbook. Each one is checked below: the text the PDF DOES show must be the literal start of the completion.
COMPLETIONS = {
    "26M-168 - Waskey Bridges, Inc. — WhiteWater Midstream Thrasher Met…":
        "26M-168 - Waskey Bridges, Inc. — WhiteWater Midstream Thrasher Meter Station",
    "24-002.154 Floor & Decor — Floor & Decor - N. Ok…":
        "24-002.154 Floor & Decor — Floor & Decor - N. Oklahoma City (Edmond), OK",
    "24-023.18 QTS — 6th Ave. SW & Edgewood Rd. S…":
        "24-023.18 QTS — 6th Ave. SW & Edgewood Rd. SW Intersection Imp, Cedar Rapids",
    "24-042 St. Tammany Parish — Tammany Trace Br…":
        "24-042 St. Tammany Parish — Tammany Trace Bridge #7",
    "25-040 Copeland and Johns — UPS New Orleans…":
        "25-040 Copeland and Johns — UPS New Orleans Expansion",
    "25-086.1 QTS — QTS-WTX1-CAMPUS, Hall Coun…":
        "25-086.1 QTS — QTS-WTX1-CAMPUS, Hall County, TX - Turkey, TX Civil Design",
    "25-086.2 QTS — QTS Turkey, TX - Phase 2 - Mas…":
        "25-086.2 QTS — QTS Turkey, TX - Phase 2 - Mass Grading",
    "25-105 Corgan — DAS114 (DC-5, DC-6, DC-7, an…":
        "25-105 Corgan — DAS114 (DC-5, DC-6, DC-7, and DC-8)",
    "26-009 Digital Engineering — Parish Line Pump St…":
        "26-009 Digital Engineering — Parish Line Pump Station Improvements Phase 2",
    "26-015 Waskey Bridges Inc. — ARM Mustang Met…":
        "26-015 Waskey Bridges Inc. — ARM Mustang Meter Station Platform",
    "26-017 QTS — QTS-DFW2 Marine - Mason Rd. Wi…":
        "26-017 QTS — QTS-DFW2 Marine - Mason Rd. Wilmer, TX",
    "26-018 Corgan — QTS-DFW2 Corner Site - Wilme…":
        "26-018 Corgan — QTS-DFW2 Corner Site - Wilmer, TX",
    "26-034 Rosehill Construction — Brookwood – High…":
        "26-034 Rosehill Construction — Brookwood – Highway 59 – St. Tammany",
    "26-038 Blue Whale Dev. — 7 Brew - 3209 Johnson…":
        "26-038 Blue Whale Dev. — 7 Brew - 3209 Johnson Street - Subwork",
    "26-039 Flavored Operations, LLC — 7 Brew - Sulp…":
        "26-039 Flavored Operations, LLC — 7 Brew - Sulphur, LA - 212 S. Cities",
    "26-047 SCNZ Architects, LLC — Renovation of 53…":
        "26-047 SCNZ Architects, LLC — Renovation of 5307 Toler - Laitram Harahan Campus",
    "26-047.1 SCNZ Architects, LLC — Renovation of 2…":
        "26-047.1 SCNZ Architects, LLC — Renovation of 220 Plantation - Laitram Harahan Campus",
    "26-060 Rosehill Construction — Brookwood - High…":
        "26-060 Rosehill Construction — Brookwood - Highway 44, Gonzales, LA",
    "26-068 Basic Systems, Inc. — Southern Star McNe…":
        "26-068 Basic Systems, Inc. — Southern Star McNew Compressor Station",
    "26-093 Corgan — SLC2 Campus Plan - DC1-DC2…":
        "26-093 Corgan — SLC2 Campus Plan - DC1-DC2 Civil Construction Drawings",
    "26-093.1 QTS — SLC1 Expansion, SLC2 Phase 1,…":
        "26-093.1 QTS — SLC1 Expansion, SLC2 Phase 1, and SLC Phase 2 Offsite Infrastructure Improvements",
    "26-095 Oracle — ABI01 – Entry Enhancement Civil…":
        "26-095 Oracle — ABI01 – Entry Enhancement Civil Design - Hrly up to $95K",
    "26-103 Laitram, LLC — Professional Civil Engineer…":
        "26-103 Laitram, LLC — Professional Civil Engineering and Land Surveying Services 5400 Jefferson Hwy",
    "26-116 Kohl's Department Stores, Inc. — Land Sur…":
        "26-116 Kohl's Department Stores, Inc. — Land Surveying services for the Seven Brew in Lafayette, LA.",
    "26-118 QTS — Pre Dev. DD-Additional 380 Acres-…":
        "26-118 QTS — Pre Dev. DD-Additional 380 Acres-Eagle Mountain",
    "26-119 QII — Due Diligence and Site Investigation…":
        "26-119 QII — Due Diligence and Site Investigation Approximate 2037 Acre Parcel Salco Road Church",
    "24-002.174 Floor & Decor — Floor & Decor - Tomb…":
        "24-002.174 Floor & Decor — Floor & Decor - Tomball, TX",
    "24-023.23 QTS — CDR1 Site Infrastructure – 76th…":
        "24-023.23 QTS — CDR1 Site Infrastructure – 76th Ave. Water Main Extension Cedar Rapids, IA",
    "26-124 QTS — QTS-SLC1 Day 2 Design and DC4/…":
        "26-124 QTS — QTS-SLC1 Day 2 Design and DC4/DC5 Revised Electric Routing Eagle Mountain, UT",
    "26-129 Woodward Design Group — Professional C…":
        "26-129 Woodward Design Group — Professional Civil Engineering Services Jefferson Highway and Maine Street",
    "26-130 Frischhertz — CPG Data Center Alexandria…":
        "26-130 Frischhertz — CPG Data Center Alexandria, LA",
}

MONEY = re.compile(r"^\$[\d,]+$|^–$")
PCT = re.compile(r"^\d+%$")
norm = lambda s: re.sub(r"\s+", " ", s.replace("–", "-").replace("—", "-")).strip().lower()
dollars = lambda t: 0 if t in (None, "–") else int(t.replace("$", "").replace(",", ""))

pdf = pdfplumber.open(PDF); page = pdf.pages[0]
W = page.extract_words(x_tolerance=1.5, y_tolerance=2)

def line_groups(ws):
    rows = {}
    for w in sorted(ws, key=lambda w: (w["top"], w["x0"])):
        k = next((k for k in rows if abs(k - w["top"]) < 2.2), w["top"]); rows.setdefault(k, []).append(w)
    return [(k, sorted(v, key=lambda w: w["x0"])) for k, v in sorted(rows.items())]
LINES = line_groups(W)
def text_of(ln): return " ".join(w["text"] for w in ln)
def find_line(pred, after=0):
    for top, ln in LINES:
        if top > after and pred(ln): return top, ln
    raise SystemExit("layout not recognised: " + pred.__doc__)

def edges_from_header(hdr, x_lo, x_hi, markers):
    """right edges of the 3 month columns = the x1 of the year words ('2026','2027') or month words in a header band"""
    ws = [w for w in hdr if x_lo <= w["x0"] < x_hi and w["text"] in markers]
    return {m: w["x1"] for m, w in zip(("nov", "dec", "jan"), sorted(ws, key=lambda w: w["x0"]))}

def classify(tokens, edges, tol=3.0, kinds=MONEY):
    name, cols = [], {}
    for w in tokens:
        hit = next((c for c, e in edges.items() if abs(w["x1"] - e) <= tol and kinds.match(w["text"])), None)
        if hit and hit not in cols: cols[hit] = w["text"]
        else: name.append(w)
    return name, cols

def money_rows(top_from, top_to, x_lo, x_hi, edges, expect=3):
    out = []
    for top, ln in LINES:
        if not (top_from < top < top_to): continue
        toks = [w for w in ln if x_lo <= w["x0"] < x_hi]
        nm, cols = classify(toks, edges)
        if nm and len(cols) == expect: out.append((" ".join(w["text"] for w in nm), cols))
    return out

def complete(name):
    if not name.endswith("…"): return name
    full = COMPLETIONS.get(name)
    if full is None: print(f"   note: still cut off in the PDF, kept as printed: {name}", file=sys.stderr); return name
    vis = name[:-1].rstrip()
    assert norm(full).startswith(norm(vis)), f"completion does not start with the printed text: {name!r} -> {full!r}"
    return full

# ---------------- Fixed price (two blocks side by side) ----------------
fp_hdr_top, fp_hdr = find_line(lambda l: any(w["text"] == "Project" and w["x0"] < 60 for w in l))
fp_total_top, fp_total = find_line(lambda l: text_of(l).startswith("Total — Fixed Price"), fp_hdr_top)
mid = next(w["x0"] for w in fp_hdr if w["text"] == "Project" and w["x0"] > 200) - 4
fixed = []
for x_lo, x_hi in ((0, mid), (mid, 612)):
    edges = edges_from_header(fp_hdr, x_lo, x_hi, {"2026", "2027"})
    for nm, cols in money_rows(fp_hdr_top, fp_total_top, x_lo, x_hi, edges):
        fixed.append((complete(nm), dollars(cols["nov"]), dollars(cols["dec"]), dollars(cols["jan"])))

# ---------------- T&M ----------------
tm_hdr_top, tm_hdr = find_line(lambda l: l[0]["text"] == "T&M" and len(l) > 1 and l[1]["text"] == "project")   # the table header, not the "T&M Projections" title
tm_total_top, tm_total = find_line(lambda l: text_of(l).startswith("Total — T&M"), tm_hdr_top)
tm_edges = edges_from_header([w for w in tm_hdr if w["x0"] < 380], 0, 380, {"2026", "2027"})
tm = []
for top, ln in LINES:
    if not (tm_hdr_top < top < tm_total_top): continue
    toks = [w for w in ln if w["x0"] < 380]
    nm, cols = classify(toks, tm_edges, tol=3.5)
    label = " ".join(w["text"] for w in nm)
    if label and len(cols) == 3: tm.append((label, dollars(cols["nov"]), dollars(cols["dec"]), dollars(cols["jan"])))
    elif label.startswith("26-130") and "Included in" in label:                       # a reference row: no amounts of its own
        tm.append(("26-130 Frischhertz — CPG Data Center (included in Fixed Price Revenue Backlog)", 0, 0, 0))

# ---------------- Small, quick jobs ----------------
sj_hdr_top, sj_hdr = find_line(lambda l: any(w["text"] == "Source" and w["x0"] > 300 for w in l))
sj_left = next(w["x0"] for w in sj_hdr if w["text"] == "Source") - 5          # this table's own left edge (the T&M header shares this row)
sj_edges = edges_from_header(sj_hdr, sj_left, 612, {"Nov", "Dec", "Jan"})
small = []
for top, ln in LINES:
    if sj_hdr_top < top < sj_hdr_top + 14:
        toks = [w for w in ln if w["x0"] > sj_left]
        nm, cols = classify(toks, sj_edges, tol=3.5)
        small.append((" ".join(w["text"] for w in nm), dollars(cols["nov"]), dollars(cols["dec"]), dollars(cols["jan"])))

# ---------------- Frontlog (weighted) ----------------
fl_hdr_top, fl_hdr = find_line(lambda l: l[0]["text"] == "File" and l[0]["x0"] < 40)
fl_total_top, fl_total = find_line(lambda l: text_of(l).startswith("Total — Frontlog"), fl_hdr_top)
col_x1 = lambda t: next(w["x1"] for w in fl_hdr if w["text"] == t)
client_x0 = next(w["x0"] for w in fl_hdr if w["text"] == "Client"); project_x0 = next(w["x0"] for w in fl_hdr if w["text"] == "Project")
pcts = sorted([w for w in fl_hdr if w["text"] == "%"], key=lambda w: w["x0"]); dols = sorted([w for w in fl_hdr if w["text"] == "$"], key=lambda w: w["x0"])
P_EDGE = {m: w["x1"] for m, w in zip(("nov", "dec", "jan"), pcts)}
D_EDGE = {m: w["x1"] for m, w in zip(("nov", "dec", "jan", "tot"), dols)}
PROB_X1, FEE_X1 = col_x1("Prob"), col_x1("Fee")
frontlog, fl_check = [], []
for top, ln in LINES:
    if not (fl_hdr_top < top < fl_total_top): continue
    near = lambda w, e: abs(w["x1"] - e) <= 3.5
    prob = next(w["text"] for w in ln if near(w, PROB_X1) and PCT.match(w["text"]))
    fee = next(w["text"] for w in ln if near(w, FEE_X1) and w["text"].startswith("$"))
    pct = {m: next((w["text"] for w in ln if near(w, e) and PCT.match(w["text"])), None) for m, e in P_EDGE.items()}
    amt = {m: next((w["text"] for w in ln if near(w, e) and MONEY.match(w["text"])), None) for m, e in D_EDGE.items()}
    file_no = ln[0]["text"]
    client = " ".join(w["text"] for w in ln if 90 <= w["x0"] < client_x0 + (project_x0 - client_x0) - 2)
    project = " ".join(w["text"] for w in ln if project_x0 - 2 <= w["x0"] < PROB_X1 - 20)
    full = f"{file_no} - {client} — {project}"
    frontlog.append((full, dollars(amt["nov"]), dollars(amt["dec"]), dollars(amt["jan"])))
    # does fee x % x probability reproduce each printed weighted amount? (catches a column read into the wrong month)
    for m in ("nov", "dec", "jan"):
        calc = dollars(fee) * (int(pct[m][:-1]) / 100 if pct[m] else 0) * int(prob[:-1]) / 100
        fl_check.append((file_no, m, calc, dollars(amt[m])))
frontlog = [(complete(n) if n.endswith("…") else n, a, b, c) for n, a, b, c in frontlog]

# ---------------- WIP: ending-October balance per project ----------------
cents = lambda v: Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
wm = openpyxl.load_workbook(MASTER, data_only=True)["WIP - Unbilled Rev"]
wip = []
for r in range(3, 27):
    num = wm.cell(r, CI("CB")).value
    if num is None: continue
    end = cents(wm.cell(r, CI("CH")).value)
    if end == 0: continue                                                           # no balance, nothing in WIP
    wip.append((str(num), f"{num} {str(wm.cell(r, CI('CC')).value or '').strip()} — {str(wm.cell(r, CI('CD')).value or '').strip()}", float(end)))

# ---------------- reconcile with the totals the PDF prints ----------------
def money_in(line): return [dollars(w["text"]) for w in line if MONEY.match(w["text"]) and w["text"] != "–"]
stated = {"fixed": money_in(fp_total), "tm": money_in(tm_total)}
sums = lambda rows: [sum(r[k] for r in rows) for k in (1, 2, 3)]
print("\nreconciliation (rows as printed  vs  the PDF's own printed totals):", file=sys.stderr)
for label, rows, st in (("fixed price", fixed, stated["fixed"]), ("T&M", tm, stated["tm"])):
    s = sums(rows); print(f"  {label:12} rows {s}   printed {st}   diff {[a-b for a, b in zip(s, st)]}", file=sys.stderr)
fl_printed = {m: dollars(next((w["text"] for w in fl_total if abs(w['x1'] - e) <= 3.5 and MONEY.match(w['text'])), '–')) for m, e in D_EDGE.items()}
s = sums(frontlog); print(f"  {'frontlog':12} rows {s}   printed {[fl_printed['nov'], fl_printed['dec'], fl_printed['jan']]}", file=sys.stderr)
bad = [(f, m, round(c), p) for f, m, c, p in fl_check if abs(c - p) > 1.01]
print(f"  frontlog fee x % x prob reproduces every printed monthly amount (+/-$1): {'YES' if not bad else 'NO ' + str(bad)}", file=sys.stderr)
print(f"  small jobs   {small}", file=sys.stderr)
print(f"  counts: fixed {len(fixed)} | T&M {len(tm)} | frontlog {len(frontlog)} | small {len(small)} | wip {len(wip)}", file=sys.stderr)

# ---------------- the JS block ----------------
q = lambda s: json.dumps(s, ensure_ascii=False)
def rows_js(rows): return "\n".join(f"      [{q(n)}, {a}, {b}, {c}]," for n, a, b, c in rows)
js = "  sections: {\n"
for sec, rows in (("fixedPriceBacklog", fixed), ("tm", tm), ("frontlog", frontlog), ("smallQuickJobs", small)):
    js += f"    {sec}: [\n{rows_js(rows)}\n    ],\n"
num = lambda n: (repr(float(n)).rstrip("0").rstrip(".") if "." in repr(float(n)) else repr(float(n)))   # 20000.0 -> 20000, as in the last update
js += "  },\n  wip: [\n" + "\n".join(f"    [{q(n)}, {q(nm)}, {num(a)}]," for n, nm, a in wip) + "\n  ],"
open(OUT, "w", encoding="utf-8").write(js)
