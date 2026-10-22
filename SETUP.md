# Setting up and running the DairyPill EOM script

No coding needed. You copy one file into Google Apps Script once; after that you drop reports in a folder and press **Run**.

---

## A. One-time setup (about 15 minutes)

### 1. Make the Drive folders
1. In Google Drive, create a folder called **DairyPill EOM** (or use an existing one).
2. Inside it, create one folder per month, named exactly like **September 2026** (full month name, space, year).
3. Open the **DairyPill EOM** folder and copy its ID from the address bar — the part after `/folders/`.
   Example: `https://drive.google.com/drive/folders/1AbCdEf...` → the ID is `1AbCdEf...`

### 2. Create the script
1. Go to **script.google.com** → **New project**. Click "Untitled project" at the top and rename it **DairyPill EOM**.
2. Delete everything in the `Code.gs` editor.
3. Open [`dist/DairyPill_EOM.gs`](dist/DairyPill_EOM.gs) in this repository on GitHub, click the **Copy raw file** button (two overlapping squares, top right of the file), and paste into `Code.gs`.
4. Near the top, find `PARENT_FOLDER_ID: 'PASTE_THE_PARENT_FOLDER_ID_HERE'` and replace the text between the quotes with your folder ID from step 1.3. Keep the quotes.
5. Press **Ctrl+S** (Cmd+S on Mac) to save.
6. Click the **gear icon (Project Settings)** on the left → set **Time zone** to *(GMT-05:00) Eastern Time - New York*.

### 3. Give it permission (first run only)
1. In the toolbar dropdown next to **Debug**, choose **buildEOM** and click **Run**.
2. Google asks for permission → **Review permissions** → pick your account → **Advanced** → **Go to DairyPill EOM (unsafe)** → **Allow**.
   ("Unsafe" just means Google hasn't reviewed a script you wrote yourself — normal for personal scripts.)

---

## B. Every month

1. In **DairyPill EOM**, create the month's folder, e.g. **October 2026**.
2. Drop these files in it (file names don't matter — the script recognizes each by its columns):

   | File | How to get it |
   |---|---|
   | ADS stock snapshot (CSV) | ADS portal, pulled on the **last day** of the month |
   | Amazon Inventory Ledger (CSV) | Seller Central → Inventory Ledger → **Summary view**, **daily**, dates **1st through last day** of the month |
   | Amazon Business Report (CSV) | Detail Page Sales and Traffic by Child Item, **1st through last day** |
   | Shopify orders export (CSV) | Shopify → Orders → Export, the month's date range |
   | Manual Orders (CSV or Google Sheet) | Columns `CUSTOMER, ORDER, SKU, QUANTITY, DATE` (header row required even if there are no orders) |
   | ADS work orders (`ProductionLabor…xls`) | ADS Production Detail Worksheet Report for the month |

   **Don't** add the start-of-month ADS snapshot or Amazon starting balance — the script copies them from last month.
   Excel (`.xlsx`) files are not accepted; save as CSV or Google Sheet.

3. In the script editor choose **buildEOM** → **Run**. It takes a few minutes. When it finishes, the **Execution log** at the bottom shows a link to the workbook.
4. Open the workbook. It opens on the **Checks** tab — anything red (**FLAG**) needs attention.
5. Fill in the **yellow tabs**:
   - **MFG Inventory** — one row per manufacturer and SKU: `MFG` (VitaQuest, VitaPros, …), `SKU`, `Received Qty`, `EOM Qty`.
   - **ADS Receipts** — `PO Number`, `SKU`, `Qty` received at ADS this month.
   - **COGS** — add any SKU the Checks tab says has no cost.
6. Run **buildEOM** again. Everything you typed in yellow tabs is kept; the summaries update.
7. For accounting: **File → Download → Microsoft Excel (.xlsx)**.

### Shopify only
To make just the **DairyPill Sell Thru** file (replaces the old "DairyPill Monthly Sell Thru" script): choose **shopifyOnly** → **Run**. It uses the Shopify CSV in the month folder.

### Building a month other than last month
Set `MONTH_OVERRIDE: 'September 2026'` near the top of the script, run, then set it back to `''`.

---

## C. The very first run (no previous month built by the script yet)

The script normally takes starting balances from last month's folder. For the first month you build with it:

1. Inside that month's folder, create a subfolder named **Starting Balances**.
2. Put in it:
   - last month's month-end **ADS stock snapshot** (CSV), and
   - an **Amazon Inventory Ledger** (CSV) that **ends on last month's final day** (e.g. for September: a ledger for August, or just 8/31).
3. COGS and Prepaid are copied automatically from the hand-built September workbook.
4. On the **MFG Starting Balance** tab, type last month's VitaQuest/VitaPros EOM quantities, then run again.

From the second month on, none of this is needed.

---

## D. If something goes wrong

- The run stops with a red message in the Execution log that says what's wrong in plain English (missing file, two ledgers, ledger missing a day, work orders that don't add up…). Fix that and run again — a failed run doesn't change anything in the folder.
- **"Exceeded maximum execution time"**: run **shopifyOnly** first, then **buildEOM** (it will reuse the Sell Thru file).
- Anything else: copy the red message and paste it into Claude Code.

## E. Changing a rule

1. Open Claude Code in this repository and say what you want, naming the rule from [RULES.md](RULES.md) — e.g. *"Change rule 5.4 so 'wholesale' tags go to a Wholesale channel."*
2. Claude Code updates the rules, the code and the tests, runs the tests, and regenerates `dist/DairyPill_EOM.gs`.
3. Copy the new `dist/DairyPill_EOM.gs` into Apps Script again (select all in `Code.gs`, paste, then put your folder ID back in), save, and run.
