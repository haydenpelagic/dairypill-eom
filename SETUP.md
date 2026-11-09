# Setting up and running the DairyPill EOM script

No coding needed. Code changes reach Google Apps Script automatically through GitHub; you drop reports in a folder and press **Run**.

---

## A. One-time setup

### 1. The Drive folder (done)
Months live in **DairyPill › EOM Reports**, one subfolder per month named exactly like **October 2026** (full month name, space, year). Its ID is already set in the script (`PARENT_FOLDER_ID` in `src/Config.gs`), so you never type it.

### 2. Connect GitHub to Apps Script (about 10 minutes, once)
The code is **not pasted by hand**. Every time Claude Code pushes a change to GitHub, GitHub runs all the tests and, only if they pass, uploads the script to the Apps Script project **DairyPill EOM** (Script ID `1RblqXtQ…`, owned by the DairyPill Google account). For that, GitHub needs a Google sign-in:

1. **Turn on the Apps Script API** for the Google account you'll sign in with: open https://script.google.com/home/usersettings and switch **Google Apps Script API** to **On**.
2. **Make sure that account can edit the script.** Either sign in as the DairyPill account, or share the Apps Script project with your own account as **Editor**.
3. **Get the sign-in file.** In Terminal on your Mac:
   - If you already use clasp **with that account**, skip to step 4: the file already exists.
   - Otherwise run `npx @google/clasp@2.4.2 login`. A browser opens; choose the account and click **Allow**.
     (This replaces any clasp login you use for other projects.)
4. **Copy it** with `pbcopy < ~/.clasprc.json` (nothing prints — it's now on your clipboard).
5. **Store it in GitHub:** the repository on GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name: `CLASPRC_JSON`. Secret: paste. **Add secret**.
6. **First upload:** GitHub → **Actions** tab → **Deploy to Apps Script** → **Run workflow**. A green check means the script is in Apps Script. A red X shows a plain-English reason at the top of the run.

Good to know:
- The upload **replaces everything** in that Apps Script project. Don't edit code in the Apps Script editor — it's overwritten on the next upload. Ask Claude Code instead.
- Any branch Claude pushes goes live once its tests pass. Change the script from **one Claude session at a time**, or the last one to push wins.
- To cut GitHub's access: Google Account → Security → Third-party connections → remove **clasp**, then delete the secret.
- Backup (only on your Mac, with clasp signed in): `npm run deploy` runs the tests, rebuilds and uploads.

### 3. Give it permission (first run only)
1. In the toolbar dropdown next to **Debug**, choose **buildEOM** and click **Run**.
2. Google asks for permission → **Review permissions** → pick the account that will run it (it needs access to the EOM Reports folder, the Ops Hub sheet and the September hand-built workbook) → **Advanced** → **Go to DairyPill EOM (unsafe)** → **Allow**.
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

   **Don't** add a start-of-month ADS snapshot (copied from last month) or a second Amazon ledger (the Amazon starting balance is the 1st-of-month rows of this month's ledger).
   Excel (`.xlsx`) files are not accepted; save as CSV or Google Sheet.

3. In the script editor choose **buildEOM** → **Run**. It takes a few minutes. When it finishes, the **Execution log** at the bottom shows a link to the workbook.
4. Open the workbook. It opens on the **Checks** tab — anything red (**FLAG**) needs attention.
5. Fill in the **yellow tabs**:
   - **MFG Inventory** — one row per manufacturer and SKU: `MFG` (VitaQuest, VitaPros, …), `SKU`, `Received Qty`, `EOM Qty`.
   - **ADS Receipts** — `PO Number`, `SKU`, `Qty` received at ADS this month.
   - **COGS** — add any SKU the Checks tab says has no cost.
6. Run **buildEOM** again. Everything you typed in yellow tabs is kept; the summaries update.
7. For accounting: **delete the Checks tab** (it's QC only; nothing points at it, and the next run rebuilds it), then **File → Download → Microsoft Excel (.xlsx)**.

### From Workspace Studio (no script editor)
The script adds two steps to Workspace Studio: **Build DairyPill EOM** and **Build DairyPill Shopify Sell Thru**. A flow is "Start manually" + one of these steps, with **Month** left blank (last month) or typed like the folder name (`October 2026`). The step checks the folder in a few seconds — if something's missing, the flow's activity log says what — then builds in the background and emails you the link (usually within 5 minutes). It always runs the latest code from GitHub.

One-time setup (as the DairyPill account that owns the script):
1. Open the script (Apps Script project **EOM Automation**) → **Deploy → Test deployments** → **Install**.
2. In Workspace Studio, create a flow: starter **Start manually**, step **Build DairyPill EOM** (and a second flow for **Build DairyPill Shopify Sell Thru** if you want it). Approve permissions on first run.

### Shopify only
To make just the **DairyPill Sell Thru** file (replaces the old "DairyPill Monthly Sell Thru" script): choose **shopifyOnly** → **Run**. It uses the Shopify CSV in the month folder.

### Building a month other than last month
Set `MONTH_OVERRIDE: 'September 2026'` near the top of the script in the Apps Script editor, run, then set it back to `''`. (The next upload from GitHub resets it to `''` anyway.)

---

## C. The very first run (no previous month built by the script yet)

The script normally takes starting balances from last month's folder. For the first month you build with it:

1. Inside that month's folder, create a subfolder named **Starting Balances**.
2. Put in it:
   - last month's month-end **ADS stock snapshot** (CSV), and
   - *optional:* an **Amazon Inventory Ledger** (CSV) that **ends on last month's final day**. It is only used to check that Amazon's starting balance ties to last month's ending (a FLAG on Checks if not).
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
2. Claude Code updates the rules, the code and the tests, runs the tests, regenerates `dist/`, commits and pushes.
3. GitHub uploads it to Apps Script automatically (about a minute; **Actions** tab shows a green check). Nothing to paste — just run.
