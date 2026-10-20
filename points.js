// Points LiveRoums (LP) : économie de points de chaîne (gains, boutique de cosmétiques, défis, niveaux)
const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS points_ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_points_ledger ON points_ledger(user_id, id);
CREATE TABLE IF NOT EXISTS user_points(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, balance INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0, win_streak INTEGER NOT NULL DEFAULT 0, login_streak INTEGER NOT NULL DEFAULT 0, last_login_day TEXT);
CREATE TABLE IF NOT EXISTS match_log(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, won INTEGER NOT NULL,
  source TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_match_log ON match_log(user_id, created_at);
CREATE TABLE IF NOT EXISTS challenge_claims(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, challenge TEXT NOT NULL, period TEXT NOT NULL,
  claimed_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, challenge, period));
CREATE TABLE IF NOT EXISTS inventory(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL,
  bought_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, item_id));
CREATE TABLE IF NOT EXISTS equipped(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, slot TEXT NOT NULL, item_id TEXT NOT NULL,
  PRIMARY KEY(user_id, slot));
`);

const PTS = { WIN: 100, FIRST_WIN_BONUS: 100, LOSS: 10, STREAK: 50, STREAK_EVERY: 3, DAILY: 25, DAILY_STREAK_STEP: 5, DAILY_STREAK_MAX: 50 };
const RARITY = { commun: ['Commun', '#9fb3c8'], rare: ['Rare', '#3fa9ff'], epique: ['Épique', '#c04bff'], legendaire: ['Légendaire', '#ffb020'] };
const SLOTS = { banner: 'Bannières de profil', frame: "Cadres d'avatar", color: 'Couleurs de pseudo', title: 'Titres', badge: 'Emotes & badges de chat' };
const ITEMS = [
  ['banner_cyan', 'banner', 'Néon Cyan', 'commun', 300, 'linear-gradient(120deg,#001a2e,#00f0ff 60%,#003a4f)'],
  ['banner_synth', 'banner', 'Synthwave', 'rare', 800, 'linear-gradient(120deg,#2b0057,#ff2bd6 50%,#ffb020)'],
  ['banner_toxic', 'banner', 'Toxique', 'rare', 800, 'linear-gradient(120deg,#002b10,#39ff14 55%,#0a3d00)'],
  ['banner_aurora', 'banner', 'Aurore boréale', 'epique', 1500, 'linear-gradient(120deg,#00ffa3,#03e1ff 35%,#dc1fff 70%,#00ffa3)'],
  ['banner_inferno', 'banner', 'Inferno', 'legendaire', 3000, 'linear-gradient(120deg,#200000,#ff3d00 40%,#ffd23f 60%,#ff006e)'],
  ['frame_cyan', 'frame', 'Cadre Cyan', 'commun', 250, '#00f0ff'],
  ['frame_pink', 'frame', 'Cadre Rose Néon', 'rare', 600, '#ff2bd6'],
  ['frame_gold', 'frame', 'Cadre Or', 'epique', 1200, '#ffd23f'],
  ['frame_rainbow', 'frame', 'Cadre Prisme', 'legendaire', 2500, 'conic-gradient(#ff004c,#ffd23f,#39ff14,#00f0ff,#c04bff,#ff004c)'],
  ['color_cyan', 'color', 'Pseudo Cyan', 'commun', 200, '#00f0ff'],
  ['color_lime', 'color', 'Pseudo Lime', 'commun', 200, '#39ff14'],
  ['color_pink', 'color', 'Pseudo Magenta', 'rare', 500, '#ff2bd6'],
  ['color_gold', 'color', 'Pseudo Doré', 'epique', 1000, '#ffd23f'],
  ['title_rookie', 'title', 'Rookie Prometteur', 'commun', 150, 'Rookie Prometteur'],
  ['title_tryhard', 'title', 'Tryhard', 'rare', 500, 'Tryhard'],
  ['title_clutch', 'title', 'Clutch King', 'epique', 1200, 'Clutch King'],
  ['title_goat', 'title', 'Le GOAT', 'legendaire', 2800, 'Le GOAT'],
  ['badge_gg', 'badge', 'Emote GG', 'commun', 100, '🤝'],
  ['badge_fire', 'badge', 'Emote En feu', 'rare', 400, '🔥'],
  ['badge_skull', 'badge', 'Emote Skull', 'rare', 400, '💀'],
  ['badge_crown', 'badge', 'Badge Couronne', 'epique', 1000, '👑'],
  ['badge_dragon', 'badge', 'Badge Dragon', 'legendaire', 2200, '🐉'],
].map(([id, slot, name, rarity, price, value]) => ({ id, slot, name, rarity, price, value }));
const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));

// Périodes calendaires en heure de Paris
const parisDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const parisWeek = (d = new Date()) => { const x = new Date(parisDay(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
// début de période (Paris) converti en horodatage UTC SQLite
const utcStart = day => { const d = new Date(day + 'T00:00:00Z'); const off = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(d - off).toISOString().replace('T', ' ').slice(0, 19); };

const CHALLENGES = [
  { id: 'd_play3', period: 'jour', label: 'Jouer 3 parties', reward: 50, goal: 3, metric: 'played' },
  { id: 'd_win2', period: 'jour', label: 'Gagner 2 parties', reward: 75, goal: 2, metric: 'won' },
  { id: 'w_play15', period: 'semaine', label: 'Jouer 15 parties', reward: 200, goal: 15, metric: 'played' },
  { id: 'w_win8', period: 'semaine', label: 'Gagner 8 parties', reward: 300, goal: 8, metric: 'won' },
  { id: 'w_tourney', period: 'semaine', label: 'Gagner un match de tournoi', reward: 150, goal: 1, metric: 'tourney' },
];

const ensure = uid => db.prepare('INSERT OR IGNORE INTO user_points(user_id) VALUES(?)').run(uid);
const state = uid => { ensure(uid); return db.prepare('SELECT * FROM user_points WHERE user_id=?').get(uid); };
const balance = uid => state(uid).balance;
// Écriture dans le registre + solde ; les gains (montants positifs, hors remboursement) donnent de l'XP
function add(uid, amount, reason, { xp = amount > 0 } = {}) {
  ensure(uid);
  db.prepare('INSERT INTO points_ledger(user_id,amount,reason) VALUES(?,?,?)').run(uid, amount, reason);
  db.prepare('UPDATE user_points SET balance=balance+?, xp=xp+? WHERE user_id=?').run(amount, xp ? Math.max(0, amount) : 0, uid);
}
const level = xp => { const lv = Math.floor(Math.sqrt(xp / 100)) + 1; const cur = 100 * (lv - 1) ** 2, nxt = 100 * lv ** 2; return { lv, xp, cur, nxt, pct: Math.round((xp - cur) / (nxt - cur) * 100) }; };

function progress(uid, c) {
  const since = utcStart(c.period === 'jour' ? parisDay() : parisWeek());
  const where = { played: '1=1', won: 'won=1', tourney: "won=1 AND source='tournoi'" }[c.metric];
  return Math.min(c.goal, db.prepare(`SELECT COUNT(*) n FROM match_log WHERE user_id=? AND created_at>=? AND ${where}`).get(uid, since).n);
}
const periodKey = c => c.period === 'jour' ? parisDay() : parisWeek();
function checkChallenges(uid) {
  for (const c of CHALLENGES) if (progress(uid, c) >= c.goal) {
    const r = db.prepare('INSERT OR IGNORE INTO challenge_claims(user_id,challenge,period) VALUES(?,?,?)').run(uid, c.id, periodKey(c));
    if (r.changes) add(uid, c.reward, `Défi ${c.period === 'jour' ? 'du jour' : 'de la semaine'} : ${c.label}`);
  }
}

// Résultat d'un match (classé, partie rapide, privée, tournoi)
const SRC = { classe: 'partie classée', rapide: 'partie rapide', privee: 'partie privée', tournoi: 'match de tournoi' };
function recordMatch(winners, losers, source) {
  const label = SRC[source] || source;
  db.transaction(() => {
    for (const uid of new Set(winners)) {
      ensure(uid);
      const firstToday = !db.prepare("SELECT 1 FROM match_log WHERE user_id=? AND won=1 AND created_at>=?").get(uid, utcStart(parisDay()));
      db.prepare('INSERT INTO match_log(user_id,won,source) VALUES(?,1,?)').run(uid, source);
      add(uid, PTS.WIN, `Victoire (${label})`);
      if (firstToday) add(uid, PTS.FIRST_WIN_BONUS, 'Bonus première victoire du jour (x2)');
      db.prepare('UPDATE user_points SET win_streak=win_streak+1 WHERE user_id=?').run(uid);
      const s = state(uid).win_streak;
      if (s % PTS.STREAK_EVERY === 0) add(uid, PTS.STREAK, `Série de ${s} victoires d'affilée`);
      checkChallenges(uid);
    }
    for (const uid of new Set(losers)) {
      ensure(uid);
      db.prepare('INSERT INTO match_log(user_id,won,source) VALUES(?,0,?)').run(uid, source);
      add(uid, PTS.LOSS, `Participation (${label})`);
      db.prepare('UPDATE user_points SET win_streak=0 WHERE user_id=?').run(uid);
      checkChallenges(uid);
    }
  })();
}

// Bonus de connexion quotidien : +25, +5 par jour de série consécutif (max +50 de bonus)
function dailyLogin(uid) {
  const s = state(uid), today = parisDay();
  if (s.last_login_day === today) return null;
  const y = new Date(today + 'T12:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
  const streak = s.last_login_day === y.toISOString().slice(0, 10) ? s.login_streak + 1 : 1;
  const r = db.prepare('UPDATE user_points SET last_login_day=?, login_streak=? WHERE user_id=? AND (last_login_day IS NULL OR last_login_day<>?)').run(today, streak, uid, today);
  if (!r.changes) return null;
  const bonus = Math.min(PTS.DAILY_STREAK_MAX, (streak - 1) * PTS.DAILY_STREAK_STEP);
  add(uid, PTS.DAILY, `Bonus de connexion quotidien (jour ${streak})`);
  if (bonus) add(uid, bonus, `Bonus de série de connexion (${streak} jours)`);
  return { streak, total: PTS.DAILY + bonus };
}

function buy(uid, itemId) {
  const it = ITEM[itemId]; if (!it) throw new Error('Objet introuvable.');
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM inventory WHERE user_id=? AND item_id=?').get(uid, it.id)) throw new Error('Tu possèdes déjà cet objet.');
    if (balance(uid) < it.price) throw new Error(`Points insuffisants : il te faut ${it.price} LP (solde : ${balance(uid)} LP).`);
    add(uid, -it.price, `Achat boutique : ${it.name}`);
    db.prepare('INSERT INTO inventory(user_id,item_id) VALUES(?,?)').run(uid, it.id);
    return it;
  })();
}
function equip(uid, itemId) {
  const it = ITEM[itemId]; if (!it) throw new Error('Objet introuvable.');
  if (!db.prepare('SELECT 1 FROM inventory WHERE user_id=? AND item_id=?').get(uid, it.id)) throw new Error("Tu ne possèdes pas cet objet.");
  db.prepare('INSERT OR REPLACE INTO equipped(user_id,slot,item_id) VALUES(?,?,?)').run(uid, it.slot, it.id); return it;
}
const unequip = (uid, slot) => db.prepare('DELETE FROM equipped WHERE user_id=? AND slot=?').run(uid, slot);
function deco(uid) {
  const d = {}; if (!uid) return d;
  for (const r of db.prepare('SELECT slot,item_id FROM equipped WHERE user_id=?').all(uid)) if (ITEM[r.item_id]) d[r.slot] = ITEM[r.item_id];
  return d;
}

module.exports = { PTS, RARITY, SLOTS, ITEMS, ITEM, CHALLENGES, add, balance, state, level, progress, recordMatch, dailyLogin, buy, equip, unequip, deco, parisDay, periodKey };

// ---- Rendu des cosmétiques équipés ----
const { esc } = require('./views');
function nameHtml(uid, pseudo, { link = true, title = true } = {}) {
  const d = deco(uid);
  const n = `<span class="pn"${d.color ? ` style="color:${d.color.value};text-shadow:0 0 8px ${d.color.value}"` : ''}>${esc(pseudo)}</span>`;
  return `${d.badge ? `<span class="lp-badge" title="${esc(d.badge.name)}">${d.badge.value}</span> ` : ''}${link ? `<a href="/joueurs/${encodeURIComponent(pseudo)}">${n}</a>` : n}${title && d.title ? ` <span class="lp-title r-${d.title.rarity}">${esc(d.title.value)}</span>` : ''}`;
}
function avatarHtml(uid, pseudo, img) {
  const d = deco(uid), st = d.frame ? ` style="--fr:${d.frame.value}"` : '';
  return `<div class="avatar-wrap${d.frame ? ' framed' : ''}"${st}>${img ? `<img class="avatar" src="${esc(img)}" alt="Avatar" style="object-fit:cover">` : `<div class="avatar">${esc(String(pseudo)[0].toUpperCase())}</div>`}</div>`;
}
const bannerHtml = uid => { const d = deco(uid); return d.banner ? `<div class="lp-banner" style="background:${d.banner.value}"></div>` : ''; };
function levelHtml(uid) {
  const L = level(state(uid).xp);
  return `<div class="lp-level"><b>Niveau ${L.lv}</b><div class="bar"><i style="width:${L.pct}%"></i></div><small class="muted">${L.xp} / ${L.nxt} XP</small></div>`;
}
// Titre de profil : <h1>pseudo …</h1> (couleur sur le h1, badge et titre à la suite)
function h1Html(uid, pseudo, extra = '') {
  const d = deco(uid);
  return `<h1${d.color ? ` style="color:${d.color.value};text-shadow:0 0 14px ${d.color.value}"` : ''}>${esc(pseudo)} ${d.badge ? `<span class="lp-badge">${d.badge.value}</span> ` : ''}${d.title ? `<span class="lp-title r-${d.title.rarity}">${esc(d.title.value)}</span> ` : ''}${extra}</h1>`;
}
Object.assign(module.exports, { h1Html, nameHtml, avatarHtml, bannerHtml, levelHtml });
