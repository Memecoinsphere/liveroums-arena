// Envoi d'emails, indépendant du fournisseur : Resend (RESEND_API_KEY) ou SMTP (SMTP_URL) via nodemailer.
// NODE_ENV=test (ou MAIL_OUTBOX hors production) : les mails sont écrits dans une boîte d'envoi locale (MAIL_OUTBOX, une ligne JSON par mail), rien n'est envoyé.
// Aucun fournisseur configuré : avertissement + lien dans les journaux du serveur uniquement (jamais dans les réponses HTTP).
const fs = require('fs');
let smtp = null;
const outboxFile = () => process.env.MAIL_OUTBOX || (process.env.DB_FILE || require('path').join(__dirname, 'data', 'arena.db')) + '.outbox.jsonl';
const from = () => process.env.MAIL_FROM || 'LiveRoums Arena <no-reply@liveroums.gg>';
const provider = () => (process.env.NODE_ENV === 'test' || (process.env.MAIL_OUTBOX && process.env.NODE_ENV !== 'production')) && !process.env.MAIL_REAL_IN_TEST ? 'outbox' : process.env.RESEND_API_KEY ? 'resend' : process.env.SMTP_URL ? 'smtp' : 'log';

async function send({ to, subject, html, text, logHint }) {
  const p = provider();
  if (p === 'outbox') { fs.appendFileSync(outboxFile(), JSON.stringify({ to, subject, html, text, at: new Date().toISOString() }) + '\n'); return { provider: p }; }
  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: from(), to: [to], subject, html, text }) });
    if (!r.ok) throw new Error(`Resend HTTP ${r.status}`);
    return { provider: p };
  }
  if (p === 'smtp') {
    smtp ||= require('nodemailer').createTransport(process.env.SMTP_URL);
    await smtp.sendMail({ from: from(), to, subject, html, text }); return { provider: p };
  }
  console.warn(`⚠ Aucun fournisseur d'email (RESEND_API_KEY ou SMTP_URL) : mail non envoyé à ${to.replace(/^(.).*@/, '$1***@')}. ${logHint || ''}`);
  return { provider: p };
}
if (process.env.NODE_ENV === 'production' && provider() === 'log') console.warn('⚠ Emails désactivés : définis RESEND_API_KEY ou SMTP_URL (+ MAIL_FROM). Les liens de vérification seront écrits dans ces journaux ; un admin peut aussi valider un compte depuis /admin/verifications.');

const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function verificationEmail(pseudo, link) {
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#07070f;font-family:Segoe UI,Arial,sans-serif;color:#e8e8ff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07070f;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0f0f22;border:1px solid #00f0ff55;border-radius:16px;box-shadow:0 0 24px #00f0ff33">
<tr><td style="padding:28px 32px 8px;font-size:24px;font-weight:800;letter-spacing:.5px"><span style="color:#00f0ff;text-shadow:0 0 12px #00f0ff">⚡ LiveRoums</span> <span style="color:#ff2bd6;text-shadow:0 0 12px #ff2bd6">Arena</span></td></tr>
<tr><td style="padding:8px 32px 0;font-size:16px;line-height:1.6">Salut <b>${escH(pseudo)}</b> 👋<br>Plus qu'une étape pour activer ton compte : confirme ton adresse email.</td></tr>
<tr><td align="center" style="padding:28px 32px"><a href="${escH(link)}" style="display:inline-block;padding:14px 30px;border-radius:12px;background:linear-gradient(90deg,#00f0ff,#ff2bd6);color:#07070f;font-weight:800;text-decoration:none;font-size:16px;box-shadow:0 0 18px #ff2bd666">Vérifier mon email</a></td></tr>
<tr><td style="padding:0 32px 8px;font-size:13px;color:#9a9ac0;line-height:1.6">Le lien est valable <b>24 heures</b> et ne fonctionne qu'une fois. S'il ne s'ouvre pas, copie cette adresse dans ton navigateur :<br><span style="color:#00f0ff;word-break:break-all">${escH(link)}</span></td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#6c6c90">Tu n'as pas créé de compte ? Ignore simplement ce message.</td></tr></table></td></tr></table></body></html>`;
  const text = `Salut ${pseudo},\n\nConfirme ton adresse email pour activer ton compte LiveRoums Arena :\n${link}\n\nLe lien est valable 24 heures et ne fonctionne qu'une fois.\nTu n'as pas créé de compte ? Ignore ce message.\n`;
  return { subject: 'Confirme ton email — LiveRoums Arena', html, text };
}
module.exports = { send, verificationEmail, provider, outboxFile };
