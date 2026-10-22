// Loads the Apps Script files (Config.gs + Logic.gs) into a sandbox so Node can test them.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLogic() {
  const ctx = vm.createContext({ console });
  for (const f of ['Config.gs', 'Logic.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

module.exports = { loadLogic };
