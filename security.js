// Sécurité : en-têtes (CSP à nonce), sessions persistées en SQLite, CSRF, limites de débit, verrouillage de connexion, gestion d'erreurs
const crypto = require('crypto');
const helmet = require('helmet');
const session = require('express-session');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');

const PROD = process.env.NODE_ENV === 'production';

// ---- Secret de session : refusé s'il est absent/faible en production ----
const WEAK = new Set(['secret', 'changeme', 'change-me', 'session', 'keyboard cat', 'dev', 'test', 'password', 'liveroums']);
function sessionSecret() {
  const s = process.env.SESSION_SECRET || '';
  if (PROD && (s.length < 32 || WEAK.has(s.toLowerCase()) || new Set(s).size < 10)) {
    console.error('FATAL : SESSION_SECRET absent ou trop faible en production (32 caractères aléatoires minimum).');
    process.exit(1);
  }
  return s || crypto.randomBytes(32).toString('hex');
}

// ---- Store de sessions SQLite (persistant, nettoyage des sessions expirées) ----
db.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS ix_sessions_exp ON sessions(expires);');
class SqliteStore extends session.Store {
  exp(sess) { return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5; }
  get(sid, cb) { try { const r = db.prepare('SELECT sess, expires FROM sessions WHERE sid=?').get(sid); if (!r || r.expires < Date.now()) return cb(null, null); cb(null, JSON.parse(r.sess)); } catch (e) { cb(e); } }
  set(sid, sess, cb = () => {}) { try { db.prepare('INSERT OR REPLACE INTO sessions(sid,sess,expires) VALUES(?,?,?)').run(sid, JSON.stringify(sess), this.exp(sess)); cb(null); } catch (e) { cb(e); } }
  destroy(sid, cb = () => {}) { try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); } catch (e) { cb(e); } }
  touch(sid, sess, cb = () => {}) { try { db.prepare('UPDATE sessions SET expires=? WHERE sid=?').run(this.exp(sess), sid); cb(null); } catch (e) { cb(e); } }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 36e5).unref();

function sessions() {
  return session({ name: 'lr.sid', secret: sessionSecret(), store: new SqliteStore(), resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 } });
}

// ---- En-têtes : CSP stricte pour les scripts (nonce par requête), HSTS en production ----
function headers(app) {
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.locals.nonce = crypto.randomBytes(16).toString('base64'); next(); });
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      'default-src': ["'self'"], 'script-src': ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`], 'script-src-attr': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], 'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'], 'connect-src': ["'self'"], 'frame-src': ["'self'", ...[require('./anticheat').agentOrigin()].filter(Boolean)], 'object-src': ["'none'"], 'base-uri': ["'self'"],
      'form-action': ["'self'"], 'frame-ancestors': ["'none'"], ...(PROD ? { 'upgrade-insecure-requests': [] } : {}) } },
    strictTransportSecurity: PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, frameguard: { action: 'deny' }, crossOriginEmbedderPolicy: false,
  }));
  app.use((req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'); next(); });
}

// ---- CSRF : jeton synchronisé par session (champ _csrf ou en-tête X-CSRF-Token) ----
const token = req => req.session.csrf || (req.session.csrf = crypto.randomBytes(32).toString('hex'));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || req.body?._csrf;
  if (req.session.csrf && same(sent, req.session.csrf)) return next();
  const json = (req.get('accept') || '').includes('json') || req.path.startsWith('/api/');
  return json ? res.status(403).json({ erreur: 'Jeton CSRF invalide. Recharge la page.' }) : res.status(403).send('Jeton CSRF invalide ou expiré. Recharge la page et réessaie.');
}
// Injecte le nonce dans les <script> et le jeton CSRF dans chaque formulaire POST du HTML rendu
function decorate(html, req, res) {
  const n = res.locals.nonce, t = token(req);
  return html.replace(/<script(?=[\s>])/g, `<script nonce="${n}"`)
    .replace(/(<form\b[^>]*\bmethod="post"[^>]*>)/gi, `$1<input type="hidden" name="_csrf" value="${t}">`)
    .replace('</head>', `<meta name="csrf-token" content="${t}"><script nonce="${n}" src="/app.js" defer></script></head>`);
}

// ---- Limites de débit (par IP réelle derrière le proxy, ou par compte) ----
const limiter = (windowMs, limit, opts = {}) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, ...opts,
  handler: (req, res) => {
    const msg = opts.message || 'Trop de requêtes. Réessaie dans quelques minutes.';
    if ((req.get('accept') || '').includes('json') || req.path.startsWith('/api/')) return res.status(429).json({ erreur: msg });
    res.status(429).send(msg);
  } });
const byUser = (req) => req.user ? 'u' + req.user.id : ipKeyGenerator(req.ip);
const limits = {
  login: limiter(15 * 6e4, 20, { message: 'Trop de tentatives de connexion depuis cette adresse. Réessaie dans 15 minutes.' }),
  signup: limiter(36e5, 5, { message: 'Trop de comptes créés depuis cette adresse. Réessaie plus tard.' }),
  wheel: limiter(6e4, 15, { keyGenerator: byUser }),
  purchase: limiter(6e4, 20, { keyGenerator: byUser }),
  api: limiter(6e4, 120),
  writes: limiter(6e4, 60, { keyGenerator: byUser }),
};

// ---- Verrouillage progressif après échecs de connexion (clé = identifiant saisi, existant ou non : pas d'énumération) ----
db.exec('CREATE TABLE IF NOT EXISTS login_failures(k TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
const MAX_FAILS = 5;
const lockKey = login => String(login).trim().toLowerCase().slice(0, 100);
const lockedFor = login => { const r = db.prepare('SELECT locked_until FROM login_failures WHERE k=?').get(lockKey(login)); return r && r.locked_until > Date.now() ? Math.ceil((r.locked_until - Date.now()) / 1000) : 0; };
function loginFailed(login) {
  const k = lockKey(login), r = db.prepare('SELECT fails FROM login_failures WHERE k=?').get(k), fails = (r?.fails || 0) + 1;
  const lock = fails >= MAX_FAILS ? Date.now() + Math.min(36e5, 6e4 * 2 ** (fails - MAX_FAILS)) : 0; // 1 min, 2, 4… max 1 h
  db.prepare('INSERT OR REPLACE INTO login_failures(k,fails,locked_until,updated_at) VALUES(?,?,?,?)').run(k, fails, lock, Date.now());
}
const loginOk = login => db.prepare('DELETE FROM login_failures WHERE k=?').run(lockKey(login));

// ---- Gestion d'erreurs générique (pas de pile en production) ----
function errors(app, layout) {
  app.use((req, res) => res.status(404).send(layout('Introuvable', req.user, null, '<section><h1>Page introuvable</h1><p><a href="/">Retour à l\'accueil</a></p></section>')));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).send('Requête trop volumineuse.');
    if (err.type === 'parameters.too.many') return res.status(413).send('Trop de paramètres.');
    console.error(PROD ? `Erreur ${req.method} ${req.path} : ${err.message}` : err);
    if (res.headersSent) return next(err);
    res.status(err.status && err.status < 500 ? err.status : 500).send(layout('Erreur', req.user, null, '<section><h1>Oups, une erreur est survenue</h1><p class="muted">Réessaie dans un instant.</p></section>'));
  });
}
// Redirection interne sûre (anti open-redirect)
const safeNext = n => { n = String(n || ''); return /^\/(?![\/\\])[^\s]*$/.test(n) && !n.includes('\\') ? n : '/profil'; };

module.exports = { PROD, sessions, headers, csrf, token, decorate, limits, lockedFor, loginFailed, loginOk, errors, safeNext };
