// =============================================================================
// DairyPill Ops Hub 2.0 — the "EOM" menu (RULES.md rule 16)
//
// Paste this ONCE into Ops Hub 2.0: Extensions → Apps Script (steps in SETUP.md §A.4). It never needs to
// change: all the work is done by the "EOM Automation" script, which this project uses as a library named
// EOM (Version: HEAD, so every update GitHub uploads to EOM Automation is live here straight away).
// Anyone who clicks the menu needs edit access to Ops Hub 2.0 AND to the EOM Automation script.
// This file is NOT uploaded by GitHub (it lives in Ops Hub, not in EOM Automation).
// =============================================================================

/** Adds the EOM menu to the menu bar (Google puts it after Help) each time Ops Hub opens. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('EOM')
    .addItem('1. Write month to Ops Hub', 'eomWriteOpsHub')
    .addItem('2. Generate EOM Report', 'eomGenerateReport')
    .addToUi();
}

function eomWriteOpsHub() { EOM.menuWriteOpsHub(); }

function eomGenerateReport() { EOM.menuGenerateEOMReport(); }

// So Google asks for every permission EOM Automation needs on the first click (it reads these names):
// DriveApp.getFolderById  SpreadsheetApp.openById  Session.getActiveUser  HtmlService.createHtmlOutput
