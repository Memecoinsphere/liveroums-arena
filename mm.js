// SR (Elo), rangs et matchmaking
const crypto = require('crypto');
const db = require('./db');
const P = require('./points');
const K = 32, START = 1000;
const TIERS = [[0, 'Bronze', '#cd7f32'], [900, 'Argent', '#c0c8d8'], [1050, 'Or', '#ffd23f'], [1200, 'Platine', '#3fe0c5'],
  [1350, 'Diamant', '#5aa9ff'], [1500, 'Maître', '#c04bff'], [1700, 'Légende', '#ff3d6e']];
const tier = sr => { let t = TIERS[0]; for (const x of TIERS) if (sr >= x[0]) t = x; return { name: t[1], color: t[2], min: t[0] }; };
const MODES = { 'Call of Duty': ['4v4', '2v2', '1v1'] }; // seul jeu supporté
const teamSize = mode => parseInt(mode, 10);

function getSR(uid, game) {
  const r = db.prepare('SELECT sr FROM ratings WHERE user_id=? AND game=?').get(uid, game);
  return r ? r.sr : START;
}
function ensure(uid, game) { db.prepare('INSERT OR IGNORE INTO ratings(user_id,game,sr) VALUES(?,?,?)').run(uid, game, START); }
// Elo par équipe : moyenne des SR, même delta pour chaque joueur d'une équipe
function applyResult(game, winners, losers) {
  if (!winners.length || !losers.length) return {};
  const avg = ids => ids.reduce((s, id) => s + getSR(id, game), 0) / ids.length;
  const ra = avg(winners), rb = avg(losers);
  const exp = 1 / (1 + 10 ** ((rb - ra) / 400));
  const delta = Math.max(1, Math.round(K * (1 - exp)));
  const out = {};
  const upd = (id, d, w) => { ensure(id, game); db.prepare(`UPDATE ratings SET sr=MAX(0,sr+?), ${w ? 'wins=wins+1' : 'losses=losses+1'} WHERE user_id=? AND game=?`).run(d, id, game); out[id] = getSR(id, game); };
  winners.forEach(id => upd(id, delta, true)); losers.forEach(id => upd(id, -delta, false));
  db.emit('role_sync', { user_ids: [...winners, ...losers] });
  return out;
}
// Résultat d'un match de tournoi : joueurs solo (pseudo) ou capitaine d'équipe (nom d'équipe)
function tournamentResult(tid, winner, loser) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid);
  if (!t || !winner || !loser) return;
  const ids = name => t.format === 'solo'
    ? db.prepare('SELECT id FROM users WHERE pseudo=?').all(name).map(r => r.id)
    : db.prepare('SELECT captain_id id FROM teams WHERE tournament_id=? AND name=?').all(tid, name).map(r => r.id);
  applyResult(t.game, ids(winner), ids(loser));
  P.recordMatch(ids(winner), ids(loser), 'tournoi'); // +LP (voir points.js)
}
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) { const c = Array.from(crypto.randomBytes(6), b => CHARS[b % CHARS.length]).join(''); if (!db.prepare('SELECT 1 FROM lobbies WHERE code=?').get(c)) return c; }
}
// Répartition équilibrée : tri par SR décroissant puis affectation à l'équipe au total le plus faible
function balance(ids, game, n) {
  const ps = ids.map(id => ({ id, sr: getSR(id, game) })).sort((a, b) => b.sr - a.sr);
  const T = { 1: [], 2: [] }, sum = { 1: 0, 2: 0 };
  ps.forEach(p => { const t = T[1].length >= n ? 2 : T[2].length >= n ? 1 : sum[1] <= sum[2] ? 1 : 2; T[t].push(p.id); sum[t] += p.sr; });
  return T;
}
function activeLobby(uid) {
  return db.prepare(`SELECT l.* FROM lobbies l JOIN lobby_players p ON p.lobby_id=l.id WHERE p.user_id=? AND l.status IN ('attente','en_cours') ORDER BY l.id DESC`).get(uid);
}
// Crée autant de parties que possible depuis la file d'attente d'un jeu/mode
function tryMatch(game, mode) {
  const n = teamSize(mode); const created = [];
  db.transaction(() => {
    for (;;) {
      const q = db.prepare('SELECT user_id FROM queue WHERE game=? AND mode=? ORDER BY joined_at, user_id LIMIT ?').all(game, mode, 2 * n).map(r => r.user_id);
      if (q.length < 2 * n) break;
      const T = balance(q, game, n);
      const lid = db.prepare("INSERT INTO lobbies(code,game,mode,team_size,is_private,status,host_id) VALUES(?,?,?,?,0,'en_cours',?)").run(newCode(), game, mode, n, q[0]).lastInsertRowid;
      for (const t of [1, 2]) T[t].forEach(id => db.prepare('INSERT INTO lobby_players(lobby_id,user_id,team,sr_before) VALUES(?,?,?,?)').run(lid, id, t, getSR(id, game)));
      db.prepare(`DELETE FROM queue WHERE user_id IN (${q.map(() => '?').join(',')})`).run(...q);
      created.push(lid); db.emit('game_found', { lobby_id: lid });
    }
  })();
  return created;
}
function joinQueue(uid, game, mode) {
  if (!MODES[game]?.includes(mode)) throw new Error('Jeu ou mode invalide.');
  if (activeLobby(uid)) throw new Error('Tu es déjà dans une partie en cours.');
  db.prepare('INSERT OR REPLACE INTO queue(user_id,game,mode) VALUES(?,?,?)').run(uid, game, mode);
  return tryMatch(game, mode);
}
function createPrivate(uid, game, mode) {
  if (!MODES[game]?.includes(mode)) throw new Error('Jeu ou mode invalide.');
  if (activeLobby(uid)) throw new Error('Tu es déjà dans une partie en cours.');
  db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
  const code = newCode();
  const lid = db.prepare("INSERT INTO lobbies(code,game,mode,team_size,is_private,status,host_id) VALUES(?,?,?,?,1,'attente',?)").run(code, game, mode, teamSize(mode), uid).lastInsertRowid;
  db.prepare('INSERT INTO lobby_players(lobby_id,user_id) VALUES(?,?)').run(lid, uid);
  return code;
}
function joinByCode(uid, code) {
  const l = db.prepare('SELECT * FROM lobbies WHERE code=?').get(String(code).trim().toUpperCase());
  if (!l) throw new Error('Code de partie introuvable.');
  if (db.prepare('SELECT 1 FROM lobby_players WHERE lobby_id=? AND user_id=?').get(l.id, uid)) return l.code;
  if (l.status !== 'attente') throw new Error('Cette partie a déjà commencé ou est terminée.');
  if (activeLobby(uid)) throw new Error('Tu es déjà dans une autre partie.');
  const cnt = db.prepare('SELECT COUNT(*) c FROM lobby_players WHERE lobby_id=?').get(l.id).c;
  if (cnt >= 2 * l.team_size) throw new Error('Partie complète.');
  db.prepare('DELETE FROM queue WHERE user_id=?').run(uid);
  db.prepare('INSERT INTO lobby_players(lobby_id,user_id) VALUES(?,?)').run(l.id, uid);
  if (cnt + 1 === 2 * l.team_size) startLobby(l.id);
  return l.code;
}
// Démarrage : équipes équilibrées par SR
function startLobby(lid) {
  const l = db.prepare('SELECT * FROM lobbies WHERE id=?').get(lid);
  const ids = db.prepare('SELECT user_id FROM lobby_players WHERE lobby_id=?').all(lid).map(r => r.user_id);
  if (ids.length < 2) throw new Error('Il faut au moins 2 joueurs.');
  const T = balance(ids, l.game, Math.ceil(ids.length / 2));
  for (const t of [1, 2]) T[t].forEach(id => db.prepare('UPDATE lobby_players SET team=?, sr_before=? WHERE lobby_id=? AND user_id=?').run(t, getSR(id, l.game), lid, id));
  db.prepare("UPDATE lobbies SET status='en_cours' WHERE id=?").run(lid);
  db.emit('game_found', { lobby_id: lid });
}
// Fin de partie : SR mis à jour, joueurs d'une partie publique remis en file, puis nouvelles parties depuis la file
function declareResult(lid, winnerTeam) {
  const l = db.prepare('SELECT * FROM lobbies WHERE id=?').get(lid);
  if (!l || l.status !== 'en_cours') throw new Error('Partie non en cours.');
  if (![1, 2].includes(+winnerTeam)) throw new Error('Équipe gagnante invalide.');
  const ps = db.prepare('SELECT user_id,team FROM lobby_players WHERE lobby_id=?').all(lid);
  const w = ps.filter(p => p.team === +winnerTeam).map(p => p.user_id), lo = ps.filter(p => p.team !== +winnerTeam).map(p => p.user_id);
  let next = [];
  db.transaction(() => {
    // Seules les parties classées modifient le SR (les parties rapides / privées n'ont aucun impact)
    const after = l.ranked ? applyResult(l.game, w, lo) : {};
    Object.entries(after).forEach(([id, sr]) => db.prepare('UPDATE lobby_players SET sr_after=? WHERE lobby_id=? AND user_id=?').run(sr, lid, +id));
    P.recordMatch(w, lo, l.ranked ? 'classe' : l.is_private ? 'privee' : 'rapide'); // +LP pour toutes les parties
    db.prepare("UPDATE lobbies SET status='termine', winner_team=?, ended_at=CURRENT_TIMESTAMP WHERE id=?").run(+winnerTeam, lid);
    db.emit('game_result', { lobby_id: lid, winner_team: +winnerTeam });
    if (!l.is_private && !l.ranked) ps.forEach(p => db.prepare('INSERT OR IGNORE INTO queue(user_id,game,mode) VALUES(?,?,?)').run(p.user_id, l.game, l.mode));
  })();
  next = tryMatch(l.game, l.mode);
  return next;
}
module.exports = { TIERS, tier, MODES, START, getSR, applyResult, tournamentResult, joinQueue, createPrivate, joinByCode, startLobby, declareResult, activeLobby, tryMatch, teamSize };
