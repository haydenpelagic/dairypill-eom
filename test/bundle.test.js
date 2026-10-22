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
