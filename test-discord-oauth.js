// Tests OAuth2 Discord avec un faux serveur Discord (token + /users/@me) : node --test test-discord-oauth.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const APP_PORT = 3100 + Math.floor(Math.random() * 500), FAKE_PORT = APP_PORT + 1000;
const APP = `http://localhost:${APP_PORT}`, FAKE = `http://localhost:${FAKE_PORT}`;
const users = { // code OAuth -> profil Discord renvoyé
  codeLink: { id: '111111111111111111', username: 'linkuser', global_name: 'Link User', avatar: 'abc123' },
  codeNew: { id: '222222222222222222', username: 'nouveau.joueur', global_name: 'Nouveau', avatar: null, discriminator: '0' },
  codeClash: { id: '333333333333333333', username: 'Admin', global_name: null, avatar: 'a_anim' },
};
const tokens = {}; let lastTokenReq;
let fake, app, tmp;

const fakeServer = () => http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/api/oauth2/token') {
      const p = Object.fromEntries(new URLSearchParams(body)); lastTokenReq = p;
      if (p.client_id !== 'cid' || p.client_secret !== 'csecret' || p.grant_type !== 'authorization_code' || !users[p.code]) return json(400, { error: 'invalid_grant' });
      const t = 'tok_' + p.code; tokens[t] = users[p.code]; return json(200, { access_token: t, token_type: 'Bearer', scope: 'identify' });
    }
    if (req.method === 'GET' && req.url === '/api/users/@me') {
      const u = tokens[(req.headers.authorization || '').replace('Bearer ', '')]; return u ? json(200, u) : json(401, { message: '401: Unauthorized' });
    }
    json(404, {});
  });
});

function startApp(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: APP_PORT, DB_FILE: path.join(tmp, 'arena.db'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { if (String(d).includes('LiveRoums Arena sur')) resolve(p); });
    p.stderr.on('data', d => process.stderr.write(d)); p.on('exit', c => reject(new Error('server exit ' + c)));
  });
}
const stop = p => new Promise(r => { if (!p || p.exitCode !== null) return r(); p.removeAllListeners('exit'); p.on('exit', r); p.kill(); });

// mini client HTTP avec cookies
function client() {
  const jar = {};
  const go = async (url, opt = {}) => {
    const r = await fetch(url.startsWith('http') ? url : APP + url, { ...opt, redirect: 'manual', headers: { ...(opt.headers || {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const form = (url, data) => go(url, { method: 'POST', body: new URLSearchParams(data), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const page = async url => (await go(url)).text();
  // Parcours complet : bouton -> URL authorize (state) -> retour callback avec le code
  const discord = async code => {
    const r = await go('/auth/discord'); assert.ok([301, 302, 303].includes(r.status));
    const u = new URL(r.headers.get('location')); return { authorize: u, cb: await go(`/auth/discord/callback?code=${code}&state=${u.searchParams.get('state')}`) };
  };
  return { go, form, page, discord };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-discord-'));
  fake = fakeServer(); await new Promise(r => fake.listen(FAKE_PORT, r));
  app = await startApp({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', PUBLIC_URL: 'https://arena.example.com/', DISCORD_API_BASE: FAKE + '/api', DISCORD_GUILD_ID: '', DISCORD_TOKEN: '' });
});
after(async () => { await stop(app); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('le bouton redirige vers Discord authorize avec state et redirect_uri', async () => {
  const c = client(); const r = await c.go('/auth/discord');
  const u = new URL(r.headers.get('location'));
  assert.strictEqual(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
  assert.strictEqual(u.searchParams.get('client_id'), 'cid');
  assert.strictEqual(u.searchParams.get('scope'), 'identify');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://arena.example.com/auth/discord/callback');
  assert.match(u.searchParams.get('state'), /^[0-9a-f]{32}$/);
  assert.match(await c.page('/connexion'), /Se connecter avec Discord/);
});

test('state invalide ou absent refusé (CSRF)', async () => {
  const c = client(); await c.go('/auth/discord');
  const r = await c.go('/auth/discord/callback?code=codeNew&state=falsifie');
  assert.strictEqual(r.headers.get('location'), '/connexion');
  assert.match(await c.page('/connexion'), /état OAuth invalide/);
  const c2 = client(); await c2.go('/auth/discord/callback?code=codeNew&state=x');
  assert.match(await c2.page('/connexion'), /état OAuth invalide/);
});

test('liaison : un compte connecté lie son Discord (id, nom, avatar)', async () => {
  const c = client();
  await c.form('/inscription', { pseudo: 'lieur', email: 'lieur@t.gg', password: 'MotDePasse1', platform: 'PC' });
  const { cb } = await c.discord('codeLink');
  assert.strictEqual(cb.headers.get('location'), '/profil');
  assert.strictEqual(lastTokenReq.redirect_uri, 'https://arena.example.com/auth/discord/callback');
  const html = await c.page('/profil');
  assert.match(html, /Discord lié : Link User/);
  assert.match(html, /<h1>lieur /);
  assert.ok(html.includes('https://cdn.discordapp.com/avatars/111111111111111111/abc123.png?size=128'));
  assert.match(html, /Link User <span class="muted">@linkuser<\/span>/);
  assert.match(html, /Délier Discord/);
  assert.match(await c.page('/joueurs/lieur'), /Link User \(@linkuser\)/);
  // déconnexion puis « Se connecter avec Discord » → même compte
  await c.form('/deconnexion', {});
  const c2 = client(); const { cb: cb2 } = await c2.discord('codeLink');
  assert.strictEqual(cb2.headers.get('location'), '/profil');
  const p2 = await c2.page('/profil'); assert.match(p2, /<h1>lieur /); assert.match(p2, /Connecté avec Discord/);
});

test('liaison refusée si le Discord appartient déjà à un autre joueur', async () => {
  const c = client(); await c.form('/inscription', { pseudo: 'autre', email: 'autre@t.gg', password: 'MotDePasse1', platform: 'PC' });
  await c.discord('codeLink');
  const html = await c.page('/profil'); assert.match(html, /déjà lié à un autre joueur/); assert.match(html, /Lier mon compte Discord/);
});

test('connexion sans compte lié : création de compte (pseudo unique) puis reconnexion', async () => {
  const c = client(); const { cb } = await c.discord('codeNew');
  assert.strictEqual(cb.headers.get('location'), '/profil');
  const html = await c.page('/profil');
  assert.match(html, /<h1>nouveau\.joueur /); assert.match(html, /Compte créé avec Discord/);
  assert.ok(html.includes('https://cdn.discordapp.com/embed/avatars/'));
  // pseudo déjà pris (Admin) → suffixe
  const c3 = client(); await c3.discord('codeClash');
  const h3 = await c3.page('/profil'); assert.match(h3, /<h1>Admin2 /);
  assert.ok(h3.includes('/avatars/333333333333333333/a_anim.gif'));
  // reconnexion : pas de nouveau compte
  const c2 = client(); await c2.discord('codeNew');
  assert.match(await c2.page('/profil'), /<h1>nouveau\.joueur /);
});

test('code refusé par Discord → erreur', async () => {
  const c = client(); await c.discord('mauvais');
  assert.match(await c.page('/connexion'), /échange du code refusé/);
});

test('délier Discord', async () => {
  const c = client(); await c.discord('codeNew');
  await c.form('/profil/discord/delier', {});
  const html = await c.page('/profil'); assert.match(html, /Discord délié/); assert.match(html, /Lier mon compte Discord/);
});

test('sans configuration : message « Discord non configuré »', async () => {
  await stop(app);
  app = await startApp({ DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '' });
  const c = client(); const r = await c.go('/auth/discord');
  assert.strictEqual(r.headers.get('location'), '/connexion');
  assert.match(await c.page('/connexion'), /Discord non configuré/);
});
