// Loaded with --require by test/clasprc.test.js: no network in tests — every fetch fails like an unreachable host.
'use strict';
globalThis.fetch = async () => { throw new Error('no network in tests'); };
