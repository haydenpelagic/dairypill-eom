'use strict';
// Workspace Studio steps (Rule 1.5): the callbacks named in appsscript.json, run against the in-memory Drive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gasMock');
const { sampleRaw, csv } = require('./fixtures/sampleMonth');
const { bundle } = require('../tools/bundle');

/** Adds the Apps Script services Studio.gs uses (properties, lock, triggers, mail) to the mock. */
function withStudioServices(gas, opts) {
  const props = new Map();
  const studio = { props, triggers: [], mails: [], lockFree: true, triggersAllowed: !(opts && opts.noTriggers) };
  Object.assign(gas.sandbox, {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
      deleteProperty: (k) => { props.delete(k); }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => studio.lockFree, releaseLock: () => {} }) },
    ScriptApp: {
      newTrigger: (fn) => { const b = { timeBased: () => b, after: () => b, create: () => {
        if (!studio.triggersAllowed) throw new Error('Triggers are not allowed here');
        const t = { getHandlerFunction: () => fn }; studio.triggers.push(t); return t; } }; return b; },
      getProjectTriggers: () => studio.triggers.slice(),
      deleteTrigger: (t) => { studio.triggers = studio.triggers.filter((x) => x !== t); }
    },
    MailApp: { sendEmail: (to, subject, body) => studio.mails.push({ to, subject, body }) }
  });
  gas.sandbox.Session.getEffectiveUser = () => ({ getEmail: () => 'owner@example.com' });
  return studio;
}

function setup(opts) {
  const gas = createGas();
  const studio = withStudioServices(gas, opts);
  const ctx = vm.createContext(gas.sandbox);
  for (const f of ['Config.gs', 'Logic.gs', 'Sheets.gs', 'Main.gs', 'Studio.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  const parent = gas.root.createFolder('DairyPill EOM');
  const sep = parent.createFolder('September 2026');
  const raw = sampleRaw(2026, 8);
  sep.createFile('DY_Stock_Snapshot_Palisades (12).csv', csv(raw.adsEnd));
  sep.createFile('177349020748.csv', csv(raw.ledger));
  sep.createFile('BusinessReport-10-22-26.csv', '﻿' + csv(raw.biz));
  sep.createFile('orders_export.csv', csv(raw.shopify));
  sep.createFile('manual orders.csv', csv(raw.manual));
  sep.createFile('ProductionLabor.DY.2026-10-01.xls', raw.woHtml, 'application/vnd.ms-excel');
  const b = sep.createFolder('Starting Balances');
  b.createFile('DY_Stock_Snapshot_Palisades (11).csv', csv(raw.adsStart));
  b.createFile('ledger 8-31.csv', csv(raw.amzStart));
  gas.spreadsheetWithId(ctx.CONFIG.BOM_SOURCE.spreadsheetId, 'DairyPill Ops Hub 2.0', null, {
    bom: raw.bomValues.map((r) => ['', '', '', ''].concat(r))
  });
  gas.spreadsheetWithId(ctx.CONFIG.BOOTSTRAP_WORKBOOK_ID, 'Sept hand-built', null, {
    COGS: [raw.cogsHeader].concat(raw.cogsRows),
    Prepaid: [['Prepaid POs', 'Invoice', 'SKU'], ['POUCHES-26', '102973', '80030']]
  });
  ctx.CONFIG.PARENT_FOLDER_ID = parent.getId();
  return { gas, ctx, studio, sep };
}

const run = (month) => ({ workflow: { actionInvocation: { inputs: month === undefined ? {} : { month: { stringValues: [month] } } } } });
const outputs = (res) => res.hostAppAction.workflowAction.returnOutputVariablesAction;
const error = (res) => res.hostAppAction.workflowAction.returnElementErrorAction;
const plain = (x) => JSON.parse(JSON.stringify(x));
function has(folder, name) { return folder.getFilesByName(name).hasNext(); }

test('every Studio callback named in appsscript.json exists in the uploaded bundle', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appsscript.json'), 'utf8'));
  const els = manifest.addOns.flows.workflowElements;
  assert.deepEqual(els.map((e) => e.name), ['Build DairyPill EOM', 'Build DairyPill Shopify Sell Thru']);
  const src = bundle();
  for (const e of els) {
    for (const fn of [e.workflowAction.onConfigFunction, e.workflowAction.onExecuteFunction]) {
      assert.match(src, new RegExp('\\nfunction ' + fn + '\\('), fn + ' is defined');
    }
  }
  assert.match(src, /\nfunction runQueuedStudioBuild\(/);
});

test('config card shows a Month box with the saved value', () => {
  const { ctx } = setup();
  const res = plain(ctx.onStudioConfigEOM({ workflow: { elementConfiguration: { inputs: { month: { stringValues: [' October 2026 '] } } } } }));
  const card = res.action.navigations[0].pushCard.sections[0];
  assert.equal(card.header, 'Build DairyPill EOM');
  assert.equal(card.widgets[1].textInput.name, 'month');
  assert.equal(card.widgets[1].textInput.value, 'October 2026');
});

test('a missing month folder is reported to Studio in plain English and nothing is queued', () => {
  const { ctx, studio } = setup();
  const err = error(plain(ctx.onStudioRunEOM(run('March 2026'))));
  assert.match(err.errorLog.textFormatElements[0].text, /No folder named "March 2026"/);
  assert.equal(err.retryability, 'NOT_RETRYABLE');
  assert.equal(studio.props.size, 0);
  assert.equal(studio.triggers.length, 0);
});

test('EOM: checks pass → queued; the background run builds the workbook and emails the link', () => {
  const { ctx, studio, sep } = setup();
  const out = outputs(plain(ctx.onStudioRunEOM(run('September 2026'))));
  assert.deepEqual(out.variables.status.stringValues, ['STARTED']);
  assert.match(out.variables.message.stringValues[0], /Checks passed for September 2026.*tester@example\.com/);
  assert.equal(studio.triggers.length, 1);
  assert.equal(studio.triggers[0].getHandlerFunction(), 'runQueuedStudioBuild');
  assert.ok(!has(sep, 'DAIRYPILL_EOM COGS - September 2026'), 'the check step changes nothing in Drive');

  // A second run while one is queued is turned away (can retry later).
  const busy = error(plain(ctx.onStudioRunShopify(run('September 2026'))));
  assert.match(busy.errorLog.textFormatElements[0].text, /already running/);
  assert.equal(busy.retryability, 'RETRYABLE');

  ctx.runQueuedStudioBuild({});
  assert.ok(has(sep, 'DAIRYPILL_EOM COGS - September 2026'), 'workbook built');
  assert.equal(studio.mails.length, 1);
  assert.equal(studio.mails[0].to, 'tester@example.com');
  assert.match(studio.mails[0].subject, /EOM workbook — September 2026 — ready/);
  assert.match(studio.mails[0].body, /https:\/\/docs\.google\.com.*Checks tab/s);
  assert.equal(studio.props.size, 0, 'job cleared');
  assert.equal(studio.triggers.length, 0, 'trigger removed');
});

test('Shopify: when triggers are not allowed it builds inside the step and returns DONE with the link', () => {
  const { ctx, studio, sep } = setup({ noTriggers: true });
  const out = outputs(plain(ctx.onStudioRunShopify(run('September 2026'))));
  assert.deepEqual(out.variables.status.stringValues, ['DONE']);
  assert.match(out.variables.message.stringValues[0], /Shopify Sell Thru file is ready: https:\/\/docs\.google\.com/);
  assert.ok(has(sep, 'DairyPill Sell Thru Sep 2026'));
  assert.equal(studio.props.size, 0);
});

test('another build starting at the same moment is turned away (retryable)', () => {
  const { ctx, studio } = setup();
  studio.lockFree = false;
  const err = error(plain(ctx.onStudioRunEOM(run(''))));
  assert.match(err.errorLog.textFormatElements[0].text, /Another DairyPill build is starting/);
  assert.equal(err.retryability, 'RETRYABLE');
});

test('Studio quick check catches a Manual Orders row with no date, or a Shopify export without status columns, before queuing', () => {
  const { ctx, studio, sep } = setup();
  const raw = sampleRaw(2026, 8);
  const manualFile = sep.getFilesByName('manual orders.csv').next();
  manualFile.content = csv(raw.manual.concat([['MANUAL', '150', '50001', '1', '']]));
  let err = error(ctx.onStudioRunEOM(run('September 2026')));
  assert.match(err.errorLog.textFormatElements[0].text, /Manual Orders row 6 \(SKU 50001\) has no DATE/);
  assert.equal(studio.triggers.length, 0, 'nothing queued');
  manualFile.content = csv(raw.manual);
  const shopFile = sep.getFilesByName('orders_export.csv').next();
  shopFile.content = csv(raw.shopify.map((r) => r.slice(0, 9))); // drop Cancelled at + Lineitem fulfillment status
  err = error(ctx.onStudioRunEOM(run('September 2026')));
  assert.match(err.errorLog.textFormatElements[0].text, /missing the column "Cancelled at"/);
  assert.equal(studio.triggers.length, 0, 'nothing queued');
});
