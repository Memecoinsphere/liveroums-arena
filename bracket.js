// Génération et progression d'un bracket à élimination directe
const db = require('./db');
function entries(tid) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid);
  if (t.format === 'equipe') return db.prepare('SELECT name FROM teams WHERE tournament_id=?').all(tid).map(r => r.name);
  return db.prepare('SELECT u.pseudo name FROM registrations r JOIN users u ON u.id=r.user_id WHERE r.tournament_id=?').all(tid).map(r => r.name);
}
function generate(tid) {
  const list = entries(tid).sort(() => Math.random() - 0.5);
  let size = 2; while (size < list.length) size *= 2;
  const rounds = Math.log2(size);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM matches WHERE tournament_id=?').run(tid);
    const ins = db.prepare('INSERT INTO matches(tournament_id,round,slot,p1,p2,winner) VALUES(?,?,?,?,?,?)');
    // Répartition : les byes affrontent les premiers seeds
    const seeds = Array(size).fill(null);
    for (let i = 0; i < list.length; i++) seeds[i < size / 2 ? i * 2 : (i - size / 2) * 2 + 1] = list[i];
    for (let s = 0; s < size / 2; s++) ins.run(tid, 1, s, seeds[2 * s], seeds[2 * s + 1], null);
    for (let r = 2; r <= rounds; r++) for (let s = 0; s < size / 2 ** r; s++) ins.run(tid, r, s, null, null, null);
    db.prepare('UPDATE tournaments SET bracket_generated=1 WHERE id=?').run(tid);
    db.emit('bracket_generated', { tournament_id: +tid });
    // Byes : qualification automatique
    db.prepare('SELECT * FROM matches WHERE tournament_id=? AND round=1').all(tid).forEach(m => {
      if (m.p1 && !m.p2) setWinner(tid, m.id, m.p1, true); else if (!m.p1 && m.p2) setWinner(tid, m.id, m.p2, true);
    });
  });
  tx();
}
function setWinner(tid, matchId, winner, bye = false) {
  const m = db.prepare('SELECT * FROM matches WHERE id=? AND tournament_id=?').get(matchId, tid);
  if (!m || (winner !== m.p1 && winner !== m.p2)) return false;
  if (m.winner) return false;
  db.prepare('UPDATE matches SET winner=? WHERE id=?').run(winner, m.id);
  if (!bye) { require('./mm').tournamentResult(tid, winner, winner === m.p1 ? m.p2 : m.p1); db.emit('match_result', { tournament_id: +tid, round: m.round, winner, loser: winner === m.p1 ? m.p2 : m.p1 }); }
  const next = db.prepare('SELECT * FROM matches WHERE tournament_id=? AND round=? AND slot=?').get(tid, m.round + 1, Math.floor(m.slot / 2));
  if (next) db.prepare(`UPDATE matches SET ${m.slot % 2 ? 'p2' : 'p1'}=? WHERE id=?`).run(winner, next.id);
  else db.prepare('UPDATE tournaments SET finished=1 WHERE id=?').run(tid);
  return true;
}
// Génère automatiquement le bracket des tournois dont les inscriptions sont clôturées
function autoGenerate() {
  const now = new Date().toISOString().slice(0, 16);
  db.prepare('SELECT id FROM tournaments WHERE bracket_generated=0 AND reg_close<=?').all(now).forEach(t => {
    if (entries(t.id).length >= 2) generate(t.id);
  });
}
module.exports = { generate, setWinner, autoGenerate, entries };
