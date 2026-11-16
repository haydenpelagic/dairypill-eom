# Setting up and running the DairyPill EOM script

No coding needed. Code changes reach Google Apps Script automatically through GitHub. Each month you drop reports in a folder and use the **EOM** menu in Ops Hub 2.0:

1. **Write month to Ops Hub**: the month's reports go into Ops Hub (`inventory_eom`, `sell_thru monthly`, `wo_log`, `sku_matrix`).
2. **Generate EOM Report**: the accounting report, made from Ops Hub, with every raw report copied in.

---

## A. One-time setup

### 1. The Drive folder (done)
Months live in **DairyPill › EOM Reports**, one subfolder per month named exactly like **October 2026** (full month name, space, year). Its ID is already set in the script (`PARENT_FOLDER_ID` in `src/Config.gs`), so you never type it.

### 2. Connect GitHub to Apps Script (done; redo only if an upload goes red)
The code is **not pasted by hand**. Every time Claude Code pushes a change to GitHub, GitHub runs all the tests and, only if they pass, uploads the script to the Apps Script project **EOM Automation** (Script ID `1RblqXtQ…`, owned by the DairyPill Google account). For that, GitHub needs a Google sign-in:

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
- The upload **replaces everything** in EOM Automation. Don't edit code in its Apps Script editor — it's overwritten on the next upload. Ask Claude Code instead.
- Only the **main** branch goes live (once its tests pass). Change the script from **one Claude session at a time**.
- Either version of `clasp login` works (clasp 2 or clasp 3): the deploy converts a clasp 3 sign-in for its uploader.
- In step 4, paste into GitHub **straight after** `pbcopy` — copying anything else in between replaces the sign-in on your clipboard.
- If an upload goes red, the step **Load the Google sign-in** says why in plain English:
  - **"is not a Google sign-in file"** or **"is empty"**: the secret holds something else. Redo steps 4–5 (click the pencil on the existing `CLASPRC_JSON` secret and paste over it), then **Re-run jobs** on the red run.
  - **invalid_grant** (in the Upload step): the saved sign-in expired. Redo steps 3–5, then **Re-run jobs**.
- To cut GitHub's access: Google Account → Security → Third-party connections → remove **clasp**, then delete the secret.
- Backup (only on your Mac, with clasp signed in): `npm run deploy` runs the tests, rebuilds and uploads.

### 3. Who can run it
Whoever clicks the menu needs **edit access** to: the **EOM Reports** folder, **Ops Hub 2.0**, and the **EOM Automation** script (it's shared like a Google file: open it at script.google.com → **Share**). ops@dairypill.com owns all three; hayden@pelagic.co is an editor.

### 4. Add the EOM menu to Ops Hub 2.0 (about 5 minutes, once)
A spreadsheet can only get a menu from a script inside it, so Ops Hub gets a tiny "connector" script that hands every click to EOM Automation. You paste it once; it never changes (updates to EOM Automation are live in the menu straight away).

1. Open **Ops Hub 2.0** → **Extensions** → **Apps Script**. A new tab opens with the Ops Hub's own script project.
2. **Look before pasting.** If `Code.gs` is empty or only has `function myFunction() {}`, carry on. **If there is any other code there, stop** and tell Claude Code what you see — pasting would replace it.
3. Select everything in `Code.gs` and paste the connector (the file `opshub/OpsHubMenu.gs` in this repository — Claude Code gives you the text to copy). Press **Save** (the disk icon). If it asks for a project name, use **Ops Hub menu**.
4. On the left, next to **Libraries**, click **+**. Script ID: `1RblqXtQTh3717xFS44CDf2tmtjho-0V1RlqtNKoQspMhbSPrbSeWNX8A` → **Look up** → Version: **HEAD (Development mode)** → Identifier: **EOM** (exactly) → **Add**.
5. Go back to the Ops Hub tab and **reload the page**. After a few seconds an **EOM** menu appears at the end of the menu bar (after Help — Google doesn't allow putting it between File and View).
6. **First click only:** EOM → any item → Google asks for permission → **Continue** → pick the account → **Advanced** → **Go to Ops Hub menu (unsafe)** → **Allow**. ("Unsafe" just means Google hasn't reviewed a script you wrote yourself.) Then click the menu item again.

If something goes wrong:
- **"Library with identifier EOM is missing"** or **"you do not have access to library"**: the person clicking needs Editor access to EOM Automation (step 3 above), or the Identifier isn't exactly `EOM`.
- **"You do not have permission to call …"**: tell Claude Code (the connector needs that permission listed).

---

## B. Every month

1. **Create the month's folder** in EOM Reports, e.g. **October 2026**, and drop these files in it (file names don't matter — the script recognizes each by its columns):

   | File | How to get it |
   |---|---|
   | ADS stock snapshot (CSV) | ADS portal, pulled on the **last day** of the month |
   | Amazon Inventory Ledger (CSV) | Seller Central → Inventory Ledger → **Summary view**, **daily**, dates **1st through last day** of the month |
   | Amazon Business Report (CSV) | Detail Page Sales and Traffic by Child Item, **1st through last day** (only needed for the report) |
   | Shopify orders export (CSV) | Shopify → Orders → Export, the month's date range |
   | ADS work orders (`ProductionLabor…xls`) | ADS Production Detail Worksheet Report for the month |

   No Manual Orders file and nothing from last month (a leftover Manual Orders file stops the run). Excel (`.xlsx`) files are not accepted; save as CSV or Google Sheet. Make sure the Ops Hub logs are up to date first (RULES 5.6):
   - **`manualorder_log`** — every non-Shopify shipment out of ADS (samples, marketing, replacements…), with its **Channel** (DTC, Marketing, CX, TikTok or Samples) and **Ship Date**.
   - **`amz_log`** — every shipment out of ADS to Amazon, with its **Ship Date** (the day it left ADS; leave blank if it hasn't shipped yet).

2. **Ops Hub → EOM → 1. Write month to Ops Hub.** Leave the month blank for last month (or type it, e.g. `October 2026`) → **OK**. In a minute or two a pop-up says what it wrote: the month's column on `inventory_eom` (ADS and Amazon rows) and `sell_thru monthly`, the month's kit lines on `wo_log`, new SKUs on `sku_matrix` (Status **NEEDS VERIFICATION**). If something is wrong it stops before writing anything and says why. Running it again replaces the month's columns — nothing doubles.
   - **TO FIX** lines: work-order lines where ADS left the Job blank or typed words (e.g. "NO GASSY DAYS STARTER KIT 30") go into `wo_log` with that text as the SKU. Type the right SKU over it in `wo_log`.
   - Once a month is in `wo_log`, running Write again **never changes those rows**, so your fixes are safe. To rebuild a month's kit lines from the work-order report, delete its rows in `wo_log` first.

3. **Type the manufacturer counts** in Ops Hub **`inventory_eom`**, in the new month's column, on every row whose Location isn't ADS or Amazon (VitaQuest, VitaPros…). The pop-up lists the rows still blank. For a new manufacturer or SKU, add a row at the bottom: Code (Location + SKU, e.g. `VitaQuest70001`), Location, SKU.

4. **Ops Hub → EOM → 2. Generate EOM Report** → same month → **OK**. When it's ready a pop-up has a link to the report (in the month folder). Open the **Checks** tab first — anything red (**FLAG**) needs attention. It also compares Ops Hub with the raw reports, so a number changed in Ops Hub by mistake shows up there.

5. **Fill in the yellow tabs** in the report (they update the summaries as you type, no rerun):
   - **COGS** — Base Cost, Freight In, Tariff for each SKU (Checks lists any SKU with no cost).
   - **ADS Receipts** — `PO Number`, `SKU`, `Qty` received at ADS this month.
   - **MFG Receipts** (optional) — `MFG`, `SKU`, `Qty` received at a manufacturer this month. It only splits a manufacturer's movement into Received and Used.

6. **The report locks Ops Hub's numbers** when you click Generate. If you change Ops Hub afterwards (a count, a correction), click **Generate EOM Report** again — what you typed in the yellow tabs is kept. If you replaced a report file in the folder, run **Write month to Ops Hub** first, then Generate.

7. **For accounting:** delete the **Checks** tab (it's QC only; nothing points at it, and the next run rebuilds it), then **File → Download → Microsoft Excel (.xlsx)**.

### Shopify only
To make just the **DairyPill Sell Thru** file: in the EOM Automation editor choose **shopifyOnly** → **Run** (it uses `MONTH_OVERRIDE`, blank = last month).

### From the Apps Script editor (backup)
The same two steps are **writeOpsHub** and **generateEOMReport** in the EOM Automation editor (toolbar dropdown → **Run**). They build last month unless `MONTH_OVERRIDE` is set (e.g. `'September 2026'`); the next upload from GitHub resets it to `''`.

---

## C. Switching from the old layout (once, the first month done the new way)

Until 2026-11-16 the report was built first and copied into Ops Hub afterwards. For the first month done the new way:

- Ops Hub needs **last month's column** on `inventory_eom` (the report's Beginning Inventory). If it's missing, Generate EOM Report says so.
- Work-order lines ADS wrote as words go into `wo_log` as written: fix them there (the old report's **WO SKU Fixes** tab has the SKUs you used before).
- Type the month's manufacturer counts in `inventory_eom` (they were on the old report's **MFG Counts** tab), and their receipts on the new **MFG Receipts** tab.
- Generating into the old report keeps your COGS, ADS Receipts and Prepaid. Old tabs (MFG Counts, MFG Starting Balance, ADS Starting Balance, WO SKU Fixes…) are left alone and listed on Checks — delete them.
- Expect **"Amazon starting balance = Ops Hub … ending"** to FLAG if last month's Amazon numbers in Ops Hub were typed by hand without units in transit. The report uses Amazon's ledger for Beginning (RULES 4.2), so this is information, not an error.

---

## D. If something goes wrong

- The run stops with a pop-up (or a red message in the Execution log) that says what's wrong in plain English (missing file, two ledgers, ledger missing a day, work orders that don't add up, Ops Hub not written yet…). Fix that and run again — a failed run doesn't change anything in the folder or Ops Hub.
- **"Exceeded maximum execution time"**: run **shopifyOnly** first, then **Generate EOM Report** (it will reuse the Sell Thru file).
- Anything else: copy the message and paste it into Claude Code.

## E. Changing a rule

1. Open Claude Code in this repository and say what you want, naming the rule from [RULES.md](RULES.md) — e.g. *"Change rule 5.4 so 'wholesale' tags go to a Wholesale channel."*
2. Claude Code updates the rules, the code and the tests, runs the tests, regenerates `dist/`, commits and pushes.
3. GitHub uploads it to Apps Script automatically (about a minute; **Actions** tab shows a green check). Nothing to paste — the menu uses the new version straight away.
