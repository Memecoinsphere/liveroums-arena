// Page admin « Anti-triche » : intègre le tableau de bord de l'agent anti-triche (service séparé) en iframe
const { esc } = require('./views');
const agentUrl = () => { try { const u = new URL(process.env.ANTICHEAT_URL || 'https://liveroums-anticheat.onrender.com'); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } };
const agentOrigin = () => agentUrl()?.origin || null;

// État du service, vérifié côté serveur (délai court : un service Render gratuit en veille met ~30 s à se réveiller)
async function status(timeoutMs = +process.env.ANTICHEAT_STATUS_TIMEOUT_MS || 3500) {
  const u = agentUrl(); if (!u) return { state: 'config', label: 'URL invalide (ANTICHEAT_URL)' };
  const t0 = Date.now();
  try {
    const r = await fetch(new URL('/healthz', u), { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { 'user-agent': 'liveroums-site' } });
    if (r.ok) return { state: 'ok', label: 'En ligne', ms: Date.now() - t0 };
    if ([502, 503, 504].includes(r.status)) return { state: 'veille', label: 'En veille / démarrage' };
    return { state: 'err', label: `Réponse inattendue (HTTP ${r.status})` };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { state: 'veille', label: 'En veille (pas de réponse rapide)' };
    return { state: 'down', label: 'Injoignable' };
  }
}

module.exports = (app, { auth, admin }) => {
  app.get('/admin/anti-triche', auth, admin, async (req, res) => {
    const u = agentUrl(), s = await status(), href = u ? u.href : '#';
    const note = { ok: `Le tableau de bord répond (${s.ms} ms).`, veille: 'Le service gratuit est en veille : l\'ouverture peut prendre ~30 s, le temps qu\'il se réveille.', down: 'Le service ne répond pas. Vérifie son déploiement sur Render ; l\'intégration ci-dessous restera vide tant qu\'il est hors ligne.', err: 'Le service répond de façon inattendue.', config: 'Définis ANTICHEAT_URL avec l\'adresse https du service anti-triche.' }[s.state];
    res.set('Cache-Control', 'no-store');
    res.page('Anti-triche', `<section class="anticheat"><div class="ac-head"><div><h1>🛡️ Anti-triche</h1>
    <p class="muted">L'<b>agent anti-triche</b> analyse les parties, les comptes liés et les résultats pour repérer smurfs, multi-comptes, matchs arrangés et farm. Il calcule un <b>score de suspicion de 0 à 100</b> avec les raisons détaillées et envoie des <b>alertes</b>. Il ne sanctionne jamais : <b>c'est toi, admin, qui décides</b> (innocent / à surveiller / sanctionné), puis appliques la sanction ici sur le site.</p></div>
    <div class="ac-status ac-${s.state}"><b>${s.state === 'ok' ? '🟢' : s.state === 'veille' ? '🟡' : '🔴'} ${esc(s.label)}</b><span class="muted">${esc(note)}</span>
    <a class="btn ghost sm" href="${esc(href)}" target="_blank" rel="noopener noreferrer">↗ Ouvrir dans un nouvel onglet</a></div></div>
    ${u ? `<iframe class="ac-frame" src="${esc(href)}" title="Tableau de bord anti-triche" referrerpolicy="no-referrer" loading="eager" style="width:100%;height:80vh;min-height:620px;border:1px solid rgba(0,240,255,.35);border-radius:14px;background:#07070f"></iframe>
    <p class="muted sm">Connexion avec le jeton ADMIN_TOKEN de l'agent. Si le cadre reste vide (agent en veille, navigateur bloquant les cookies tiers), utilise « Ouvrir dans un nouvel onglet ». Les données brutes sont aussi disponibles dans <a href="/admin/export">📦 Export</a>.</p>` : ''}</section>`);
  });
};
module.exports.agentOrigin = agentOrigin;
module.exports.status = status;
