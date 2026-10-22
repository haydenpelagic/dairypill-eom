// Combines src/*.gs into dist/DairyPill_EOM.gs — the ONE file you paste into Apps Script.
'use strict';
const fs = require('fs');
const path = require('path');

const ORDER = ['Config.gs', 'Main.gs', 'Logic.gs', 'Sheets.gs'];

function bundle() {
  const root = path.join(__dirname, '..');
  const parts = ORDER.map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8').trim() + '\n');
  return '// DairyPill EOM Report — generated from src/ by `npm run bundle`. Do not edit here; edit src/ and re-bundle.\n' +
    '// Paste this whole file into Apps Script (see SETUP.md). Settings are at the top.\n\n' + parts.join('\n');
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'dist', 'DairyPill_EOM.gs');
  fs.writeFileSync(out, bundle());
  console.log('Wrote ' + out);
}

module.exports = { bundle };
