// Comportements globaux (remplacent les attributs on* interdits par la CSP) + jeton CSRF pour les fetch POST
(() => {
  const t = document.querySelector('meta[name="csrf-token"]')?.content;
  const f = window.fetch;
  window.fetch = (url, opt = {}) => {
    if (t && opt.method && opt.method.toUpperCase() !== 'GET') { const h = new Headers(opt.headers || {}); h.set('X-CSRF-Token', t); opt = { ...opt, headers: h }; }
    return f(url, opt);
  };
  document.addEventListener('change', e => { if (e.target.matches('[data-autosubmit]')) e.target.form.submit(); });
  document.addEventListener('submit', e => { const m = e.target.getAttribute('data-confirm'); if (m && !confirm(m)) e.preventDefault(); }, true);
})();
