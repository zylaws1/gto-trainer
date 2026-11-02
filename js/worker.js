// Web Worker: runs ComputeFns off the main thread so the page never freezes on slow devices.
// The ?v= cache-busting stamp on this script's URL is forwarded to every imported file.
const v = self.location.search;
importScripts(...['i18n.js', 'cards.js', 'charts.js', 'engine.js', 'eqtable.js', 'icm.js', 'modes.js', 'multiway.js', 'classify.js', 'compute-fns.js']
  .map(f => f + v));

self.onmessage = e => {
  const { id, fn, args } = e.data;
  try {
    self.postMessage({ id, r: ComputeFns[fn](...args) });
  } catch (err) {
    self.postMessage({ id, err: String((err && err.stack) || err) });
  }
};
