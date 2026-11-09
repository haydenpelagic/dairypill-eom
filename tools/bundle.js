// Combines src/*.gs into dist/DairyPill_EOM.gs and copies appsscript.json into dist/.
// dist/ is exactly what clasp uploads to Apps Script (see .clasp.json and SETUP.md).
'use strict';
const fs = require('fs');
const path = require('path');

const ORDER = ['Config.gs', 'Main.gs', 'Studio.gs', 'Logic.gs', 'Sheets.gs'];

function bundle() {
  const root = path.join(__dirname, '..');
  const parts = ORDER.map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8').trim() + '\n');
  return '// DairyPill EOM Report — generated from src/ by `npm run bundle`. Do not edit here; edit src/ and re-bundle.\n' +
    '// Uploaded to Apps Script automatically on every push (see SETUP.md). Settings are at the top.\n\n' + parts.join('\n');
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'dist', 'DairyPill_EOM.gs');
  fs.writeFileSync(out, bundle());
  fs.copyFileSync(path.join(__dirname, '..', 'appsscript.json'), path.join(__dirname, '..', 'dist', 'appsscript.json'));
  console.log('Wrote ' + out + ' and dist/appsscript.json');
}

module.exports = { bundle };
