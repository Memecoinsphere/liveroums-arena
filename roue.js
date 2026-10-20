// Roue du jour : 1 tour gratuit / jour (heure de Paris), tours payants (150 LP, 3 max / jour), tirage pondéré côté serveur
const crypto = require('crypto');
const db = require('./db');
const P = require('./points');
const { esc, fmtDate } = require('./views');

db.exec(`
CREATE TABLE IF NOT EXISTS wheel_spins(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('gratuit','payant','bonus')), segment TEXT NOT NULL, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_wheel_spins ON wheel_spins(user_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS ux_wheel_free ON wheel_spins(user_id, day) WHERE kind='gratuit';
CREATE TABLE IF NOT EXISTS prize_claims(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, prize TEXT NOT NULL,
  spin_id INTEGER REFERENCES wheel_spins(id), status TEXT NOT NULL DEFAULT 'en_attente' CHECK(status IN ('en_attente','livre')), twitch TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT);
`);

const PAID_PRICE = 150, PAID_MAX = 3, BOOST_HOURS = 24;
// Poids sur 10 000 (somme = 10 000). Ordre = ordre d'affichage sur la roue.
const SEGMENTS = [
  { id: 'lp10', label: '10 LP', lp: 10, w: 3000, color: '#00f0ff' },
  { id: 'cosm', label: 'Cosmétique', w: 300, color: '#c04bff', big: true },
  { id: 'lp25', label: '25 LP', lp: 25, w: 2400, color: '#39ff14' },
  { id: 'boost', label: 'Boost x2 24 h', w: 600, color: '#ff8a00' },
  { id: 'lp50', label: '50 LP', lp: 50, w: 1800, color: '#3fa9ff' },
  { id: 'jackpot', label: 'JACKPOT 1000 LP', lp: 1000, w: 100, color: '#ffd23f', big: true },
  { id: 'lp100', label: '100 LP', lp: 100, w: 1000, color: '#ff2bd6' },
  { id: 'extra', label: 'Tour bonus', w: 480, color: '#2bff88' },
  { id: 'lp250', label: '250 LP', lp: 250, w: 300, color: '#ff3d6e', big: true },
  { id: 'sub', label: 'Sub Twitch 1 mois', w: 20, color: '#9146ff', big: true },
];
const SEG = Object.fromEntries(SEGMENTS.map(s => [s.id, s]));
const TOTAL = SEGMENTS.reduce((a, s) => a + s.w, 0);
const draw = () => { let r = crypto.randomInt(TOTAL); for (const s of SEGMENTS) { if (r < s.w) return s; r -= s.w; } };
// Résultat forcé : uniquement pour les tests automatisés (NODE_ENV=test ET WHEEL_TEST_FORCE=1), jamais en production
const FORCE_OK = process.env.NODE_ENV === 'test' && process.env.WHEEL_TEST_FORCE === '1';

const today = () => P.parisDay();
const counts = uid => {
  const r = db.prepare("SELECT SUM(kind='gratuit') g, SUM(kind='payant') p FROM wheel_spins WHERE user_id=? AND day=?").get(uid, today());
  return { free: !r.g, paid: r.p || 0, bonus: P.state(uid).bonus_spins };
};
const canSpin = uid => { const c = counts(uid); return c.free || c.bonus > 0; };

function spin(uid, { paid = false, force } = {}) {
  return db.transaction(() => {
    const c = counts(uid); let kind;
    if (paid) {
      if (c.paid >= PAID_MAX) throw new Error(`Maximum ${PAID_MAX} tours payants par jour.`);
      if (P.balance(uid) < PAID_PRICE) throw new Error(`Points insuffisants : un tour payant coûte ${PAID_PRICE} LP.`);
      P.add(uid, -PAID_PRICE, 'Roue du jour : tour payant'); kind = 'payant';
    } else if (c.free) kind = 'gratuit';
    else if (c.bonus > 0) { db.prepare('UPDATE user_points SET bonus_spins=bonus_spins-1 WHERE user_id=?').run(uid); kind = 'bonus'; }
    else throw new Error('Tu as déjà utilisé ton tour gratuit aujourd\'hui. Reviens demain (ou achète un tour à 150 LP) !');
    const s = FORCE_OK && SEG[force] ? SEG[force] : draw();
    let detail = s.label, msg;
    if (s.lp) { P.add(uid, s.lp, `Roue du jour : ${s.label}`); msg = `+${s.lp} LP !`; }
    else if (s.id === 'cosm') {
      const owned = new Set(db.prepare('SELECT item_id FROM inventory WHERE user_id=?').all(uid).map(r => r.item_id));
      const pool = P.ITEMS.filter(i => !owned.has(i.id) && ['commun', 'rare'].includes(i.rarity));
      if (pool.length) { const it = pool[crypto.randomInt(pool.length)]; db.prepare('INSERT INTO inventory(user_id,item_id) VALUES(?,?)').run(uid, it.id); detail = `Cosmétique : ${it.name}`; msg = `Cosmétique gagné : ${it.name} (dans ton inventaire) !`; }
      else { P.add(uid, 250, 'Roue du jour : cosmétique (déjà tout possédé) → 250 LP'); detail = 'Cosmétique → 250 LP'; msg = 'Tu possèdes déjà tout : +250 LP à la place !'; }
    } else if (s.id === 'boost') {
      const st = P.state(uid), base = st.boost_until && st.boost_until > new Date().toISOString() ? new Date(st.boost_until) : new Date();
      db.prepare('UPDATE user_points SET boost_until=? WHERE user_id=?').run(new Date(+base + BOOST_HOURS * 36e5).toISOString(), uid);
      msg = `Boost x2 activé : tes victoires rapportent ${2 * P.PTS.WIN} LP pendant ${BOOST_HOURS} h !`;
    } else if (s.id === 'extra') { db.prepare('UPDATE user_points SET bonus_spins=bonus_spins+1 WHERE user_id=?').run(uid); msg = 'Tour bonus ! Relance la roue.'; }
    const id = db.prepare('INSERT INTO wheel_spins(user_id,day,kind,segment,detail) VALUES(?,?,?,?,?)').run(uid, today(), kind, s.id, detail).lastInsertRowid;
    if (s.id === 'sub') { db.prepare('INSERT INTO prize_claims(user_id,prize,spin_id) VALUES(?,?,?)').run(uid, s.label, id); msg = "🎉 Sub Twitch 1 mois ! Lot à réclamer — l'admin te contacte."; }
    if (s.id === 'jackpot') msg = '💰 JACKPOT ! +1000 LP !';
    return { index: SEGMENTS.indexOf(s), segment: s.id, label: s.label, message: msg, spin_id: id };
  })();
}

module.exports = (app, { auth, admin }) => {
  const N = SEGMENTS.length, deg = 360 / N;
  const wheel = () => `<div class="wheel-box"><div class="wheel-pointer">▼</div><div class="wheel" id="wheel" style="background:conic-gradient(${SEGMENTS.map((s, i) => `${s.color} ${i * deg}deg ${(i + 1) * deg}deg`).join(',')})">
    ${SEGMENTS.map((s, i) => `<span class="wl${s.big ? ' big' : ''}" style="transform:rotate(${i * deg + deg / 2}deg)"><b>${esc(s.label)}</b></span>`).join('')}<div class="wheel-hub">⚡</div></div></div>`;
  app.get('/roue', (req, res) => {
    const u = req.user, c = u ? counts(u.id) : null;
    const feed = db.prepare(`SELECT w.detail, w.created_at, u.id uid, u.pseudo FROM wheel_spins w JOIN users u ON u.id=w.user_id WHERE w.segment IN ('jackpot','sub','lp250','cosm') ORDER BY w.id DESC LIMIT 12`).all();
    const claims = u ? db.prepare('SELECT * FROM prize_claims WHERE user_id=? ORDER BY id DESC').all(u.id) : [];
    const boost = u && P.boostActive(u.id) ? P.state(u.id).boost_until : null;
    const btn = !u ? '<a class="btn lg" href="/connexion?next=/roue">Connecte-toi pour tourner</a>'
      : `${c.free || c.bonus ? `<form method="post" action="/roue/tourner" class="spin-form"><button class="btn lg spin-btn">🎡 ${c.free ? 'Tour gratuit' : `Tour bonus (${c.bonus})`}</button></form>` : '<p class="muted">✔ Tour gratuit utilisé. Reviens demain !</p>'}
        <form method="post" action="/roue/payer" class="spin-form"><button class="btn ghost spin-btn" ${c.paid >= PAID_MAX ? 'disabled' : ''}>Tour payant · ${PAID_PRICE} LP (${PAID_MAX - c.paid}/${PAID_MAX} restants)</button></form>`;
    res.page('Roue du jour', `<section class="roue"><h1>🎡 Roue du jour</h1><p class="muted">1 tour gratuit par jour (heure de Paris). Tirage effectué côté serveur.</p>
      ${boost ? `<div class="flash ok">⚡ Boost x2 actif jusqu'au ${fmtDate(boost)}</div>` : ''}
      ${claims.map(cl => `<div class="panel claim ${cl.status}"><b>🎁 ${esc(cl.prize)}</b> — ${cl.status === 'livre' ? '✔ Lot livré' : "Lot à réclamer — l'admin te contacte"}
        ${cl.status === 'en_attente' ? `<form method="post" action="/roue/lots/${cl.id}" class="inline"><input name="twitch" maxlength="25" placeholder="Ton pseudo Twitch" value="${esc(cl.twitch || '')}" required><button class="btn sm">Enregistrer</button></form>` : ''}</div>`).join('')}
      <div class="roue-grid"><div>${wheel()}<div class="spin-actions">${btn}</div><p class="spin-result" id="spinResult"></p></div>
      <div><div class="panel"><h3>🏆 Derniers gros gains</h3><ul class="feed">${feed.map(f => `<li>${P.nameHtml(f.uid, f.pseudo, { title: false })} — <b>${esc(f.detail)}</b> <small class="muted">${fmtDate(f.created_at.replace(' ', 'T') + 'Z')}</small></li>`).join('') || '<li class="muted">Aucun gros gain pour l\'instant. Sois le premier !</li>'}</ul></div>
      <div class="panel"><h3>🎲 Probabilités</h3><table class="odds">${SEGMENTS.map(s => `<tr><td><i class="dot" style="background:${s.color}"></i> ${esc(s.label)}</td><td>${(s.w / TOTAL * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %</td></tr>`).join('')}</table></div></div></div></section>
<script>(()=>{const W=document.getElementById('wheel'),out=document.getElementById('spinResult');let rot=0,busy=false;
document.querySelectorAll('.spin-form').forEach(f=>f.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;out.textContent='';
const r=await fetch(f.action,{method:'POST',headers:{Accept:'application/json'}});const j=await r.json().catch(()=>({erreur:'Erreur.'}));
if(!r.ok){out.textContent=j.erreur;busy=false;return;}
const target=360-(j.index*${deg}+${deg / 2});rot+=360*6+((target-rot)%360+360)%360;W.style.transform='rotate('+rot+'deg)';
setTimeout(()=>{out.textContent=j.message;out.classList.add('show');setTimeout(()=>location.reload(),2600);},5200);}));})();</script>`);
  });
  const doSpin = paid => (req, res) => {
    const json = (req.get('Accept') || '').includes('application/json');
    try {
      const r = spin(req.user.id, { paid, force: req.body.force });
      if (json) return res.json(r);
      req.flash('ok', `${r.label} — ${r.message}`);
    } catch (e) { if (json) return res.status(400).json({ erreur: e.message }); req.flash('err', e.message); }
    res.redirect(303, '/roue');
  };
  app.post('/roue/tourner', auth, doSpin(false));
  app.post('/roue/payer', auth, doSpin(true));
  app.post('/roue/lots/:id', auth, (req, res) => {
    const t = String(req.body.twitch || '').trim();
    if (!/^[A-Za-z0-9_]{3,25}$/.test(t)) req.flash('err', 'Pseudo Twitch invalide (3 à 25 caractères : lettres, chiffres, _).');
    else if (db.prepare("UPDATE prize_claims SET twitch=? WHERE id=? AND user_id=? AND status='en_attente'").run(t, +req.params.id, req.user.id).changes) req.flash('ok', `Pseudo Twitch enregistré : ${t}. L'admin te contacte !`);
    else req.flash('err', 'Lot introuvable.');
    res.redirect(303, '/roue');
  });
  app.get('/admin/lots', auth, admin, (req, res) => {
    const rows = db.prepare('SELECT c.*, u.pseudo, u.email, u.discord_username FROM prize_claims c JOIN users u ON u.id=c.user_id ORDER BY c.status, c.id DESC').all();
    res.page('Lots à livrer', `<section><h1>🎁 Lots à livrer</h1><div class="table-wrap"><table><tr><th>Date</th><th>Joueur</th><th>Lot</th><th>Pseudo Twitch</th><th>Contact</th><th>Statut</th><th></th></tr>
    ${rows.map(r => `<tr><td>${fmtDate(r.created_at.replace(' ', 'T') + 'Z')}</td><td>${esc(r.pseudo)}</td><td>${esc(r.prize)}</td><td>${esc(r.twitch || '—')}</td><td>${esc(r.email)}${r.discord_username ? ` · Discord @${esc(r.discord_username)}` : ''}</td>
      <td><span class="badge ${r.status === 'livre' ? 'termine' : 'en_cours'}">${r.status === 'livre' ? 'Livré' : 'En attente'}</span></td>
      <td>${r.status === 'en_attente' ? `<form method="post" action="/admin/lots/${r.id}/livrer"><button class="btn sm">Marquer livré</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aucun lot.</td></tr>'}</table></div></section>`);
  });
  app.post('/admin/lots/:id/livrer', auth, admin, (req, res) => {
    db.prepare("UPDATE prize_claims SET status='livre', delivered_at=CURRENT_TIMESTAMP WHERE id=? AND status='en_attente'").run(+req.params.id);
    req.flash('ok', 'Lot marqué comme livré.'); res.redirect(303, '/admin/lots');
  });
  return { canSpin, SEGMENTS, TOTAL };
};
