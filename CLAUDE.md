# DairyPill EOM — notes for Claude Code

Google Apps Script that builds DairyPill's end-of-month inventory/COGS workbook from a Drive folder of raw reports.
The owner is non-technical: explain in plain English, never ask them to review code.

## Ownership — DairyPill owns everything (fact, confirmed in Drive 2026-11-10)
- The live script is the Apps Script project **"EOM Automation"** (`1RblqXtQ…`, `.clasp.json`), **owned by ops@dairypill.com**. hayden@pelagic.co is an editor. This is the ONLY deploy target — never change `.clasp.json` to another project.
- The months folder **DairyPill › EOM Reports** (`16H9CC…`, `PARENT_FOLDER_ID`) lives in DairyPill's shared drive.
- The old personal project **"DairyPill EOM"** (`1VY7Ejzw…`) is retired and in the trash. Never deploy to it, restore it, or point anything at it. A backup clone exists on the owner's Mac only.
- **How it runs:** someone opens EOM Automation in the Apps Script editor and presses **Run** on `buildEOM` / `shopifyOnly`. Workspace Studio was tried and **abandoned 2026-11-10** (it won't run from the DairyPill account) — don't re-add Studio steps, `addOns` in `appsscript.json`, or suggest Studio. The code is in git history (commit 400bafa) if the owner ever asks.
- Anything that must be done as DairyPill (approving permissions, sharing) is a human click in that account — say so plainly; don't suggest moving anything back to a personal account to avoid it.

## Source of truth
- `RULES.md` is the rule set. Every behaviour change starts there. Rule numbers are referenced in `src/Config.gs` and code comments.
- When asked to "change rule X": update `RULES.md`, then `src/Config.gs` / `src/Logic.gs`, then the tests, run `npm test`, then `npm run bundle`.
- Business-logic changes (what counts as receiving, sold, starting balance, channels…): restate the new rule in plain English and confirm before coding.

## Layout
- `src/Config.gs` — every setting (folder ID, channel rules, SKU renames, column names).
- `src/Logic.gs` — pure functions: parsing, SKU lists, and every formula. No Google calls. All tested in Node.
- `src/Main.gs` — entry points `buildEOM()` / `shopifyOnly()` (thin wrappers over `buildEOMFor_(month)` / `shopifyOnlyFor_(month)`); Drive reading, starting balances.
- `src/Sheets.gs` — writing sheet models to Google Sheets.
- `dist/` — exactly what clasp uploads to Apps Script: `DairyPill_EOM.gs` (generated bundle) + `appsscript.json` (copied). Never edit by hand (`npm run bundle`; a test fails if stale).
- `.clasp.json` — Apps Script project (owned by the DairyPill account), `rootDir: dist`.
- `.github/workflows/deploy-apps-script.yml` — on every push **to `main`**: `npm test`, check `dist/` is fresh, `clasp push`. Needs repo secret `CLASPRC_JSON` (SETUP.md §A.2). Pushes to other branches never upload.

## Branches — one branch: `main` (owner's decision, 2026-11-10)
- The owner is the only editor. All work ends up on `main`; `main` is what is live in Apps Script.
- The owner has given standing permission to push to `main`. A session that starts on its own `claude/…` branch: do the work there, run `npm test` + `npm run bundle`, then `git push origin HEAD:main` (fast-forward; if main moved, rebase first — never force-push main), then delete the session branch on GitHub. Don't leave extra branches behind.
- After pushing, **check the "Deploy to Apps Script" run on main went green** (GitHub Actions) before telling the owner it is live. A red run with "invalid_grant" = the saved Google sign-in expired: owner reruns `npx @google/clasp@2.4.2 login`, `pbcopy < ~/.clasprc.json`, updates the `CLASPRC_JSON` secret, then re-run the job.
- Old unmerged work is kept as tags, not branches: `archive/wo-log-rule-5.7` (writing kit lines to the Ops Hub wo_log — never adopted), `archive/workspace-studio` (retired), `archive/ops-logs-first-draft` (superseded by the current Ops Hub log reading).
- `test/` — `formulaEngine.js` calculates the generated formulas; `gasMock.js` is an in-memory Drive/Sheets so `e2e.test.js` runs the real entry points.
- `tools/replay.js <folder>` — replays a real month from local CSV exports and compares with the hand-built report (data is never committed).

## Hard constraints
- Formulas must be Excel-safe (accounting downloads .xlsx): SUMIFS/SUMIF/COUNTIF(S)/COUNT/COUNTA/INDEX+MATCH/IF/IFERROR/ISNUMBER/SEARCH/MAX/SUM/ABS only. `assertExcelSafe_` enforces it.
- No hardcoded SKUs, channels or row positions in summary formulas; rows come from source data (RULES §9.2).
- Tab names ≤ 31 chars, no "/" (dates as MM.DD.YYYY).
- SKU columns are written as text; quantities as numbers.
- Errors are loud and plain-English; validate all inputs before changing anything in Drive.
- After any code change: `npm test` must pass, then `npm run bundle`, then commit and push — **pushing is the deploy** (GitHub uploads to Apps Script). Don't tell the owner to paste anything; tell them it goes live in about a minute and to check the Actions tab if unsure. Never run `clasp push` from a cloud session.
- Real Drive/Script IDs live in `src/Config.gs` / `.clasp.json` (never typed in the Apps Script editor — each upload replaces the whole project).
