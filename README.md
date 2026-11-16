# DairyPill EOM

Two steps, run from the **EOM** menu in DairyPill Ops Hub 2.0:

1. **Write month to Ops Hub** — reads the month's raw reports from a Google Drive folder (ADS snapshot, Amazon ledger, Shopify orders, ADS work orders) plus the Ops Hub shipment logs, and writes the month into Ops Hub 2.0: on-hand inventory at ADS and Amazon (`inventory_eom` — manufacturer counts are typed there by hand), units sold by channel (`sell_thru monthly`), kits built (`wo_log`) and new SKUs (`sku_matrix`).
2. **Generate EOM Report** — builds the end-of-month inventory / COGS workbook for accounting from Ops Hub's numbers (locked when generated) with every raw report copied in. Every number in the workbook is a visible formula, and the rows come from the data, not from typed lists.

- **[SETUP.md](SETUP.md)** — one-time setup (including the Ops Hub menu) and the monthly routine (no coding).
- **[RULES.md](RULES.md)** — the rule set: what every tab and column means. Change behaviour by changing a rule.
- `dist/` — what is uploaded to Google Apps Script automatically on every push (tests must pass first; see SETUP.md §A.2).
- `opshub/OpsHubMenu.gs` — the small connector pasted once into Ops Hub 2.0 for the menu (not uploaded by GitHub).

For developers / Claude Code: `npm test` runs everything (the formulas are calculated by a test engine and the entry points run against an in-memory Drive and Ops Hub). See [CLAUDE.md](CLAUDE.md).
