'use strict';
// tools/clasprc.js: the deploy's sign-in check. Made-up credentials only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toClasp2, checkWithGoogle, explainGoogleError, maskEmail } = require('../tools/clasprc');

const SECRET = 'REFRESH-TOKEN-THAT-MUST-NEVER-BE-PRINTED';
const clasp2 = { token: { access_token: 'a', refresh_token: SECRET, scope: 's', token_type: 'Bearer', expiry_date: 1 },
  oauth2ClientSettings: { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost' }, isLocalCreds: false };
const clasp3 = { tokens: { default: { client_id: 'cid', client_secret: 'csecret', type: 'authorized_user', refresh_token: SECRET,
  access_token: 'a', token_type: 'Bearer', expiry_date: 1 } } };

test('a clasp 2 sign-in is used as is', () => {
  const out = toClasp2(JSON.stringify(clasp2));
  assert.equal(out.format, 'clasp 2 sign-in');
  assert.deepEqual(out.rc, clasp2);
});

test('a clasp 3 sign-in is converted to the layout the uploader (clasp 2.4.2) reads', () => {
  const out = toClasp2('\n' + JSON.stringify(clasp3) + '\n'); // a pasted trailing newline is fine
  assert.match(out.format, /clasp 3/);
  assert.deepEqual(out.rc, {
    token: { refresh_token: SECRET, token_type: 'Bearer', access_token: 'a', expiry_date: 1 },
    oauth2ClientSettings: { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost' }, isLocalCreds: false
  });
});

test('anything that is not a sign-in file stops with a plain-English reason, and never echoes the paste', () => {
  const pasted = 'Goal: finish deploying my DairyPill EOM script ' + SECRET;
  assert.throws(() => toClasp2(pasted), (e) => /is not a Google sign-in file/.test(e.message) && /pbcopy/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => toClasp2(''), /secret is empty/);
  assert.throws(() => toClasp2('   '), /secret is empty/);
  assert.throws(() => toClasp2('[1,2]'), /not a Google sign-in file/);
  assert.throws(() => toClasp2('{"installed":{"client_id":"x"}}'), /not a clasp sign-in file \(it has: installed\)/);
  assert.throws(() => toClasp2(JSON.stringify({ tokens: { work: clasp3.tokens.default } })), /no "default" user \(it has: work\)/);
  const noRefresh = JSON.parse(JSON.stringify(clasp3)); delete noRefresh.tokens.default.refresh_token;
  assert.throws(() => toClasp2(JSON.stringify(noRefresh)), /incomplete/);
  const old = JSON.parse(JSON.stringify(clasp2)); delete old.token.refresh_token;
  assert.throws(() => toClasp2(JSON.stringify(old)), /no refresh token/);
});

test('run as the deploy step: writes ~/.clasprc.json, prints only the format; a bad secret fails the step', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clasprc-'));
  // Google can't be reached from the test (a proxy that refuses) → a warning, and the step carries on.
  const run = (secret) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'clasprc.js')],
    { env: { HOME: home, USERPROFILE: home, CLASPRC_JSON: secret, NODE_OPTIONS: '--require ' + path.join(__dirname, 'fixtures', 'noNetwork.js') }, encoding: 'utf8' });
  const ok = run(JSON.stringify(clasp3));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Could not reach Google to check the sign-in/);
  assert.match(ok.stdout, /Google sign-in loaded \(clasp 3 sign-in, converted/);
  assert.ok(!ok.stdout.includes(SECRET));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.clasprc.json'), 'utf8')).token.refresh_token, SECRET);
  const bad = run('not a sign-in ' + SECRET);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^::error::The CLASPRC_JSON secret is not a Google sign-in file/);
  assert.ok(!bad.stdout.includes(SECRET));
});

/** A stand-in for fetch: answers the token call with `token`, the tokeninfo call with `info`; records what was sent. */
function fakeFetch(status, token, info) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? String(opts.body) : '' });
    const isToken = url.endsWith('/token');
    return { ok: isToken ? status === 200 : true, json: async () => (isToken ? token : info) };
  };
  fn.calls = calls;
  return fn;
}

test('asks Google whether the sign-in still works: OK names the account (masked)', async () => {
  const f = fakeFetch(200, { access_token: 'AT', expires_in: 3599 }, { email: 'hayden@pelagic.co' });
  const r = await checkWithGoogle(toClasp2(JSON.stringify(clasp2)).rc, f);
  assert.deepEqual(r, { ok: true, account: 'h***@pelagic.co' });
  assert.match(f.calls[0].body, /grant_type=refresh_token/);
  assert.match(f.calls[0].body, /client_id=cid/);
  assert.equal(maskEmail('ops@dairypill.com'), 'o***@dairypill.com');
  assert.equal(maskEmail(''), '');
});

test('a dead sign-in fails with Google\'s reason in plain English — and the secret is never in the message', async () => {
  const rc = toClasp2(JSON.stringify(clasp2)).rc;
  const reauth = await checkWithGoogle(rc, fakeFetch(400, { error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)', error_subtype: 'invalid_rapt' }));
  assert.equal(reauth.ok, false);
  assert.match(reauth.message, /Google Workspace security rule .* \("Google Cloud session control"\)\. That is why it keeps expiring/);
  assert.match(reauth.message, /Google said: invalid_grant — "reauth related error \(invalid_rapt\)"\./);
  const revoked = await checkWithGoogle(rc, fakeFetch(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  assert.match(revoked.message, /^Google no longer accepts this sign-in \(expired or revoked\)\. Usual causes: someone ran `clasp logout`/);
  assert.match(revoked.message, /npx @google\/clasp@2\.4\.2 login/);
  assert.match(explainGoogleError({ error: 'invalid_client' }), /client was deleted or blocked/);
  for (const m of [reauth.message, revoked.message]) assert.ok(!m.includes(SECRET));
  // Google can't be reached: carry on (the upload step will say if the sign-in is bad)
  const down = await checkWithGoogle(rc, async () => { throw new Error('ECONNRESET'); });
  assert.deepEqual(down, { ok: true, warning: 'Could not reach Google to check the sign-in (ECONNRESET); carrying on.' });
});
