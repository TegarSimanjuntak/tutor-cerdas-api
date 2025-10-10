// src/lib/fetcher.js
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    // undici provides fetch in Node 18+
    fetchFn = require('undici').fetch;
  } catch (e) {
    throw new Error('No fetch available. Install undici or upgrade Node.');
  }
}
module.exports = { fetch: fetchFn };
