// Mode « Classé » : solo ou duo (2 max), équipes équilibrées par SR, écart de SR qui s'élargit avec l'attente
const crypto = require('crypto');
const db = require('./db');
const M = require('./mm');

if (!db.prepare('PRAGMA table_info(lobbies)').all().some(c => c.name === 'ranked')) db.exec('ALTER TABLE lobbies ADD COLUMN ranked INTEGER DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS duos(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, game TEXT NOT NULL, leader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mate_id INTEGER REFERENCES users(id) ON DELETE CASCADE, invited_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ranked_queue(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, duo_id INTEGER,
  joined_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')));
`);

const FORMAT = { 'Valorant': 5, 'League of Legends': 5, 'Rocket League': 3, 'EA FC': 1, 'Fortnite': 1, 'CS2': 5, 'Call of Duty': 4 };
const SPREAD0 = 200, SPREAD_STEP = 100, STEP_S = 30;
const duoAllowed = g => FORMAT[g] > 1;
const fmt = g => `${FORMAT[g]}v${FORMAT[g]}`;
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const duoCode = () => { for (;;) { const c = Array.from(crypto.randomBytes(5), b => CH[b % CH.length]).join(''); if (!db.prepare('SELECT 1 FROM duos WHERE code=?').get(c)) return c; } };
const myDuo = uid => db.prepare('SELECT * FROM duos WHERE leader_id=? OR mate_id=?').get(uid, uid);
const invites = uid => db.prepare('SELECT d.*, u.pseudo leader FROM duos d JOIN users u ON u.id=d.leader_id WHERE d.invited_id=? AND d.mate_id IS NULL').all(uid);
const inQueue = uid => db.prepare('SELECT * FROM ranked_queue WHERE user_id=?').get(uid);
const busy = uid => { if (M.activeLobby(uid)) throw new Error('Tu es déjà dans une partie en cours.'); };
const leaveQueueOf = d => db.prepare('DELETE FROM ranked_queue WHERE duo_id=?').run(d.id);

function createDuo(uid, game) {
  if (!FORMAT[game]) throw new Error('Jeu invalide.');
  if (!duoAllowed(game)) throw new Error(`Duo impossible en ${game} : le classé se joue en ${fmt(game)}, solo uniquement.`);
  if (myDuo(uid)) throw new Error('Tu es déjà dans un duo. Quitte-le d\'abord.');
  if (inQueue(uid)) throw new Error('Quitte la file classée avant de créer un duo.');
  const code = duoCode(); db.prepare('INSERT INTO duos(code,game,leader_id) VALUES(?,?,?)').run(code, game, uid); return code;
}
function invite(uid, pseudo) {
  const d = myDuo(uid); if (!d || d.leader_id !== uid) throw new Error('Crée d\'abord un duo.');
  if (d.mate_id) throw new Error('Duo complet : 2 joueurs maximum en classé.');
  const u = db.prepare('SELECT id,pseudo FROM users WHERE pseudo=?').get(String(pseudo || '').trim());
  if (!u) throw new Error('Joueur introuvable.'); if (u.id === uid) throw new Error('Tu ne peux pas t\'inviter toi-même.');
  db.prepare('UPDATE duos SET invited_id=? WHERE id=?').run(u.id, d.id); return u.pseudo;
}
function joinDuo(uid, { id, code }) {
  const d = id ? db.prepare('SELECT * FROM duos WHERE id=?').get(+id) : db.prepare('SELECT * FROM duos WHERE code=?').get(String(code || '').trim().toUpperCase());
  if (!d) throw new Error('Duo introuvable.');
  if (d.leader_id === uid || d.mate_id === uid) return d;
  if (d.mate_id) throw new Error('Duo complet : 2 joueurs maximum en classé.');
  if (id && d.invited_id !== uid) throw new Error('Invitation introuvable.');
  if (myDuo(uid)) throw new Error('Tu es déjà dans un duo.');
  busy(uid); leaveQueueOf(d); db.prepare('DELETE FROM ranked_queue WHERE user_id=?').run(uid);
  db.prepare('UPDATE duos SET mate_id=?, invited_id=NULL WHERE id=?').run(uid, d.id); return d;
}
function leaveDuo(uid) {
  const d = myDuo(uid); if (!d) return; leaveQueueOf(d);
  if (d.leader_id === uid) db.prepare('DELETE FROM duos WHERE id=?').run(d.id);
  else db.prepare('UPDATE duos SET mate_id=NULL WHERE id=?').run(d.id);
}
function joinRanked(uid, game) {
  if (!FORMAT[game]) throw new Error('Jeu invalide.');
  busy(uid);
  const d = myDuo(uid);
  if (d) {
    if (d.game !== game) throw new Error(`Ton duo est prévu pour ${d.game}.`);
    if (!duoAllowed(game)) throw new Error(`Duo impossible en ${game} (${fmt(game)}).`);
    if (!d.mate_id) throw new Error('Ton duo est incomplet : attends que ton ami accepte, ou quitte le duo pour jouer solo.');
    if (d.leader_id !== uid) throw new Error('Seul le créateur du duo lance la recherche.');
    busy(d.mate_id);
    for (const id of [d.leader_id, d.mate_id]) { db.prepare('DELETE FROM queue WHERE user_id=?').run(id); db.prepare('INSERT OR REPLACE INTO ranked_queue(user_id,game,duo_id) VALUES(?,?,?)').run(id, game, d.id); }
  } else {
    db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
    db.prepare('INSERT OR REPLACE INTO ranked_queue(user_id,game,duo_id) VALUES(?,?,NULL)').run(uid, game);
  }
  return tryRanked(game);
}
function leaveRanked(uid) { const q = inQueue(uid); if (!q) return; if (q.duo_id) db.prepare('DELETE FROM ranked_queue WHERE duo_id=?').run(q.duo_id); else db.prepare('DELETE FROM ranked_queue WHERE user_id=?').run(uid); }
const spread = waitedMs => SPREAD0 + SPREAD_STEP * Math.floor(waitedMs / 1000 / STEP_S);
// Groupes (solo / duo) de la file, du plus ancien au plus récent
function groups(game) {
  const rows = db.prepare(`SELECT *, (julianday('now') - julianday(joined_at)) * 864e5 waited FROM ranked_queue WHERE game=? ORDER BY joined_at, user_id`).all(game);
  const G = [], seen = {};
  for (const r of rows) {
    const key = r.duo_id ? 'd' + r.duo_id : 'u' + r.user_id;
    if (!seen[key]) G.push(seen[key] = { ids: [], waited: r.waited });
    seen[key].ids.push(r.user_id);
  }
  G.forEach(g => { g.sr = g.ids.reduce((s, id) => s + M.getSR(id, game), 0) / g.ids.length; });
  return G;
}
// Répartit les groupes en 2 équipes de n : duos d'abord (jamais séparés), puis solos, vers l'équipe au total le plus faible
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
        const lim = spread(anchor.waited), sel = [anchor]; let count = anchor.ids.length, duos = anchor.ids.length > 1 ? 1 : 0;
        for (const g of G) {
          if (g === anchor || count === 2 * n) continue;
          if (Math.abs(g.sr - anchor.sr) > Math.max(lim, spread(g.waited))) continue;
          if (count + g.ids.length > 2 * n) continue;
          if (g.ids.length > 1 && duos + 1 > 2 * Math.floor(n / 2)) continue;
          sel.push(g); count += g.ids.length; if (g.ids.length > 1) duos++;
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
module.exports = { FORMAT, fmt, duoAllowed, spread, SPREAD0, SPREAD_STEP, STEP_S, myDuo, invites, inQueue, createDuo, invite, joinDuo, leaveDuo, joinRanked, leaveRanked, tryRanked, tryAll };
