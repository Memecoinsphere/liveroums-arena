// Base de données SQLite (seul le compte admin est créé)
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
  // Seul le compte admin est créé : aucune donnée d'exemple
  db.prepare('INSERT INTO users(pseudo,email,password_hash,platform,game_id,is_admin) VALUES(?,?,?,?,?,?)')
    .run('Admin', 'admin@liveroums.gg', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Admin123!', 12), 'PC', 'admin#0001', 1);
  // ADMIN_PASSWORD (variable d'environnement) remplace le mot de passe par défaut, faible, à la création de la base
  console.log(process.env.ADMIN_PASSWORD ? 'Base initialisée. Admin : admin@liveroums.gg (mot de passe : ADMIN_PASSWORD)'
    : 'Base initialisée. Admin : admin@liveroums.gg / Admin123! — ⚠ mot de passe par défaut faible : définis ADMIN_PASSWORD');
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

// ---- Discord : identifiant lié + file d'événements (outbox) lue par le bot ----
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'discord_id')) {
  db.exec('ALTER TABLE users ADD COLUMN discord_id TEXT'); db.exec('ALTER TABLE users ADD COLUMN discord_username TEXT');
}
for (const col of ['discord_global_name', 'discord_avatar'])
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_discord ON users(discord_id) WHERE discord_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, processed_at TEXT);`);
db.emit = (type, payload = {}) => db.prepare('INSERT INTO events(type,payload) VALUES(?,?)').run(type, JSON.stringify(payload));
module.exports = db;
