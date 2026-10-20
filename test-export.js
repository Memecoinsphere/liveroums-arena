// Test de l'API d'export Bearer + import dans l'agent anti-triche (lecture seule du code de l'agent)
// Usage : DB_FILE=<base remplie par test-e2e.sh> [AGENT_DIR=../liveroums-anticheat] node test-export.js
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = process.env.DB_FILE || '/tmp/lp-test.db', TOKEN = 'tok-' + require('crypto').randomBytes(16).toString('hex');
const AGENT = process.env.AGENT_DIR || path.join(__dirname, '..', 'liveroums-anticheat');
let P = 0, F = 0; const ok = async (n, f) => { try { await f(); console.log('✅ ' + n); P++; } catch (e) { console.log('❌ ' + n + ' — ' + e.message); F++; } };
const start = (port, env) => new Promise((res, rej) => {
  const db = `/tmp/export-test-${port}.db`; for (const s of ['', '-wal', '-shm']) { fs.rmSync(db + s, { force: true }); if (fs.existsSync(SRC + s)) fs.copyFileSync(SRC + s, db + s); }
  const c = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: port, DB_FILE: db, NODE_ENV: 'test', WHEEL_TEST_FORCE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', d => /localhost/.test(d) && res(c)); c.on('exit', code => rej(new Error('serveur arrêté ' + code))); setTimeout(() => rej(new Error('timeout')), 8000);
});
(async () => {
  const on = await start(3078, { ANTICHEAT_EXPORT_TOKEN: TOKEN }), off = await start(3079, { ANTICHEAT_EXPORT_TOKEN: '' });
  const B = 'http://127.0.0.1:3078/api/admin/anticheat-export'; let data;
  try {
    await ok('API : 404 quand ANTICHEAT_EXPORT_TOKEN est absent', async () => assert.equal((await fetch('http://127.0.0.1:3079/api/admin/anticheat-export', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 404));
    await ok('API : 401 sans jeton', async () => { const r = await fetch(B); assert.equal(r.status, 401); assert.equal(r.headers.get('www-authenticate'), 'Bearer'); });
    await ok('API : 401 avec un mauvais jeton', async () => assert.equal((await fetch(B, { headers: { authorization: 'Bearer ' + TOKEN + 'x' } })).status, 401));
    await ok('API : 200 avec le bon jeton, sans cache', async () => { const r = await fetch(B, { headers: { authorization: 'Bearer ' + TOKEN } }); assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /no-store/); data = await r.json(); });
    await ok('API : format agent, identifiants sensibles hachés, ni email ni mot de passe', async () => {
      assert.ok(data.players.length > 5 && data.matches.length > 5 && data.points.length);
      const s = JSON.stringify(data); assert.ok(!/@t\.gg|@liveroums\.gg|password|\$2[aby]\$/.test(s), 'donnée sensible trouvée');
      for (const p of data.players) { assert.ok(!('email' in p)); for (const l of p.linked) assert.match(l.account_id, /^h:[0-9a-f]{32}$/); }
      assert.ok(data.players.some(p => p.linked.length), 'aucun compte lié dans les données de test');
    });
    await ok('API : since invalide → 400', async () => assert.equal((await fetch(B + '?since=nope', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 400));
    await ok('API : limite de débit (429 après 6 requêtes/min)', async () => { let last; for (let i = 0; i < 6; i++) last = (await fetch(B, { headers: { authorization: 'Bearer x' } })).status; assert.equal(last, 429); });
    // Import dans l'agent : même JSON que le téléchargement admin et que l'API
    await ok("Agent : le JSON exporté s'importe et s'analyse", async () => {
      const { open, dataset } = require(path.join(AGENT, 'src/db')), { importData } = require(path.join(AGENT, 'src/importer')), D = require(path.join(AGENT, 'src/detectors'));
      const adminJson = fs.readFileSync(process.env.ADMIN_JSON || fs.readdirSync('/tmp').filter(f => /^ex\d+\.json$/.test(f)).map(f => '/tmp/' + f).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0], 'utf8');
      for (const [nom, input] of [['admin', adminJson], ['api', JSON.stringify(data)]]) {
        const db = open(':memory:'), n = importData(db, input, 'export-' + nom), ds = dataset(db);
        assert.equal(n.joueurs, JSON.parse(input).players.length); assert.equal(n.parties, JSON.parse(input).matches.length);
        assert.ok(ds.matches.length > 0 && ds.linked.length > 0); const sc = D.score(ds, Date.now());
        console.log(`   ${nom} : ${n.joueurs} joueurs, ${n.parties} parties, ${n.comptes} comptes liés importés ; ${Object.values(sc).filter(x => x.score > 0).length} joueurs avec un score > 0`);
      }
    });
  } finally { on.kill(); off.kill(); }
  console.log(`Résultat : ${P} réussis, ${F} échoués`); process.exit(F ? 1 : 0);
})();
