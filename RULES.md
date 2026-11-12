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
- **1.5** Run it from the Apps Script editor (**buildEOM** / **shopifyOnly** / **writeOpsHub** → **Run**), signed in to an account that can open the EOM Reports folder. (Workspace Studio steps were tried and retired on 2026-11-10 — they can't run from the DairyPill account.)

## 2. Recognizing files (by their columns, never by file name)

| Source | Recognized by these columns | Required |
|---|---|---|
| ADS stock snapshot (month end) | Stock Number, Lot Code, Qty On Hand | yes |
| Amazon Inventory Ledger (whole month, daily, Summary view) | Date, FNSKU, MSKU, Disposition, Receipts, Ending Warehouse Balance | yes |
| Amazon Business Report | (Child) ASIN, Units Ordered | yes |
| Shopify order export | Name, Lineitem quantity, Lineitem sku, Tags | yes |
| ADS work orders (`ProductionLabor…xls`) | the page says "Production Detail Worksheet Report" | yes |

Shipments out of ADS that aren't Shopify orders are **not files**: they are read from the Ops Hub 2.0 logs (rule 5.6).

- **2.1** Two files of the same kind in the month folder stops the run.
- **2.2** **First run only:** last month's ADS snapshot goes in a subfolder named `Starting Balances` inside the month folder. Optionally, an Amazon ledger that ends on last month's final day can go there too — it is only used for the tie-out check (rule 4.2a).
- **2.2a** **First run only, shortcut:** last month's ADS snapshot may instead sit loose in the month folder next to this month's. Because the snapshots carry no date, the script compares both with the `ADS 930` tab of the first-run (hand-built September) workbook: the one that matches it exactly (every SKU, lot and Qty On Hand) is last month's ending and is renamed `ADS Starting Balance <last month end>.csv`; the other is this month's. If neither or both match, the run stops. Later months never need this — last month's renamed file is found automatically (rule 2.3).
- **2.3** After a successful build, raw files are renamed to match their tab names (e.g. `ADS Ending Balance 09.30.2026.csv`). Next month uses these names to find its starting balances. The name is matched with or without `.csv`, and a file saved as a Google Sheet under that name also works.
- **2.4** An Excel (`.xlsx`) file in the month folder stops the run — save it as CSV or Google Sheet instead. Other unrecognized files are ignored and listed on Checks.
- **2.5** A Manual Orders file (columns CUSTOMER, ORDER, SKU, QUANTITY, DATE) in the month folder **stops the run**. Those shipments now come from the Ops Hub logs (rule 5.6); two sources for the same shipments would double count.

## 3. Tab names

Dates are written `MM.DD.YYYY` because Excel forbids "/" in tab names and limits names to 31 characters (accounting downloads the .xlsx).

| Group | Tabs (September 2026 example) | Tab color |
|---|---|---|
| Summaries | README, Checks, Variance Overview, Inventory Valuation, Outbound Summary | green |
| You type here | MFG Counts 09.30.2026, ADS Receipts 09.30.2026, WO SKU Fixes, Prepaid, COGS | yellow |
| Starting balances | ADS Starting Balance 08.31.2026, AMZ Starting Balance 08.31.2026, MFG Starting Balance 08.31.2026 | gray |
| Raw reports | ADS Ending Balance 09.30.2026, AMZ Inventory Ledger 09.30.2026, AMZ Business Report 09.30.2026, Shopify Orders 09.30.2026, Work Orders 09.30.2026, Manual Order Log 09.30.2026, AMZ Log 09.30.2026 | gray |
| Reference | BOM, AMZ SKU Map, SKU List | blue |
| Helpers | Bundle Map, Kit Consumption | purple |

- **3.1** Old tabs no longer built: SAGE ×3, Sheet21, PO LOG, Replacements, DY_Stock_Snapshot, Kitting, BOM Translation (replaced by Kit Consumption and Bundle Map).

## 4. Starting balances (start of month = last month's end)

- **4.1 ADS Starting** = last month's ADS ending snapshot (`ADS Ending Balance <last month end>.csv` in last month's folder). It is also copied into this month's folder as `ADS Starting Balance <date>.csv`.
- **4.2 AMZ Starting** = the rows of **this month's** ledger dated the **1st of the month** (all warehouses, all dispositions). The value used is *Starting Warehouse Balance* **plus units travelling between Amazon warehouses** at the start of the 1st (the 1st's *In Transit Between Warehouses* + its *Warehouse Transfer In/Out*, because Amazon's In Transit figure is end-of-day). Those units are DairyPill's; leaving them out made October's Amazon Delta +704 instead of +3. Last month's ledger is not needed.
- **4.2a Tie-out (warning only):** if last month's ledger is found (`AMZ Inventory Ledger <last month end>.csv` in last month's folder, or on the first run a ledger in the `Starting Balances` subfolder), Checks compares, per Amazon SKU (our SKU after the AMZ SKU Map, e.g. `A0030 - TEMP SKU` shows as `A0030`), its *Ending Warehouse Balance + In Transit Between Warehouses* on last month's final day with this month's Amazon Beginning (rule 4.2). Any difference is a FLAG on Checks; the run never stops for it. If no last-month ledger is found, Checks says it was not compared.
- **4.3 MFG Starting** = last month's MFG Counts tab (MFG, SKU, EOM Qty), copied from last month's workbook. If last month's workbook exists but has no MFG Counts tab, the run stops.
- **4.4** First run (no last-month folder/workbook): ADS comes from the `Starting Balances` subfolder (or rule 2.2a); MFG Starting = the *Raw Material - Component* rows of the first-run (hand-built) workbook's Variance Overview (*Location*, *SKU*, *Actual Ending Inventory*) — nothing to type. Amazon needs nothing extra (rule 4.2).

## 5. Raw reports: what is kept and what is changed

- **5.1** Pasted exactly as received, except: (a) SKU, MSKU and ASIN columns are stored as **text** so `10030` always matches `10030` and `80090,80090` never turns into a number; (b) ledger dates become real dates; (c) quantity/money columns become numbers (commas, `$`, `%` removed) — the columns the formulas use **must** be numbers or the run stops; other columns keep odd values like "--" as text; (d) helper columns are added at the right (rules 5.2–5.4).
- **5.2 Amazon ledger** must contain **every day from the 1st to the last day** of the month, or the run stops (September's sample started 9/2). All dispositions count (SELLABLE, EXPIRED, DEFECTIVE, damaged). Added column `SKU (mapped)` = our SKU from AMZ SKU Map by MSKU.
- **5.3 Business Report:** still required, but **for reference only** — Amazon units sold come from the ledger (rule 9.3). `Units Ordered` (includes B2B) is compared with units shipped on Checks (rule 12.13). Added column `SKU (mapped)` = our SKU from AMZ SKU Map by `(Child) ASIN`. The file has no dates inside, so Checks reminds you to confirm the date range.
- **5.4 Shopify channel.** Shopify fills Tags only on an order's **first** line, so an added `Order Tags` column copies the order's tags onto every line of that order. `Channel` is then a formula on Order Tags — **first match wins, not case-sensitive**:
  1. contains "influencer" → Marketing
  2. contains "replacement" → CX
  3. contains "free sample" → Marketing
  4. contains "tiktok" → TikTok
  5. otherwise → DTC

  The run stops if one order's lines are not next to each other in the file.
- **5.4a Which Shopify lines count as sold.** *Financial Status* and *Cancelled at* are also only on an order's first line, so `Order Financial Status` and `Order Cancelled At` copy them down. A `Counted` column then decides, per line:
  1. order cancelled (*Cancelled at* filled in) → **not counted**
  2. line *Lineitem fulfillment status* = fulfilled → **counted** (the product left ADS, even if refunded afterwards)
  3. order *refunded* or *voided* (and the line was never fulfilled) → **not counted**
  4. everything else (paid, partially refunded, pending…) → counted

  `Counted Qty` = quantity if counted, else 0; every "units sold" formula (Bundle Map, Outbound Summary, Channel Breakdown) uses it. The export must include *Financial Status*, *Cancelled at* and *Lineitem fulfillment status* (Shopify's standard order export does), or the run stops.
- **5.5 Work orders:** one row per kit line (Work Order, Date, SKU, Pieces). "Setup Fee" lines are dropped. The run stops if the line amounts don't add up to the report's TOTAL, or if the report is for a different month. Quantities only — labor dollars are not used.
- **5.5a Which SKU a kit line is for.** ADS sometimes leaves *Job* blank or types words in it (October 2026: `AMAZON KIT A0030`, `NO GASSY DAYS STARTER KIT 10270`, and 7 blank lines = 1,870 kits). For each line, first match wins:
  1. *Job* is a single word → that is the SKU (as before; a SKU missing from the BOM is still flagged by rule 8.2).
  2. The line's text — *Job*, or the work order's *Description* when Job is blank — is on the **WO SKU Fixes** tab with a SKU → that SKU (capitals and extra spaces don't matter).
  3. Exactly **one** BOM kit SKU (a BOM *Parent SKU*) appears as a whole word in Job (else in Description) → that SKU. `AMAZON KIT A0030` → A0030. The text and SKU are added to WO SKU Fixes and listed on Checks as CHECK.
  4. Otherwise (no SKU word, a typo like `A-1080`, or two different SKUs) → **not counted**: no SKU, the text is added to WO SKU Fixes with the SKU blank, and Checks shows a FLAG with the lines and kit count. Type the SKU on WO SKU Fixes and run `buildEOM` again. Nothing is guessed from words like "STARTER KIT 30".

  **WO SKU Fixes** (`Reported as | Our SKU | Note`) is carried from last month like the AMZ SKU Map; rows you typed are kept and win over step 3. The Work Orders tab shows each line's *Job (as reported)* and *How the SKU was found*.
- **5.6 Ops Hub shipment logs** (replace the Manual Orders file). Fill these in Ops Hub 2.0 **before** running `buildEOM`; the script reads them directly.
  - `manualorder_log` — columns A:F `ADS Order Number | Channel | SKU | Quantity | Order Date | Ship Date`. Hand-entered shipments out of ADS (samples, marketing, replacements…). **Channel** must be DTC, Marketing, CX, TikTok or Samples (capitals don't matter). **Amazon stops the run**: units sent to Amazon belong in `amz_log`.
  - `amz_log` — columns A:F `ADS Order Number | Amazon Number | SKU | Quantity | Order Date | Ship Date`. **Units shipped out of ADS to Amazon.** They only reduce ADS (rule 9.3). They are not sales, and Amazon's side never uses them: what *arrived* at Amazon is the ledger's *Receipts*.
  - A row counts in the month of its **Ship Date** (the day the units left ADS). **Blank Ship Date = not shipped yet**: not counted, and Checks shows CHECK with the count. Rows from other months are ignored. Anything else odd stops the run: a Ship Date that isn't a date (e.g. "Shipped"), a Quantity that isn't a number, an unknown Channel, a missing SKU, or a SKU Google Sheets has turned into a number (`80030,51003` → `8003051003`). Format the SKU columns as **Plain text**. Order Date is copied as text and never used. Columns after F are ignored.
  - The month's rows are frozen into the workbook as `Manual Order Log <date>` and `AMZ Log <date>`, so the workbook stays self-contained.

## 6. Reference tabs

- **6.1 BOM** is copied as values from Ops Hub 2.0, tab "BOM", columns E:I (Parent SKU, Parent Desc, Child SKU, Child Desc, Qty) on build day, so each month stays frozen. Rows where Parent = Child (the "FG" rows) and duplicate Parent/Child rows are removed; counts are noted on the tab and on Checks.
- **6.2 COGS is typed by hand every month — never carried** from last month or the first-run workbook. When this month's workbook has no COGS tab, the script creates it: **`SKU | Description | Base Cost | Freight In | Tariff | Total / Unit`**, one row per SKU the summaries need (A→Z, with its description), **Base Cost / Freight In / Tariff blank**, and Total / Unit = a sum formula (blank until at least one cost is typed). Once it exists it is never overwritten — type the costs, and summaries update without a rerun. No `Trim` column: a SKU stored as a number (`10030`) still matches our text SKU (`"10030"`). A SKU whose Total / Unit is blank or missing shows **NO COST** (never $0) and is flagged on Checks (12.1). If a rerun needs a SKU that isn't on your COGS tab, Checks lists it — add a row.
- **6.3 AMZ SKU Map** (Amazon MSKU | ASIN | Our SKU | Note) is carried forward. New MSKU/ASIN pairs seen in the ledgers are added automatically: remove " - TEMP SKU"; rename A80002 → A80004; otherwise our SKU = Amazon SKU. Additions are listed on Checks. You can correct any row by hand.
- **6.4 SKU List** = SKU → description from every BOM row (including the Parent = Child rows). Shopify bundle SKUs not in the BOM are described by their parts (e.g. "30ct Pouch + Bold Travel Tin"). SKUs with no description show "(no description)" and are flagged.

## 7. Tabs you type in (created once with headers, never overwritten)

- **7.1 MFG Counts** — `MFG | SKU | EOM Qty | Received Qty` (Received optional, blank = 0). When the tab is created it already lists the MFG + SKU of every row with a non-zero starting balance (rule 4.3/4.4), quantities blank. Type the quantities, add new MFG/SKU rows at the bottom, and reorder rows freely — the MFG section of Variance Overview and Inventory Valuation follows this tab row by row (rule 9.5), with no rerun.
- **7.2 ADS Receipts** — `PO Number | SKU | Qty`.
- **7.3 Prepaid** — carried from last month; feeds nothing.

## 8. Helper tabs (rows written by the script, every number a formula)

- **8.1 Bundle Map** — one row per (Shopify sold SKU, component): the SKU text is split on commas and repeats counted (`80090,80090` → 80090 × 2; `10030` → 10030 × 1). Columns: Sold SKU | Component | Count | Units Sold (SUMIFS on Shopify, all channels) | Component Units = Count × Units.
- **8.1a Mailer rule.** Every unit sold on Shopify of `80030`, `80090`, `80090,80090` or `80090,80090,80090` (the exact Shopify SKU, every channel, counted lines only — rule 5.4a) uses **one 41001 Dairy Pill Mailer**. So does every unit sold of **any bundle SKU with a 30ct or 90ct pouch in it** (`80030,51002`, `50005,80030`, `80030,80030,51002`…) — one mailer per bundle unit, not per pouch (owner, 2026-11-10). Bundles with no pouch (`20001,20002` jar + lid) use no mailer. These show as extra Bundle Map rows (Sold SKU → 41001 × 1, *Why* = "Mailer rule"), so they flow into ADS 41001 Sold / Used. Other SKUs use no mailer here (kits' mailers are counted when the kit is built, rule 8.2). **Pouches shipped through `manualorder_log` (samples, marketing, replacements) do not use a mailer** — confirmed by the owner 2026-11-10 — so only Shopify sales count. The SKU list and mailer SKU are `MAILER_RULE` in `Config.gs`.
- **8.2 Kit Consumption** — one row per (kit built this month, BOM child). Columns: Parent | Child | Qty per Kit (SUMIFS on BOM) | Kits Built (SUMIFS on Work Orders) | Child Units Used = Qty × Kits. Kits built that have no BOM rows are flagged.

## 9. Variance Overview

- **9.1** One table, no sub-headings or subtotal rows: ADS rows (SKU A→Z), then Amazon rows, then the MFG rows (rule 9.5). The *Location* column says which is which. To the right of the table (row 4) a box shows **Total Variance ($)** = the sum of the whole *Delta $* column.
- **9.2 Which SKUs get a row** (nothing is typed):
  - **ADS:** every SKU in ADS Starting, ADS Ending, ADS Receipts, Work Orders (kits built), the two Ops Hub logs, or Bundle Map components. Kit components only reduce SKUs already in this list — e.g. 70001/70003 inside a kit never create ADS rows.
  - **Amazon:** every *mapped* SKU in AMZ Starting, the AMZ ledger, or the Business Report with units > 0.
  - **MFG:** not a SKU list — row by row from the MFG Counts tab (rule 9.5).
- **9.3 Columns** (each row in a block has the identical formula pattern, keyed on that row's SKU):

| Column | ADS | Amazon | MFG |
|---|---|---|---|
| Beginning | ADS Starting *Qty On Hand* | AMZ Starting *Starting Warehouse Balance* + units between Amazon warehouses (rule 4.2) | MFG Starting *EOM Qty* (matched by MFG + SKU) |
| Receiving | ADS Receipts *Qty* + Work Orders *Pieces* (kits built) | Ledger *Receipts* (whole month) | MFG Counts *Received Qty* |
| Sold / Used | Bundle Map component units (every Shopify channel incl. CX) + `manualorder_log` *Quantity* (every channel) + `amz_log` *Quantity* (shipped to Amazon) + Kit Consumption child units | Ledger *Customer Shipments* (whole month, shown positive) | **Calculated** = Beginning + Receiving − Actual |
| Expected Ending | Beginning + Receiving − Sold/Used | same | same |
| Actual Ending | ADS Ending *Qty On Hand* | Ledger *Ending Warehouse Balance* **+ In Transit Between Warehouses** on the **last date** in the file | MFG Counts *EOM Qty* |
| Delta | Actual − Expected | same | same (always 0) |
| Avg Cost / Unit | COGS *Total / Unit* | same | same |
| Expected $ / Actual $ / Delta $ | Expected × cost, Actual × cost, difference | same | same |

- **9.4 Categorization:** ADS and Amazon = "Ending Inventory"; MFG = "Raw Material - Component".
- **9.5 MFG section.** `MFG_ROWS` rows (50, more if MFG Counts already has more) where row *k* = row *k* of the MFG Counts tab: MFG and SKU are plain cell links (so reordering or adding rows on MFG Counts shows up immediately, in the same order), Beginning / Received / EOM are looked up as in 9.3, Sold / Used = Beginning + Received − EOM, so Delta is 0. Rows with no SKU stay blank. More rows on MFG Counts than the section holds is a FLAG on Checks (run `buildEOM` again and it makes room). The formulas are links, IF, SUM and SUMIFS only — no UNIQUE/FILTER/XLOOKUP, which break in older Excel.

## 10. Inventory Valuation

- **10.1** Same blocks and rows as Variance Overview. Available Inventory = that row's *Actual Ending* on Variance Overview (matched by Location + SKU; the MFG rows mirror Variance Overview's MFG rows one for one). COGS / Freight / Tariffs from COGS; Total Inventory Value = Available × (COGS + Freight + Tariffs).
- **10.2** One table, no sub-headings or subtotal rows (same order as Variance Overview). To the right of the table (from row 4) a totals box: one line per categorization (SUMIFS on the Categorization column — *Ending Inventory*, *Raw Material - Component*) and **TOTAL INVENTORY VALUE** = their sum. No fixed row ranges.

## 11. Outbound Summary

- **11.1** One row per SKU sold: every Shopify SKU (bundles kept whole, e.g. `80090,80090`), every `manualorder_log` SKU shipped in the month, every Amazon SKU with ledger Customer Shipments. Only counted Shopify lines (rule 5.4a). A TOTAL row adds the rows above it.
- **11.2** Columns: SKU | Description | Avg Cost | then *Units* and *Total Cost* for DTC, Marketing, CX, TikTok, Samples, Amazon, All Channels. The channel names in row 3 drive the formulas. Each channel = Shopify lines with that Channel (rule 5.4) + `manualorder_log` rows with that Channel shipped in the month. Shopify never produces Samples ("free sample" tags stay Marketing). Amazon = ledger *Customer Shipments*; `amz_log` units are not sales.
- **11.2a Bundle cost.** *Avg Cost / Unit* for a plain SKU is its COGS *Total / Unit*. For a bundle SKU (has a comma, e.g. `80030,51002`) it is the bundle's own COGS *Total / Unit* when that is a number above $0; otherwise the **sum of its parts**: the SKU is split on commas exactly like the Bundle Map (rule 8.1) and each part's COGS *Total / Unit* × its count is added (`80030,80030,51002` = 2 × 80030 + 51002). No Ops Hub BOM rows are needed for bundles. A $0 typed for a bundle is treated as "not costed" (a bundle never really costs $0). If any part has no cost, the cell shows **NO COST**. No extra mailer is added — a part's COGS cost already includes whatever it includes (e.g. 80030 on COGS). Bundles only ever appear on Outbound Summary, never on Variance Overview / Inventory Valuation, so this is the only place it applies. Checks 12.1 lists a bundle only when one of its parts is missing from COGS.
- **11.3** *Description* is looked up on this month's **COGS** tab (its Description column, SKU matched as text or as a number, INDEX/MATCH — no XLOOKUP, rule 9.5). Edit a description on COGS and Outbound Summary follows without a rerun. A SKU not on COGS, or with a blank description there, shows "(no description)".

## 12. Checks tab

Checks is the internal QC tab: every callout lives here. Nothing else in the workbook points at it, so **delete it before sending** the workbook out (it is rebuilt on the next run).

Each line shows **OK**, **FLAG** (needs attention), **CHECK** (confirm by eye) or **INFO**:

- **12.1** SKUs with no COGS cost (cells show "NO COST" and are left out of totals).
- **12.2** SKUs with no description.
- **12.3** Amazon rows with no SKU mapping; AMZ SKU Map entries added this run. An ASIN or MSKU whose AMZ SKU Map rows point at different SKUs is a FLAG (only the first matching row is used).
- **12.4** Shopify lines with no SKU (gift cards etc.; not counted anywhere).
- **12.5** Rows where Expected Ending Inventory is negative.
- **12.6** Where MFG starting balances came from (INFO); MFG Counts rows with a SKU but no EOM Qty (FLAG, updates live); MFG Counts longer than the MFG section (FLAG); SKUs typed as numbers on ADS Receipts (they must be text to match — MFG Counts SKUs are converted automatically).
- **12.7** Inventory Valuation TOTAL = sum of every row's Total Inventory Value (catches a row whose Categorization the totals box doesn't list).
- **12.8** Work orders parsed completely (lines = report TOTAL).
- **12.8a** Work-order lines with no usable SKU (FLAG, kits not counted) and SKUs not taken straight from Job (CHECK) — rule 5.5a.
- **12.9** Where the starting balances came from; where the Shopify data came from; files ignored; build time.
- **12.10** Amazon starting balance ties to last month's ending (rule 4.2a): OK, FLAG with the SKUs that differ, or INFO if last month's ledger wasn't found.
- **12.11** Shopify lines not counted (rule 5.4a): number of lines and units.
- **12.12** Ops Hub shipment logs (rule 5.6): rows counted this month per log, rows with no Ship Date (CHECK — not shipped, not counted), rows from other months.
- **12.13** **Amazon Delta explained.** A table below the checks, one row per Amazon SKU: Delta from Variance Overview, split into the ledger events that caused it — Customer Returns, Vendor Returns (removals), Found, Lost, Damaged, Disposed, Other Events, Unknown Events, and transfers not matched by the in-transit figures — then *Unexplained* (should be 0; any SKU that isn't is a FLAG). Also *Units Ordered* (Business Report) vs *Units Shipped* (ledger) per SKU, with totals as an INFO line.

## 13. Shopify Sell Thru file (replaces the old "DairyPill Monthly Sell Thru" script)

- **13.1** `shopifyOnly()` turns the Shopify CSV in the month folder into `DairyPill Sell Thru Sep 2026` in the same folder: an *Order Export* tab (with Order Tags and Channel, rule 5.4) and a *Channel Breakdown* tab (SKU × channel SUMIFS pointing at each row's SKU cell — no typed SKUs).
- **13.2** `buildEOM()` uses that file's Order Export if it is newer than the Shopify CSV; otherwise it rebuilds it first. Then it copies Order Export into the workbook as `Shopify Orders <date>`.

## 14. Formula style (applies everywhere)

- **14.1** Only Excel-safe functions: SUMIFS, SUMIF, COUNTIF(S), COUNT, COUNTA, INDEX/MATCH, IF, IFERROR, ISNUMBER, SEARCH, MAX, SUM, ABS. **Never** XLOOKUP, UNIQUE, FILTER, VSTACK, LET, ARRAYFORMULA, IMPORTRANGE, QUERY (they broke the .xlsx accounting downloads). The script refuses to write a formula that breaks this rule.
- **14.2** References to other tabs are whole columns (`'Tab'!H:H`), so source length never matters.
- **14.3** No typed SKUs, channels or locations inside summary formulas — they point at the row's SKU/location cell or a header cell.
- **14.4** Totals use whole columns or SUMIFS, never fixed row numbers.
- **14.5** The README tab lists every tab, what it is and its rule number.

## 15. Writing the month into Ops Hub 2.0 (`writeOpsHub`)

`buildEOM` never writes to the Ops Hub. When the month's workbook is finished and checked, run **`writeOpsHub`** (Apps Script editor → **Run**). It copies the month into four Ops Hub 2.0 tabs.

- **15.1 Source and safety.** Everything comes from **this month's workbook** as it calculates now (so MFG counts and WO SKU Fixes you typed are included): Variance Overview, Outbound Summary, Work Orders and SKU List. All inputs and all four tabs are read and checked **before anything is written**; any problem stops the run with a plain-English message and nothing changes. Running it again for the same month **replaces** that month's numbers — nothing is ever added twice. Columns are found by their header names; nothing else on the tabs is touched (other months, formulas, the wo_log rate table).
- **15.2 `inventory_eom`** — one row per **Location + SKU** (`Code | Location | SKU | months…`, headers in row 2, each month headed by its month-end date). The month's column = each Variance Overview row's **Actual Ending Inventory**, for every location: ADS, Amazon and each MFG (VitaQuest, VitaPros…).
  - If the month has no column yet, it is added right after the last month column, which must be **last month** (months stay in order — a missing month stops the run). The new column copies last month's column first, so the total formula in row 1 and the formats follow.
  - The row is found by Location + SKU (capitals don't matter; `10030` typed as a number still matches). Every existing row gets a number — **0** when the month has none for it.
  - A Location + SKU that isn't on the tab is **added at the bottom** (Code = Location + SKU), only when its number isn't 0. Older month cells on a new row stay blank.
- **15.3 `sell_thru monthly`** — one row per **Channel + SKU** (`Channel | Code | SKU | Description | months…`, headers in row 5). The month's column = **Units** per channel from Outbound Summary: DTC, Marketing, CX, TikTok, Samples and Amazon (All Channels is not written). Same column, matching, 0 and new-row rules as 15.2. On a new row, Code and Description copy the formulas of the row above (so Description is looked up on `sku_matrix` like every other row). SKUs match exactly: Amazon `50001` and `A50001` are different rows.
- **15.4 `wo_log`** — one row per kit line on the Work Orders tab (Pieces ≠ 0): **Date**, **Quantity** = Pieces, **SKU** (after WO SKU Fixes, rule 5.5a), **Cost** = the line's **Rate** from the ADS production report. Only those four columns are written; Month and Channel stay the tab's formulas (copied down from the row above if a written row has none).
  - The rows dated in the month are **replaced** by the month's kit lines, oldest first, where that month's rows were (else before the first later month, else at the end). Rows of other months are kept as they are.
  - A kit line with **no SKU**, no Rate, or a date outside the month stops the run (fix it, run `buildEOM` again, then `writeOpsHub`). A wo_log row with a Quantity/SKU/Cost but no Date also stops it.
- **15.5 `sku_matrix`** — every SKU that lands on one of the tabs above with a number other than 0 (or in a kit line) and isn't on `sku_matrix` is **added after its last SKU**: SKU (as text), Description (from the workbook's SKU List, blank if none) and **Status = NEEDS VERIFICATION**. Existing rows are never changed. This runs first, so new sell_thru rows find their description.
- **15.6** The Execution log lists what was done: which column was added or replaced, how many rows were filled, which rows and SKUs were added, and which wo_log rows hold the month.
