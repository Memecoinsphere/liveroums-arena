// Mode « Classé » : solo ou quatuor (groupe pré-formé de 4 = équipe complète), équipes équilibrées par SR, écart de SR qui s'élargit avec l'attente
const crypto = require('crypto');
const db = require('./db');
const M = require('./mm');

if (!db.prepare('PRAGMA table_info(lobbies)').all().some(c => c.name === 'ranked')) db.exec('ALTER TABLE lobbies ADD COLUMN ranked INTEGER DEFAULT 0');
db.exec(`
DROP TABLE IF EXISTS duos;
CREATE TABLE IF NOT EXISTS quatuors(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, game TEXT NOT NULL, leader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quatuor_members(quatuor_id INTEGER NOT NULL REFERENCES quatuors(id) ON DELETE CASCADE, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(quatuor_id, user_id));
CREATE TABLE IF NOT EXISTS ranked_queue(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, duo_id INTEGER,
  joined_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')));
`);
// ranked_queue.group_id = quatuor en file (l'ancienne colonne duo_id n'est plus utilisée)
if (!db.prepare('PRAGMA table_info(ranked_queue)').all().some(c => c.name === 'group_id')) db.exec('ALTER TABLE ranked_queue ADD COLUMN group_id INTEGER');

const FORMAT = { 'Call of Duty': 4 }; // classé CoD : 4v4, solo ou quatuor (4 = équipe complète)
const SPREAD0 = 200, SPREAD_STEP = 100, STEP_S = 30;
const groupAllowed = g => FORMAT[g] > 1;
const fmt = g => `${FORMAT[g]}v${FORMAT[g]}`;
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const qCode = () => { for (;;) { const c = Array.from(crypto.randomBytes(5), b => CH[b % CH.length]).join(''); if (!db.prepare('SELECT 1 FROM quatuors WHERE code=?').get(c)) return c; } };
const members = qid => db.prepare('SELECT m.user_id, u.pseudo FROM quatuor_members m JOIN users u ON u.id=m.user_id WHERE m.quatuor_id=? ORDER BY m.joined_at, m.user_id').all(qid);
function myQuatuor(uid) {
  const q = db.prepare('SELECT q.* FROM quatuors q JOIN quatuor_members m ON m.quatuor_id=q.id WHERE m.user_id=?').get(uid);
  if (q) q.members = members(q.id); return q;
}
const inQueue = uid => db.prepare('SELECT * FROM ranked_queue WHERE user_id=?').get(uid);
const busy = uid => { if (M.activeLobby(uid)) throw new Error('Tu es déjà dans une partie en cours.'); };
const unqueue = q => db.prepare('DELETE FROM ranked_queue WHERE group_id=?').run(q.id);

function createQuatuor(uid, game) {
  if (!FORMAT[game]) throw new Error('Jeu invalide.');
  if (myQuatuor(uid)) throw new Error('Tu es déjà dans un quatuor. Quitte-le d\'abord.');
  if (inQueue(uid)) throw new Error('Quitte la file classée avant de créer un quatuor.');
  busy(uid);
  return db.transaction(() => {
    const code = qCode(), id = db.prepare('INSERT INTO quatuors(code,game,leader_id) VALUES(?,?,?)').run(code, game, uid).lastInsertRowid;
    db.prepare('INSERT INTO quatuor_members(quatuor_id,user_id) VALUES(?,?)').run(id, uid); return code;
  })();
}
function joinQuatuor(uid, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(c)) throw new Error('Code de quatuor invalide (5 caractères).');
  return db.transaction(() => {
    const q = db.prepare('SELECT * FROM quatuors WHERE code=?').get(c);
    if (!q) throw new Error('Quatuor introuvable.');
    if (db.prepare('SELECT 1 FROM quatuor_members WHERE quatuor_id=? AND user_id=?').get(q.id, uid)) return q;
    if (myQuatuor(uid)) throw new Error('Tu es déjà dans un quatuor.');
    if (members(q.id).length >= FORMAT[q.game]) throw new Error(`Quatuor complet : ${FORMAT[q.game]} joueurs maximum.`);
    busy(uid); unqueue(q); db.prepare('DELETE FROM ranked_queue WHERE user_id=?').run(uid); db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
    db.prepare('INSERT INTO quatuor_members(quatuor_id,user_id) VALUES(?,?)').run(q.id, uid); return q;
  })();
}
// Un membre quitte ; si c'est le chef, le quatuor est dissous
function leaveQuatuor(uid) {
  const q = myQuatuor(uid); if (!q) return null; unqueue(q);
  if (q.leader_id === uid) { db.prepare('DELETE FROM quatuors WHERE id=?').run(q.id); return 'dissous'; }
  db.prepare('DELETE FROM quatuor_members WHERE quatuor_id=? AND user_id=?').run(q.id, uid); return 'quitte';
}
function kick(uid, targetId) {
  const q = myQuatuor(uid); if (!q || q.leader_id !== uid) throw new Error('Seul le chef du quatuor peut exclure un membre.');
  if (+targetId === uid) throw new Error('Utilise « Dissoudre le quatuor ».');
  const m = q.members.find(x => x.user_id === +targetId); if (!m) throw new Error('Ce joueur n\'est pas dans ton quatuor.');
  unqueue(q); db.prepare('DELETE FROM quatuor_members WHERE quatuor_id=? AND user_id=?').run(q.id, m.user_id); return m.pseudo;
}
function joinRanked(uid, game) {
  if (!FORMAT[game]) throw new Error('Jeu invalide.');
  busy(uid);
  const q = myQuatuor(uid);
  if (q) {
    if (q.game !== game) throw new Error(`Ton quatuor est prévu pour ${q.game}.`);
    if (q.leader_id !== uid) throw new Error('Seul le chef du quatuor lance la recherche.');
    if (q.members.length !== FORMAT[game]) throw new Error(`Quatuor incomplet (${q.members.length}/${FORMAT[game]}) : il faut exactement ${FORMAT[game]} joueurs pour lancer la recherche.`);
    q.members.forEach(m => busy(m.user_id));
    for (const m of q.members) { db.prepare('DELETE FROM queue WHERE user_id=?').run(m.user_id); db.prepare('INSERT OR REPLACE INTO ranked_queue(user_id,game,group_id) VALUES(?,?,?)').run(m.user_id, game, q.id); }
  } else {
    db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
    db.prepare('INSERT OR REPLACE INTO ranked_queue(user_id,game,group_id) VALUES(?,?,NULL)').run(uid, game);
  }
  return tryRanked(game);
}
function leaveRanked(uid) { const q = inQueue(uid); if (!q) return; if (q.group_id) db.prepare('DELETE FROM ranked_queue WHERE group_id=?').run(q.group_id); else db.prepare('DELETE FROM ranked_queue WHERE user_id=?').run(uid); }
const spread = waitedMs => SPREAD0 + SPREAD_STEP * Math.floor(waitedMs / 1000 / STEP_S);
// Groupes (solo / quatuor) de la file, du plus ancien au plus récent
function groups(game) {
  const rows = db.prepare(`SELECT *, (julianday('now') - julianday(joined_at)) * 864e5 waited FROM ranked_queue WHERE game=? ORDER BY joined_at, user_id`).all(game);
  const G = [], seen = {};
  for (const r of rows) {
    const key = r.group_id ? 'q' + r.group_id : 'u' + r.user_id;
    if (!seen[key]) G.push(seen[key] = { ids: [], waited: r.waited });
    seen[key].ids.push(r.user_id);
  }
  G.forEach(g => { g.sr = g.ids.reduce((s, id) => s + M.getSR(id, game), 0) / g.ids.length; });
  return G;
}
// Répartit les groupes en 2 équipes de n : quatuors d'abord (une équipe entière, jamais séparés), puis solos, vers l'équipe au total le plus faible
function split(sel, n) {
  const T = { 1: [], 2: [] }, sum = { 1: 0, 2: 0 };
  for (const g of [...sel].sort((a, b) => b.ids.length - a.ids.length || b.sr - a.sr)) {
    const fits = [1, 2].filter(t => T[t].length + g.ids.length <= n); if (!fits.length) return null;
    const t = fits.length === 2 ? (sum[1] <= sum[2] ? 1 : 2) : fits[0];
    T[t].push(...g.ids); sum[t] += g.sr * g.ids.length;
  }
  return T[1].length === n && T[2].length === n ? T : null;
}
function tryRanked(game) {
  const n = FORMAT[game]; const created = [];
  db.transaction(() => {
    for (;;) {
      const G = groups(game); let made = false;
      for (const anchor of G) {
        const lim = spread(anchor.waited), sel = [anchor]; let count = anchor.ids.length;
        for (const g of G) {
          if (g === anchor || count === 2 * n) continue;
          if (Math.abs(g.sr - anchor.sr) > Math.max(lim, spread(g.waited))) continue;
          if (count + g.ids.length > 2 * n) continue;
          if (g.ids.length !== 1 && g.ids.length !== n) continue; // solo ou quatuor complet uniquement
          sel.push(g); count += g.ids.length;
        }
        if (count < 2 * n) continue;
        const T = split(sel, n); if (!T) continue;
        const ids = [...T[1], ...T[2]];
        const lid = db.prepare("INSERT INTO lobbies(code,game,mode,team_size,is_private,status,host_id,ranked) VALUES(?,?,?,?,0,'en_cours',?,1)")
          .run(code6(), game, fmt(game), n, anchor.ids[0]).lastInsertRowid;
        for (const t of [1, 2]) T[t].forEach(id => db.prepare('INSERT INTO lobby_players(lobby_id,user_id,team,sr_before) VALUES(?,?,?,?)').run(lid, id, t, M.getSR(id, game)));
        db.prepare(`DELETE FROM ranked_queue WHERE user_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        created.push(lid); db.emit('game_found', { lobby_id: lid, ranked: true }); made = true; break;
      }
      if (!made) break;
    }
  })();
  return created;
}
function code6() { for (;;) { const c = Array.from(crypto.randomBytes(6), b => CH[b % CH.length]).join(''); if (!db.prepare('SELECT 1 FROM lobbies WHERE code=?').get(c)) return c; } }
const tryAll = () => Object.keys(FORMAT).flatMap(g => db.prepare('SELECT 1 FROM ranked_queue WHERE game=? LIMIT 1').get(g) ? tryRanked(g) : []);
module.exports = { FORMAT, fmt, groupAllowed, spread, SPREAD0, SPREAD_STEP, STEP_S, myQuatuor, inQueue, createQuatuor, joinQuatuor, leaveQuatuor, kick, joinRanked, leaveRanked, tryRanked, tryAll };
