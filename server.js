// LiveRoums Arena — serveur Express
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
require('dotenv').config({ quiet: true });
const db = require('./db');
const S = require('./services');
const B = require('./bracket');
const V = require('./views');
const { esc, layout, card, status, GAMES, PLATFORMS } = V;

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 } }));
app.use((req, res, next) => {
  B.autoGenerate();
  req.user = req.session.uid ? db.prepare('SELECT id,pseudo,email,platform,game_id,is_admin FROM users WHERE id=?').get(req.session.uid) : null;
  res.page = (title, body) => { const f = req.session.flash; delete req.session.flash; res.send(layout(title, req.user, f, body)); };
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});
const auth = (req, res, next) => req.user ? next() : (req.flash('err', 'Connecte-toi pour continuer.'), res.redirect(303, '/connexion?next=' + encodeURIComponent(req.originalUrl)));
const admin = (req, res, next) => req.user?.is_admin ? next() : res.status(403).send(layout('Accès refusé', req.user, { type: 'err', msg: 'Réservé aux administrateurs.' }, ''));

const TQ = `SELECT t.*, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id=t.id) count FROM tournaments t`;
const MMR = require('./routes-mm')(app, { auth, admin });
require('./discord-oauth')(app, { auth });
const M = require('./mm');
const getT = id => db.prepare(TQ + ' WHERE t.id=?').get(id);

// ---------- Accueil ----------
app.get('/', (req, res) => {
  const all = db.prepare(TQ + ' ORDER BY t.start_date').all();
  const featured = all.filter(t => status(t).key === 'ouvert').slice(0, 3);
  const games = Object.entries(GAMES).map(([g, v]) => ({ g, ...v, n: all.filter(t => t.game === g).length }));
  res.page('Accueil', `
  <section class="hero"><div class="glow"></div><p class="kicker">Saison 2026 · Plateforme 100% gaming</p>
  <h1>Entre dans l'<span class="neon">arène</span>.<br>Grimpe le <span class="neon2">bracket</span>.</h1>
  <p class="lead">Tournois Valorant, LoL, Rocket League, EA FC, Fortnite, CS2, Call of Duty… Inscris-toi en solo ou avec ton équipe, suis le bracket en direct et décroche le cashprize.</p>
  <div class="cta"><a class="btn lg" href="/tournois">Voir les tournois</a>${req.user ? '' : '<a class="btn ghost lg" href="/inscription">Créer mon compte</a>'}</div>
  <div class="stats"><div><b>${all.length}</b><span>tournois</span></div><div><b>${db.prepare('SELECT COUNT(*) c FROM users').get().c}</b><span>joueurs</span></div><div><b>${all.filter(t => status(t).key === 'ouvert').length}</b><span>inscriptions ouvertes</span></div></div></section>
  <section><div class="sec-head"><h2>🔥 Tournois à la une</h2><a href="/tournois">Tout voir →</a></div><div class="grid">${featured.map(card).join('') || '<p class="muted">Aucun tournoi ouvert.</p>'}</div></section>
  <section><h2>🎮 Jeux populaires</h2><div class="games">${games.map(g => `<a class="game" style="--gc:${g.color}" href="/tournois?jeu=${encodeURIComponent(g.g)}"><span>${g.icon}</span><b>${esc(g.g)}</b><small>${g.n} tournoi(s)</small></a>`).join('')}</div></section>
  <section class="how"><h2>Comment ça marche ?</h2><div class="steps"><div><b>1</b><h4>Crée ton compte</h4><p>Pseudo, plateforme et ID de jeu.</p></div><div><b>2</b><h4>Inscris-toi</h4><p>En solo, ou crée ton équipe et ajoute tes coéquipiers.</p></div><div><b>3</b><h4>Joue le bracket</h4><p>Élimination directe générée automatiquement.</p></div></div></section>`);
});

// ---------- Liste + filtres ----------
app.get('/tournois', (req, res) => {
  const { jeu = '', plateforme = '', format = '', statut = '', q = '' } = req.query;
  const list = db.prepare(TQ + ' ORDER BY t.start_date').all()
    .filter(t => (!jeu || t.game === jeu) && (!plateforme || t.platform === plateforme) && (!format || t.format === format)
      && (!statut || status(t).key === statut) && (!q || t.name.toLowerCase().includes(String(q).toLowerCase())));
  const L = { jeu: 'Tous les jeux', plateforme: 'Toutes plateformes', format: 'Tous formats', statut: 'Tous statuts' };
  const sel = (name, val, opts) => `<select name="${name}" onchange="this.form.submit()"><option value="">${L[name]}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  res.page('Tournois', `<section><h1>Tournois</h1>
  <form class="filters" method="get"><input name="q" placeholder="🔍 Rechercher…" value="${esc(q)}">
  ${sel('jeu', jeu, Object.keys(GAMES).map(g => [g, g]))}${sel('plateforme', plateforme, PLATFORMS.map(p => [p, p]))}
  ${sel('format', format, [['solo', 'Solo'], ['equipe', 'Équipe']])}${sel('statut', statut, [['ouvert', 'Ouvert'], ['complet', 'Complet'], ['ferme', 'Inscriptions closes'], ['en_cours', 'En cours'], ['termine', 'Terminé']])}
  <button class="btn sm">Filtrer</button><a href="/tournois" class="btn ghost sm">Réinitialiser</a></form>
  <p class="muted">${list.length} tournoi(s)</p><div class="grid">${list.map(card).join('') || '<p class="muted">Aucun tournoi ne correspond.</p>'}</div></section>`);
});

// ---------- Détail ----------
app.get('/tournois/:id', (req, res) => {
  const t = getT(req.params.id); if (!t) return res.status(404).page('Introuvable', '<h1>Tournoi introuvable</h1>');
  const s = status(t); const g = GAMES[t.game] || { icon: '🎮', color: '#00f0ff' };
  const mine = req.user && db.prepare('SELECT * FROM registrations WHERE tournament_id=? AND user_id=?').get(t.id, req.user.id);
  let entrants;
  if (t.format === 'equipe') {
    entrants = db.prepare('SELECT tm.*, u.pseudo cap FROM teams tm JOIN users u ON u.id=tm.captain_id WHERE tournament_id=?').all(t.id)
      .map(tm => `<li><b>${esc(tm.name)}</b> <span class="muted">— cap. <a href="/joueurs/${encodeURIComponent(tm.cap)}">${esc(tm.cap)}</a> ${MMR.rank(M.getSR(tm.captain_id, t.game), false)}, ${db.prepare('SELECT member_name FROM team_members WHERE team_id=?').all(tm.id).map(m => esc(m.member_name)).join(', ')}</span></li>`);
  } else entrants = db.prepare('SELECT u.id,u.pseudo,u.platform FROM registrations r JOIN users u ON u.id=r.user_id WHERE tournament_id=? ORDER BY r.id').all(t.id).map(u => `<li><a href="/joueurs/${encodeURIComponent(u.pseudo)}"><b>${esc(u.pseudo)}</b></a> ${MMR.rank(M.getSR(u.id, t.game))} <span class="muted">${esc(u.platform)}</span></li>`);
  const matches = db.prepare('SELECT * FROM matches WHERE tournament_id=? ORDER BY round,slot').all(t.id);
  let action;
  if (mine) action = `<div class="ok-box">✅ Tu es inscrit à ce tournoi.</div>${!t.bracket_generated ? `<form method="post" action="/tournois/${t.id}/desinscription"><button class="btn ghost">Se désinscrire</button></form>` : ''}`;
  else if (s.key === 'ouvert') action = `<a class="btn lg" href="/tournois/${t.id}/inscription">${t.format === 'solo' ? "S'inscrire" : 'Inscrire mon équipe'}</a>`;
  else action = `<button class="btn lg" disabled>${s.label}</button>`;
  res.page(t.name, `<section class="detail" style="--gc:${g.color}">
  <div class="dhead"><span class="gicon xl">${g.icon}</span><div><span class="badge ${s.key}">${s.label}</span>${t.is_example ? ' <span class="badge ex">Donnée d\'exemple</span>' : ''}
  <h1>${esc(t.name)}</h1><p class="muted">${esc(t.game)} · ${esc(t.platform)} · ${t.format === 'solo' ? 'Solo 1v1' : `Équipe ${t.team_size}v${t.team_size}`} · Élimination directe</p></div></div>
  <div class="info"><div><small>Cashprize</small><b>🏆 ${esc(t.cashprize || '—')}</b></div><div><small>Début</small><b>${V.fmtDate(t.start_date)}</b></div>
  <div><small>Clôture inscriptions</small><b>${V.fmtDate(t.reg_close)}</b></div><div><small>Places</small><b>${t.count} / ${t.max_slots}</b></div></div>
  <div class="cols"><div><h2>Description</h2><p>${esc(t.description)}</p><h2>Règlement</h2><pre class="rules">${esc(t.rules)}</pre></div>
  <aside class="panel">${action}${req.user?.is_admin ? `<hr><form method="post" action="/admin/tournois/${t.id}/bracket"><button class="btn ghost sm">⚙ ${t.bracket_generated ? 'Régénérer' : 'Générer'} le bracket</button></form>` : ''}
  <h3>Inscrits (${t.count})</h3><ul class="entrants">${entrants.join('') || '<li class="muted">Aucun inscrit pour le moment.</li>'}</ul></aside></div>
  <h2>Bracket</h2>${V.bracketHtml(matches, req.user?.is_admin, t.id)}</section>`);
});

// ---------- Inscription à un tournoi ----------
app.get('/tournois/:id/inscription', auth, (req, res) => {
  const t = getT(req.params.id); if (!t) return res.redirect('/tournois');
  const mates = Array.from({ length: t.team_size - 1 }, (_, i) => `<label>Coéquipier ${i + 2} (pseudo / ID de jeu)<input name="mates" required maxlength="40"></label>`).join('');
  res.page('Inscription', `<section class="form-wrap"><h1>Inscription — ${esc(t.name)}</h1><form method="post" class="form">
  <p class="muted">Joueur : <b>${esc(req.user.pseudo)}</b> (${esc(req.user.platform)}, ${esc(req.user.game_id || 'ID non renseigné')})</p>
  ${t.format === 'equipe' ? `<label>Nom de l'équipe<input name="team_name" required maxlength="40"></label><p class="muted">Tu seras capitaine. Ajoute tes ${t.team_size - 1} coéquipier(s) :</p>${mates}` : ''}
  <label class="check"><input type="checkbox" name="rules" required> J'accepte le règlement du tournoi</label><button class="btn lg">Confirmer l'inscription</button></form></section>`);
});
app.post('/tournois/:id/inscription', auth, (req, res) => {
  const t = getT(req.params.id); if (!t) return res.status(404).send('Introuvable');
  try { S.register(t.id, req.user.id, { teamName: req.body.team_name, mates: [].concat(req.body.mates || []) }); }
  catch (e) { req.flash('err', e.message); return res.redirect(303, `/tournois/${t.id}`); }
  req.flash('ok', 'Inscription confirmée ! Bonne chance 🎮'); res.redirect(303, `/tournois/${t.id}`);
});
app.post('/tournois/:id/desinscription', auth, (req, res) => {
  try { S.unregister(req.params.id, req.user.id); } catch (e) { req.flash('err', e.message); return res.redirect(303, '/profil'); }
  req.flash('ok', 'Tu as été désinscrit.'); res.redirect(303, (req.get('referer') || '').includes('/profil') ? '/profil' : `/tournois/${req.params.id}`);
});

// ---------- Comptes ----------
const platformOpts = sel => PLATFORMS.map(p => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');
app.get('/inscription', (req, res) => res.page('Créer un compte', `<section class="form-wrap"><h1>Créer un compte</h1><form method="post" class="form">
  <label>Pseudo<input name="pseudo" required minlength="3" maxlength="20"></label><label>Email<input type="email" name="email" required></label>
  <label>Mot de passe (8 caractères min.)<input type="password" name="password" required minlength="8"></label>
  <label>Plateforme principale<select name="platform">${platformOpts('PC')}</select></label><label>ID de jeu (Riot ID, Epic, PSN…)<input name="game_id" maxlength="40" placeholder="Pseudo#1234"></label>
  <button class="btn lg">Créer mon compte</button><p class="muted">Déjà inscrit ? <a href="/connexion">Connexion</a></p></form></section>`));
app.post('/inscription', async (req, res) => {
  const { pseudo = '', email = '', password = '', platform = '', game_id = '' } = req.body;
  const err = m => { req.flash('err', m); res.redirect(303, '/inscription'); };
  if (!/^[A-Za-z0-9_\-.]{3,20}$/.test(pseudo)) return err('Pseudo invalide (3-20 caractères alphanumériques).');
  if (!/^\S+@\S+\.\S+$/.test(email)) return err('Email invalide.');
  if (password.length < 8) return err('Mot de passe trop court (8 caractères minimum).');
  if (!PLATFORMS.includes(platform)) return err('Plateforme invalide.');
  if (db.prepare('SELECT 1 FROM users WHERE pseudo=? OR email=?').get(pseudo, email.toLowerCase())) return err('Pseudo ou email déjà utilisé.');
  const hash = await bcrypt.hash(password, 12);
  const id = db.prepare('INSERT INTO users(pseudo,email,password_hash,platform,game_id) VALUES(?,?,?,?,?)').run(pseudo, email.toLowerCase(), hash, platform, game_id.trim()).lastInsertRowid;
  req.session.regenerate(() => { req.session.uid = id; req.session.flash = { type: 'ok', msg: `Bienvenue ${pseudo} !` }; res.redirect(303, '/profil'); });
});
app.get('/connexion', (req, res) => res.page('Connexion', `<section class="form-wrap"><h1>Connexion</h1><form method="post" class="form">
  <input type="hidden" name="next" value="${esc(req.query.next || '/profil')}"><label>Email ou pseudo<input name="login" required></label>
  <label>Mot de passe<input type="password" name="password" required></label><button class="btn lg">Se connecter</button>
  <a class="btn discord lg" href="/auth/discord">💬 Se connecter avec Discord</a>
  <p class="muted">Pas de compte ? <a href="/inscription">Inscription</a></p></form></section>`));
app.post('/connexion', async (req, res) => {
  const { login = '', password = '' } = req.body; const next = String(req.body.next || '/profil');
  const u = db.prepare('SELECT * FROM users WHERE email=? OR pseudo=?').get(String(login).toLowerCase(), login);
  if (!u || !(await bcrypt.compare(String(password), u.password_hash))) { req.flash('err', 'Identifiants incorrects.'); return res.redirect(303, '/connexion'); }
  req.session.regenerate(() => { req.session.uid = u.id; res.redirect(303, next.startsWith('/') && !next.startsWith('//') ? next : '/profil'); });
});
app.post('/deconnexion', (req, res) => req.session.destroy(() => res.redirect(303, '/')));

// ---------- Profil ----------
app.get('/profil', auth, (req, res) => {
  const regs = db.prepare(`SELECT t.id, tm.name team FROM registrations r JOIN tournaments t ON t.id=r.tournament_id LEFT JOIN teams tm ON tm.id=r.team_id WHERE r.user_id=? ORDER BY t.start_date`).all(req.user.id);
  const rows = regs.map(r => { const t = getT(r.id); const s = status(t); return `<tr><td><a href="/tournois/${t.id}">${esc(t.name)}</a></td><td>${esc(t.game)}</td><td>${r.team ? '👥 ' + esc(r.team) : 'Solo'}</td><td>${V.fmtDate(t.start_date)}</td><td><span class="badge ${s.key}">${s.label}</span></td>
    <td>${!t.bracket_generated ? `<form method="post" action="/tournois/${t.id}/desinscription" onsubmit="return confirm('Se désinscrire ?')"><button class="btn ghost sm">Se désinscrire</button></form>` : '—'}</td></tr>`; }).join('');
  res.page('Mon profil', `<section><div class="profile"><div class="avatar">${esc(req.user.pseudo[0].toUpperCase())}</div><div><h1>${esc(req.user.pseudo)} ${req.user.is_admin ? '<span class="badge ex">Admin</span>' : ''}</h1>
  <p class="muted">${esc(req.user.email)} · ${esc(req.user.platform)} · ID de jeu : ${esc(req.user.game_id || '—')}</p></div></div>
  <p><a href="/joueurs/${encodeURIComponent(req.user.pseudo)}">Voir mon profil public →</a></p>
  <h2>Skill rating</h2><div class="sr-grid">${MMR.srTable(req.user.id)}</div>
  <h2>🔗 Comptes liés</h2>${MMR.linkedList(req.user.id)}
  <div class="link-forms panel"><div class="inline">${(() => { const d = db.prepare('SELECT discord_username FROM users WHERE id=?').get(req.user.id).discord_username;
    return d ? `<span class="link-chip">💬 <b>Discord</b> ${esc(d)} <i class="ver ok">✔ vérifié</i></span><form method="post" action="/profil/discord/delier" class="inline"><button class="btn ghost sm">Délier Discord</button></form>`
      : '<a class="btn discord" href="/auth/discord">💬 Lier mon compte Discord</a>'; })()}<a class="btn steam" href="/auth/steam">🟦 Se connecter avec Steam (vérifié)</a></div>
  <form method="post" action="/profil/comptes" class="inline"><select name="provider">${Object.entries(MMR.PROVIDERS).filter(([k]) => k !== 'steam' && k !== 'discord').map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select>
  <input name="account_id" placeholder="ID / pseudo du compte" required maxlength="60"><button class="btn sm">Lier (non vérifié)</button></form>
  <div class="linked">${db.prepare('SELECT provider FROM linked_accounts WHERE user_id=?').all(req.user.id).filter(a => a.provider !== 'discord').map(a => `<form method="post" action="/profil/comptes/${a.provider}/supprimer" class="inline"><button class="btn ghost sm">Délier ${esc(MMR.PROVIDERS[a.provider]?.[0] || a.provider)}</button></form>`).join('')}</div>
  <p class="muted sm">Steam utilise OpenID 2.0 (vérification réelle, nécessite une URL publique). Les autres plateformes sont déclaratives (« non vérifié ») : la vérification exige les API partenaires officielles.</p></div>
  <h2>Mes tournois (${regs.length})</h2>${regs.length ? `<div class="table-wrap"><table><tr><th>Tournoi</th><th>Jeu</th><th>Inscription</th><th>Date</th><th>Statut</th><th></th></tr>${rows}</table></div>` : '<p class="muted">Aucune inscription. <a href="/tournois">Trouver un tournoi →</a></p>'}</section>`);
});

// ---------- Admin ----------
app.get('/admin/tournois/nouveau', auth, admin, (req, res) => res.page('Créer un tournoi', `<section class="form-wrap wide"><h1>Créer un tournoi</h1><form method="post" action="/admin/tournois" class="form two">
  <label class="full">Nom<input name="name" required maxlength="80"></label><label>Jeu<select name="game">${Object.keys(GAMES).map(g => `<option>${g}</option>`).join('')}</select></label>
  <label>Plateforme<select name="platform">${platformOpts('PC')}</select></label><label>Format<select name="format"><option value="solo">Solo</option><option value="equipe">Équipe</option></select></label>
  <label>Joueurs par équipe<input type="number" name="team_size" min="1" max="10" value="1"></label><label>Nombre de places<input type="number" name="max_slots" min="2" max="256" value="16" required></label>
  <label>Cashprize<input name="cashprize" placeholder="500 €"></label><label>Début<input type="datetime-local" name="start_date" required></label><label>Clôture des inscriptions<input type="datetime-local" name="reg_close" required></label>
  <label class="full">Description<textarea name="description" rows="3"></textarea></label><label class="full">Règlement<textarea name="rules" rows="6"></textarea></label>
  <button class="btn lg full">Publier le tournoi</button></form></section>`));
app.post('/admin/tournois', auth, admin, (req, res) => {
  const b = req.body; const fmt = b.format === 'equipe' ? 'equipe' : 'solo';
  const ts = fmt === 'solo' ? 1 : Math.max(2, Math.min(10, +b.team_size || 2)); const slots = Math.max(2, Math.min(256, +b.max_slots || 0));
  if (!b.name || !GAMES[b.game] || !PLATFORMS.includes(b.platform) || !b.start_date || !b.reg_close) { req.flash('err', 'Champs invalides.'); return res.redirect(303, '/admin/tournois/nouveau'); }
  if (b.reg_close > b.start_date) { req.flash('err', 'La clôture doit précéder le début.'); return res.redirect(303, '/admin/tournois/nouveau'); }
  const id = db.prepare(`INSERT INTO tournaments(name,game,platform,format,team_size,max_slots,cashprize,start_date,reg_close,rules,description,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.name, b.game, b.platform, fmt, ts, slots, b.cashprize, b.start_date, b.reg_close, b.rules, b.description, req.user.id).lastInsertRowid;
  db.emit('tournament_created', { tournament_id: id });
  req.flash('ok', 'Tournoi publié.'); res.redirect(303, `/tournois/${id}`);
});
app.post('/admin/tournois/:id/bracket', auth, admin, (req, res) => {
  if (B.entries(req.params.id).length < 2) req.flash('err', 'Il faut au moins 2 inscrits.'); else { B.generate(req.params.id); req.flash('ok', 'Bracket généré.'); }
  res.redirect(303, `/tournois/${req.params.id}`);
});
app.post('/admin/tournois/:id/match/:mid', auth, admin, (req, res) => { B.setWinner(+req.params.id, +req.params.mid, req.body.winner); res.redirect(303, `/tournois/${req.params.id}`); });

app.get('/api/tournois', (req, res) => res.json(db.prepare(TQ).all().map(t => ({ ...t, statut: status(t).key }))));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LiveRoums Arena sur http://localhost:${PORT}`));
