"""Generates the data block for the Nov-2026 Unbilled AR update straight from the two source workbooks.
Re-run with the new files to prepare a future month's update; paste the output between the
UPDATE_DATA:START / UPDATE_DATA:END markers in public/js/state.js. Needs: pip install openpyxl"""
import sys, json, warnings, openpyxl
from decimal import Decimal, ROUND_HALF_UP
from openpyxl.utils import column_index_from_string as CI
warnings.filterwarnings("ignore")

# usage: python3 gen_unbilled_update_data.py [billing_workbook.xlsx] [project_master.xlsx] [output.js]
BILLING = sys.argv[1] if len(sys.argv) > 1 else "PM_Billing_Forecasting_Workbook_Oct2026_Master_Updated_6.xlsx"
MASTER  = sys.argv[2] if len(sys.argv) > 2 else "2026ProjectMaster.xlsx"
OUT     = sys.argv[3] if len(sys.argv) > 3 else "unbilled_update_data_block.js"
cents = lambda v: Decimal(str(v or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

# ---- Fixed price rolling revenue forecast: Nov/Dec/Jan $ per PROJECT (summed over every line / sales order) ----
ws = openpyxl.load_workbook(BILLING, data_only=True)["Billing & Forecasting"]
order, agg, cur = [], {}, None
for r in range(16, ws.max_row + 1):
    a = ws.cell(r, CI("A")).value
    if a not in (None, ""): cur = str(a).strip().split("\n")[0].strip()      # first line only: the rest is WIP / contract notes
    if cur is None or "TOTALS" in cur: continue                              # the sheet's own totals row sits inside the data range
    if cur not in agg: agg[cur] = [Decimal(0)] * 3; order.append(cur)
    for k, col in enumerate(("W", "Y", "AA")):                               # cached $ (a PM typed $ over the formula on one line, so don't recompute from %)
        v = ws.cell(r, CI(col)).value
        if isinstance(v, (int, float)): agg[cur][k] += Decimal(str(v))
fixed = []
for name in order:
    amts = [cents(x) for x in agg[name]]
    if all(x == 0 for x in amts): continue                                   # projects with no Nov/Dec/Jan forecast aren't part of the section
    fixed.append((name.split()[0], name.replace(" : ", " — "), *[float(x) for x in amts]))

# ---- WIP: END OCT balance per project (roll-forward block CB:CH), zero balances left out ----
wm = openpyxl.load_workbook(MASTER, data_only=True)["WIP - Unbilled Rev"]
wip = []
for r in range(3, 27):
    num = wm.cell(r, CI("CB")).value
    if num is None: continue
    end = cents(wm.cell(r, CI("CH")).value)
    if end == 0: continue
    cust, nm = str(wm.cell(r, CI("CC")).value or "").strip(), str(wm.cell(r, CI("CD")).value or "").strip()
    wip.append((str(num), f"{num} {cust} — {nm}", float(end)))

def fmt(n): return repr(float(n)).rstrip("0").rstrip(".") if "." in repr(float(n)) else repr(float(n))
lines = ["  fixedPrice: ["]
lines += [f"    [{json.dumps(n, ensure_ascii=False)}, {json.dumps(nm, ensure_ascii=False)}, {fmt(a)}, {fmt(b)}, {fmt(c)}]," for n, nm, a, b, c in fixed]
lines += ["  ],", "  wip: ["]
lines += [f"    [{json.dumps(n, ensure_ascii=False)}, {json.dumps(nm, ensure_ascii=False)}, {fmt(v)}]," for n, nm, v in wip]
lines += ["  ],"]
js = "\n".join(lines)
if __name__ == "__main__":
    open(OUT, "w", encoding="utf-8").write(js)
    print(f"fixed price projects: {len(fixed)} | WIP projects: {len(wip)}")
    print("Nov/Dec/Jan totals:", [str(sum(cents(x[2+k]) for x in fixed)) for k in range(3)], "| WIP total:", sum(cents(x[2]) for x in wip))
