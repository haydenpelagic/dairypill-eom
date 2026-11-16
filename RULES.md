# DairyPill EOM Report — Rule Set

This file is the **source of truth** for how the month is written into Ops Hub 2.0 and how the end-of-month (EOM) report is built.
The script (`src/`) follows these rules exactly; every setting in `src/Config.gs` names the rule it implements.

**To change something,** tell Claude Code which rule to change, for example:
> "Change rule 5.4 so tags containing 'wholesale' go to a new Wholesale channel."
> "Change rule 9.3 so Amazon Sold/Used uses Customer Shipments from the ledger instead of the Business Report."

Claude Code should then update this file, `src/Config.gs` / `src/Logic.gs`, and the tests, and run `npm test`.

---

## 1. Folders and running

The month runs in **two steps, in this order** (owner, 2026-11-16 — the Ops Hub is the record; the report is made from it):

1. **Write month to Ops Hub** (`writeOpsHub`, rule 15): the month folder's reports → Ops Hub 2.0 (`inventory_eom`, `sell_thru monthly`, `wo_log`, `sku_matrix`).
2. **Generate EOM Report** (`generateEOMReport`): Ops Hub's numbers for the month + the reports → the EOM report in the month folder.

- **1.1** One parent folder ("DairyPill › EOM Reports") holds one subfolder per month, named exactly like `September 2026`.
- **1.2** Both steps are normally run from the **EOM** menu in Ops Hub 2.0 (rule 16), which asks for the month (blank = **last calendar month**). From the Apps Script editor they use `MONTH_OVERRIDE` in `Config.gs` (e.g. `'September 2026'`), or last month when it is blank.
- **1.3** The report `DAIRYPILL_EOM COGS - September 2026` is created in the month folder. If it already exists it is **rebuilt in place**: raw, Ops Hub, helper and summary tabs are replaced; **typed tabs are never overwritten** (rule 7). Tabs it doesn't make (e.g. the old layout's MFG Counts) are left alone and listed on Checks. Safe to run, fill in typed tabs, and run again.
- **1.4** Anything missing or ambiguous **stops the run** with a plain-English message naming the file and the problem. No silent defaults. Every file and Ops Hub tab is read and checked before anything is changed.
- **1.5** Whoever runs it needs edit access to the EOM Reports folder, Ops Hub 2.0, and the EOM Automation script (rule 16). (Workspace Studio steps were tried and retired on 2026-11-10 — they can't run from the DairyPill account.)
- **1.6** **Order matters.** Generate EOM Report stops if Ops Hub has no column for the month yet ("run Write month to Ops Hub first"). The report **locks** Ops Hub's numbers when it is generated: after changing Ops Hub (a manufacturer count, a correction), click Generate EOM Report again.

## 2. Recognizing files (by their columns, never by file name)

| Source | Recognized by these columns | Needed by |
|---|---|---|
| ADS stock snapshot (month end) | Stock Number, Lot Code, Qty On Hand | both steps |
| Amazon Inventory Ledger (whole month, daily, Summary view) | Date, FNSKU, MSKU, Disposition, Receipts, Ending Warehouse Balance | both steps |
| Amazon Business Report | (Child) ASIN, Units Ordered | the report (reference only) |
| Shopify order export | Name, Lineitem quantity, Lineitem sku, Tags | both steps |
| ADS work orders (`ProductionLabor…xls`) | the page says "Production Detail Worksheet Report" | both steps |

Shipments out of ADS that aren't Shopify orders are **not files**: they are read from the Ops Hub 2.0 logs (rule 5.6). Last month's numbers are **not files** either: they come from Ops Hub (rule 4).

- **2.1** Two files of the same kind in the month folder stops the run (keep only this month's).
- **2.2** *(Retired 2026-11-16: the "Starting Balances" subfolder and the first-run matching of last month's ADS snapshot. Starting balances come from Ops Hub, rule 4.)* Files named `ADS Starting Balance …` left by the old layout are ignored.
- **2.3** After a successful run, raw files are renamed to match their tab names (e.g. `ADS Ending Balance 09.30.2026.csv`), so the folder is tidy. A file saved as a Google Sheet works the same as a CSV.
- **2.4** An Excel (`.xlsx`) file in the month folder stops the run — save it as CSV or Google Sheet instead. Other unrecognized files are ignored and listed on Checks.
- **2.5** A Manual Orders file (columns CUSTOMER, ORDER, SKU, QUANTITY, DATE) in the month folder **stops the run**. Those shipments now come from the Ops Hub logs (rule 5.6); two sources for the same shipments would double count.

## 3. Tab names (the report)

Dates are written `MM.DD.YYYY` because Excel forbids "/" in tab names and limits names to 31 characters (accounting downloads the .xlsx).

| Group | Tabs (September 2026 example) | Tab color |
|---|---|---|
| Summaries | README, Checks, Variance Overview, Inventory Valuation, Outbound Summary | green |
| You type here | ADS Receipts 09.30.2026, MFG Receipts 09.30.2026, Prepaid, COGS | yellow |
| Locked copy of Ops Hub | Ops Hub Inventory 09.30.2026, Ops Hub Sell Thru 09.30.2026, Ops Hub WO Log 09.30.2026 | orange |
| Raw reports | ADS Ending Balance 09.30.2026, AMZ Starting Balance 08.31.2026, AMZ Inventory Ledger 09.30.2026, AMZ Business Report 09.30.2026, Shopify Orders 09.30.2026, Work Orders 09.30.2026, Manual Order Log 09.30.2026, AMZ Log 09.30.2026 | gray |
| Reference | BOM, AMZ SKU Map, SKU List | blue |
| Helpers | Bundle Map, Kit Consumption | purple |

- **3.1** Old tabs no longer built: SAGE ×3, Sheet21, PO LOG, Replacements, DY_Stock_Snapshot, Kitting, BOM Translation; and since 2026-11-16 MFG Counts, MFG Starting Balance, ADS Starting Balance and WO SKU Fixes (their data lives in Ops Hub now). A report from the old layout keeps them until you delete them; Checks lists them.

## 4. Starting balances (start of month = last month's end)

- **4.1 ADS and manufacturers:** Beginning = **last month's column of Ops Hub `inventory_eom`**, for the same Location + SKU (locked into the report's Ops Hub Inventory tab). Generate EOM Report stops if `inventory_eom` has no column for last month.
- **4.2 AMZ Starting** = the rows of **this month's** ledger dated the **1st of the month** (all warehouses, all dispositions). The value used is *Starting Warehouse Balance* **plus units travelling between Amazon warehouses** at the start of the 1st (the 1st's *In Transit Between Warehouses* + its *Warehouse Transfer In/Out*, because Amazon's In Transit figure is end-of-day). Those units are DairyPill's; leaving them out made October's Amazon Delta +704 instead of +3. This stays the ledger, not Ops Hub (owner, 2026-11-16): Ops Hub's hand-typed September Amazon column left out units in transit (A0180 0 vs 1,036).
- **4.2a Tie-out (warning only):** Checks compares, per Amazon SKU (our SKU, rule 6.3), the ledger's 1st-of-month figure (rule 4.2) with **last month's Amazon ending in Ops Hub `inventory_eom`**. Any difference is a FLAG on Checks; the run never stops for it.
- **4.3 / 4.4** *(Retired 2026-11-16: MFG Starting from last month's MFG Counts tab, and the first-run hand-built workbook. Rule 4.1 covers both.)*

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
  2. The line's text — *Job*, or the work order's *Description* when Job is blank — is on Ops Hub **`wo_sku_fixes`** with a SKU → that SKU (capitals and extra spaces don't matter).
  3. Exactly **one** BOM kit SKU (a BOM *Parent SKU*) appears as a whole word in Job (else in Description) → that SKU. `AMAZON KIT A0030` → A0030. The text and SKU are added to `wo_sku_fixes` and listed as CHECK (Write month to Ops Hub's summary and the report's Checks).
  4. Otherwise (no SKU word, a typo like `A-1080`, or two different SKUs) → **no SKU**: the text is added to `wo_sku_fixes` with the SKU blank and Write month to Ops Hub stops, naming the lines and kit count. Nothing is guessed from words like "STARTER KIT 30".

  The fixes live on the Ops Hub tab **`wo_sku_fixes`** (`Reported as | Our SKU | Note`, one list for every month; moved from the report on 2026-11-16 because Ops Hub is written first). Write month to Ops Hub creates it the first time, starting from the WO SKU Fixes tab of this month's or last month's old-layout report. Rows you typed are kept and win over step 3. In step 4 the line is added with Our SKU blank and **Write month to Ops Hub stops before writing the month** (that list is the only thing it writes): type the SKU, run it again. The report's Work Orders tab shows each line's *Job (as reported)* and *How the SKU was found*.
- **5.6 Ops Hub shipment logs** (replace the Manual Orders file). Fill these in Ops Hub 2.0 **before** running Write month to Ops Hub; both steps read them directly.
  - `manualorder_log` — columns A:F `ADS Order Number | Channel | SKU | Quantity | Order Date | Ship Date`. Hand-entered shipments out of ADS (samples, marketing, replacements…). **Channel** must be DTC, Marketing, CX, TikTok or Samples (capitals don't matter). **Amazon stops the run**: units sent to Amazon belong in `amz_log`.
  - `amz_log` — columns A:F, found **by name** under a summary row (headers in row 2 since 2026-11): `SKU | Quantity | ADS Order Number | Amazon Store Number | Order Date (Date Labels are Received) | Ship Date`. **Ship Date** (column F) was added 2026-11-13 (owner): the label date is not the day the units left ADS. Its SKUs are Amazon's, so they get the same renames as the ledger (rule 6.3: " - TEMP SKU" removed, A80002 → A80004 — owner, 2026-11-13) and reduce the right ADS row. **Units shipped out of ADS to Amazon.** They only reduce ADS (rule 9.3). They are not sales, and Amazon's side never uses them: what *arrived* at Amazon is the ledger's *Receipts*.
  - In both logs the header row may be any of the top 5 rows; spaces and line breaks inside a column name don't matter.
  - A row counts in the month of its **Ship Date** (the day the units left ADS). **Blank Ship Date = not shipped yet**: not counted, and Checks shows CHECK with the count. Rows from other months are ignored. Anything else odd stops the run: a Ship Date that isn't a date (e.g. "Shipped"), a Quantity that isn't a number, an unknown Channel, a missing SKU, or a SKU Google Sheets has turned into a number (`80030,51003` → `8003051003`). Format the SKU columns as **Plain text**. Order Date is copied as text and never used. Columns after F are ignored.
  - The month's rows are frozen into the workbook as `Manual Order Log <date>` and `AMZ Log <date>`, so the workbook stays self-contained.

## 6. Reference tabs

- **6.1 BOM** is copied as values from Ops Hub 2.0, tab "BOM", columns E:I (Parent SKU, Parent Desc, Child SKU, Child Desc, Qty) on build day, so each month stays frozen. Rows where Parent = Child (the "FG" rows) and duplicate Parent/Child rows are removed; counts are noted on the tab and on Checks. Column F, **Mailer added when shipped**, says **Yes** on the lines from a mailer-rule SKU (rule 8.1a: 80030, 80090, 80090,80090, 80090,80090,80090, pouch bundles) to the mailer — see rule 8.1b. The Ops Hub BOM itself is never changed: those lines are what the Ops Hub forecast uses to plan mailers.
- **6.2 COGS is typed by hand every month — never carried** from last month or the first-run workbook. When this month's workbook has no COGS tab, the script creates it: **`SKU | Description | Base Cost | Freight In | Tariff | Total / Unit`**, one row per SKU the summaries need (A→Z, with its description), **Base Cost / Freight In / Tariff blank**, and Total / Unit = a sum formula (blank until at least one cost is typed). Once it exists it is never overwritten — type the costs, and summaries update without a rerun. No `Trim` column: a SKU stored as a number (`10030`) still matches our text SKU (`"10030"`). A SKU whose Total / Unit is blank or missing shows **NO COST** (never $0) and is flagged on Checks (12.1). If a rerun needs a SKU that isn't on your COGS tab, Checks lists it — add a row.
- **6.3 Amazon SKU → our SKU, by rule only:** remove " - TEMP SKU"; rename A80002 → A80004; otherwise our SKU = Amazon SKU (`AMAZON_SKU_RULES` in `Config.gs`). Since 2026-11-16 nothing is carried or typed (every row of October's map had come from these rules): the report's **AMZ SKU Map** tab (Amazon MSKU | ASIN | Our SKU | How) is made fresh each run from the ledger's MSKU/ASIN pairs, for reference. To change a mapping, change the rule. The Business Report is matched to our SKU by ASIN through that map.
- **6.4 SKU List** = SKU → description from every BOM row (including the Parent = Child rows). Shopify bundle SKUs not in the BOM are described by their parts (e.g. "30ct Pouch + Bold Travel Tin"). SKUs with no description show "(no description)" and are flagged.

## 7. Tabs you type in the report (created once with headers, never overwritten)

Manufacturer month-end counts are **not** typed in the report: every on-hand number is in Ops Hub `inventory_eom` (owner, 2026-11-16, rule 15.2).

- **7.1** *(Retired 2026-11-16: the MFG Counts tab.)*
- **7.2 ADS Receipts** — `PO Number | SKU | Qty`.
- **7.2a MFG Receipts** — `MFG | SKU | Qty` received at a manufacturer this month (optional; blank = 0). It only splits a manufacturer's movement into Received and Used (rule 9.5); the count itself comes from Ops Hub. Updates the summaries as you type.
- **7.3 Prepaid** — carried from last month's report; feeds nothing.

## 8. Helper tabs (rows written by the script, every number a formula)

- **8.1 Bundle Map** — one row per (Shopify sold SKU, component): the SKU text is split on commas and repeats counted (`80090,80090` → 80090 × 2; `10030` → 10030 × 1). Columns: Sold SKU | Component | Count | Units Sold (SUMIFS on Shopify, all channels) | Component Units = Count × Units.
- **8.1a Mailer rule.** Every unit sold on Shopify of `80030`, `80090`, `80090,80090` or `80090,80090,80090` (the exact Shopify SKU, every channel, counted lines only — rule 5.4a) uses **one 41001 Dairy Pill Mailer**. So does every unit sold of **any bundle SKU with a 30ct or 90ct pouch in it** (`80030,51002`, `50005,80030`, `80030,80030,51002`…) — one mailer per bundle unit, not per pouch (owner, 2026-11-10). Bundles with no pouch (`20001,20002` jar + lid) use no mailer. These show as extra Bundle Map rows (Sold SKU → 41001 × 1, *Why* = "Mailer rule"), so they flow into ADS 41001 Sold / Used. Other SKUs use no mailer here (kits' mailers are counted when the kit is built, rule 8.2). **Pouches shipped through `manualorder_log` (samples, marketing, replacements) do not use a mailer** — confirmed by the owner 2026-11-10 — so only Shopify sales count. The SKU list and mailer SKU are `MAILER_RULE` in `Config.gs`. The mailer's **cost** follows rule 8.1b.
- **8.1b Mailer cost: out of on-hand cost, into outbound cost** (owner, 2026-11-13). The Ops Hub costs a pouch as sold on its own, so its COGS cost (pasted on the COGS tab) includes one mailer. A pouch on the ADS shelf has no mailer in it — the mailers sit loose at ADS and are valued on their own 41001 row — so counting it in the pouch too valued the same mailer twice (October 2026: (4,733 × 80030 + 11,178 × 80090) × $0.27 = $4,295.97).
  - **On-hand cost** (Variance Overview *Avg Cost / Unit*, Inventory Valuation *Total / Unit*, every location) = COGS *Total / Unit* − (qty on this SKU's BOM lines marked *Mailer added when shipped*, rule 6.1) × the mailer's COGS *Total / Unit*. Same formula on every row; it is 0 for any SKU without such a line (kits whose mailer is inside the kit — A0061, A0062, A80004 — keep it). If the Ops Hub ever drops the mailer line, nothing is taken out and the cost is used as typed.
  - **Outbound cost** of a mailer-rule SKU (rule 11.2a) = on-hand cost + **one** mailer: what one Shopify unit costs as shipped. That mailer is charged on **Shopify units only**: `manualorder_log` units and Amazon units of the same SKU are costed at on-hand cost.
  - A bundle cost typed on COGS with no BOM mailer line is taken as having no mailer in it (one is added on Outbound) and is listed on Checks as CHECK.
  - The mailer's own COGS cost must be filled in: a pouch with a mailer line shows NO COST until it is.
  - Owner's estimate (2026-11-13): ADS does not take a mailer off its 41001 count when it ships a Shopify order — only kit work orders reduce it — so the 41001 row's Delta ≈ the mailer-rule units (October: +4,201). The ADS count is still what Actual Ending uses (rule 9.3).
- **8.2 Kit Consumption** — one row per (kit built this month, BOM child). Kits built = the month's rows of Ops Hub `wo_log` (locked into the Ops Hub WO Log tab). Columns: Parent | Child | Qty per Kit (SUMIFS on BOM) | Kits Built (SUMIFS on Ops Hub WO Log) | Child Units Used = Qty × Kits. Kits built that have no BOM rows are flagged.

## 9. Variance Overview

- **9.1** One table, no sub-headings or subtotal rows: ADS rows (SKU A→Z), then Amazon rows, then the manufacturer rows (rule 9.5). The *Location* column says which is which. To the right of the table (row 4) a box shows **Total Variance ($)** = the sum of the whole *Delta $* column.
- **9.2 Which SKUs get a row** (nothing is typed):
  - **ADS:** every SKU with a number other than 0 in last month's or this month's ADS column of Ops Hub `inventory_eom`, or in the ADS snapshot, ADS Receipts, kits built (Ops Hub `wo_log`), the two Ops Hub logs, or Bundle Map components. Kit components only reduce SKUs already in this list — e.g. 70001/70003 inside a kit never create ADS rows.
  - **Amazon:** every SKU (rule 6.3) in this month's ledger, the Business Report with units > 0, or Ops Hub's Amazon rows with a number other than 0 last month or this month.
  - **Manufacturers:** rule 9.5.
- **9.3 Columns** (each row in a block has the identical formula pattern, keyed on that row's Location + SKU). "Ops Hub" = the report's locked copy (Ops Hub Inventory / Ops Hub WO Log tabs):

| Column | ADS | Amazon | Manufacturer |
|---|---|---|---|
| Beginning | Ops Hub `inventory_eom`, last month's column | AMZ Starting *Starting Warehouse Balance* + units between Amazon warehouses (rule 4.2) | Ops Hub `inventory_eom`, last month's column |
| Receiving | ADS Receipts *Qty* + kits built (Ops Hub `wo_log` *Quantity*) | Ledger *Receipts* (whole month) | MFG Receipts *Qty* |
| Sold / Used | Bundle Map component units (every Shopify channel incl. CX) + `manualorder_log` *Quantity* (every channel) + `amz_log` *Quantity* (shipped to Amazon) + Kit Consumption child units | Ledger *Customer Shipments* (whole month, shown positive) | **Calculated** = Beginning + Receiving − Actual |
| Expected Ending | Beginning + Receiving − Sold/Used | same | same |
| Actual Ending | Ops Hub `inventory_eom`, this month's column (= the ADS snapshot's *Qty On Hand*, rule 15.2) | Ops Hub `inventory_eom`, this month's column (= ledger *Ending Warehouse Balance* **+ In Transit Between Warehouses** on the last date, rule 15.2) | Ops Hub `inventory_eom`, this month's column (typed by hand) |
| Delta | Actual − Expected | same | same (always 0) |
| Avg Cost / Unit | On-hand cost: COGS *Total / Unit* − the mailer added when shipped (rule 8.1b; 0 for most SKUs) | same | same |
| Expected $ / Actual $ / Delta $ | Expected × cost, Actual × cost, difference | same | same |

- **9.4 Categorization:** ADS and Amazon = "Ending Inventory"; manufacturers = "Raw Material - Component".
- **9.5 Manufacturer rows.** Every Location in Ops Hub `inventory_eom` other than ADS and Amazon is a manufacturer (VitaQuest, VitaPros…). One row per manufacturer + SKU with a number other than 0 in last month's or this month's column, in Ops Hub's order, then any MFG Receipts row not among them. **A count left blank in Ops Hub for this month stays blank on the report** — Sold / Used, Expected, Actual, Delta and the dollars are blank (never 0), the row is valued at nothing on Inventory Valuation, and Checks shows a FLAG naming it (owner, 2026-11-16). Type the count in Ops Hub and click Generate EOM Report again. Formulas are SUMIFS, IF, SUM only — no UNIQUE/FILTER/XLOOKUP, which break in older Excel.

## 10. Inventory Valuation

- **10.1** Same rows as Variance Overview. Available Inventory = that row's *Actual Ending* on Variance Overview (matched by Location + SKU; blank for a manufacturer row with no count, rule 9.5). Base Cost / Freight In / Tariff from COGS; **Less: Mailer (added when shipped)** = the mailer taken out of the cost (rule 8.1b, $0 for most SKUs); **Total / Unit** = on-hand cost (Base + Freight + Tariff − Mailer); Total Inventory Value = Available × Total / Unit.
- **10.2** One table, no sub-headings or subtotal rows (same order as Variance Overview). To the right of the table (from row 4) a totals box: one line per categorization (SUMIFS on the Categorization column — *Ending Inventory*, *Raw Material - Component*) and **TOTAL INVENTORY VALUE** = their sum. No fixed row ranges.

## 11. Outbound Summary

- **11.1** One row per SKU with units this month in Ops Hub `sell_thru monthly` (bundles kept whole, e.g. `80090,80090`). A TOTAL row adds the rows above it.
- **11.2** Columns: SKU | Description | Avg Cost | then *Units* and *Total Cost* for DTC, Marketing, CX, TikTok, Samples, Amazon, All Channels. The channel names in row 3 drive the formulas. **Units = Ops Hub `sell_thru monthly`** for that Channel + SKU (locked into the Ops Hub Sell Thru tab). Write month to Ops Hub put there: Shopify lines with that Channel (rules 5.4 / 5.4a, counted lines only) + `manualorder_log` rows with that Channel shipped in the month; Amazon = ledger *Customer Shipments* (rule 15.3). Shopify never produces Samples ("free sample" tags stay Marketing); `amz_log` units are not sales.
- **11.2a Bundle cost.** *Avg Cost / Unit* for a plain SKU is its COGS *Total / Unit*. For a bundle SKU (has a comma, e.g. `80030,51002`) it is the bundle's own COGS *Total / Unit* when that is a number above $0; otherwise the **sum of its parts**: the SKU is split on commas exactly like the Bundle Map (rule 8.1) and each part's COGS *Total / Unit* × its count is added (`80030,80030,51002` = 2 × 80030 + 51002). No Ops Hub BOM rows are needed for bundles. A $0 typed for a bundle is treated as "not costed" (a bundle never really costs $0). If any part has no cost, the cell shows **NO COST**. **Mailer (rule 8.1b):** for a SKU that ships in a mailer on Shopify (rule 8.1a — the pouches and every pouch bundle), the own cost and each part are taken at **on-hand cost** (mailer out) and **one** mailer is added per unit, so `80030,80030,51002` = 2 × 80030 on-hand + 51002 + one mailer (it used to count two). A pouch sold alone comes out at its full COGS cost (on-hand + mailer). Per channel, Total Cost = Units × Avg Cost, less the mailer on `manualorder_log` units; Amazon units are costed without it. Bundles only ever appear on Outbound Summary, never on Variance Overview / Inventory Valuation, so this is the only place it applies. Checks 12.1 lists a bundle only when one of its parts is missing from COGS.
- **11.3** *Description* is looked up on this month's **COGS** tab (its Description column, SKU matched as text or as a number, INDEX/MATCH — no XLOOKUP, rule 9.5). Edit a description on COGS and Outbound Summary follows without a rerun. A SKU not on COGS, or with a blank description there, shows "(no description)".

## 12. Checks tab

Checks is the internal QC tab: every callout lives here. Nothing else in the workbook points at it, so **delete it before sending** the workbook out (it is rebuilt on the next run).

Each line shows **OK**, **FLAG** (needs attention), **CHECK** (confirm by eye) or **INFO**:

- **12.1** SKUs with no COGS cost (cells show "NO COST" and are left out of totals).
- **12.2** SKUs with no description.
- **12.3** Business Report rows with sales whose ASIN isn't in this month's ledger (CHECK — reference only). An ASIN whose MSKUs map to different SKUs is a FLAG (the Business Report uses the first).
- **12.4** Shopify lines with no SKU (gift cards etc.; not counted anywhere).
- **12.5** Rows where Expected Ending Inventory is negative.
- **12.6** Manufacturer rows with no count this month in Ops Hub (FLAG, rule 9.5); manufacturer rows with negative Sold / Used (CHECK — usually a missing MFG Receipts row; updates live); SKUs typed as numbers on ADS Receipts or MFG Receipts (they must be text to match).
- **12.7** Inventory Valuation TOTAL = sum of every row's Total Inventory Value (catches a row whose Categorization the totals box doesn't list).
- **12.7a** Inventory Valuation TOTAL = Variance Overview *Total Actual Cost* (whole column). Both tabs have the same rows at the same on-hand cost, so a difference means a row was copied, deleted or typed over by hand on one of them (October 2026 had ADS A80004 twice on Inventory Valuation: +$592).
- **12.7b** Mailer (rule 8.1b): INFO with the number of mailers on Shopify orders and, in the details, every BOM line whose mailer is taken out of on-hand cost; CHECK when a mailer-rule SKU has a typed COGS cost but no BOM mailer line.
- **12.8** Work orders parsed completely (lines = report TOTAL).
- **12.8a** Work-order lines with no usable SKU (FLAG, kits not counted) and SKUs not taken straight from Job (CHECK) — rule 5.5a.
- **12.9** Which Ops Hub numbers were locked into the report and when; where the Shopify data came from; files ignored; tabs this version doesn't make (rule 3.1); build time.
- **12.10** Amazon starting balance (ledger) ties to Ops Hub's last-month Amazon ending (rule 4.2a): OK, or FLAG with the SKUs that differ.
- **12.11** Shopify lines not counted (rule 5.4a): number of lines and units.
- **12.12** Ops Hub shipment logs (rule 5.6): rows counted this month per log, rows with no Ship Date (CHECK — not shipped, not counted), rows from other months.
- **12.13** **Amazon Delta explained.** A table below the checks, one row per Amazon SKU: Delta from Variance Overview, split into the ledger events that caused it — Customer Returns, Vendor Returns (removals), Found, Lost, Damaged, Disposed, Other Events, Unknown Events, and transfers not matched by the in-transit figures — then *Unexplained* (should be 0; any SKU that isn't is a FLAG). Also *Units Ordered* (Business Report) vs *Units Shipped* (ledger) per SKU, with totals as an INFO line.
- **12.14 Ops Hub vs the raw reports** (FLAG only, never stops). The locked Ops Hub numbers compared with this folder's reports, worked out exactly as Write month to Ops Hub does (rule 15): ADS and Amazon ending inventory (ADS snapshot, Amazon ledger), units sold per Channel + SKU (Shopify, `manualorder_log`, Amazon ledger), kits built per SKU (work-order report). A difference means Ops Hub was changed after it was written, or Write month to Ops Hub wasn't run again after a file changed. The report uses the Ops Hub number; the FLAG lists each SKU with both numbers.

## 13. Shopify Sell Thru file (replaces the old "DairyPill Monthly Sell Thru" script)

- **13.1** `shopifyOnly()` turns the Shopify CSV in the month folder into `DairyPill Sell Thru Sep 2026` in the same folder: an *Order Export* tab (with Order Tags and Channel, rule 5.4) and a *Channel Breakdown* tab (SKU × channel SUMIFS pointing at each row's SKU cell — no typed SKUs).
- **13.2** Generate EOM Report uses that file's Order Export if it is newer than the Shopify CSV; otherwise it rebuilds it first. Then it copies Order Export into the workbook as `Shopify Orders <date>`.

## 14. Formula style (applies everywhere)

- **14.1** Only Excel-safe functions: SUMIFS, SUMIF, COUNTIF(S), COUNT, COUNTA, INDEX/MATCH, IF, IFERROR, ISNUMBER, SEARCH, MAX, SUM, ABS. **Never** XLOOKUP, UNIQUE, FILTER, VSTACK, LET, ARRAYFORMULA, IMPORTRANGE, QUERY (they broke the .xlsx accounting downloads). The script refuses to write a formula that breaks this rule.
- **14.2** References to other tabs are whole columns (`'Tab'!H:H`), so source length never matters.
- **14.3** No typed SKUs, channels or locations inside summary formulas — they point at the row's SKU/location cell or a header cell.
- **14.4** Totals use whole columns or SUMIFS, never fixed row numbers.
- **14.5** The README tab lists every tab, what it is and its rule number.

## 15. Step 1 — Write month to Ops Hub (`writeOpsHub`)

Run first, as soon as the month's reports are in the month folder (EOM menu → **1. Write month to Ops Hub**). It reads the reports directly — no report is needed — and writes the month into four Ops Hub 2.0 tabs. Generate EOM Report only ever **reads** Ops Hub.

- **15.1 Source and safety.** The month folder's ADS snapshot, Amazon ledger, Shopify export and work-order report (rule 2), plus the Ops Hub logs (rule 5.6), BOM (rule 6.1) and `wo_sku_fixes` (rule 5.5a). All files and all four tabs are read and checked **before anything is written**; any problem stops the run with a plain-English message and nothing changes (the one exception: rule 5.5a step 4 adds lines to `wo_sku_fixes`). Running it again for the same month **replaces** that month's numbers — nothing is ever added twice. Columns are found by their header names; nothing else on the tabs is touched (other months, formulas, the wo_log rate table). The numbers are the same ones the report's formulas would give (proved by the tests, and checked on every report by rule 12.14).
- **15.2 `inventory_eom`** — one row per **Location + SKU** (`Code | Location | SKU | months…`, headers in row 2, each month headed by its month-end date). The script fills only the **ADS** and **Amazon** rows of the month's column:
  - ADS = the snapshot's *Qty On Hand*, added up per SKU (all lots).
  - Amazon = ledger *Ending Warehouse Balance* + *In Transit Between Warehouses* on the ledger's last date, per our SKU (rule 6.3).
  - **Every other Location (the manufacturers) is typed by hand** in the month's column (owner, 2026-11-16) and is never written by the script: in a new column those cells start **blank** (not last month's number); in an existing column they are not touched, even on a rerun. The summary lists the manufacturer rows still blank.
  - If the month has no column yet, it is added right after the last month column, which must be **last month** (months stay in order — a missing month stops the run). The new column copies last month's column first, so the total formula in row 1 and the formats follow.
  - The row is found by Location + SKU (capitals don't matter; `10030` typed as a number still matches). Every existing ADS / Amazon row gets a number — **0** when the month has none for it.
  - An ADS / Amazon SKU that isn't on the tab is **added at the bottom** (Code = Location + SKU), only when its number isn't 0. Older month cells on a new row stay blank.
- **15.3 `sell_thru monthly`** — one row per **Channel + SKU** (`Channel | Code | SKU | Description | months…`, headers in row 5). The month's column = units sold: counted Shopify lines by their order's Channel (rules 5.4 / 5.4a) + `manualorder_log` rows shipped in the month by their Channel (DTC, Marketing, CX, TikTok, Samples) + **Amazon** = ledger *Customer Shipments* for the whole month, per our SKU. Same column, matching, 0 and new-row rules as 15.2 (every Channel is written by the script). On a new row, Code and Description copy the formulas of the row above (so Description is looked up on `sku_matrix` like every other row). SKUs match exactly: Amazon `50001` and `A50001` are different rows.
- **15.4 `wo_log`** — one row per kit line of the work-order report (Pieces ≠ 0, fee lines dropped): **Date**, **Quantity** = Pieces, **SKU** (rule 5.5a), **Cost** = the line's **Rate**. Only those four columns are written; Month and Channel stay the tab's formulas (copied down from the row above if a written row has none).
  - The rows dated in the month are **replaced** by the month's kit lines, oldest first, where that month's rows were (else before the first later month, else at the end). Rows of other months are kept as they are.
  - A kit line with **no SKU** (rule 5.5a step 4), no Rate, or a date outside the month stops the run. A wo_log row with a Quantity/SKU/Cost but no Date also stops it.
- **15.5 `sku_matrix`** — every SKU that lands on one of the tabs above with a number other than 0 (or in a kit line) and isn't on `sku_matrix` is **added after its last SKU**: SKU (as text), Description (from the BOM, rule 6.4; blank if none) and **Status = NEEDS VERIFICATION**. Existing rows are never changed. This runs first, so new sell_thru rows find their description.
- **15.6** When it finishes, a pop-up (and the Execution log) says what was done: which column was added or replaced, how many rows were filled, which rows and SKUs were added, which wo_log rows hold the month, the manufacturer rows still blank, and anything to confirm (work-order SKUs found in the text, log rows with no Ship Date, Shopify lines not counted).

## 16. The EOM menu in Ops Hub 2.0

- **16.1** Ops Hub 2.0 has an **EOM** menu (Google puts it after Help) with **1. Write month to Ops Hub** and **2. Generate EOM Report**. Each asks which month — leave it blank for last month, or type it like `October 2026` — then runs and shows the result: a summary (step 1) or a link to the report (step 2). If it stops, the pop-up says why in plain English.
- **16.2** The menu comes from a small connector script pasted **once** into Ops Hub (Extensions → Apps Script; `opshub/OpsHubMenu.gs`, SETUP.md §A.4). It never changes: all the work is done by the EOM Automation script, which it uses as a library (HEAD), so every update GitHub uploads is live in the menu at once. Anyone who clicks it needs edit access to Ops Hub 2.0 and to EOM Automation.
- **16.3** From the Apps Script editor the same steps are `writeOpsHub` and `generateEOMReport` (month = `MONTH_OVERRIDE`, blank = last month), plus `shopifyOnly` (rule 13).
