// Migration : une base antérieure à la vérification d'email garde tous ses comptes actifs
// Usage : node test-email-migration.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const Database = require('better-sqlite3'), bcrypt = require('bcrypt');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), file = path.join(dir, 'old.db'), PORT = 3200 + Math.floor(Math.random() * 300);
// Base « ancienne » : table users sans email_verified / verified_at
const old = new Database(file);
old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, pseudo TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, platform TEXT NOT NULL, game_id TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
old.prepare('INSERT INTO users(pseudo,email,password_hash,platform,is_admin) VALUES(?,?,?,?,?)').run('Admin', 'admin@liveroums.gg', bcrypt.hashSync('Admin123!', 4), 'PC', 1);
old.prepare('INSERT INTO users(pseudo,email,password_hash,platform) VALUES(?,?,?,?)').run('Ancien', 'ancien@t.gg', bcrypt.hashSync('MotDePasse1', 4), 'PC');
old.close();
const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DB_FILE: file, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', async d => { if (!/localhost/.test(d)) return;
  try {
    const B = `http://127.0.0.1:${PORT}`; let ck = '';
    const go = async (p, o = {}) => { const r = await fetch(B + p, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: ck } }); const sc = r.headers.getSetCookie(); if (sc.length) ck = sc.map(x => x.split(';')[0]).join('; '); return r; };
    const { csrf } = await (await go('/api/csrf')).json();
    const r = await go('/connexion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf }, body: 'login=Ancien&password=MotDePasse1' });
    assert.strictEqual(r.headers.get('location'), '/profil', 'le compte existant doit pouvoir se connecter');
    assert.strictEqual((await go('/profil')).status, 200);
    const db = new Database(file, { readonly: true });
    assert.deepStrictEqual(db.prepare('SELECT pseudo, email_verified FROM users ORDER BY id').all().map(u => [u.pseudo, u.email_verified]), [['Admin', 1], ['Ancien', 1]]);
    assert.ok(db.prepare("SELECT verified_at FROM users WHERE pseudo='Ancien'").get().verified_at);
    console.log('✅ Migration : comptes existants marqués vérifiés (verified_at renseigné), connexion OK'); srv.kill(); process.exit(0);
  } catch (e) { console.log('❌ Migration — ' + e.message); srv.kill(); process.exit(1); }
});
srv.on('exit', c => { if (c) { console.log('❌ serveur arrêté ' + c); process.exit(1); } });
