// =============================================================================
// DairyPill EOM Report — SETTINGS
// Every setting below implements a numbered rule in RULES.md. If you change a
// rule there, change the matching setting here (and vice versa).
// =============================================================================

var CONFIG = {

  // ---- Rule 1.1 / 1.2: folders and which month to build ----------------------
  // The Google Drive folder that holds one subfolder per month ("September 2026").
  PARENT_FOLDER_ID: 'PASTE_THE_PARENT_FOLDER_ID_HERE',
  // Leave blank to build LAST calendar month. To force a month, type it exactly
  // like the folder name, e.g. 'September 2026'.
  MONTH_OVERRIDE: '',

  CLIENT_NAME: 'DairyPill',
  // Rule 1.3: the workbook name is this prefix + the month folder name.
  WORKBOOK_NAME_PREFIX: 'DAIRYPILL_EOM COGS - ',
  // Rule 13.1: the standalone Shopify file is this prefix + "Sep 2026".
  SELL_THRU_NAME_PREFIX: 'DairyPill Sell Thru ',
  // Rule 2.2 / 4.4: first-run-only subfolder with last month's ADS snapshot and
  // an Amazon ledger that ends on last month's final day.
  STARTING_BALANCES_SUBFOLDER: 'Starting Balances',

  // ---- Rule 6.1: where the BOM is copied from --------------------------------
  BOM_SOURCE: {
    spreadsheetId: '1rCXpffesBqnfocXslxqb9VzuFCQd60X5IV_YPZTkEtE', // DairyPill Ops Hub 2.0
    sheetName: 'BOM',
    columns: 'E:I', // Parent SKU, Parent Desc, Child SKU, Child Desc, Qty
    headers: { parent: 'Parent SKU', parentDesc: 'Parent Desc', child: 'Child SKU', childDesc: 'Child Desc', qty: 'Qty' }
  },

  // ---- Rules 5.6 and 15: DairyPill Ops Hub 2.0 tabs the script reads and writes -
  OPS_HUB: {
    spreadsheetId: '1rCXpffesBqnfocXslxqb9VzuFCQd60X5IV_YPZTkEtE', // DairyPill Ops Hub 2.0
    // Rule 5.6: shipments typed in Ops Hub before running buildEOM. Month = Ship Date.
    manualLog: { sheetName: 'manualorder_log', columns: 'A:F',
      headers: { order: 'ADS Order Number', channel: 'Channel', sku: 'SKU', qty: 'Quantity', orderDate: 'Order Date', shipDate: 'Ship Date' } },
    amzLog: { sheetName: 'amz_log', columns: 'A:F',
      headers: { order: 'ADS Order Number', amazon: 'Amazon Number', sku: 'SKU', qty: 'Quantity', orderDate: 'Order Date', shipDate: 'Ship Date' } },
    // Rule 15: where postToOpsHub() writes the finished month.
    woLog:     { sheetName: 'wo_log', headers: ['Date', 'Quantity', 'SKU', 'Cost'] },
    sellThru:  { sheetName: 'sell_thru monthly', headerRow: 5, headers: ['Channel', 'Code', 'SKU', 'Description'], firstMonthCol: 5 },
    inventory: { sheetName: 'inventory_eom', headerRow: 2, headers: ['Code', 'Location', 'SKU'], firstMonthCol: 4 },
    skuMatrix: { sheetName: 'sku_matrix', headers: ['SKU', 'Description', 'Status'], newStatus: 'NEEDS VERIFICATION' }
  },
  // Rule 15.1: postToOpsHub() refuses to post while the Checks tab shows any FLAG.
  // Set to true only for a run where you have read every FLAG and decided it doesn't matter.
  POST_DESPITE_FLAGS: false,

  // ---- Rule 6.2 / 7.3: first-run source for COGS and Prepaid -----------------
  // Used only when there is no previous month's workbook to carry them from.
  BOOTSTRAP_WORKBOOK_ID: '1vFNFEbUKyoTlj21PrKWjk_2Yfdhionh7wkkSF2J3pAw', // Sept 2026 (hand-built)

  // ---- Rule 6.2: which COGS columns the summaries read ------------------------
  COGS_COLUMNS: { key: 'Trim', cogs: 'COGS / Unit', freight: 'Freight / Unit', tariffs: 'Tariffs / Unit', total: 'Total / Unit' },

  // ---- Rule 2: how each raw file is recognized (by its header row) ------------
  FILE_TYPES: {
    ADS:      { label: 'ADS stock snapshot',       headers: ['Stock Number', 'Lot Code', 'Qty On Hand'] },
    LEDGER:   { label: 'Amazon Inventory Ledger',  headers: ['Date', 'FNSKU', 'MSKU', 'Disposition', 'Receipts', 'Ending Warehouse Balance'] },
    BIZ:      { label: 'Amazon Business Report',   headers: ['(Child) ASIN', 'Units Ordered'] },
    SHOPIFY:  { label: 'Shopify order export',     headers: ['Name', 'Lineitem quantity', 'Lineitem sku', 'Tags'] },
    // Rule 2.5: no longer used (replaced by the Ops Hub logs) — recognized only so the run can refuse it.
    MANUAL:   { label: 'Manual Orders file',       headers: ['CUSTOMER', 'ORDER', 'SKU', 'QUANTITY', 'DATE'] },
    WORK_ORDERS: { label: 'ADS work orders', marker: 'Production Detail Worksheet Report' }
  },

  // ---- Columns the formulas use, by header name (Rule 5) ----------------------
  COLUMNS: {
    ADS:     { sku: 'Stock Number', qty: 'Qty On Hand',
               numeric: ['Shelf Life', 'Qty Picked (7 Days)', 'Qty Picked (30 Days)', 'Qty On Hand', 'Qty On Hand (S1)', 'Qty On Hand (S2)', 'Qty On Hand (S3)', 'Projected Months of Inventory'] },
    LEDGER:  { date: 'Date', asin: 'ASIN', msku: 'MSKU', receipts: 'Receipts', ending: 'Ending Warehouse Balance',
               numericFrom: 'Starting Warehouse Balance', numericTo: 'Unknown Events' },
    BIZ:     { asin: '(Child) ASIN', units: 'Units Ordered', numericFrom: 'Sessions - Total' },
    SHOPIFY: { name: 'Name', sku: 'Lineitem sku', qty: 'Lineitem quantity', tags: 'Tags',
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
  // Rule 11.2: Outbound Summary / sell-through channels. Samples comes only from manualorder_log.
  OUTBOUND_CHANNELS: ['DTC', 'Marketing', 'CX', 'TikTok', 'Samples'],
  AMAZON_CHANNEL_LABEL: 'Amazon',

  // ---- Rule 6.3: Amazon MSKU → our SKU ----------------------------------------
  AMAZON_SKU_RULES: {
    removeText: [' - TEMP SKU'],
    renames: { 'A80002': 'A80004' }
  },

  // ---- Rule 5.5: work-order lines that are fees, not kits ---------------------
  WORK_ORDER_FEE_JOBS: ['Setup Fee'],

  // ---- Rule 9: locations, their labels and categorization ---------------------
  LOCATIONS: {
    ADS: { label: 'ADS',    categorization: 'Ending Inventory' },
    TRANSIT: { label: 'In Transit to AMZ', categorization: 'Ending Inventory' }, // Rule 9.5
    AMZ: { label: 'Amazon', categorization: 'Ending Inventory' },
    MFG: {                  categorization: 'Raw Material - Component' } // label = the MFG name typed on the MFG Inventory tab
  },

  // ---- Rule 7: manual-entry tab headers ---------------------------------------
  MANUAL_TABS: {
    MFG_INVENTORY: ['MFG', 'SKU', 'Received Qty', 'EOM Qty'],
    MFG_STARTING:  ['MFG', 'SKU', 'EOM Qty'],
    TRANSIT_STARTING: ['SKU', 'Qty'],
    ADS_RECEIPTS:  ['PO Number', 'SKU', 'Qty'],
    PREPAID:       ['Prepaid POs', 'Invoice', 'SKU', 'Description', 'Quantity', 'Unit Cost', 'Total Cost', 'Amount Paid']
  },

  // Text shown in place of a number when a SKU has no COGS row (Rule 12.1).
  NO_COST_TEXT: 'NO COST',
  NO_DESCRIPTION_TEXT: '(no description)',
  UNMAPPED_TEXT: 'UNMAPPED'
};
