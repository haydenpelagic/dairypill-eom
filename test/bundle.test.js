'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bundle } = require('../tools/bundle');

test('dist/DairyPill_EOM.gs is up to date with src/ (run `npm run bundle` if this fails)', () => {
  const current = fs.readFileSync(path.join(__dirname, '..', 'dist', 'DairyPill_EOM.gs'), 'utf8');
  assert.equal(current, bundle());
});

test('dist/ holds exactly what clasp uploads: the bundle + appsscript.json (run `npm run bundle` if this fails)', () => {
  const root = path.join(__dirname, '..');
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'appsscript.json'), 'utf8'), fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['DairyPill_EOM.gs', 'appsscript.json']);
  const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));
  assert.equal(clasp.rootDir, 'dist');
  assert.match(clasp.scriptId, /^1RblqXtQ/);
});
