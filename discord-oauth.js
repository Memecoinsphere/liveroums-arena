// Connexion / liaison Discord via OAuth2 (scopes : identify, + guilds.join si DISCORD_GUILD_ID et DISCORD_TOKEN)
const crypto = require('crypto');
const db = require('./db');
const API = 'https://discord.com/api/v10';
const cfg = () => ({ id: process.env.DISCORD_CLIENT_ID, secret: process.env.DISCORD_CLIENT_SECRET, guild: process.env.DISCORD_GUILD_ID, token: process.env.DISCORD_TOKEN });
const base = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = req => base(req) + '/auth/discord/retour';
function authorizeUrl(req, state) {
  const c = cfg(); const scopes = ['identify']; if (c.guild && c.token) scopes.push('guilds.join');
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: c.id, response_type: 'code', redirect_uri: redirectUri(req), scope: scopes.join(' '), state, prompt: 'consent' });
}
module.exports = (app, { auth }) => {
  app.get('/auth/discord', (req, res) => {
    if (!cfg().id) { req.session.flash = { type: 'err', msg: 'Discord non configuré sur ce serveur (DISCORD_CLIENT_ID manquant).' }; return res.redirect(303, req.user ? '/profil' : '/connexion'); }
    req.session.discordState = crypto.randomBytes(16).toString('hex');
    res.redirect(authorizeUrl(req, req.session.discordState));
  });
  app.get('/auth/discord/retour', async (req, res) => {
    const fail = m => { req.session.flash = { type: 'err', msg: 'Discord : ' + m }; res.redirect(303, req.user ? '/profil' : '/connexion'); };
    const expected = req.session.discordState; delete req.session.discordState;
    if (!req.query.state || req.query.state !== expected) return fail('état OAuth invalide (requête expirée ou falsifiée).');
    if (req.query.error || !req.query.code) return fail('autorisation refusée.');
    const c = cfg();
    try {
      const tr = await fetch(API + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri(req) }) });
      const tok = await tr.json(); if (!tok.access_token) return fail("échange du code refusé.");
      const me = await (await fetch(API + '/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      if (!me.id) return fail('profil Discord illisible.');
      if (c.guild && c.token && String(tok.scope || '').includes('guilds.join')) // ajoute le joueur au serveur (ignoré s'il y est déjà)
        await fetch(`${API}/guilds/${c.guild}/members/${me.id}`, { method: 'PUT', headers: { Authorization: `Bot ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: tok.access_token }) }).catch(() => {});
      const owner = db.prepare('SELECT id FROM users WHERE discord_id=?').get(me.id);
      if (req.user) {
        if (owner && owner.id !== req.user.id) return fail('ce compte Discord est déjà lié à un autre joueur.');
        db.prepare('UPDATE users SET discord_id=?, discord_username=? WHERE id=?').run(me.id, me.username, req.user.id);
        db.prepare("INSERT OR REPLACE INTO linked_accounts(user_id,provider,account_id,verified) VALUES(?,'discord',?,1)").run(req.user.id, me.username);
        db.emit('role_sync', { user_ids: [req.user.id] });
        req.session.flash = { type: 'ok', msg: `Discord lié : ${me.username} ✔` }; return res.redirect(303, '/profil');
      }
      if (!owner) return fail("aucun compte LiveRoums n'est lié à ce Discord. Crée un compte puis lie Discord depuis ton profil.");
      req.session.regenerate(() => { req.session.uid = owner.id; req.session.flash = { type: 'ok', msg: 'Connecté avec Discord.' }; res.redirect(303, '/profil'); });
    } catch (e) { fail('Discord injoignable.'); }
  });
  app.post('/profil/discord/delier', auth, (req, res) => {
    db.prepare('UPDATE users SET discord_id=NULL, discord_username=NULL WHERE id=?').run(req.user.id);
    db.prepare("DELETE FROM linked_accounts WHERE user_id=? AND provider='discord'").run(req.user.id);
    req.session.flash = { type: 'ok', msg: 'Discord délié.' }; res.redirect(303, '/profil');
  });
};
module.exports.authorizeUrl = authorizeUrl;
