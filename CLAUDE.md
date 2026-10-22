# DairyPill EOM — notes for Claude Code

Google Apps Script that builds DairyPill's end-of-month inventory/COGS workbook from a Drive folder of raw reports.
The owner is non-technical: explain in plain English, never ask them to review code.

## Source of truth
- `RULES.md` is the rule set. Every behaviour change starts there. Rule numbers are referenced in `src/Config.gs` and code comments.
- When asked to "change rule X": update `RULES.md`, then `src/Config.gs` / `src/Logic.gs`, then the tests, run `npm test`, then `npm run bundle`.
- Business-logic changes (what counts as receiving, sold, starting balance, channels…): restate the new rule in plain English and confirm before coding.

## Layout
- `src/Config.gs` — every setting (folder ID, channel rules, SKU renames, column names).
- `src/Logic.gs` — pure functions: parsing, SKU lists, and every formula. No Google calls. All tested in Node.
- `src/Main.gs` — entry points `buildEOM()` / `shopifyOnly()`; Drive reading, starting balances.
- `src/Sheets.gs` — writing sheet models to Google Sheets.
- `dist/DairyPill_EOM.gs` — generated bundle the owner pastes into Apps Script. Never edit by hand (`npm run bundle`; a test fails if stale).
- `test/` — `formulaEngine.js` calculates the generated formulas; `gasMock.js` is an in-memory Drive/Sheets so `e2e.test.js` runs the real entry points.
- `tools/replay.js <folder>` — replays a real month from local CSV exports and compares with the hand-built report (data is never committed).

## Hard constraints
- Formulas must be Excel-safe (accounting downloads .xlsx): SUMIFS/SUMIF/COUNTIF(S)/COUNT/COUNTA/INDEX+MATCH/IF/IFERROR/ISNUMBER/SEARCH/MAX/SUM/ABS only. `assertExcelSafe_` enforces it.
- No hardcoded SKUs, channels or row positions in summary formulas; rows come from source data (RULES §9.2).
- Tab names ≤ 31 chars, no "/" (dates as MM.DD.YYYY).
- SKU columns are written as text; quantities as numbers.
- Errors are loud and plain-English; validate all inputs before changing anything in Drive.
- After any code change: `npm test` must pass, then `npm run bundle`, and remind the owner to re-paste `dist/DairyPill_EOM.gs`.
