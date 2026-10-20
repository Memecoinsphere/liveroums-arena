// Chat de pré-partie : réservé aux joueurs de la partie (et aux admins), code in-game épinglé
const db = require('./db');
const M = require('./mm');
const { esc } = require('./views');

db.exec(`
CREATE TABLE IF NOT EXISTS lobby_messages(id INTEGER PRIMARY KEY, lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'msg', body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_lobby_messages ON lobby_messages(lobby_id, id);
CREATE TABLE IF NOT EXISTS lobby_pins(lobby_id INTEGER PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE, code TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id), pinned_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const MAX = 300, CODE_MAX = 40;
const hits = new Map(); // limite simple : 5 actions / 10 s et 1 / 0,7 s par joueur
function limited(uid) {
  const now = Date.now(), h = (hits.get(uid) || []).filter(t => now - t < 10000);
  if (h.length >= 5 || (h.length && now - h[h.length - 1] < 700)) { hits.set(uid, h); return true; }
  h.push(now); hits.set(uid, h); return false;
}
const getLobby = code => db.prepare('SELECT * FROM lobbies WHERE code=?').get(String(code).toUpperCase());
const canAccess = (user, l) => !!user && (user.is_admin || !!db.prepare('SELECT 1 FROM lobby_players WHERE lobby_id=? AND user_id=?').get(l.id, user.id));
const time = s => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

module.exports = (app, { auth, rank }) => {
  const messages = (l, after = 0) => db.prepare(`SELECT m.id, m.kind, m.body, m.created_at, u.pseudo, m.user_id FROM lobby_messages m LEFT JOIN users u ON u.id=m.user_id
    WHERE m.lobby_id=? AND m.id>? ORDER BY m.id DESC LIMIT 100`).all(l.id, after).reverse()
    .map(m => ({ id: m.id, systeme: m.kind === 'system', pseudo: m.pseudo || '', texte: m.body, heure: time(m.created_at),
      rang: m.user_id && m.kind !== 'system' ? rank(M.getSR(m.user_id, l.game), true) : '' }));
  const pin = l => { const p = db.prepare('SELECT p.code, u.pseudo FROM lobby_pins p LEFT JOIN users u ON u.id=p.user_id WHERE lobby_id=?').get(l.id); return p ? { code: p.code, par: p.pseudo } : null; };
  const guard = (req, res) => {
    const l = getLobby(req.params.code); if (!l) { res.status(404).json({ erreur: 'Partie introuvable.' }); return null; }
    if (!canAccess(req.user, l)) { res.status(403).json({ erreur: 'Chat réservé aux joueurs de la partie.' }); return null; }
    return l;
  };

  app.get('/api/parties/:code/chat', (req, res) => {
    const l = guard(req, res); if (!l) return;
    res.set('Cache-Control', 'no-store').json({ messages: messages(l, +req.query.apres || 0), code_ingame: pin(l) });
  });
  app.post('/api/parties/:code/chat', (req, res) => {
    const l = guard(req, res); if (!l) return;
    const body = String(req.body.message || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim();
    if (!body) return res.status(400).json({ erreur: 'Message vide.' });
    if (body.length > MAX) return res.status(400).json({ erreur: `${MAX} caractères maximum.` });
    if (limited(req.user.id)) return res.status(429).json({ erreur: 'Doucement ! Attends un peu avant de renvoyer un message.' });
    const r = db.prepare('INSERT INTO lobby_messages(lobby_id,user_id,body) VALUES(?,?,?)').run(l.id, req.user.id, body);
    res.json({ ok: true, id: r.lastInsertRowid });
  });
  app.post('/api/parties/:code/chat/code', (req, res) => {
    const l = guard(req, res); if (!l) return;
    const code = String(req.body.code || '').replace(/[\u0000-\u001f]/g, '').trim();
    if (code.length > CODE_MAX) return res.status(400).json({ erreur: `${CODE_MAX} caractères maximum.` });
    if (limited(req.user.id)) return res.status(429).json({ erreur: 'Doucement ! Attends un peu.' });
    if (!code) {
      db.prepare('DELETE FROM lobby_pins WHERE lobby_id=?').run(l.id);
      db.prepare("INSERT INTO lobby_messages(lobby_id,user_id,kind,body) VALUES(?,?,'system',?)").run(l.id, req.user.id, `${req.user.pseudo} a retiré le code de la partie in-game.`);
      return res.json({ ok: true, code_ingame: null });
    }
    db.prepare('INSERT OR REPLACE INTO lobby_pins(lobby_id,code,user_id,pinned_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').run(l.id, code, req.user.id);
    db.prepare("INSERT INTO lobby_messages(lobby_id,user_id,kind,body) VALUES(?,?,'system',?)").run(l.id, req.user.id, `📌 ${req.user.pseudo} a épinglé le code de la partie in-game : ${code}`);
    res.json({ ok: true, code_ingame: pin(l) });
  });

  // Fenêtre de chat (rendu initial côté serveur, échappé ; mises à jour via textContent côté client)
  const msgHtml = m => m.systeme ? `<div class="cm sys" data-id="${m.id}"><span class="ct">${esc(m.heure)}</span> <span class="cb">${esc(m.texte)}</span></div>`
    : `<div class="cm" data-id="${m.id}"><div class="ch"><b class="cp">${esc(m.pseudo)}</b> <span class="cr">${m.rang}</span> <span class="ct">${esc(m.heure)}</span></div><div class="cb">${esc(m.texte)}</div></div>`;
  const html = (req, l) => {
    if (!canAccess(req.user, l)) return '';
    const ms = messages(l), p = pin(l), base = `/api/parties/${l.code}/chat`;
    return `<div class="chat panel" id="chat"><h3>💬 Chat de pré-partie</h3>
  <div class="pin-box ${p ? 'set' : ''}" id="pinBox"><small>📌 Code de la partie in-game</small>
    <div class="pin-row"><b class="code big" id="pinCode">${p ? esc(p.code) : '—'}</b><button type="button" class="btn sm" id="pinCopy" ${p ? '' : 'hidden'}>Copier</button></div>
    <small class="muted" id="pinBy">${p ? `épinglé par ${esc(p.par)}` : "Aucun code pour l'instant : colle le code du lobby / de la party in-game."}</small>
    <form id="pinForm" class="pin-form"><input name="code" maxlength="${CODE_MAX}" placeholder="Code lobby / party in-game" autocomplete="off"><button class="btn ghost sm">📌 Épingler</button></form></div>
  <div class="chat-log" id="chatLog" aria-live="polite">${ms.map(msgHtml).join('') || '<p class="muted sm empty">Aucun message. Dis bonjour à ton équipe !</p>'}</div>
  <form id="chatForm" class="chat-form"><input name="message" maxlength="${MAX}" placeholder="Écris un message…" autocomplete="off" required><button class="btn sm">Envoyer</button></form>
  <small class="muted" id="chatErr"></small></div>
<script>(()=>{const B=${JSON.stringify(base)},log=document.getElementById('chatLog'),err=document.getElementById('chatErr');let last=${ms.length ? ms[ms.length - 1].id : 0};
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;};
const add=m=>{if(m.id<=last)return;last=m.id;log.querySelector('.empty')?.remove();const near=log.scrollHeight-log.scrollTop-log.clientHeight<80;const d=el('div','cm'+(m.systeme?' sys':''));
if(m.systeme){d.append(el('span','ct',m.heure),' ',el('span','cb',m.texte));}else{const h=el('div','ch'),r=el('span','cr');r.innerHTML=m.rang;h.append(el('b','cp',m.pseudo),' ',r,' ',el('span','ct',m.heure));d.append(h,el('div','cb',m.texte));}
log.append(d);if(near||m.mine)log.scrollTop=log.scrollHeight;};
const setPin=p=>{document.getElementById('pinBox').classList.toggle('set',!!p);document.getElementById('pinCode').textContent=p?p.code:'—';document.getElementById('pinCopy').hidden=!p;
document.getElementById('pinBy').textContent=p?'épinglé par '+p.par:"Aucun code pour l'instant : colle le code du lobby / de la party in-game.";};
const refresh=async()=>{try{const r=await fetch(B+'?apres='+last,{cache:'no-store'});if(!r.ok)return;const j=await r.json();j.messages.forEach(add);setPin(j.code_ingame);}catch(e){}};
const send=async(url,data)=>{err.textContent='';const r=await fetch(url,{method:'POST',body:new URLSearchParams(data)});const j=await r.json().catch(()=>({}));if(!r.ok){err.textContent=j.erreur||'Erreur.';return false;}await refresh();log.scrollTop=log.scrollHeight;return true;};
document.getElementById('chatForm').onsubmit=async e=>{e.preventDefault();const i=e.target.message;if(await send(B,{message:i.value}))i.value='';};
document.getElementById('pinForm').onsubmit=async e=>{e.preventDefault();const i=e.target.code;if(await send(B+'/code',{code:i.value}))i.value='';};
document.getElementById('pinCopy').onclick=async e=>{const t=document.getElementById('pinCode').textContent;try{await navigator.clipboard.writeText(t);}catch(_){const a=el('textarea');a.value=t;document.body.append(a);a.select();document.execCommand('copy');a.remove();}
e.target.textContent='Copié ✔';setTimeout(()=>e.target.textContent='Copier',1500);};
log.scrollTop=log.scrollHeight;setInterval(refresh,2500);})();</script>`;
  };
  return { html, canAccess };
};
