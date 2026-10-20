// Connexion / liaison Discord via OAuth2 (scope : identify, + guilds.join si DISCORD_GUILD_ID et DISCORD_TOKEN)
const crypto = require('crypto');
const db = require('./db');
// DISCORD_API_BASE / DISCORD_AUTHORIZE_URL : surcharges réservées aux tests (faux serveur Discord)
const API = () => (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/$/, '');
const AUTHORIZE = () => process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize';
const CALLBACK_PATH = '/auth/discord/callback';
const cfg = () => ({ id: process.env.DISCORD_CLIENT_ID, secret: process.env.DISCORD_CLIENT_SECRET, guild: process.env.DISCORD_GUILD_ID, token: process.env.DISCORD_TOKEN });
const configured = () => { const c = cfg(); return !!(c.id && c.secret); };
const base = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = req => base(req) + CALLBACK_PATH;
function authorizeUrl(req, state) {
  const c = cfg(); const scopes = ['identify']; if (c.guild && c.token) scopes.push('guilds.join');
  return AUTHORIZE() + '?' + new URLSearchParams({ client_id: c.id, response_type: 'code', redirect_uri: redirectUri(req), scope: scopes.join(' '), state, prompt: 'consent' });
}
function avatarUrl(me) {
  if (me.avatar) return `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.${me.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  const idx = me.discriminator && me.discriminator !== '0' ? Number(me.discriminator) % 5 : Number((BigInt(me.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}
// Pseudo unique dérivé du nom Discord (format du site : 3-20 car. [A-Za-z0-9_.-])
function uniquePseudo(name) {
  let p = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 20);
  if (p.length < 3) p = ('joueur' + p).slice(0, 20);
  const taken = x => db.prepare('SELECT 1 FROM users WHERE pseudo=? COLLATE NOCASE').get(x);
  if (!taken(p)) return p;
  for (let i = 2; ; i++) { const s = String(i); const c = p.slice(0, 20 - s.length) + s; if (!taken(c)) return c; }
}
function saveDiscord(uid, me) {
  const display = me.global_name || me.username;
  db.prepare('UPDATE users SET discord_id=?, discord_username=?, discord_global_name=?, discord_avatar=? WHERE id=?').run(me.id, me.username, me.global_name || null, avatarUrl(me), uid);
  db.prepare("INSERT OR REPLACE INTO linked_accounts(user_id,provider,account_id,verified) VALUES(?,'discord',?,1)").run(uid, display === me.username ? me.username : `${display} (@${me.username})`);
  db.emit('role_sync', { user_ids: [uid] });
}
module.exports = (app, { auth }) => {
  app.get('/auth/discord', (req, res) => {
    if (!configured()) { req.session.flash = { type: 'err', msg: 'Discord non configuré sur ce serveur (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquant).' }; return res.redirect(303, req.user ? '/profil' : '/connexion'); }
    req.session.discordState = crypto.randomBytes(16).toString('hex');
    req.session.save(() => res.redirect(authorizeUrl(req, req.session.discordState)));
  });
  app.get(CALLBACK_PATH, async (req, res) => {
    const fail = m => { req.session.flash = { type: 'err', msg: 'Discord : ' + m }; res.redirect(303, req.user ? '/profil' : '/connexion'); };
    if (!configured()) return fail('non configuré sur ce serveur.');
    const expected = req.session.discordState; delete req.session.discordState;
    if (!req.query.state || !expected || req.query.state !== expected) return fail('état OAuth invalide (requête expirée ou falsifiée).');
    if (req.query.error || !req.query.code) return fail('autorisation refusée.');
    const c = cfg();
    try {
      const tr = await fetch(API() + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req) }) });
      const tok = await tr.json().catch(() => ({})); if (!tr.ok || !tok.access_token) return fail('échange du code refusé.');
      const mr = await fetch(API() + '/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const me = await mr.json().catch(() => ({}));
      if (!mr.ok || !me.id || !/^\d+$/.test(String(me.id))) return fail('profil Discord illisible.');
      me.id = String(me.id);
      if (c.guild && c.token && String(tok.scope || '').includes('guilds.join')) // ajoute le joueur au serveur (ignoré s'il y est déjà)
        await fetch(`${API()}/guilds/${c.guild}/members/${me.id}`, { method: 'PUT', headers: { Authorization: `Bot ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: tok.access_token }) }).catch(() => {});
      const owner = db.prepare('SELECT id FROM users WHERE discord_id=?').get(me.id);
      const name = me.global_name || me.username;
      if (req.user) { // liaison au compte connecté
        if (owner && owner.id !== req.user.id) return fail('ce compte Discord est déjà lié à un autre joueur.');
        saveDiscord(req.user.id, me);
        req.session.flash = { type: 'ok', msg: `Discord lié : ${name} ✔` }; return res.redirect(303, '/profil');
      }
      let uid = owner?.id, msg = `Connecté avec Discord (${name}).`;
      if (uid) saveDiscord(uid, me); // rafraîchit nom / avatar
      else { // nouveau compte créé depuis Discord
        const pseudo = uniquePseudo(me.username || me.global_name);
        const hash = require('bcrypt').hashSync(crypto.randomBytes(32).toString('hex'), 10); // mot de passe inutilisable
        uid = db.transaction(() => {
          const id = db.prepare("INSERT INTO users(pseudo,email,password_hash,platform,game_id,email_verified,verified_at) VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)").run(pseudo, `discord-${me.id}@discord.local`, hash, 'PC', '') /* connexion Discord = preuve suffisante */.lastInsertRowid;
          saveDiscord(id, me); return id;
        })();
        msg = `Bienvenue ${pseudo} ! Compte créé avec Discord.`;
      }
      req.session.regenerate(() => { req.session.uid = uid; req.session.flash = { type: 'ok', msg }; res.redirect(303, '/profil'); });
    } catch (e) { fail('Discord injoignable.'); }
  });
  app.post('/profil/discord/delier', auth, (req, res) => {
    db.prepare('UPDATE users SET discord_id=NULL, discord_username=NULL, discord_global_name=NULL, discord_avatar=NULL WHERE id=?').run(req.user.id);
    db.prepare("DELETE FROM linked_accounts WHERE user_id=? AND provider='discord'").run(req.user.id);
    req.session.flash = { type: 'ok', msg: 'Discord délié.' }; res.redirect(303, '/profil');
  });
};
module.exports.authorizeUrl = authorizeUrl;
module.exports.CALLBACK_PATH = CALLBACK_PATH;
module.exports.uniquePseudo = uniquePseudo;
