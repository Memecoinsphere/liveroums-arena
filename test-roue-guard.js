// Vérifie que le tirage forcé de la Roue est ignoré hors mode test (NODE_ENV=production + WHEEL_TEST_FORCE=1)
// Usage : node test-roue-guard.js  (base temporaire, code de sortie 0 = OK)
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.GUARD_CHILD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-'));
  try { execFileSync(process.execPath, [__filename], { env: { ...process.env, GUARD_CHILD: '1', DB_FILE: path.join(dir, 'g.db'), NODE_ENV: 'production', WHEEL_TEST_FORCE: '1' }, stdio: 'inherit' }); console.log('OK : tirage forcé ignoré en production'); }
  catch { console.error('ÉCHEC : le tirage forcé est exploitable hors test'); process.exit(1); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else {
  const db = require('./db'); let spin;
  require('./roue')({ get() {}, post(p, ...f) { if (p === '/roue/tourner') spin = f[1]; } }, {});
  let n = 0;
  for (let i = 0; i < 300; i++) {
    db.prepare('DELETE FROM prize_claims').run(); db.prepare('DELETE FROM wheel_spins').run(); let j;
    spin({ user: { id: 1 }, body: { force: 'sub' }, get: () => 'application/json' }, { json: x => (j = x), status() { return this; } });
    if (j.segment === 'sub') n++;
  }
  process.exit(n < 10 ? 0 : 1); // proba naturelle 0,2 % → ~0,6 attendu sur 300
}
