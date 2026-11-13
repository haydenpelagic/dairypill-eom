#!/usr/bin/env node
// Deploy helper (GitHub Actions, "Load the Google sign-in" step): turns the CLASPRC_JSON repository secret into
// the ~/.clasprc.json that the uploader (clasp 2.4.2) reads. It accepts the sign-in file from either version of
// `clasp login`:
//   clasp 2.x  { token: {...}, oauth2ClientSettings: {...}, isLocalCreds }       -> used as is
//   clasp 3.x  { tokens: { default: { client_id, client_secret, refresh_token } } } -> converted to the 2.x layout
// Anything else (an empty secret, a paste that isn't the sign-in file) stops the deploy with a plain-English reason.
// The secret itself is never printed.
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

function main() {
  try {
    const out = toClasp2(process.env.CLASPRC_JSON);
    const file = path.join(os.homedir(), '.clasprc.json');
    fs.writeFileSync(file, JSON.stringify(out.rc), { mode: 0o600 });
    console.log('Google sign-in loaded (' + out.format + ').');
  } catch (e) {
    console.log('::error::' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { toClasp2 };
