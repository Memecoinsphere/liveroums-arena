// Services partagés entre le site et le bot Discord
const db = require('./db');
const { status } = require('./views');
const TQ = `SELECT t.*, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id=t.id) count FROM tournaments t`;
const getT = id => db.prepare(TQ + ' WHERE t.id=?').get(id);
const listOpen = () => db.prepare(TQ + ' ORDER BY t.start_date').all().filter(t => status(t).key === 'ouvert');
function register(tid, uid, { teamName = '', mates = [] } = {}) {
  const t = getT(tid); if (!t) throw new Error('Tournoi introuvable.');
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM registrations WHERE tournament_id=? AND user_id=?').get(t.id, uid)) throw new Error('Tu es déjà inscrit à ce tournoi.');
    const st = status(getT(t.id)).key;
    if (st === 'complet') throw new Error('Tournoi complet : plus aucune place disponible.');
    if (st !== 'ouvert') throw new Error('Les inscriptions sont fermées.');
    let teamId = null;
    if (t.format === 'equipe') {
      const name = String(teamName || '').trim(); const ms = mates.map(m => String(m).trim()).filter(Boolean);
      if (!name) throw new Error("Nom d'équipe requis.");
      if (ms.length !== t.team_size - 1) throw new Error(`Il faut exactement ${t.team_size - 1} coéquipier(s).`);
      if (db.prepare('SELECT 1 FROM teams WHERE tournament_id=? AND name=?').get(t.id, name)) throw new Error("Ce nom d'équipe est déjà pris.");
      teamId = db.prepare('INSERT INTO teams(tournament_id,name,captain_id) VALUES(?,?,?)').run(t.id, name, uid).lastInsertRowid;
      ms.forEach(m => db.prepare('INSERT INTO team_members(team_id,member_name) VALUES(?,?)').run(teamId, m));
    }
    db.prepare('INSERT INTO registrations(tournament_id,user_id,team_id) VALUES(?,?,?)').run(t.id, uid, teamId);
    db.emit('registration', { tournament_id: t.id, user_id: uid, added: true });
  })();
  return getT(t.id);
}
function unregister(tid, uid) {
  const t = getT(tid);
  if (!t || t.bracket_generated) throw new Error('Désinscription impossible (bracket déjà lancé).');
  const r = db.prepare('SELECT * FROM registrations WHERE tournament_id=? AND user_id=?').get(t.id, uid);
  if (!r) throw new Error("Tu n'es pas inscrit à ce tournoi.");
  db.prepare('DELETE FROM registrations WHERE id=?').run(r.id); if (r.team_id) db.prepare('DELETE FROM teams WHERE id=?').run(r.team_id);
  db.emit('registration', { tournament_id: t.id, user_id: uid, added: false });
  return t;
}
module.exports = { TQ, getT, listOpen, register, unregister, status };
