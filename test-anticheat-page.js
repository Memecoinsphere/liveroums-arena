// Page /admin/anti-triche : rendu avec agent en ligne, en veille (pas de réponse) et injoignable
// Usage : node test-anticheat-page.js  (bases temporaires, ports libres)
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), assert = require('assert');
let P = 0, F = 0; const ok = async (n, f) => { try { await f(); console.log('✅ ' + n); P++; } catch (e) { console.log('❌ ' + n + ' — ' + e.message); F++; } };
const listen = h => new Promise(r => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const site = (port, url) => new Promise((res, rej) => {
  const db = `/tmp/ac-page-${port}.db`; for (const s of ['', '-wal', '-shm']) fs.rmSync(db + s, { force: true });
  const c = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: port, DB_FILE: db, NODE_ENV: 'test', WHEEL_TEST_FORCE: '1', ANTICHEAT_URL: url, ANTICHEAT_STATUS_TIMEOUT_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', d => /localhost/.test(d) && res(c)); c.on('exit', code => rej(new Error('exit ' + code))); setTimeout(() => rej(new Error('timeout')), 8000);
});
async function adminPage(port) {
  const B = `http://127.0.0.1:${port}`; let ck = '';
  const f = async (p, o = {}) => { const r = await fetch(B + p, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: ck } }); const sc = r.headers.getSetCookie(); if (sc.length) ck = sc.map(x => x.split(';')[0]).join('; '); return r; };
  const tok = (await (await f('/api/csrf')).json()).csrf;
  await f('/connexion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': tok }, body: 'login=admin%40liveroums.gg&password=Admin123!' });
  const t0 = Date.now(), r = await f('/admin/anti-triche'); return { r, html: await r.text(), ms: Date.now() - t0 };
}
(async () => {
  const up = await listen((q, s) => q.url === '/healthz' ? s.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') : s.writeHead(200).end('agent'));
  const asleep = await listen(() => {}); // ne répond jamais (service Render en cours de réveil)
  const procs = [];
  try {
    const urlUp = `http://127.0.0.1:${up.address().port}`;
    procs.push(await site(3091, urlUp), await site(3092, `http://127.0.0.1:${asleep.address().port}`), await site(3093, 'http://127.0.0.1:1'));
    await ok('Agent en ligne : statut 🟢, iframe + lien nouvel onglet (noopener), frame-src = origine de l agent', async () => {
      const { r, html } = await adminPage(3091); assert.equal(r.status, 200);
      assert.match(html, /🟢 En ligne/); assert.match(html, new RegExp(`<iframe class="ac-frame" src="${urlUp}/"`));
      assert.match(html, new RegExp(`href="${urlUp}/" target="_blank" rel="noopener noreferrer"`)); assert.match(html, /c'est toi, admin, qui décides/);
      assert.match(r.headers.get('content-security-policy'), new RegExp(`frame-src 'self' ${urlUp};`));
    });
    await ok('Agent en veille : page rendue rapidement avec « ~30 s »', async () => {
      const { r, html, ms } = await adminPage(3092); assert.equal(r.status, 200); assert.match(html, /🟡 En veille/); assert.match(html, /~30 s/); assert.ok(ms < 5000, ms + ' ms');
    });
    await ok('Agent injoignable : page rendue, statut 🔴, lien de secours présent', async () => {
      const { r, html } = await adminPage(3093); assert.equal(r.status, 200); assert.match(html, /🔴 Injoignable/); assert.match(html, /Ouvrir dans un nouvel onglet/);
    });
  } finally { procs.forEach(p => p.kill()); up.close(); asleep.closeAllConnections?.(); asleep.close(); }
  console.log(`Résultat : ${P} réussis, ${F} échoués`); process.exit(F ? 1 : 0);
})();
