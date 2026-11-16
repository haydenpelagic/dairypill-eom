#!/usr/bin/env node
// Deploy helper (GitHub Actions, "Load the Google sign-in" step): turns the CLASPRC_JSON repository secret into
// the ~/.clasprc.json that the uploader (clasp 2.4.2) reads. It accepts the sign-in file from either version of
// `clasp login`:
//   clasp 2.x  { token: {...}, oauth2ClientSettings: {...}, isLocalCreds }       -> used as is
//   clasp 3.x  { tokens: { default: { client_id, client_secret, refresh_token } } } -> converted to the 2.x layout
// Anything else (an empty secret, a paste that isn't the sign-in file) stops the deploy with a plain-English reason.
// Then it asks Google whether the sign-in still works (a token refresh — nothing is changed) and, if not, prints
// Google's own reason in plain English (expired/revoked vs. a Workspace "sign in again every N hours" rule).
// `--check-only` (the weekly "Check Google sign-in" workflow) does the same without writing the file.
// The secret itself is never printed; the account is shown masked (h***@example.com).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REDO = 'On your Mac run `pbcopy < ~/.clasprc.json`, paste it into the CLASPRC_JSON secret straight away ' +
  '(before copying anything else), then re-run this deploy. SETUP.md section 2 has the steps.';

/** Returns { format, rc } where rc is the clasp 2.4.2 sign-in object, or throws an Error with a plain-English message. */
function toClasp2(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('The CLASPRC_JSON secret is empty, so nothing was uploaded to Apps Script. ' + REDO);
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error('The CLASPRC_JSON secret is not a Google sign-in file (it is ' + text.length +
      ' characters of text that is not a sign-in file). Usually the clipboard held something else when it was pasted. ' + REDO);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error('The CLASPRC_JSON secret is not a Google sign-in file. ' + REDO);
  }
  // clasp 2.x layout: what the uploader reads.
  if (j.token && j.oauth2ClientSettings) {
    if (!j.token.refresh_token) {
      throw new Error('The Google sign-in in CLASPRC_JSON has no refresh token. Log in again with `npx @google/clasp@2.4.2 login`, then: ' + REDO);
    }
    return { format: 'clasp 2 sign-in', rc: j };
  }
  // clasp 3.x layout: one entry per named user; `clasp login` saves "default".
  if (j.tokens && typeof j.tokens === 'object') {
    const t = j.tokens.default;
    if (!t) {
      throw new Error('The CLASPRC_JSON secret is a clasp 3 sign-in with no "default" user (it has: ' +
        Object.keys(j.tokens).join(', ') + '). Log in again with plain `clasp login` (no --user), then: ' + REDO);
    }
    if (!t.refresh_token || !t.client_id || !t.client_secret) {
      throw new Error('The clasp 3 sign-in in CLASPRC_JSON is incomplete (it needs a refresh token, client id and client secret). ' +
        'Log in again, then: ' + REDO);
    }
    const token = { refresh_token: t.refresh_token, token_type: t.token_type || 'Bearer' };
    ['access_token', 'expiry_date', 'scope', 'id_token'].forEach(function (k) { if (t[k] != null) token[k] = t[k]; });
    return {
      format: 'clasp 3 sign-in, converted for the uploader',
      rc: { token: token, oauth2ClientSettings: { clientId: t.client_id, clientSecret: t.client_secret, redirectUri: 'http://localhost' }, isLocalCreds: false }
    };
  }
  throw new Error('The CLASPRC_JSON secret is not a clasp sign-in file (it has: ' + Object.keys(j).join(', ') + '). ' + REDO);
}

const RELOGIN = 'Sign in again on your Mac with `npx @google/clasp@2.4.2 login`, then ' + REDO.charAt(0).toLowerCase() + REDO.slice(1);

/** "hayden@pelagic.co" -> "h***@pelagic.co" (enough to tell which account and which company, in a shared log). */
function maskEmail(email) {
  const m = /^(.)[^@]*(@.+)$/.exec(String(email || ''));
  return m ? m[1] + '***' + m[2] : '';
}

/**
 * Turns Google's answer to a failed token refresh into a plain-English reason and what to do.
 * `err` = Google's JSON ({error, error_description, error_subtype}).
 */
function explainGoogleError(err) {
  const code = String((err && err.error) || 'unknown_error');
  const desc = String((err && err.error_description) || '');
  const said = 'Google said: ' + code + (desc ? ' — "' + desc + '"' : '') + '.';
  if (/rapt|reauth/i.test(desc + ' ' + ((err && err.error_subtype) || ''))) {
    return 'The Google sign-in was cut off by a Google Workspace security rule that makes this account sign in again every so often ' +
      '("Google Cloud session control"). That is why it keeps expiring. Permanent fix: in the Google Admin console of the account\'s ' +
      'company, Security → Access and data control → Google Cloud session control → set Reauthentication to "Never require reauthentication" ' +
      '(or exempt trusted apps and mark "clasp" as Trusted under API controls). Or sign in with an account whose company has no such rule. ' +
      'Then: ' + RELOGIN + ' ' + said;
  }
  if (code === 'invalid_grant') {
    return 'Google no longer accepts this sign-in (expired or revoked). Usual causes: someone ran `clasp logout`; clasp\'s access was removed ' +
      '(Google Account → Security → Third-party connections); the account\'s password was changed; or a Workspace admin rule. ' + RELOGIN + ' ' + said;
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return 'Google does not recognise the app this sign-in was made with (its client was deleted or blocked). ' + RELOGIN + ' ' + said;
  }
  return 'Google refused the sign-in. ' + RELOGIN + ' ' + said;
}

/**
 * Asks Google to refresh the access token with the saved sign-in (changes nothing). Resolves to
 * {ok: true, account} or {ok: false, message}; a network problem resolves to {ok: true, warning} (the upload will tell).
 */
async function checkWithGoogle(rc, fetchFn) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rc.token.refresh_token,
    client_id: rc.oauth2ClientSettings.clientId, client_secret: rc.oauth2ClientSettings.clientSecret });
  let res, j;
  try {
    res = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    j = await res.json();
  } catch (e) {
    return { ok: true, warning: 'Could not reach Google to check the sign-in (' + e.message + '); carrying on.' };
  }
  if (!res.ok || !j || !j.access_token) return { ok: false, message: explainGoogleError(j) };
  let account = '';
  try {
    const info = await (await fetchFn('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(j.access_token))).json();
    account = maskEmail(info && info.email);
  } catch (e) { /* the account name is only a nicety */ }
  return { ok: true, account: account };
}

async function main() {
  const checkOnly = process.argv.indexOf('--check-only') >= 0;
  try {
    const out = toClasp2(process.env.CLASPRC_JSON);
    const google = await checkWithGoogle(out.rc, fetch);
    if (!google.ok) throw new Error(google.message);
    if (google.warning) console.log('::warning::' + google.warning);
    if (!checkOnly) {
      const file = path.join(os.homedir(), '.clasprc.json');
      fs.writeFileSync(file, JSON.stringify(out.rc), { mode: 0o600 });
    }
    console.log('Google sign-in ' + (checkOnly ? 'checked' : 'loaded') + ' (' + out.format + ')' +
      (google.account ? ': Google accepts it, signed in as ' + google.account : google.warning ? '' : ': Google accepts it') + '.');
  } catch (e) {
    console.log('::error::' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { toClasp2, checkWithGoogle, explainGoogleError, maskEmail };
