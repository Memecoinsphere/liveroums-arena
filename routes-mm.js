// Routes : classement, profils publics, comptes liés (Steam OpenID), matchmaking & parties
const db = require('./db');
const M = require('./mm');
const { esc, GAMES } = require('./views');

const rank = (sr, withSr = true) => { const t = M.tier(sr); return `<span class="rank" style="--rc:${t.color}" title="${t.name} · ${sr} SR">◆ ${t.name}${withSr ? ` <b>${sr}</b>` : ''}</span>`; };
const PROVIDERS = { discord: ['Discord', '💬'], steam: ['Steam', '🟦'], psn: ['PlayStation Network', '🎮'], xbox: ['Xbox Live', '🟩'], epic: ['Epic Games', '⬛'],
  riot: ['Riot Games', '🟥'], battlenet: ['Battle.net', '🔷'], nintendo: ['Nintendo', '🔴'] };
const poll = (url, v, redirectKey) => `<script>(()=>{const v0=${JSON.stringify(v)};setInterval(async()=>{try{const r=await fetch(${JSON.stringify(url)},{cache:'no-store'});const j=await r.json();
${redirectKey ? `if(j.${redirectKey})return location.href=j.${redirectKey};` : ''}if(j.v!==v0)location.reload();}catch(e){}},3000);})();</script>`;
const STEAM = 'https://steamcommunity.com/openid/login';

function srTable(uid) {
  return Object.keys(GAMES).map(g => {
    const r = db.prepare('SELECT * FROM ratings WHERE user_id=? AND game=?').get(uid, g) || { sr: M.START, wins: 0, losses: 0 };
    return `<div class="sr-card" style="--gc:${GAMES[g].color}"><span>${GAMES[g].icon} ${esc(g)}</span>${rank(r.sr)}<small class="muted">${r.wins} V · ${r.losses} D</small></div>`;
  }).join('');
}
function linkedList(uid) {
  const rows = db.prepare('SELECT * FROM linked_accounts WHERE user_id=?').all(uid);
  return rows.length ? `<div class="linked">${rows.map(a => `<span class="link-chip">${PROVIDERS[a.provider]?.[1] || ''} <b>${esc(PROVIDERS[a.provider]?.[0] || a.provider)}</b> ${esc(a.account_id)} ${a.verified ? '<i class="ver ok">✔ vérifié</i>' : '<i class="ver">non vérifié</i>'}</span>`).join('')}</div>` : '<p class="muted">Aucun compte lié.</p>';
}

module.exports = (app, { auth, admin }) => {
  // ---------- Classement ----------
  app.get('/classement', (req, res) => {
    const game = GAMES[req.query.jeu] ? req.query.jeu : 'Valorant';
    const rows = db.prepare(`SELECT u.pseudo, r.* FROM ratings r JOIN users u ON u.id=r.user_id WHERE r.game=? ORDER BY r.sr DESC LIMIT 100`).all(game);
    res.page('Classement', `<section><h1>🏅 Classement SR</h1>
    <div class="tabs">${Object.keys(GAMES).map(g => `<a class="${g === game ? 'active' : ''}" href="/classement?jeu=${encodeURIComponent(g)}">${GAMES[g].icon} ${esc(g)}</a>`).join('')}</div>
    <div class="tiers">${M.TIERS.map(([min, n, c]) => `<span class="rank" style="--rc:${c}">◆ ${n} <small>${min}+</small></span>`).join('')}</div>
    <div class="table-wrap"><table class="lb"><tr><th>#</th><th>Joueur</th><th>Rang</th><th>SR</th><th>V / D</th><th>% victoires</th></tr>
    ${rows.map((r, i) => `<tr class="${i < 3 ? 'top' + (i + 1) : ''}"><td class="pos">${i + 1}</td><td><a href="/joueurs/${encodeURIComponent(r.pseudo)}">${esc(r.pseudo)}</a></td><td>${rank(r.sr, false)}</td><td><b>${r.sr}</b></td><td>${r.wins} / ${r.losses}</td><td>${r.wins + r.losses ? Math.round(r.wins / (r.wins + r.losses) * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun joueur classé.</td></tr>'}
    </table></div><p class="muted sm">SR de départ : ${M.START}. Système Elo (K=${32}) mis à jour après chaque match de tournoi et de matchmaking.</p></section>`);
  });

  // ---------- Profil public ----------
  app.get('/joueurs/:pseudo', (req, res) => {
    const u = db.prepare('SELECT id,pseudo,platform,game_id,created_at FROM users WHERE pseudo=?').get(req.params.pseudo);
    if (!u) return res.status(404).page('Introuvable', '<h1>Joueur introuvable</h1>');
    const ts = db.prepare('SELECT t.id,t.name FROM registrations r JOIN tournaments t ON t.id=r.tournament_id WHERE r.user_id=?').all(u.id);
    res.page(u.pseudo, `<section><div class="profile"><div class="avatar">${esc(u.pseudo[0].toUpperCase())}</div><div><h1>${esc(u.pseudo)}</h1>
    <p class="muted">${esc(u.platform)} · membre depuis ${new Date(u.created_at).toLocaleDateString('fr-FR')}</p></div></div>
    <h2>Skill rating</h2><div class="sr-grid">${srTable(u.id)}</div><h2>Comptes liés</h2>${linkedList(u.id)}
    <h2>Tournois</h2>${ts.length ? `<ul>${ts.map(t => `<li><a href="/tournois/${t.id}">${esc(t.name)}</a></li>`).join('')}</ul>` : '<p class="muted">Aucun.</p>'}</section>`);
  });
  app.get('/api/joueurs/:pseudo', (req, res) => {
    const u = db.prepare('SELECT id,pseudo FROM users WHERE pseudo=?').get(req.params.pseudo); if (!u) return res.status(404).json({});
    res.json({ pseudo: u.pseudo, ratings: Object.fromEntries(db.prepare('SELECT game,sr FROM ratings WHERE user_id=?').all(u.id).map(r => [r.game, r.sr])),
      lobby: M.activeLobby(u.id)?.code || null, queue: db.prepare('SELECT game,mode FROM queue WHERE user_id=?').get(u.id) || null });
  });

  // ---------- Comptes liés ----------
  app.post('/profil/comptes', auth, (req, res) => {
    const p = req.body.provider, id = String(req.body.account_id || '').trim();
    if (!PROVIDERS[p] || p === 'steam' || p === 'discord' || !id || id.length > 60) { req.flash('err', 'Compte invalide.'); return res.redirect(303, '/profil'); }
    db.prepare('INSERT OR REPLACE INTO linked_accounts(user_id,provider,account_id,verified) VALUES(?,?,?,0)').run(req.user.id, p, id);
    req.flash('ok', `${PROVIDERS[p][0]} lié (non vérifié).`); res.redirect(303, '/profil');
  });
  app.post('/profil/comptes/:p/supprimer', auth, (req, res) => {
    db.prepare('DELETE FROM linked_accounts WHERE user_id=? AND provider=?').run(req.user.id, req.params.p); req.flash('ok', 'Compte délié.'); res.redirect(303, '/profil');
  });
  // Steam OpenID 2.0 (aucune clé API requise ; nécessite une URL publique joignable par le navigateur)
  const base = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  app.get('/auth/steam', auth, (req, res) => {
    const p = new URLSearchParams({ 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
      'openid.return_to': base(req) + '/auth/steam/retour', 'openid.realm': base(req),
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select', 'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select' });
    res.redirect(`${STEAM}?${p}`);
  });
  app.get('/auth/steam/retour', auth, async (req, res) => {
    const q = req.query; const fail = m => { req.flash('err', 'Liaison Steam échouée : ' + m); res.redirect(303, '/profil'); };
    if (q['openid.mode'] !== 'id_res') return fail('connexion annulée.');
    if (!String(q['openid.return_to'] || '').startsWith(base(req) + '/auth/steam/retour')) return fail('return_to invalide.');
    if (q['openid.op_endpoint'] !== STEAM) return fail('fournisseur inattendu.');
    const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(q['openid.claimed_id'] || '');
    if (!m) return fail('identifiant invalide.');
    try {
      const body = new URLSearchParams(Object.entries(q).filter(([k]) => k.startsWith('openid.')));
      body.set('openid.mode', 'check_authentication');
      const r = await fetch(STEAM, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!/is_valid\s*:\s*true/.test(await r.text())) return fail('signature refusée par Steam.');
    } catch (e) { return fail('Steam injoignable.'); }
    db.prepare('INSERT OR REPLACE INTO linked_accounts(user_id,provider,account_id,verified) VALUES(?,?,?,1)').run(req.user.id, 'steam', m[1]);
    req.flash('ok', 'Compte Steam vérifié et lié ✔'); res.redirect(303, '/profil');
  });

  // ---------- Matchmaking ----------
  const modeOpts = () => Object.entries(M.MODES).map(([g, ms]) => `<optgroup label="${esc(g)}">${ms.map(m => `<option value="${esc(g)}|${m}">${esc(g)} — ${m}</option>`).join('')}</optgroup>`).join('');
  const queueState = uid => {
    const counts = db.prepare('SELECT game,mode,COUNT(*) n FROM queue GROUP BY game,mode').all();
    const mine = uid ? db.prepare('SELECT * FROM queue WHERE user_id=?').get(uid) : null;
    const lobby = uid ? M.activeLobby(uid) : null;
    const live = db.prepare("SELECT COUNT(*) c FROM lobbies WHERE status='en_cours'").get().c;
    return { counts, mine, lobby, live, v: JSON.stringify([counts, mine && mine.game + mine.mode, lobby?.code, live]) };
  };
  app.get('/api/matchmaking', (req, res) => { const s = queueState(req.user?.id); res.json({ v: s.v, partie: s.lobby && s.lobby.status === 'en_cours' ? `/parties/${s.lobby.code}` : null }); });
  app.get('/matchmaking', (req, res) => {
    const s = queueState(req.user?.id);
    const cnt = (g, m) => s.counts.find(c => c.game === g && c.mode === m)?.n || 0;
    const cards = Object.entries(M.MODES).flatMap(([g, ms]) => ms.map(m => {
      const n = cnt(g, m), need = 2 * M.teamSize(m), me = s.mine && s.mine.game === g && s.mine.mode === m;
      return `<div class="queue-card ${me ? 'me' : ''}" style="--gc:${GAMES[g].color}"><div class="qc-head"><span class="gicon">${GAMES[g].icon}</span><div><b>${esc(g)}</b><span class="mode">${m}</span></div></div>
      <div class="bar"><i style="width:${Math.min(100, n / need * 100)}%"></i></div><p class="muted sm">${n} / ${need} joueurs en attente${req.user ? ` · ton SR : ${rank(M.getSR(req.user.id, g))}` : ''}</p>
      ${req.user ? (me ? `<form method="post" action="/matchmaking/quitter"><button class="btn ghost sm">Quitter la file</button></form><span class="searching">⏳ Recherche en cours…</span>`
        : `<form method="post" action="/matchmaking/rejoindre"><input type="hidden" name="gm" value="${esc(g)}|${m}"><button class="btn sm" ${s.lobby ? 'disabled' : ''}>Rejoindre la file</button></form>`) : ''}</div>`;
    })).join('');
    res.page('Matchmaking', `<section><h1>⚔️ Matchmaking</h1><p class="muted">Rejoins une file : dès que assez de joueurs attendent, ou dès qu'une partie se termine, les équipes sont formées automatiquement et équilibrées par SR. Mise à jour en direct toutes les 3 s.</p>
    ${s.lobby ? `<div class="ok-box">🎮 Tu es dans la partie <a href="/parties/${s.lobby.code}"><b class="code">${s.lobby.code}</b></a> (${s.lobby.status === 'attente' ? 'en attente' : 'en cours'}).</div>` : ''}
    <div class="mm-cols"><div><h2>Files d'attente</h2><div class="queue-grid">${cards}</div></div>
    <aside class="panel"><h3>🔒 Partie privée</h3>${req.user ? `<form method="post" action="/parties" class="stack"><select name="gm">${modeOpts()}</select><button class="btn">Créer une partie privée</button></form>
    <h3>🔑 Rejoindre avec un code</h3><form method="post" action="/parties/rejoindre" class="stack"><input name="code" placeholder="EX : DEMO42" maxlength="6" class="code-input" required><button class="btn ghost">Rejoindre</button></form>`
      : '<p><a href="/connexion?next=/matchmaking">Connecte-toi</a> pour jouer.</p>'}
    <h3>📡 Live</h3><p class="muted">${s.live} partie(s) en cours</p></aside></div></section>${poll('/api/matchmaking', s.v, 'partie')}`);
  });
  const go = (req, res, fn) => { try { const r = fn(); return r; } catch (e) { req.flash('err', e.message); res.redirect(303, '/matchmaking'); return null; } };
  app.post('/matchmaking/rejoindre', auth, (req, res) => {
    const [g, m] = String(req.body.gm || '').split('|');
    const r = go(req, res, () => M.joinQueue(req.user.id, g, m)); if (!r) return;
    const l = M.activeLobby(req.user.id);
    if (l) { req.flash('ok', 'Partie trouvée !'); return res.redirect(303, `/parties/${l.code}`); }
    req.flash('ok', `Tu es dans la file ${g} ${m}.`); res.redirect(303, '/matchmaking');
  });
  app.post('/matchmaking/quitter', auth, (req, res) => { db.prepare('DELETE FROM queue WHERE user_id=?').run(req.user.id); req.flash('ok', 'Tu as quitté la file.'); res.redirect(303, '/matchmaking'); });
  app.post('/parties', auth, (req, res) => {
    const [g, m] = String(req.body.gm || '').split('|');
    const code = go(req, res, () => M.createPrivate(req.user.id, g, m)); if (code) res.redirect(303, `/parties/${code}`);
  });
  app.post('/parties/rejoindre', auth, (req, res) => { const code = go(req, res, () => M.joinByCode(req.user.id, req.body.code)); if (code) res.redirect(303, `/parties/${code}`); });

  // ---------- Page d'une partie ----------
  const lobbyState = code => {
    const l = db.prepare('SELECT * FROM lobbies WHERE code=?').get(String(code).toUpperCase()); if (!l) return null;
    const ps = db.prepare('SELECT p.*, u.pseudo FROM lobby_players p JOIN users u ON u.id=p.user_id WHERE lobby_id=? ORDER BY team, sr_before DESC').all(l.id);
    return { l, ps, v: JSON.stringify([l.status, l.winner_team, ps.length]) };
  };
  app.get('/api/parties/:code', (req, res) => {
    const s = lobbyState(req.params.code); if (!s) return res.status(404).json({});
    const next = req.user && s.l.status === 'termine' ? M.activeLobby(req.user.id) : null;
    res.json({ v: s.v, code: s.l.code, statut: s.l.status, equipe_gagnante: s.l.winner_team, joueurs: s.ps.map(p => ({ pseudo: p.pseudo, equipe: p.team, sr_avant: p.sr_before, sr_apres: p.sr_after })),
      prochaine: next && next.status === 'en_cours' ? `/parties/${next.code}` : null });
  });
  app.get('/parties/:code', (req, res) => {
    const s = lobbyState(req.params.code); if (!s) return res.status(404).page('Introuvable', '<h1>Partie introuvable</h1>');
    const { l, ps } = s; const g = GAMES[l.game];
    const isHost = req.user && (req.user.id === l.host_id || req.user.is_admin);
    const inLobby = req.user && ps.some(p => p.user_id === req.user.id);
    const ST = { attente: ['ouvert', 'En attente de joueurs'], en_cours: ['en_cours', 'En cours'], termine: ['termine', 'Terminée'] }[l.status];
    const pl = p => { const sr = p.sr_before ?? M.getSR(p.user_id, l.game); const d = p.sr_after != null ? p.sr_after - p.sr_before : null;
      return `<li><a href="/joueurs/${encodeURIComponent(p.pseudo)}">${esc(p.pseudo)}</a>${p.user_id === l.host_id ? ' <small class="muted">👑 hôte</small>' : ''} ${rank(p.sr_after ?? sr)}${d != null ? ` <span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</span>` : ''}</li>`; };
    const avg = t => { const x = ps.filter(p => p.team === t); return x.length ? Math.round(x.reduce((a, p) => a + (p.sr_before ?? 0), 0) / x.length) : 0; };
    const team = t => `<div class="team-box ${l.winner_team === t ? 'win' : l.winner_team ? 'lose' : ''}"><h3>Équipe ${t === 1 ? 'Alpha' : 'Bravo'} ${l.winner_team === t ? '🏆' : ''}</h3><p class="muted sm">SR moyen ${avg(t)}</p><ul>${ps.filter(p => p.team === t).map(pl).join('') || '<li class="muted">—</li>'}</ul>
      ${isHost && l.status === 'en_cours' ? `<form method="post" action="/parties/${l.code}/resultat"><input type="hidden" name="winner" value="${t}"><button class="btn sm">Victoire Équipe ${t === 1 ? 'Alpha' : 'Bravo'}</button></form>` : ''}</div>`;
    const waiting = ps.filter(p => !p.team);
    res.page(`Partie ${l.code}`, `<section class="lobby" style="--gc:${g.color}"><div class="dhead"><span class="gicon xl">${g.icon}</span><div><span class="badge ${ST[0]}">${ST[1]}</span> <span class="badge ex">${l.is_private ? 'Privée' : 'Matchmaking'}</span>
    <h1>${esc(l.game)} · ${l.mode}</h1><p>Code de la partie : <b class="code big">${l.code}</b></p></div></div>
    ${l.status === 'attente' ? `<div class="panel"><h3>Salle d'attente (${ps.length} / ${2 * l.team_size})</h3><ul class="entrants">${waiting.map(pl).join('')}</ul>
      <p class="muted">Partage le code <b class="code">${l.code}</b> : la partie démarre automatiquement quand elle est complète (équipes équilibrées par SR).</p>
      ${!inLobby && req.user ? `<form method="post" action="/parties/rejoindre"><input type="hidden" name="code" value="${l.code}"><button class="btn">Rejoindre</button></form>` : ''}
      ${isHost && ps.length >= 2 ? `<form method="post" action="/parties/${l.code}/lancer"><button class="btn ghost sm">Lancer maintenant</button></form>` : ''}</div>`
      : `<div class="versus">${team(1)}<div class="vs">VS</div>${team(2)}</div>`}
    ${l.status === 'termine' && inLobby && !l.is_private ? `<p class="muted">Tu as été remis dans la file ${esc(l.game)} ${l.mode}. <a href="/matchmaking">Voir le matchmaking</a></p>` : ''}
    </section>${poll(`/api/parties/${l.code}`, s.v, 'prochaine')}`);
  });
  app.post('/parties/:code/lancer', auth, (req, res) => {
    const l = db.prepare('SELECT * FROM lobbies WHERE code=?').get(req.params.code);
    if (l && l.status === 'attente' && (l.host_id === req.user.id || req.user.is_admin)) { try { M.startLobby(l.id); } catch (e) { req.flash('err', e.message); } }
    res.redirect(303, `/parties/${req.params.code}`);
  });
  app.post('/parties/:code/resultat', auth, (req, res) => {
    const l = db.prepare('SELECT * FROM lobbies WHERE code=?').get(req.params.code);
    if (!l || !(l.host_id === req.user.id || req.user.is_admin)) { req.flash('err', "Seul l'hôte ou un admin peut déclarer le résultat."); return res.redirect(303, `/parties/${req.params.code}`); }
    try { const next = M.declareResult(l.id, +req.body.winner); req.flash('ok', `Résultat enregistré, SR mis à jour.${next.length ? ` ${next.length} nouvelle(s) partie(s) lancée(s) depuis la file.` : ''}`); }
    catch (e) { req.flash('err', e.message); }
    res.redirect(303, `/parties/${l.code}`);
  });
  return { rank, srTable, linkedList, PROVIDERS };
};
