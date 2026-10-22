# DairyPill EOM Report

Builds the monthly end-of-month inventory / COGS workbook for DairyPill's accounting team from a Google Drive folder of raw reports (ADS, Amazon, Shopify, work orders, manual orders). Every number in the workbook is a visible formula, and the rows come from the data, not from typed lists.

- **[SETUP.md](SETUP.md)** — one-time setup and the monthly routine (no coding).
- **[RULES.md](RULES.md)** — the rule set: what every tab and column means. Change behaviour by changing a rule.
- `dist/DairyPill_EOM.gs` — the single file pasted into Google Apps Script.

For developers / Claude Code: `npm test` runs everything (the formulas are calculated by a test engine and the entry points run against an in-memory Drive). See [CLAUDE.md](CLAUDE.md).
