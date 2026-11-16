// =============================================================================
// DairyPill EOM Report — SETTINGS
// Every setting below implements a numbered rule in RULES.md. If you change a
// rule there, change the matching setting here (and vice versa).
// =============================================================================

var CONFIG = {

  // ---- Rule 1.1 / 1.2: folders and which month to build ----------------------
  // The Google Drive folder that holds one subfolder per month ("October 2026"):
  // DairyPill › EOM Reports. Kept here (not typed in Apps Script) because every
  // deploy replaces the whole script.
  PARENT_FOLDER_ID: '16H9CCvtmchb2N7dzhcoY9-43PviS-sxn',
  // Leave blank to build LAST calendar month. To force a month, type it exactly
  // like the folder name, e.g. 'September 2026'.
  MONTH_OVERRIDE: '',

  CLIENT_NAME: 'DairyPill',
  // Rule 1.3: the workbook name is this prefix + the month folder name.
  WORKBOOK_NAME_PREFIX: 'DAIRYPILL_EOM COGS - ',
  // Rule 13.1: the standalone Shopify file is this prefix + "Sep 2026".
  SELL_THRU_NAME_PREFIX: 'DairyPill Sell Thru ',

  // ---- Rule 6.1: where the BOM is copied from --------------------------------
  BOM_SOURCE: {
    spreadsheetId: '1rCXpffesBqnfocXslxqb9VzuFCQd60X5IV_YPZTkEtE', // DairyPill Ops Hub 2.0
    sheetName: 'BOM',
    columns: 'E:I', // Parent SKU, Parent Desc, Child SKU, Child Desc, Qty
    headers: { parent: 'Parent SKU', parentDesc: 'Parent Desc', child: 'Child SKU', childDesc: 'Child Desc', qty: 'Qty' }
  },

  // ---- Rule 5.6: shipments out of ADS, typed in Ops Hub 2.0 before running ---------------
  // Read straight from these tabs (no file in the month folder). A row counts in the month of its
  // Ship Date; a blank Ship Date = not shipped yet (not counted, listed on Checks).
  OPS_HUB: {
    spreadsheetId: '1rCXpffesBqnfocXslxqb9VzuFCQd60X5IV_YPZTkEtE', // DairyPill Ops Hub 2.0
    // Hand-entered shipments from ADS (samples, marketing, replacements…), each with its sales channel.
    manualLog: { sheetName: 'manualorder_log', columns: 'A:F',
      headers: { order: 'ADS Order Number', channel: 'Channel', sku: 'SKU', qty: 'Quantity', orderDate: 'Order Date', shipDate: 'Ship Date' } },
    // Units shipped out of ADS to Amazon. They only reduce ADS (never a sale; Amazon's side is the ledger).
    // Layout since 2026-11 (owner): a summary row above, headers in row 2, columns SKU | Quantity | ADS Order Number |
    // Amazon Store Number | Order Date (Date Labels are Received) | Ship Date (F, added 2026-11-13). Found by name.
    amzLog: { sheetName: 'amz_log', columns: 'A:F',
      headers: { order: 'ADS Order Number', amazon: 'Amazon Store Number', sku: 'SKU', qty: 'Quantity',
                 orderDate: 'Order Date Date Labels are Received', shipDate: 'Ship Date' } },
    // Rule 5.5a: our SKU for work-order lines whose Job is blank or words. One list for every month (moved here from
    // the report on 2026-11-16, because the Ops Hub is now written first). Created by "Write month to Ops Hub" if missing.
    woFixes: { sheetName: 'wo_sku_fixes', headers: ['Reported as (Job, or Description when Job is blank)', 'Our SKU', 'Note'] }
  },

  // ---- Rule 15: "Write month to Ops Hub" fills these Ops Hub 2.0 tabs from the month's files ----
  // Columns are found by their header names; nothing else on the tabs is touched.
  OPS_HUB_WRITE: {
    spreadsheetId: '1rCXpffesBqnfocXslxqb9VzuFCQd60X5IV_YPZTkEtE', // DairyPill Ops Hub 2.0
    // Rule 15.2: one row per Location + SKU, one column per month (header = month-end date). The script fills only the
    // `ownedGroups` rows (it has their reports); every other Location (the manufacturers) is typed by hand (owner, 2026-11-16).
    inventoryEom: { sheetName: 'inventory_eom', headerRow: 2, group: 'Location', sku: 'SKU', code: 'Code', ownedGroups: ['ADS', 'Amazon'] },
    // Rule 15.3: one row per Channel + SKU, one column per month (header = month-end date).
    sellThru: { sheetName: 'sell_thru monthly', headerRow: 5, group: 'Channel', sku: 'SKU', code: 'Code', desc: 'Description' },
    // Rule 15.4: one row per kit line. Only these four columns are written; Month / Channel are formulas on the tab.
    woLog: { sheetName: 'wo_log', headers: { date: 'Date', qty: 'Quantity', sku: 'SKU', cost: 'Cost' }, formulaHeaders: ['Month', 'Channel'] },
    // Rule 15.5: SKUs not on sku_matrix are added with this Status.
    skuMatrix: { sheetName: 'sku_matrix', headers: { sku: 'SKU', desc: 'Description', status: 'Status' }, newStatus: 'NEEDS VERIFICATION' }
  },

  // ---- Rule 6.2: which COGS columns the summaries read ------------------------
  // Rule 6.2: COGS is typed by hand every month. The script creates it with these headers, one row per SKU,
  // costs blank, and Total / Unit = sum of the three cost columns. SKUs match as text or numbers (no Trim column).
  COGS_HEADER: ['SKU', 'Description', 'Base Cost', 'Freight In', 'Tariff', 'Total / Unit'],
  COGS_COLUMNS: { key: 'SKU', desc: 'Description', cogs: 'Base Cost', freight: 'Freight In', tariffs: 'Tariff', total: 'Total / Unit' },

  // ---- Rule 2: how each raw file is recognized (by its header row) ------------
  FILE_TYPES: {
    ADS:      { label: 'ADS stock snapshot',       headers: ['Stock Number', 'Lot Code', 'Qty On Hand'] },
    LEDGER:   { label: 'Amazon Inventory Ledger',  headers: ['Date', 'FNSKU', 'MSKU', 'Disposition', 'Receipts', 'Ending Warehouse Balance'] },
    BIZ:      { label: 'Amazon Business Report',   headers: ['(Child) ASIN', 'Units Ordered'] },
    SHOPIFY:  { label: 'Shopify order export',     headers: ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags'] },
    // Rule 2.5: no longer used — recognized only so a leftover file stops the run (it would double count the Ops Hub logs).
    MANUAL:   { label: 'Manual Orders',            headers: ['CUSTOMER', 'ORDER', 'SKU', 'QUANTITY', 'DATE'] },
    WORK_ORDERS: { label: 'ADS work orders', marker: 'Production Detail Worksheet Report' }
  },

  // ---- Columns the formulas use, by header name (Rule 5) ----------------------
  COLUMNS: {
    ADS:     { sku: 'Stock Number', qty: 'Qty On Hand',
               numeric: ['Shelf Life', 'Qty Picked (7 Days)', 'Qty Picked (30 Days)', 'Qty On Hand', 'Qty On Hand (S1)', 'Qty On Hand (S2)', 'Qty On Hand (S3)', 'Projected Months of Inventory'] },
    LEDGER:  { date: 'Date', asin: 'ASIN', msku: 'MSKU', receipts: 'Receipts', ending: 'Ending Warehouse Balance',
               starting: 'Starting Warehouse Balance', // Rule 4.2: Amazon Beginning = this on the 1st-of-month rows
               inTransit: 'In Transit Between Warehouses', transfers: 'Warehouse Transfer In/Out', // Rule 4.2 / 9.3
               shipments: 'Customer Shipments', // Rule 9.3: Amazon Sold / Used
               // Rule 12.13: ledger events (other than receipts/shipments) that explain the Amazon Delta
               deltaEvents: ['Customer Returns', 'Vendor Returns', 'Found', 'Lost', 'Damaged', 'Disposed', 'Other Events', 'Unknown Events'],
               numericFrom: 'Starting Warehouse Balance', numericTo: 'Unknown Events' },
    BIZ:     { asin: '(Child) ASIN', units: 'Units Ordered', numericFrom: 'Sessions - Total' },
    // Rule 5.4a: Financial Status / Cancelled at are on an order's first line only; Lineitem fulfillment status is per line.
    SHOPIFY: { name: 'Name', sku: 'Lineitem sku', qty: 'Lineitem quantity', tags: 'Tags',
               financial: 'Financial Status', cancelled: 'Cancelled at', fulfillment: 'Lineitem fulfillment status',
               numeric: ['Lineitem quantity', 'Subtotal', 'Shipping', 'Taxes', 'Total', 'Discount Amount', 'Lineitem price', 'Lineitem compare at price', 'Refunded Amount', 'Outstanding Balance', 'Lineitem discount'] }
  },

  // ---- Rule 5.4: Shopify channel rules (first match wins, not case-sensitive) -
  CHANNEL_RULES: [
    { keyword: 'influencer',  channel: 'Marketing' },
    { keyword: 'replacement', channel: 'CX' },
    { keyword: 'free sample', channel: 'Marketing' },
    { keyword: 'tiktok',      channel: 'TikTok' }
  ],
  DEFAULT_CHANNEL: 'DTC',
  // Shopify channels, in Channel Breakdown column order (Rule 13).
  CHANNELS: ['DTC', 'Marketing', 'CX', 'TikTok'],
  // Rule 5.6 / 11.2: Outbound Summary channels = the Channel values manualorder_log may use.
  // Samples comes only from manualorder_log (Shopify "free sample" tags stay Marketing).
  OUTBOUND_CHANNELS: ['DTC', 'Marketing', 'CX', 'TikTok', 'Samples'],
  AMAZON_CHANNEL_LABEL: 'Amazon',

  // ---- Rule 6.3: Amazon MSKU → our SKU ----------------------------------------
  AMAZON_SKU_RULES: {
    removeText: [' - TEMP SKU'],
    renames: { 'A80002': 'A80004' }
  },

  // ---- Rule 8.1a: mailers used when ADS ships these Shopify SKUs --------------
  // Each unit sold of a SKU in `soldSkus` (the exact Shopify SKU text) uses `perUnit` of `sku`, and so does
  // each unit sold of any bundle SKU (has a comma) with a pouch from `bundlePouches` in it — one mailer per
  // bundle, not per pouch (owner, 2026-11-10). Jar bundles (20001,20002) have no pouch → no mailer.
  // Shopify only: manualorder_log shipments use no mailer (owner, 2026-11-10).
  // Rule 8.1b: a pouch on the shelf has no mailer in it. On the workbook's BOM tab, the lines from these SKUs to
  // the mailer are marked `bomFlag` in column `bomFlagHeader`; that mailer is taken out of on-hand cost
  // (Variance Overview, Inventory Valuation) and added back once per Shopify unit on Outbound Summary (owner, 2026-11-13).
  MAILER_RULE: { sku: '41001', perUnit: 1, soldSkus: ['80030', '80090', '80090,80090', '80090,80090,80090'], bundlePouches: ['80030', '80090'],
                 bomFlagHeader: 'Mailer added when shipped', bomFlag: 'Yes' },

  // ---- Rule 5.5: work-order lines that are fees, not kits ---------------------
  WORK_ORDER_FEE_JOBS: ['Setup Fee'],

  // ---- Rule 9: locations, their labels and categorization ---------------------
  // ADS and Amazon match the Location column of Ops Hub inventory_eom. Every other Location there is a manufacturer (MFG).
  LOCATIONS: {
    ADS: { label: 'ADS',    categorization: 'Ending Inventory' },
    AMZ: { label: 'Amazon', categorization: 'Ending Inventory' },
    MFG: { label: 'MFG',    categorization: 'Raw Material - Component' } // one section; each row's Location is the manufacturer
  },

  // ---- Rule 7: manual-entry tab headers (typed in the report, never overwritten) -
  MANUAL_TABS: {
    ADS_RECEIPTS:  ['PO Number', 'SKU', 'Qty'],
    MFG_RECEIPTS:  ['MFG', 'SKU', 'Qty'], // Rule 7.2a: received at a manufacturer this month (optional, blank = 0)
    PREPAID:       ['Prepaid POs', 'Invoice', 'SKU', 'Description', 'Quantity', 'Unit Cost', 'Total Cost', 'Amount Paid']
  },

  // Text shown in place of a number when a SKU has no COGS row (Rule 12.1).
  NO_COST_TEXT: 'NO COST',
  NO_DESCRIPTION_TEXT: '(no description)',
  UNMAPPED_TEXT: 'UNMAPPED'
};
