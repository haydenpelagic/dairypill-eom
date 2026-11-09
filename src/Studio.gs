// =============================================================================
// DairyPill EOM Report — WORKSPACE STUDIO STEPS (Rule 1.5)
//   "Build DairyPill EOM"              → buildEOMFor_(month)
//   "Build DairyPill Shopify Sell Thru" → shopifyOnlyFor_(month)
// A flow ("Start manually" + one of these steps) passes a Month. The step checks
// the folder in a few seconds (problems show in the flow's activity log), then
// queues the real build to run in the background and emails the result — so a
// build of several minutes never depends on how long Studio waits for a step.
// Wiring: appsscript.json → addOns.flows.workflowElements.
// =============================================================================

var STUDIO_JOB_KEY_ = 'STUDIO_JOB';
var STUDIO_JOB_STALE_MS_ = 30 * 60 * 1000; // a queued job older than this is treated as dead
var STUDIO_KINDS_ = {
  EOM: { title: 'Build DairyPill EOM', what: 'EOM workbook' },
  SHOPIFY: { title: 'Build DairyPill Shopify Sell Thru', what: 'Shopify Sell Thru file' }
};

// ---- Studio callbacks (names are referenced from appsscript.json) -----------

function onStudioConfigEOM(e) { return studioConfigCard_('EOM', e); }
function onStudioConfigShopify(e) { return studioConfigCard_('SHOPIFY', e); }
function onStudioRunEOM(e) { return studioRun_('EOM', e); }
function onStudioRunShopify(e) { return studioRun_('SHOPIFY', e); }

/** Time-driven trigger target: runs the job a Studio step queued, then emails the result. */
function runQueuedStudioBuild(e) {
  deleteStudioTriggers_();
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(STUDIO_JOB_KEY_);
  if (!raw) return;
  var job = JSON.parse(raw);
  try {
    runStudioJob_(job);
  } finally {
    props.deleteProperty(STUDIO_JOB_KEY_);
  }
}

// ---- Implementation ---------------------------------------------------------

function studioConfigCard_(kind, e) {
  var saved = studioMonthInput_(e && e.workflow && e.workflow.elementConfiguration);
  var card = {
    sections: [{
      header: STUDIO_KINDS_[kind].title,
      widgets: [
        { textParagraph: { text: 'Builds the ' + STUDIO_KINDS_[kind].what + ' from the month folder, in the background. ' +
          'You get an email with the link (or the problem) when it finishes.' } },
        { textInput: {
          name: 'month',
          label: 'Month (e.g. October 2026)',
          hintText: 'Exactly like the month folder name. Leave blank for last month. Can be a variable from the starter.',
          value: saved,
          hostAppDataSource: { workflowDataSource: { includeVariables: true } }
        } }
      ]
    }]
  };
  return { action: { navigations: [{ pushCard: card }] } };
}

/** Reads the "month" input from an actionInvocation / elementConfiguration ('' when absent). */
function studioMonthInput_(holder) {
  var v = holder && holder.inputs && holder.inputs.month && holder.inputs.month.stringValues;
  return v && v.length ? String(v[0]).trim() : '';
}

/** Rule 1.5: check quickly, queue, report. Never throws — Studio gets a plain-English error instead. */
function studioRun_(kind, e) {
  var month = studioMonthInput_(e && e.workflow && e.workflow.actionInvocation);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return studioError_('Another DairyPill build is starting right now. Wait a minute and run the flow again.', true);
  try {
    var props = PropertiesService.getScriptProperties();
    var running = props.getProperty(STUDIO_JOB_KEY_);
    if (running) {
      var r = JSON.parse(running);
      if (new Date().getTime() - r.queuedAt < STUDIO_JOB_STALE_MS_) {
        return studioError_('A build of ' + r.month + ' (' + STUDIO_KINDS_[r.kind].what + ') is already running. ' +
          'Wait for its email, then run the flow again if you still need to.', true);
      }
    }
    var check = preflight_(kind, month);
    var job = { kind: kind, month: check.label, email: studioUserEmail_(), queuedAt: new Date().getTime() };
    props.setProperty(STUDIO_JOB_KEY_, JSON.stringify(job));
    try {
      deleteStudioTriggers_();
      ScriptApp.newTrigger('runQueuedStudioBuild').timeBased().after(1000).create();
    } catch (err) {
      // Background runs not allowed here: build now, inside the step, and report directly.
      props.deleteProperty(STUDIO_JOB_KEY_);
      var res = runStudioJob_(job);
      return res.ok ? studioOk_('DONE', res.message) : studioError_(res.message, false);
    }
    return studioOk_('STARTED', 'Checks passed for ' + check.label + '. Building the ' + STUDIO_KINDS_[kind].what +
      ' in the background — an email to ' + (job.email || 'you') + ' will have the link (usually within 5 minutes).');
  } catch (err) {
    return studioError_(errorText_(err), false);
  } finally {
    lock.releaseLock();
  }
}

/** Runs one build and emails the outcome. Returns {ok, message}; never throws. */
function runStudioJob_(job) {
  var what = STUDIO_KINDS_[job.kind].what;
  var ok, message, url;
  try {
    url = job.kind === 'SHOPIFY' ? shopifyOnlyFor_(job.month) : buildEOMFor_(job.month);
    ok = true;
    message = 'The ' + job.month + ' ' + what + ' is ready: ' + url +
      (job.kind === 'EOM' ? '\n\nOpen the Checks tab first — anything marked FLAG needs attention.' : '');
  } catch (err) {
    ok = false;
    message = 'The ' + job.month + ' ' + what + ' was NOT built.\n\nProblem: ' + errorText_(err) +
      '\n\nFix it in the month folder, then run the flow again.';
  }
  log_(message);
  if (job.email) {
    try {
      MailApp.sendEmail(job.email, 'DairyPill ' + what + ' — ' + job.month + (ok ? ' — ready' : ' — FAILED'), message);
    } catch (mailErr) {
      log_('Could not send the result email: ' + errorText_(mailErr));
    }
  }
  return { ok: ok, message: message };
}

function deleteStudioTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runQueuedStudioBuild') ScriptApp.deleteTrigger(t);
  });
}

function studioUserEmail_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (err) { /* fall through */ }
  if (!email) { try { email = Session.getEffectiveUser().getEmail(); } catch (err) { /* none */ } }
  return email;
}

function errorText_(err) { return err && err.message ? err.message : String(err); }

function studioOk_(status, message) {
  return { hostAppAction: { workflowAction: { returnOutputVariablesAction: {
    variables: { status: { stringValues: [status] }, message: { stringValues: [message] } },
    log: { textFormatElements: [{ text: message }] }
  } } } };
}

function studioError_(message, retryable) {
  return { hostAppAction: { workflowAction: { returnElementErrorAction: {
    errorLog: { textFormatElements: [{ text: message }] },
    developerErrorMessage: message,
    retryability: retryable ? 'RETRYABLE' : 'NOT_RETRYABLE',
    errorActionability: 'ACTIONABLE'
  } } } };
}
