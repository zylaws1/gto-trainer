// Runs ComputeFns in a Web Worker when possible, otherwise in the page.
// Browsers refuse workers for file:// pages, so opening index.html from disk uses the fallback.
const Compute = (() => {
  const ver = (() => { try { return new URL(document.currentScript.src).search; } catch { return ''; } })();
  const waiting = new Map();
  let worker = null, seq = 0;

  const local = (fn, args) => new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(ComputeFns[fn](...args)); } catch (err) { reject(err); }
  }, 0));

  // If the worker fails to start or crashes, finish its queued jobs in the page and stop using it.
  function abandonWorker() {
    if (worker) worker.terminate();
    worker = null;
    for (const w of waiting.values()) local(w.fn, w.args).then(w.resolve, w.reject);
    waiting.clear();
  }

  try {
    if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
      worker = new Worker('js/worker.js' + ver);
      worker.onmessage = e => {
        const { id, r, err } = e.data;
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        if (err) w.reject(new Error(err)); else w.resolve(r);
      };
      worker.onerror = e => { e.preventDefault(); abandonWorker(); };
    }
  } catch { worker = null; }

  function call(fn, ...args) {
    if (!worker) return local(fn, args);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, fn, args });
      worker.postMessage({ id, fn, args });
    });
  }

  return { call, get usingWorker() { return !!worker; } };
})();
