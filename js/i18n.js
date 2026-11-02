// Minimal two-language support. Strings are written inline as tr(chinese, english) so both
// versions share the same interpolated values. Static HTML uses data-en attributes.
const I18N = (() => {
  let lang = (() => {
    try { const p = JSON.parse(localStorage.getItem('gto-trainer-prefs')); if (p && p.lang) return p.lang; } catch { /* no saved prefs */ }
    return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })();

  // Swaps every [data-en] element (and [data-en-title] / [data-en-ph] attributes) between languages.
  function applyStatic(root = document) {
    root.querySelectorAll('[data-en]').forEach(el => {
      if (el.dataset.zh === undefined) el.dataset.zh = el.innerHTML;
      el.innerHTML = lang === 'en' ? el.dataset.en : el.dataset.zh;
    });
    root.querySelectorAll('[data-en-title]').forEach(el => {
      if (el.dataset.zhTitle === undefined) el.dataset.zhTitle = el.title;
      el.title = lang === 'en' ? el.dataset.enTitle : el.dataset.zhTitle;
    });
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }

  return {
    get lang() { return lang; },
    set lang(v) { lang = v === 'en' ? 'en' : 'zh'; },
    applyStatic,
  };
})();
const tr = (zh, en) => (I18N.lang === 'en' ? en : zh);
