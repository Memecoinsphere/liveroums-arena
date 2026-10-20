// Routes : boutique, inventaire, historique de points, défis, octroi admin
const db = require('./db');
const P = require('./points');
const { esc, fmtDate } = require('./views');

module.exports = (app, { auth, admin }) => {
  const back = (req, res, def) => res.redirect(303, String(req.body.retour || '').startsWith('/') && !String(req.body.retour).startsWith('//') ? req.body.retour : def);
  const preview = it => it.slot === 'banner' ? `<div class="pv-banner" style="background:${it.value}"></div>`
    : it.slot === 'frame' ? `<div class="avatar-wrap framed" style="--fr:${it.value}"><div class="avatar">A</div></div>`
    : it.slot === 'color' ? `<b class="pv-name" style="color:${it.value};text-shadow:0 0 10px ${it.value}">Pseudo</b>`
    : it.slot === 'title' ? `<span class="lp-title r-${it.rarity}">${esc(it.value)}</span>` : `<span class="pv-emote">${it.value}</span>`;

  app.get('/boutique', (req, res) => {
    const u = req.user, bal = u ? P.balance(u.id) : 0;
    const owned = new Set(u ? db.prepare('SELECT item_id FROM inventory WHERE user_id=?').all(u.id).map(r => r.item_id) : []);
    const eq = u ? P.deco(u.id) : {};
    const filt = P.SLOTS[req.query.type] ? req.query.type : null;
    const item = it => {
      const [rn, rc] = P.RARITY[it.rarity]; const has = owned.has(it.id), on = eq[it.slot]?.id === it.id;
      const act = !u ? `<a class="btn sm" href="/connexion?next=/boutique">Se connecter</a>`
        : on ? `<form method="post" action="/boutique/desequiper"><input type="hidden" name="slot" value="${it.slot}"><button class="btn ghost sm">Déséquiper</button></form>`
        : has ? `<form method="post" action="/boutique/equiper"><input type="hidden" name="item" value="${it.id}"><button class="btn sm">Équiper</button></form>`
        : `<form method="post" action="/boutique/acheter"><input type="hidden" name="item" value="${it.id}"><button class="btn sm${bal < it.price ? ' ghost' : ''}">Acheter · ${it.price} LP</button></form>`;
      return `<div class="shop-item r-${it.rarity}${on ? ' equipped' : ''}" style="--rc:${rc}"><div class="pv">${preview(it)}</div><span class="rar">${rn}</span><h4>${esc(it.name)}</h4>
        <p class="price">💎 ${it.price} LP</p>${has ? `<small class="owned">${on ? '✔ Équipé' : '✔ Possédé'}</small>` : ''}${act}</div>`;
    };
    res.page('Boutique', `<section><div class="shop-head"><div><h1>🛒 Boutique LiveRoums</h1><p class="muted">Dépense tes <b>Points LiveRoums (LP)</b> en cosmétiques : bannières, cadres, couleurs de pseudo, titres et emotes de chat.</p></div>
      ${u ? `<div class="lp-wallet">💎 <b>${bal}</b> LP<a href="/points" class="sm">Historique →</a></div>` : ''}</div>
      <div class="lp-earn panel"><b>Comment gagner des LP ?</b> Victoire <b>+${P.PTS.WIN}</b> · 1re victoire du jour <b>x2</b> · Défaite <b>+${P.PTS.LOSS}</b> · Série de ${P.PTS.STREAK_EVERY} victoires <b>+${P.PTS.STREAK}</b> · Connexion quotidienne <b>+${P.PTS.DAILY}</b> (+${P.PTS.DAILY_STREAK_STEP}/jour de série) · <a href="/points#defis">Défis</a></div>
      <div class="tabs"><a class="${!filt ? 'active' : ''}" href="/boutique">Tout</a>${Object.entries(P.SLOTS).map(([k, n]) => `<a class="${filt === k ? 'active' : ''}" href="/boutique?type=${k}">${n}</a>`).join('')}</div>
      ${Object.entries(P.SLOTS).filter(([k]) => !filt || k === filt).map(([k, n]) => `<h2>${n}</h2><div class="shop-grid">${P.ITEMS.filter(i => i.slot === k).map(item).join('')}</div>`).join('')}
      <p class="muted sm">Raretés : ${Object.values(P.RARITY).map(([n, c]) => `<span style="color:${c}">◆ ${n}</span>`).join(' · ')}</p></section>`);
  });
  const act = fn => (req, res) => { try { req.flash('ok', fn(req)); } catch (e) { req.flash('err', e.message); } back(req, res, '/boutique'); };
  app.post('/boutique/acheter', auth, act(req => { const it = P.buy(req.user.id, req.body.item); return `Achat réussi : ${it.name} ! Pense à l'équiper.`; }));
  app.post('/boutique/equiper', auth, act(req => `${P.equip(req.user.id, req.body.item).name} équipé.`));
  app.post('/boutique/desequiper', auth, act(req => { if (!P.SLOTS[req.body.slot]) throw new Error('Emplacement invalide.'); P.unequip(req.user.id, req.body.slot); return 'Cosmétique déséquipé.'; }));

  app.get('/points', auth, (req, res) => {
    const uid = req.user.id, s = P.state(uid);
    const rows = db.prepare('SELECT * FROM points_ledger WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid);
    const ch = c => { const p = P.progress(uid, c), done = !!db.prepare('SELECT 1 FROM challenge_claims WHERE user_id=? AND challenge=? AND period=?').get(uid, c.id, P.periodKey(c));
      return `<div class="challenge${done ? ' done' : ''}"><div><b>${esc(c.label)}</b> <small class="muted">${c.period === 'jour' ? 'Quotidien' : 'Hebdomadaire'}</small><div class="bar"><i style="width:${Math.round(p / c.goal * 100)}%"></i></div><small>${p} / ${c.goal}</small></div><span class="reward">${done ? '✔' : ''} +${c.reward} LP</span></div>`; };
    res.page('Mes points', `<section><h1>💎 Points LiveRoums</h1><div class="lp-stats"><div class="lp-wallet">💎 <b>${s.balance}</b> LP</div>${P.levelHtml(uid)}
      <div class="panel sm-panel">🔥 Série de victoires : <b>${s.win_streak}</b><br>📅 Série de connexion : <b>${s.login_streak}</b> jour(s)</div></div>
      <h2 id="defis">🎯 Défis</h2><div class="challenges">${P.CHALLENGES.map(ch).join('')}</div>
      <h2>📜 Historique</h2><div class="table-wrap"><table><tr><th>Date</th><th>Motif</th><th>Points</th></tr>
      ${rows.map(r => `<tr><td>${fmtDate(r.created_at.replace(' ', 'T') + 'Z')}</td><td>${esc(r.reason)}</td><td class="${r.amount >= 0 ? 'up' : 'down'}"><b>${r.amount >= 0 ? '+' : ''}${r.amount}</b></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Aucun mouvement.</td></tr>'}</table></div></section>`);
  });
  app.get('/api/points', auth, (req, res) => { const s = P.state(req.user.id); res.json({ solde: s.balance, xp: s.xp, niveau: P.level(s.xp).lv, serie_victoires: s.win_streak, serie_connexion: s.login_streak,
    inventaire: db.prepare('SELECT item_id FROM inventory WHERE user_id=?').all(req.user.id).map(r => r.item_id), equipe: Object.fromEntries(Object.entries(P.deco(req.user.id)).map(([k, v]) => [k, v.id])),
    historique: db.prepare('SELECT amount montant, reason motif, created_at date FROM points_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id) }); });

  app.get('/admin/points', auth, admin, (req, res) => res.page('Octroyer des points', `<section class="form-wrap"><h1>💎 Octroyer des LP</h1><form method="post" class="form">
    <label>Pseudo du joueur<input name="pseudo" required maxlength="20"></label><label>Montant (négatif pour retirer)<input type="number" name="amount" required min="-100000" max="100000"></label>
    <label>Motif<input name="reason" maxlength="80" placeholder="Récompense événement"></label><button class="btn lg">Valider</button></form></section>`));
  app.post('/admin/points', auth, admin, (req, res) => {
    const u = db.prepare('SELECT id,pseudo FROM users WHERE pseudo=?').get(String(req.body.pseudo || '').trim()), n = parseInt(req.body.amount, 10);
    if (!u || !Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) { req.flash('err', 'Joueur ou montant invalide.'); return res.redirect(303, '/admin/points'); }
    P.add(u.id, n, `Admin : ${String(req.body.reason || 'octroi manuel').slice(0, 80)}`, { xp: false });
    req.flash('ok', `${n > 0 ? '+' : ''}${n} LP pour ${u.pseudo} (solde : ${P.balance(u.id)} LP).`); res.redirect(303, '/admin/points');
  });
};
