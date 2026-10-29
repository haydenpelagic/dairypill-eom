# DairyPill EOM Report — Rule Set

This file is the **source of truth** for how the end-of-month (EOM) workbook is built.
The script (`src/`) follows these rules exactly; every setting in `src/Config.gs` names the rule it implements.

**To change something,** tell Claude Code which rule to change, for example:
> "Change rule 5.4 so tags containing 'wholesale' go to a new Wholesale channel."
> "Change rule 9.3 so Amazon Sold/Used uses Customer Shipments from the ledger instead of the Business Report."

Claude Code should then update this file, `src/Config.gs` / `src/Logic.gs`, and the tests, and run `npm test`.

---

## 1. Folders and running

- **1.1** One parent folder ("DairyPill EOM") holds one subfolder per month, named exactly like `September 2026`.
- **1.2** `buildEOM()` builds **last calendar month** by default. `MONTH_OVERRIDE` in `Config.gs` (e.g. `'September 2026'`) forces a month.
- **1.3** The workbook `DAIRYPILL_EOM COGS - September 2026` is created in the month folder. If it already exists it is **rebuilt in place**: raw, helper and summary tabs are replaced; **manual tabs are never overwritten** (rule 7). Safe to run, fill in manual tabs, and run again.
- **1.4** Anything missing or ambiguous **stops the run** with a plain-English message naming the file and the problem. No silent defaults.

## 2. Recognizing files (by their columns, never by file name)

| Source | Recognized by these columns | Required |
|---|---|---|
| ADS stock snapshot (month end) | Stock Number, Lot Code, Qty On Hand | yes |
| Amazon Inventory Ledger (whole month, daily, Summary view) | Date, FNSKU, MSKU, Disposition, Receipts, Ending Warehouse Balance | yes |
| Amazon Business Report | (Child) ASIN, Units Ordered | yes |
| Shopify order export | Name, Lineitem quantity, Lineitem sku, Tags | yes |
| Manual Orders (CSV or Google Sheet) | CUSTOMER, ORDER, SKU, QUANTITY, DATE | yes (may have no rows) |
| ADS work orders (`ProductionLabor…xls`) | the page says "Production Detail Worksheet Report" | yes |

- **2.1** Two files of the same kind in the month folder stops the run.
- **2.2** **First run only:** last month's ADS snapshot and an Amazon ledger that ends on last month's final day go in a subfolder named `Starting Balances` inside the month folder.
- **2.3** After a successful build, raw files are renamed to match their tab names (e.g. `ADS Ending Balance 09.30.2026.csv`). Next month uses these names to find its starting balances.
- **2.4** An Excel (`.xlsx`) file in the month folder stops the run — save it as CSV or Google Sheet instead. Other unrecognized files are ignored and listed on Checks.

## 3. Tab names

Dates are written `MM.DD.YYYY` because Excel forbids "/" in tab names and limits names to 31 characters (accounting downloads the .xlsx).

| Group | Tabs (September 2026 example) | Tab color |
|---|---|---|
| Summaries | README, Checks, Variance Overview, Inventory Valuation, Outbound Summary | green |
| You type here | MFG Inventory 09.30.2026, ADS Receipts 09.30.2026, Prepaid, COGS | yellow |
| Starting balances | ADS Starting Balance 08.31.2026, AMZ Starting Balance 08.31.2026, MFG Starting Balance 08.31.2026 | gray (MFG yellow on first run) |
| Raw reports | ADS Ending Balance 09.30.2026, AMZ Inventory Ledger 09.30.2026, AMZ Business Report 09.30.2026, Shopify Orders 09.30.2026, Work Orders 09.30.2026, Manual Orders 09.30.2026 | gray |
| Reference | BOM, AMZ SKU Map, SKU List | blue |
| Helpers | Bundle Map, Kit Consumption | purple |

- **3.1** Old tabs no longer built: SAGE ×3, Sheet21, PO LOG, Replacements, DY_Stock_Snapshot, Kitting, BOM Translation (replaced by Kit Consumption and Bundle Map).

## 4. Starting balances (start of month = last month's end)

- **4.1 ADS Starting** = last month's ADS ending snapshot (`ADS Ending Balance <last month end>.csv` in last month's folder). It is also copied into this month's folder as `ADS Starting Balance <date>.csv`.
- **4.2 AMZ Starting** = the rows of last month's ledger (`AMZ Inventory Ledger <last month end>.csv`) that carry its **last date**, which must be last month's final day. The value used is *Ending Warehouse Balance*.
- **4.3 MFG Starting** = last month's MFG Inventory tab (MFG, SKU, EOM Qty), copied from last month's workbook.
- **4.4** First run (no last-month folder/workbook): ADS and Amazon come from the `Starting Balances` subfolder; MFG Starting is created empty for you to type (Checks flags it until you do).

## 5. Raw reports: what is kept and what is changed

- **5.1** Pasted exactly as received, except: (a) SKU, MSKU and ASIN columns are stored as **text** so `10030` always matches `10030` and `80090,80090` never turns into a number; (b) ledger dates become real dates; (c) quantity/money columns become numbers (commas, `$`, `%` removed) — the columns the formulas use **must** be numbers or the run stops; other columns keep odd values like "--" as text; (d) helper columns are added at the right (rules 5.2–5.4).
- **5.2 Amazon ledger** must contain **every day from the 1st to the last day** of the month, or the run stops (September's sample started 9/2). All dispositions count (SELLABLE, EXPIRED, DEFECTIVE, damaged). Added column `SKU (mapped)` = our SKU from AMZ SKU Map by MSKU.
- **5.3 Business Report:** units sold = `Units Ordered` (already includes B2B). Added column `SKU (mapped)` = our SKU from AMZ SKU Map by `(Child) ASIN`. The file has no dates inside, so Checks reminds you to confirm the date range.
- **5.4 Shopify channel.** Shopify fills Tags only on an order's **first** line, so an added `Order Tags` column copies the order's tags onto every line of that order. `Channel` is then a formula on Order Tags — **first match wins, not case-sensitive**:
  1. contains "influencer" → Marketing
  2. contains "replacement" → CX
  3. contains "free sample" → Marketing
  4. contains "tiktok" → TikTok
  5. otherwise → DTC

  The run stops if one order's lines are not next to each other in the file.
- **5.5 Work orders:** one row per kit line (Work Order, Date, SKU from the *Job* column, Pieces). "Setup Fee" lines are dropped; the *Description* text is ignored (it is sometimes wrong). The run stops if the line amounts don't add up to the report's TOTAL, or if the report is for a different month. Quantities only — labor dollars are not used.
- **5.6 Manual Orders:** as received. CUSTOMER = MANUAL means samples/marketing sends; CUSTOMER = AMAZON means ADS → FBA transfers.
- **5.7 Ops Hub `wo_log`:** the same kit lines (rule 5.5) are written to the `wo_log` tab of Ops Hub 2.0, one row per line: **Date** (col A), **Quantity** = Pieces (B), **SKU** = Job (C), **Cost** = the per-piece Rate (G). Setup fees are not written. Columns are found by their header in row 1. Nothing else on the tab is touched — Description, Channel and Month (D–F) are formulas there, and the rate table at the right stays put.
  - Rows dated in the report's month are **replaced** by the report's lines (oldest first), so running again never doubles them and corrections in a new report replace the old numbers. Rows for other months are never changed; if the month's row count changes, the rows dated after it move up or down with it.
  - The new rows go where that month's rows were; if there were none, before the first later-dated row, otherwise at the end.
  - The run stops **before anything changes** if the tab or a header is missing, a row has a quantity/SKU/cost but no readable date, or a kit line is dated outside the report's month. `wo_log` is written last, after the workbook is built. Checks shows which rows hold the month's lines. Turn it off with `WO_LOG.enabled: false` in Config.gs.

## 6. Reference tabs

- **6.1 BOM** is copied as values from Ops Hub 2.0, tab "BOM", columns E:I (Parent SKU, Parent Desc, Child SKU, Child Desc, Qty) on build day, so each month stays frozen. Rows where Parent = Child (the "FG" rows) and duplicate Parent/Child rows are removed; counts are noted on the tab and on Checks.
- **6.2 COGS** is carried from last month's workbook (first run: from the hand-built September workbook). If this month's workbook already has a COGS tab, yours is kept. Columns used: `Trim` (the SKU), `COGS / Unit`, `Freight / Unit`, `Tariffs / Unit`, `Total / Unit`. *To be replaced by the new COGS report.*
- **6.3 AMZ SKU Map** (Amazon MSKU | ASIN | Our SKU | Note) is carried forward. New MSKU/ASIN pairs seen in the ledgers are added automatically: remove " - TEMP SKU"; rename A80002 → A80004; otherwise our SKU = Amazon SKU. Additions are listed on Checks. You can correct any row by hand.
- **6.4 SKU List** = SKU → description from every BOM row (including the Parent = Child rows). Shopify bundle SKUs not in the BOM are described by their parts (e.g. "30ct Pouch + Bold Travel Tin"). SKUs with no description show "(no description)" and are flagged.

## 7. Tabs you type in (created once with headers, never overwritten)

- **7.1 MFG Inventory** — `MFG | SKU | Received Qty | EOM Qty`. Every MFG name (VitaQuest, VitaPros, or a new one) automatically gets its own block.
- **7.2 ADS Receipts** — `PO Number | SKU | Qty`.
- **7.3 Prepaid** — carried from last month; feeds nothing.

## 8. Helper tabs (rows written by the script, every number a formula)

- **8.1 Bundle Map** — one row per (Shopify sold SKU, component): the SKU text is split on commas and repeats counted (`80090,80090` → 80090 × 2; `10030` → 10030 × 1). Columns: Sold SKU | Component | Count | Units Sold (SUMIFS on Shopify, all channels) | Component Units = Count × Units.
- **8.2 Kit Consumption** — one row per (kit built this month, BOM child). Columns: Parent | Child | Qty per Kit (SUMIFS on BOM) | Kits Built (SUMIFS on Work Orders) | Child Units Used = Qty × Kits. Kits built that have no BOM rows are flagged.

## 9. Variance Overview

- **9.1** Blocks in this order: **ADS → Amazon → one block per MFG** (alphabetical). Each block = a gray header row, one row per SKU (A→Z), and a `Subtotal – <location>` row that adds the rows **between that block's header and its subtotal**.
- **9.2 Which SKUs get a row** (nothing is typed):
  - **ADS:** every SKU in ADS Starting, ADS Ending, ADS Receipts, Work Orders (kits built), Manual Orders, or Bundle Map components. Kit components only reduce SKUs already in this list — e.g. 70001/70003 inside a kit never create ADS rows.
  - **Amazon:** every *mapped* SKU in AMZ Starting, the AMZ ledger, or the Business Report with units > 0.
  - **Each MFG:** every SKU listed for that MFG on MFG Starting or MFG Inventory.
- **9.3 Columns** (each row in a block has the identical formula pattern, keyed on that row's SKU):

| Column | ADS | Amazon | MFG |
|---|---|---|---|
| Beginning | ADS Starting *Qty On Hand* | AMZ Starting *Ending Warehouse Balance* | MFG Starting *EOM Qty* |
| Receiving | ADS Receipts *Qty* + Work Orders *Pieces* (kits built) | Ledger *Receipts* (whole month) | MFG Inventory *Received Qty* |
| Sold / Used | Bundle Map component units (every Shopify channel incl. CX) + Manual Orders *QUANTITY* (MANUAL and AMAZON) + Kit Consumption child units | Business Report *Units Ordered* | **Calculated** = Beginning + Receiving − Actual |
| Expected Ending | Beginning + Receiving − Sold/Used | same | same |
| Actual Ending | ADS Ending *Qty On Hand* | Ledger *Ending Warehouse Balance* on the **last date** in the file | MFG Inventory *EOM Qty* |
| Delta | Actual − Expected | same | same (always 0) |
| Avg Cost / Unit | COGS *Total / Unit* | same | same |
| Expected $ / Actual $ / Delta $ | Expected × cost, Actual × cost, difference | same | same |

- **9.4 Categorization:** ADS and Amazon = "Ending Inventory"; MFG = "Raw Material - Component".

## 10. Inventory Valuation

- **10.1** Same blocks and rows as Variance Overview. Available Inventory = that row's *Actual Ending* on Variance Overview (matched by Location + SKU). COGS / Freight / Tariffs from COGS; Total Inventory Value = Available × (COGS + Freight + Tariffs).
- **10.2** The totals box is at the **top** and never moves: each categorization = SUMIFS on the Categorization column; TOTAL = their sum. No fixed row ranges.

## 11. Outbound Summary

- **11.1** One row per SKU sold: every Shopify SKU (bundles kept whole, e.g. `80090,80090`), every Manual Orders MANUAL SKU, every Amazon SKU with Business Report units. A TOTAL row adds the rows above it.
- **11.2** Columns: SKU | Avg Cost | then *Units* and *Total Cost* for DTC, Marketing, CX, TikTok, Amazon, All Channels. The channel names in row 3 drive the formulas. Marketing = Shopify Marketing + Manual Orders with CUSTOMER = MANUAL.

## 12. Checks tab

Each line shows **OK**, **FLAG** (needs attention), **CHECK** (confirm by eye) or **INFO**:

- **12.1** SKUs with no COGS cost (cells show "NO COST" and are left out of totals).
- **12.2** SKUs with no description.
- **12.3** Amazon rows with no SKU mapping; AMZ SKU Map entries added this run.
- **12.4** Shopify lines with no SKU (gift cards etc.; not counted anywhere).
- **12.5** Rows where Expected Ending Inventory is negative.
- **12.6** MFG Starting / MFG Inventory filled in; SKUs typed as numbers on the yellow tabs (they must be text to match).
- **12.7** Inventory Valuation total = sum of block subtotals.
- **12.8** Work orders parsed completely (lines = report TOTAL).
- **12.8a** Which `wo_log` rows hold this month's kit lines, and whether they changed (rule 5.7).
- **12.9** Where the starting balances came from; where the Shopify data came from; files ignored; build time.

## 13. Shopify Sell Thru file (replaces the old "DairyPill Monthly Sell Thru" script)

- **13.1** `shopifyOnly()` turns the Shopify CSV in the month folder into `DairyPill Sell Thru Sep 2026` in the same folder: an *Order Export* tab (with Order Tags and Channel, rule 5.4) and a *Channel Breakdown* tab (SKU × channel SUMIFS pointing at each row's SKU cell — no typed SKUs).
- **13.2** `buildEOM()` uses that file's Order Export if it is newer than the Shopify CSV; otherwise it rebuilds it first. Then it copies Order Export into the workbook as `Shopify Orders <date>`.

## 14. Formula style (applies everywhere)

- **14.1** Only Excel-safe functions: SUMIFS, SUMIF, COUNTIF(S), COUNT, COUNTA, INDEX/MATCH, IF, IFERROR, ISNUMBER, SEARCH, MAX, SUM, ABS. **Never** XLOOKUP, UNIQUE, FILTER, VSTACK, LET, ARRAYFORMULA, IMPORTRANGE, QUERY (they broke the .xlsx accounting downloads). The script refuses to write a formula that breaks this rule.
- **14.2** References to other tabs are whole columns (`'Tab'!H:H`), so source length never matters.
- **14.3** No typed SKUs, channels or locations inside summary formulas — they point at the row's SKU/location cell or a header cell.
- **14.4** Every block is header + rows + subtotal; totals never depend on fixed row numbers.
- **14.5** The README tab lists every tab, what it is and its rule number.
