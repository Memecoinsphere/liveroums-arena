// Vérification obligatoire de l'email (inscription email / mot de passe)
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const mailer = require('./mailer');
const { esc } = require('./views');

const TTL = 24 * 36e5, RESEND_COOLDOWN = 60e3;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
db.exec(`CREATE TABLE IF NOT EXISTS email_tokens(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_email_tokens_user ON email_tokens(user_id);`);

const base = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
// Crée un jeton à usage unique (seul son hachage SHA-256 est stocké), invalide les précédents et envoie le mail
async function sendVerification(req, user) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  db.prepare('DELETE FROM email_tokens WHERE user_id=?').run(user.id);
  db.prepare('INSERT INTO email_tokens(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)').run(user.id, sha(token), now + TTL, now);
  const link = `${base(req)}/verifier-email?token=${token}`, m = mailer.verificationEmail(user.pseudo, link);
  try { await mailer.send({ to: user.email, ...m, logHint: `Lien de vérification pour ${user.pseudo} : ${link}` }); }
  catch (e) { console.error(`Envoi du mail de vérification impossible (${e.message}). Lien pour ${user.pseudo} : ${link}`); }
}
function markVerified(uid) {
  db.prepare("UPDATE users SET email_verified=1, verified_at=COALESCE(verified_at,CURRENT_TIMESTAMP) WHERE id=?").run(uid);
  db.prepare('DELETE FROM email_tokens WHERE user_id=?').run(uid);
}
const resendForm = (email = '') => `<form method="post" action="/renvoyer-verification" class="form resend-form"><p class="muted">Pas reçu le mail (pense aux spams) ?</p>
  <label>Ton email<input type="email" name="email" required maxlength="254" value="${esc(email)}" autocomplete="email"></label><button class="btn ghost">📧 Renvoyer le mail</button></form>`;

module.exports = (app, { auth, admin, layout }) => {
  const resendLimit = rateLimit({ windowMs: 15 * 6e4, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => ipKeyGenerator(req.ip),
    handler: (req, res) => res.status(429).send(layout('Trop de demandes', null, { type: 'err', msg: 'Trop de demandes de renvoi. Réessaie dans 15 minutes.' }, `<section class="form-wrap"><h1>Trop de demandes</h1><p><a href="/connexion">Retour à la connexion</a></p></section>`)) });

  app.get('/verifier-email', (req, res, next) => {
    const token = String(req.query.token || '');
    const row = /^[A-Za-z0-9_-]{43}$/.test(token) ? db.prepare('SELECT t.*, u.pseudo FROM email_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?').get(sha(token)) : null;
    if (!row || row.used_at || row.expires_at < Date.now()) {
      if (row && row.expires_at < Date.now()) db.prepare('DELETE FROM email_tokens WHERE id=?').run(row.id);
      res.status(400); return res.page('Lien invalide', `<section class="form-wrap"><h1>Lien invalide ou expiré</h1><p class="muted">Ce lien de vérification n'est plus valable (déjà utilisé, expiré après 24 h ou incorrect). Demande un nouveau mail :</p>${resendForm()}</section>`);
    }
    // usage unique : le jeton est consommé atomiquement avant toute autre action
    if (db.prepare('UPDATE email_tokens SET used_at=? WHERE id=? AND used_at IS NULL').run(Date.now(), row.id).changes !== 1) return res.redirect(303, '/connexion');
    markVerified(row.user_id);
    req.session.regenerate(e => { if (e) return next(e); req.session.uid = row.user_id; req.session.flash = { type: 'ok', msg: `✅ Email vérifié, bienvenue ${row.pseudo} !` }; res.redirect(303, '/profil'); });
  });

  // Réponse identique que le compte existe ou non (pas d'énumération) ; 1 mail par minute et par compte maximum
  app.post('/renvoyer-verification', resendLimit, async (req, res, next) => { try {
    const email = String(req.body.email || '').slice(0, 254).trim().toLowerCase();
    const u = email ? db.prepare('SELECT id,pseudo,email,email_verified FROM users WHERE email=?').get(email) : null;
    if (u && !u.email_verified) {
      const last = db.prepare('SELECT MAX(created_at) t FROM email_tokens WHERE user_id=?').get(u.id).t;
      if (!last || Date.now() - last > RESEND_COOLDOWN) await sendVerification(req, u);
    }
    req.flash('ok', 'Si un compte non vérifié correspond à cet email, un nouveau lien vient d\'être envoyé (valable 24 h).');
    res.redirect(303, '/connexion');
  } catch (e) { next(e); } });

  // Admin : validation manuelle (utile si aucun fournisseur d'email n'est configuré)
  app.get('/admin/verifications', auth, admin, (req, res) => {
    const rows = db.prepare('SELECT id,pseudo,email,created_at FROM users WHERE email_verified=0 ORDER BY id DESC LIMIT 200').all();
    res.page('Comptes à vérifier', `<section><h1>📧 Comptes non vérifiés (${rows.length})</h1><p class="muted">Fournisseur d'email : <b>${esc({ resend: 'Resend', smtp: 'SMTP', log: 'aucun (liens dans les journaux du serveur)', outbox: 'boîte de test' }[mailer.provider()])}</b>. Ne valide un compte que si tu es sûr de son propriétaire.</p>
    <div class="table-wrap"><table><tr><th>Pseudo</th><th>Email</th><th>Inscrit le</th><th></th></tr>${rows.map(u => `<tr><td>${esc(u.pseudo)}</td><td>${esc(u.email)}</td><td>${esc(u.created_at)}</td><td><form method="post" action="/admin/utilisateurs/${u.id}/verifier"><button class="btn sm">✔ Valider</button></form></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun.</td></tr>'}</table></div></section>`);
  });
  app.post('/admin/utilisateurs/:id/verifier', auth, admin, (req, res) => {
    const u = db.prepare('SELECT id,pseudo FROM users WHERE id=?').get(+req.params.id);
    if (u) { markVerified(u.id); req.flash('ok', `Compte ${u.pseudo} validé.`); } else req.flash('err', 'Compte introuvable.');
    res.redirect(303, '/admin/verifications');
  });
};
module.exports.sendVerification = sendVerification;
module.exports.resendForm = resendForm;
