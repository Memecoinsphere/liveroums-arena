// Base de données SQLite + données d'exemple
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const DB_FILE = process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'arena.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (process.argv.includes('--reset') && fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, pseudo TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, platform TEXT NOT NULL, game_id TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tournaments(id INTEGER PRIMARY KEY, name TEXT NOT NULL, game TEXT NOT NULL, platform TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('solo','equipe')), team_size INTEGER DEFAULT 1, max_slots INTEGER NOT NULL,
  cashprize TEXT, start_date TEXT NOT NULL, reg_close TEXT NOT NULL, rules TEXT, description TEXT,
  bracket_generated INTEGER DEFAULT 0, finished INTEGER DEFAULT 0, is_example INTEGER DEFAULT 0, created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, captain_id INTEGER NOT NULL REFERENCES users(id), UNIQUE(tournament_id,name));
CREATE TABLE IF NOT EXISTS team_members(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, member_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registrations(id INTEGER PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(tournament_id,user_id));
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round INTEGER NOT NULL, slot INTEGER NOT NULL, p1 TEXT, p2 TEXT, winner TEXT, UNIQUE(tournament_id,round,slot));
`);

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const h = p => bcrypt.hashSync(p, 10);
  const addU = db.prepare('INSERT INTO users(pseudo,email,password_hash,platform,game_id,is_admin) VALUES(?,?,?,?,?,?)');
  addU.run('Admin', 'admin@liveroums.gg', h('Admin123!'), 'PC', 'admin#0001', 1);
  const players = ['NeoBlaze','ShadowFox','KiraVolt','PixelRaid','Zephyr','NovaStrike','Rekt0r','LunaAce','Ghostly','Vortex','Bl1tz','Cyra'];
  const pids = players.map((p, i) => addU.run(p, `${p.toLowerCase()}@exemple.gg`, h('Joueur123!'), ['PC','PlayStation','Xbox'][i % 3], `${p}#${1000 + i}`, 0).lastInsertRowid);
  const d = days => { const x = new Date(Date.now() + days * 864e5); return x.toISOString().slice(0, 16); };
  const addT = db.prepare(`INSERT INTO tournaments(name,game,platform,format,team_size,max_slots,cashprize,start_date,reg_close,rules,description,is_example,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1)`);
  const R = '• Fair-play obligatoire, toute triche entraîne une disqualification.\n• Check-in 30 minutes avant le début.\n• Matchs en BO1, finale en BO3.\n• Les litiges sont tranchés par les admins (captures d\'écran requises).';
  const T = [
    ['[EXEMPLE] Valorant Neon Cup', 'Valorant', 'PC', 'equipe', 5, 16, '1 000 €', d(10), d(8), R, 'La coupe 5v5 Valorant de la communauté LiveRoums.'],
    ['[EXEMPLE] LoL Rift Masters', 'League of Legends', 'PC', 'equipe', 5, 8, '750 €', d(14), d(12), R, 'Tournoi 5v5 sur la Faille de l\'invocateur, draft classique.'],
    ['[EXEMPLE] Rocket League 2v2 Turbo', 'Rocket League', 'Multiplateforme', 'equipe', 2, 16, '300 €', d(5), d(4), R, 'Duo, cross-play activé.'],
    ['[EXEMPLE] EA FC Weekend League', 'EA FC', 'PlayStation', 'solo', 1, 8, '200 € + jeux', d(3), d(2), R, '1v1 sur EA SPORTS FC, équipes en ligne autorisées.'],
    ['[EXEMPLE] Fortnite Zero Build Solo', 'Fortnite', 'Multiplateforme', 'solo', 1, 32, '500 V-Bucks x10', d(7), d(6), R, 'Élimination directe en 1v1 Zero Build.'],
    ['[EXEMPLE] CS2 Open Arena', 'CS2', 'PC', 'solo', 1, 8, '400 €', d(1), d(-1), R, '1v1 aim map — inscriptions clôturées, bracket généré.'],
    ['[EXEMPLE] Call of Duty Warzone Duos', 'Call of Duty', 'Multiplateforme', 'equipe', 2, 16, '600 €', d(12), d(10), R, 'Duos Warzone, cross-play activé.'],
  ];
  const tids = T.map(t => addT.run(...t).lastInsertRowid);
  const reg = db.prepare('INSERT INTO registrations(tournament_id,user_id,team_id) VALUES(?,?,?)');
  // Inscriptions solo d'exemple
  pids.slice(0, 5).forEach(u => reg.run(tids[3], u, null));
  pids.slice(0, 8).forEach(u => reg.run(tids[5], u, null));
  pids.slice(0, 9).forEach(u => reg.run(tids[4], u, null));
  // Équipes d'exemple
  const addTeam = db.prepare('INSERT INTO teams(tournament_id,name,captain_id) VALUES(?,?,?)');
  const addM = db.prepare('INSERT INTO team_members(team_id,member_name) VALUES(?,?)');
  [['Team Néon', 0], ['Les Spectres', 1], ['Volt Esport', 2]].forEach(([n, i]) => {
    const tm = addTeam.run(tids[0], n, pids[i]).lastInsertRowid; reg.run(tids[0], pids[i], tm);
    ['Alpha','Bravo','Charlie','Delta'].forEach(m => addM.run(tm, `${m}_${i}`));
  });
  [['Turbo Bros', 3], ['Aerial Kings', 4]].forEach(([n, i]) => {
    const tm = addTeam.run(tids[2], n, pids[i]).lastInsertRowid; reg.run(tids[2], pids[i], tm); addM.run(tm, `Mate_${i}`);
  });
  console.log('Base initialisée avec les données d\'exemple. Admin : admin@liveroums.gg / Admin123!');
}
seed();

// ---- SR, comptes liés, matchmaking ----
db.exec(`
CREATE TABLE IF NOT EXISTS ratings(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL,
  sr INTEGER NOT NULL DEFAULT 1000, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, PRIMARY KEY(user_id,game));
CREATE TABLE IF NOT EXISTS linked_accounts(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
  account_id TEXT NOT NULL, verified INTEGER DEFAULT 0, linked_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,provider));
CREATE TABLE IF NOT EXISTS lobbies(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, game TEXT NOT NULL, mode TEXT NOT NULL,
  team_size INTEGER NOT NULL, is_private INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'attente', host_id INTEGER REFERENCES users(id),
  winner_team INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT);
CREATE TABLE IF NOT EXISTS lobby_players(lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
  team INTEGER, sr_before INTEGER, sr_after INTEGER, PRIMARY KEY(lobby_id,user_id));
CREATE TABLE IF NOT EXISTS queue(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, mode TEXT NOT NULL,
  joined_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')));
`);
function seedExtra() {
  if (db.prepare('SELECT COUNT(*) c FROM ratings').get().c > 0) return;
  const users = db.prepare('SELECT id,pseudo FROM users WHERE is_admin=0').all();
  if (!users.length) return;
  const games = ['Valorant','League of Legends','Rocket League','EA FC','Fortnite','CS2','Call of Duty'];
  const ins = db.prepare('INSERT INTO ratings(user_id,game,sr,wins,losses) VALUES(?,?,?,?,?)');
  // SR d'exemple réparti sur tous les rangs (déterministe)
  users.forEach((u, i) => games.forEach((g, j) => { const sr = 780 + ((i * 137 + j * 211) % 1050); ins.run(u.id, g, sr, 5 + (i + j) % 20, 3 + (i * j) % 15); }));
  const la = db.prepare('INSERT INTO linked_accounts(user_id,provider,account_id,verified) VALUES(?,?,?,?)');
  la.run(users[0].id, 'riot', 'NeoBlaze#EUW', 0); la.run(users[0].id, 'psn', 'NeoBlaze_PS', 0); la.run(users[0].id, 'epic', 'NeoBlazeEpic', 0);
  la.run(users[1].id, 'xbox', 'Shadow Fox', 0); la.run(users[1].id, 'battlenet', 'ShadowFox#2187', 0);
  // Lobby privé d'exemple (code DEMO42) et file d'attente Valorant 5v5
  const lid = db.prepare("INSERT INTO lobbies(code,game,mode,team_size,is_private,status,host_id) VALUES('DEMO42','Rocket League','2v2',2,1,'attente',?)").run(users[2].id).lastInsertRowid;
  [2, 3].forEach(i => db.prepare('INSERT INTO lobby_players(lobby_id,user_id) VALUES(?,?)').run(lid, users[i].id));
  users.slice(4, 8).forEach(u => db.prepare("INSERT INTO queue(user_id,game,mode) VALUES(?,'Valorant','5v5')").run(u.id));
}
seedExtra();

// ---- Discord : identifiant lié + file d'événements (outbox) lue par le bot ----
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'discord_id')) {
  db.exec('ALTER TABLE users ADD COLUMN discord_id TEXT'); db.exec('ALTER TABLE users ADD COLUMN discord_username TEXT');
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_discord ON users(discord_id) WHERE discord_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, processed_at TEXT);`);
db.emit = (type, payload = {}) => db.prepare('INSERT INTO events(type,payload) VALUES(?,?)').run(type, JSON.stringify(payload));
module.exports = db;
