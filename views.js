// Gabarits HTML (rendu serveur)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Site 100 % Call of Duty : un seul jeu
const GAME = 'Call of Duty';
const GAMES = { [GAME]: { icon: '🪖', color: '#7cb342' } };
const PLATFORMS = ['PC', 'PlayStation', 'Xbox', 'Switch', 'Mobile', 'Multiplateforme'];
const fmtDate = s => new Date(s).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });
function status(t) {
  if (t.finished) return { key: 'termine', label: 'Terminé' };
  if (t.bracket_generated) return { key: 'en_cours', label: 'En cours' };
  if (t.count >= t.max_slots) return { key: 'complet', label: 'Complet' };
  if (new Date(t.reg_close) <= new Date()) return { key: 'ferme', label: 'Inscriptions closes' };
  return { key: 'ouvert', label: 'Inscriptions ouvertes' };
}
function layout(title, user, flash, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · LiveRoums Arena</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="nav"><a class="logo" href="/">⚡ LiveRoums<span>Arena</span></a>
<input type="checkbox" id="burger" hidden><label for="burger" class="burger">☰</label>
<nav><a href="/tournois">Tournois</a><a href="/matchmaking">Matchmaking</a><a href="/classement">Classement</a><a href="/boutique">Boutique</a><a href="/roue" class="roue-link">🎡 Roue${user?.spin ? '<i class="spin-dot" title="Tour gratuit disponible !"></i>' : ''}</a>${user?.is_admin ? '<a href="/admin/tournois/nouveau">+ Créer un tournoi</a>' : ''}
${user ? `<a href="/points" class="chip lp-chip" title="Points LiveRoums">💎 ${user.points ?? 0} LP</a><a href="/profil" class="chip">👤 ${esc(user.pseudo)}</a><form method="post" action="/deconnexion"><button class="btn ghost sm">Déconnexion</button></form>`
       : '<a href="/connexion">Connexion</a><a class="btn sm" href="/inscription">Créer un compte</a>'}</nav></header>
${flash ? `<div class="flash ${flash.type}">${esc(flash.msg)}</div>` : ''}
<main>${body}</main>
<footer><p>⚡ LiveRoums Arena — plateforme de tournois esport.</p></footer></body></html>`;
}
function card(t) {
  const g = GAMES[t.game] || { icon: '🎮', color: '#00f0ff' }; const s = status(t);
  const pct = Math.min(100, Math.round(t.count / t.max_slots * 100));
  return `<a class="card" href="/tournois/${t.id}" style="--gc:${g.color}">
  <div class="card-top"><span class="gicon">${g.icon}</span><span class="badge ${s.key}">${s.label}</span></div>
  <h3>${esc(t.name)}</h3><p class="muted">${esc(t.game)} · ${esc(t.platform)} · ${t.format === 'solo' ? 'Solo' : `Équipe ${t.team_size}v${t.team_size}`}</p>
  <div class="prize">🏆 ${esc(t.cashprize || '—')}</div>
  <div class="bar"><i style="width:${pct}%"></i></div><p class="muted sm">${t.count}/${t.max_slots} places · ${fmtDate(t.start_date)}</p></a>`;
}
function bracketHtml(matches, isAdmin, tid) {
  if (!matches.length) return '<p class="muted">Le bracket sera généré automatiquement à la clôture des inscriptions.</p>';
  const rounds = Math.max(...matches.map(m => m.round));
  const name = r => r === rounds ? 'Finale' : r === rounds - 1 ? 'Demi-finales' : r === rounds - 2 ? 'Quarts' : `Tour ${r}`;
  let h = '<div class="bracket">';
  for (let r = 1; r <= rounds; r++) {
    h += `<div class="round"><h4>${name(r)}</h4>`;
    matches.filter(m => m.round === r).forEach(m => {
      const p = x => {
        const cls = m.winner && m.winner === x ? 'win' : m.winner ? 'lose' : '';
        const btn = isAdmin && x && !m.winner && m.p1 && m.p2 ? `<form method="post" action="/admin/tournois/${tid}/match/${m.id}"><input type="hidden" name="winner" value="${esc(x)}"><button title="Déclarer vainqueur">✔</button></form>` : '';
        return `<div class="slot ${cls}"><span>${x ? esc(x) : '<i class="muted">' + (r === 1 ? 'BYE' : 'À déterminer') + '</i>'}</span>${btn}</div>`;
      };
      h += `<div class="match">${p(m.p1)}${p(m.p2)}</div>`;
    });
    h += '</div>';
  }
  const champ = matches.find(m => m.round === rounds)?.winner;
  return h + `<div class="round champ"><h4>Champion</h4><div class="match"><div class="slot win">${champ ? '👑 ' + esc(champ) : '<i class="muted">?</i>'}</div></div></div></div>`;
}
module.exports = { GAME, esc, layout, card, status, bracketHtml, fmtDate, GAMES, PLATFORMS };
