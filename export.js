// Export de données admin : page /admin/export (session admin) + API GET /api/admin/anticheat-export (jeton Bearer)
// Format JSON = format d'import de l'agent anti-triche (players[], matches[]) + jeux de données complémentaires.
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const { GAME, esc } = require('./views');

const iso = s => s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).toISOString() : null; // SQLite = UTC
const sqlDate = s => new Date(s).toISOString().slice(0, 19).replace('T', ' ');
// HMAC stable : la même valeur donne le même hachage d'un export à l'autre (corrélation possible, valeur non réversible)
const hashKey = () => process.env.ANTICHEAT_HASH_KEY || process.env.ANTICHEAT_EXPORT_TOKEN || process.env.SESSION_SECRET || 'liveroums-export';
const hash = v => v == null || v === '' ? null : 'h:' + crypto.createHmac('sha256', hashKey()).update(String(v).trim().toLowerCase()).digest('hex').slice(0, 32);
const kind = l => l.ranked ? 'classe' : l.is_private ? 'privee' : 'rapide';

function parseSince(v) {
  if (!v) return null; const d = new Date(String(v));
  if (isNaN(d)) throw Object.assign(new Error('Paramètre since invalide (date ISO 8601 attendue).'), { status: 400 });
  return sqlDate(d);
}

// mode 'admin' : identifiants de plateformes en clair + emails (marqués sensibles) ; mode 'api' : tout identifiant sensible haché, pas d'email
function build({ since = null, mode = 'api' } = {}) {
  const A = mode === 'admin', S = since || '0000';
  const users = db.prepare(`SELECT u.id,u.pseudo,u.email,u.platform,u.game_id,u.is_admin,u.created_at,u.discord_id,u.discord_username,
      r.sr,r.wins,r.losses,COALESCE(p.balance,0) lp,COALESCE(p.xp,0) xp,qm.quatuor_id
    FROM users u LEFT JOIN ratings r ON r.user_id=u.id AND r.game=? LEFT JOIN user_points p ON p.user_id=u.id
    LEFT JOIN quatuor_members qm ON qm.user_id=u.id ORDER BY u.id`).all(GAME); // jamais password_hash ni sessions
  const linked = db.prepare('SELECT user_id,provider,account_id,verified,linked_at FROM linked_accounts').all();
  const byId = Object.fromEntries(users.map(u => [u.id, u]));
  const players = users.map(u => {
    const l = linked.filter(x => x.user_id === u.id).map(x => ({ provider: x.provider, account_id: A ? x.account_id : hash(x.account_id), verified: x.verified ? 1 : 0, linked_at: iso(x.linked_at) }));
    if (u.discord_id) l.push({ provider: 'Discord', account_id: hash(u.discord_id), verified: 1, linked_at: null }); // ID technique toujours haché
    const p = { id: u.id, pseudo: u.pseudo, platform: u.platform, created_at: iso(u.created_at), member_since: iso(u.created_at)?.slice(0, 10),
      sr: u.sr ?? 1000, wins: u.wins ?? 0, losses: u.losses ?? 0, lp_balance: u.lp, xp: u.xp, is_admin: u.is_admin ? 1 : 0,
      quatuor_id: u.quatuor_id ?? null, discord_id_hash: hash(u.discord_id), game_id: A ? u.game_id : hash(u.game_id), linked: l };
    if (A) { p.email = u.email; p.discord_username = u.discord_username; }
    return p;
  });
  const lobbies = db.prepare(`SELECT l.*,h.pseudo host FROM lobbies l LEFT JOIN users h ON h.id=l.host_id WHERE COALESCE(l.ended_at,l.created_at)>=? ORDER BY l.id`).all(S);
  const lp = db.prepare('SELECT lp.*,u.pseudo,qm.quatuor_id FROM lobby_players lp JOIN users u ON u.id=lp.user_id LEFT JOIN quatuor_members qm ON qm.user_id=lp.user_id WHERE lp.lobby_id=? ORDER BY lp.team,u.pseudo');
  const matches = lobbies.map(l => ({ code: l.code, kind: kind(l), ranked: l.ranked ? 1 : 0, is_private: l.is_private ? 1 : 0, mode: l.mode, team_size: l.team_size,
    map: l.map || null, status: l.status, winner_team: l.winner_team, host: l.host, started_at: iso(l.created_at), ended_at: iso(l.ended_at),
    players: lp.all(l.id).map(p => ({ pseudo: p.pseudo, team: p.team, sr_before: p.sr_before, sr_after: p.sr_after, quatuor_id: p.quatuor_id ?? null })) }));
  const points = db.prepare('SELECT l.id,u.pseudo,l.amount,l.reason,l.created_at FROM points_ledger l JOIN users u ON u.id=l.user_id WHERE l.created_at>=? ORDER BY l.id').all(S)
    .map(r => ({ ...r, created_at: iso(r.created_at) }));
  const tournaments = db.prepare('SELECT id,name,game,platform,format,team_size,max_slots,cashprize,start_date,reg_close,bracket_generated,finished,created_at FROM tournaments WHERE created_at>=? OR start_date>=? ORDER BY id').all(S, S)
    .map(t => ({ ...t, created_at: iso(t.created_at),
      registrations: db.prepare('SELECT u.pseudo,tm.name team,r.created_at FROM registrations r JOIN users u ON u.id=r.user_id LEFT JOIN teams tm ON tm.id=r.team_id WHERE r.tournament_id=? ORDER BY r.id').all(t.id).map(r => ({ ...r, created_at: iso(r.created_at) })),
      matches: db.prepare('SELECT round,slot,p1,p2,winner FROM matches WHERE tournament_id=? ORDER BY round,slot').all(t.id) }));
  const quatuors = db.prepare('SELECT q.id,q.code,q.game,u.pseudo leader,q.created_at FROM quatuors q JOIN users u ON u.id=q.leader_id ORDER BY q.id').all()
    .map(q => ({ ...q, code: A ? q.code : hash(q.code), created_at: iso(q.created_at),
      members: db.prepare('SELECT u.pseudo,m.joined_at FROM quatuor_members m JOIN users u ON u.id=m.user_id WHERE m.quatuor_id=? ORDER BY m.joined_at').all(q.id).map(m => ({ ...m, joined_at: iso(m.joined_at) })) }));
  const claims = db.prepare('SELECT c.id,u.pseudo,c.prize,c.status,c.twitch,c.created_at,c.delivered_at FROM prize_claims c JOIN users u ON u.id=c.user_id WHERE c.created_at>=? ORDER BY c.id').all(S)
    .map(c => ({ ...c, twitch: A ? c.twitch : hash(c.twitch), created_at: iso(c.created_at), delivered_at: iso(c.delivered_at) }));
  return {
    format: 'liveroums-anticheat-export/v1', generated_at: new Date().toISOString(), since: since ? iso(since) : null, mode: A ? 'admin' : 'api',
    notes: ['Horodatages en UTC (ISO 8601).', 'started_at = création du salon (le site ne stocke pas l\'heure de lancement).',
      'quatuor_id des participations = appartenance actuelle (l\'historique des quatuors n\'est pas conservé).',
      'since filtre parties, points, tournois et lots ; joueurs et quatuors sont un instantané complet.',
      'Les scores de suspicion sont calculés par l\'agent anti-triche, pas par le site.'],
    sensitive: A ? ['players[].email', 'players[].discord_username', 'players[].linked[].account_id', 'players[].game_id', 'claims[].twitch', 'quatuors[].code'] : [],
    hashed: ['players[].discord_id_hash', 'players[].linked[provider=Discord].account_id', ...(A ? [] : ['players[].linked[].account_id', 'players[].game_id', 'claims[].twitch', 'quatuors[].code'])],
    players, matches, points, tournaments, quatuors, claims,
  };
}

// ---- CSV (séparateur virgule, UTF-8 avec BOM, protection contre l'injection de formules) ----
const cell = v => { if (v == null) return ''; let s = String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (cols, rows) => '\ufeff' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
const DATASETS = {
  joueurs: { label: 'Joueurs', f: d => toCsv(['id', 'pseudo', 'platform', 'created_at', 'member_since', 'sr', 'wins', 'losses', 'lp_balance', 'xp', 'is_admin', 'quatuor_id', 'discord_id_hash', 'game_id', 'email'], d.players) },
  comptes_lies: { label: 'Comptes liés', f: d => toCsv(['pseudo', 'provider', 'account_id', 'verified', 'linked_at'], d.players.flatMap(p => p.linked.map(l => ({ pseudo: p.pseudo, ...l })))) },
  parties: { label: 'Parties', f: d => toCsv(['code', 'kind', 'mode', 'team_size', 'map', 'status', 'winner_team', 'host', 'started_at', 'ended_at'], d.matches) },
  participations: { label: 'Participations', f: d => toCsv(['code', 'kind', 'status', 'winner_team', 'host', 'started_at', 'ended_at', 'pseudo', 'team', 'sr_before', 'sr_after', 'quatuor_id'], d.matches.flatMap(m => m.players.map(p => ({ ...m, ...p })))) },
  points: { label: 'Registre des points LP', f: d => toCsv(['id', 'pseudo', 'amount', 'reason', 'created_at'], d.points) },
  tournois: { label: 'Tournois (inscriptions)', f: d => toCsv(['id', 'name', 'game', 'platform', 'format', 'team_size', 'max_slots', 'start_date', 'finished', 'created_at', 'pseudo', 'team', 'registered_at'], d.tournaments.flatMap(t => (t.registrations.length ? t.registrations : [{}]).map(r => ({ ...t, pseudo: r.pseudo, team: r.team, registered_at: r.created_at })))) },
  quatuors: { label: 'Quatuors (membres)', f: d => toCsv(['id', 'code', 'leader', 'created_at', 'pseudo', 'joined_at'], d.quatuors.flatMap(q => q.members.map(m => ({ ...q, ...m })))) },
  lots: { label: 'Lots / réclamations', f: d => toCsv(['id', 'pseudo', 'prize', 'status', 'twitch', 'created_at', 'delivered_at'], d.claims) },
};

function download(res, name, type, body) {
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0', 'X-Content-Type-Options': 'nosniff' });
  res.send(body);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

module.exports = (app, { auth, admin }) => {
  const exportLimit = rateLimit({ windowMs: 6e4, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: req => req.user ? 'u' + req.user.id : ipKeyGenerator(req.ip), handler: (req, res) => res.status(429).json({ erreur: 'Trop d\'exports. Réessaie dans une minute.' }) });

  app.get('/admin/export', auth, admin, (req, res) => {
    const c = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const since = esc(req.query.since || '');
    res.set('Cache-Control', 'no-store');
    res.page('Export des données', `<section class="form-wrap wide"><h1>📦 Export des données (admin)</h1>
    <p class="muted">Données brutes pour l'analyse anti-triche. <b>Les scores de suspicion sont dans le tableau de bord anti-triche</b> (agent séparé) : importe le JSON dans sa page « Import ».</p>
    <div class="stats"><div><b>${c('users')}</b><span>joueurs</span></div><div><b>${c('lobbies')}</b><span>parties</span></div><div><b>${c('points_ledger')}</b><span>mouvements LP</span></div><div><b>${c('quatuors')}</b><span>quatuors</span></div><div><b>${c('prize_claims')}</b><span>lots</span></div></div>
    <form method="get" action="/admin/export" class="form inline"><label>Depuis (optionnel)<input type="date" name="since" value="${since}"></label><button class="btn ghost sm">Appliquer le filtre</button></form>
    <p class="muted">⚠ Fichiers <b>sensibles</b> : emails et identifiants de plateformes en clair (l'ID Discord technique reste haché). Aucun mot de passe ni donnée de session. Ne les partage pas.</p>
    <h2>JSON complet (format d'import de l'agent)</h2>
    <p><a class="btn" href="/admin/export/liveroums-export.json${since ? '?since=' + encodeURIComponent(req.query.since) : ''}">⬇ Télécharger le JSON</a></p>
    <h2>CSV par jeu de données</h2><ul class="export-list">${Object.entries(DATASETS).map(([k, d]) => `<li><a href="/admin/export/${k}.csv${since ? '?since=' + encodeURIComponent(req.query.since) : ''}">⬇ ${esc(d.label)}</a> <span class="muted">(${k}.csv)</span></li>`).join('')}</ul>
    <h2>API pour l'agent</h2><p class="muted">GET <code>/api/admin/anticheat-export?since=ISO8601</code> avec <code>Authorization: Bearer &lt;ANTICHEAT_EXPORT_TOKEN&gt;</code> — identifiants sensibles hachés, sans email. ${process.env.ANTICHEAT_EXPORT_TOKEN ? '<b>Activée.</b>' : '<b>Désactivée</b> (variable ANTICHEAT_EXPORT_TOKEN non définie).'}</p></section>`);
  });

  app.get('/admin/export/liveroums-export.json', auth, admin, exportLimit, (req, res, next) => {
    try { download(res, `liveroums-export-${stamp()}.json`, 'application/json; charset=utf-8', JSON.stringify(build({ since: parseSince(req.query.since), mode: 'admin' }), null, 1)); }
    catch (e) { if (e.status) return res.status(e.status).send(esc(e.message)); next(e); }
  });
  app.get('/admin/export/:ds.csv', auth, admin, exportLimit, (req, res, next) => {
    const d = DATASETS[req.params.ds]; if (!d) return res.status(404).send('Jeu de données inconnu.');
    try { download(res, `liveroums-${req.params.ds}-${stamp()}.csv`, 'text/csv; charset=utf-8', d.f(build({ since: parseSince(req.query.since), mode: 'admin' }))); }
    catch (e) { if (e.status) return res.status(e.status).send(esc(e.message)); next(e); }
  });

  // API machine-à-machine : désactivée (404) tant que ANTICHEAT_EXPORT_TOKEN n'est pas défini
  const apiLimit = rateLimit({ windowMs: 6e4, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => ipKeyGenerator(req.ip),
    handler: (req, res) => res.status(429).json({ erreur: 'Trop de requêtes.' }) });
  const digest = s => crypto.createHash('sha256').update(String(s)).digest();
  app.get('/api/admin/anticheat-export', apiLimit, (req, res, next) => {
    const tok = process.env.ANTICHEAT_EXPORT_TOKEN;
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    if (!tok) return res.status(404).json({ erreur: 'Export désactivé.' });
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!m || !crypto.timingSafeEqual(digest(m[1].trim()), digest(tok))) { res.set('WWW-Authenticate', 'Bearer'); return res.status(401).json({ erreur: 'Jeton invalide.' }); }
    try { res.json(build({ since: parseSince(req.query.since), mode: 'api' })); }
    catch (e) { if (e.status) return res.status(e.status).json({ erreur: e.message }); next(e); }
  });
};
module.exports.build = build;
