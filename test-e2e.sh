#!/bin/bash
# Test de bout en bout : inscription, connexion, inscription tournoi, doublon, capacité, désinscription
# Démarrer le serveur avec NODE_ENV=test WHEEL_TEST_FORCE=1 (tirage forcé de la Roue, test uniquement) ; BASE_URL optionnel. Lancer depuis la racine du dépôt.
B=${BASE_URL:-http://localhost:3000}; J=$(mktemp); P=0; F=0
# Client curl : chaque bocal de cookies = un « joueur » avec sa propre IP simulée (X-Forwarded-For, proxy de confiance)
# et, pour toute requête d'écriture, le jeton CSRF de sa session (GET /api/csrf). « command curl » contourne ce wrapper.
curl(){
  local jar="" post=0 a prev=""
  for a in "$@"; do case "$prev" in -b|-c) jar=$a;; esac; case "$a" in -d|--data*|-X) post=1;; esac; prev=$a; done
  local ip="10.$(( $(printf %s "${jar:-anon}" | cksum | cut -d" " -f1) % 250 )).$(( RANDOM % 250 )).$(( ${#jar} % 250 ))"
  [ -n "$jar" ] && ip="10.$(( $(printf %s "$jar" | cksum | cut -d" " -f1) / 250 % 250 )).$(( $(printf %s "$jar" | cksum | cut -d" " -f1) % 250 )).7"
  if [ $post = 1 ] && [ -n "$jar" ]; then
    local tok=$(command curl -s -c "$jar" -b "$jar" -H "X-Forwarded-For: $ip" "$B/api/csrf" | sed 's/.*"csrf":"\([0-9a-f]*\)".*/\1/')
    command curl -H "X-Forwarded-For: $ip" -H "X-CSRF-Token: $tok" "$@"
  else command curl -H "X-Forwarded-For: $ip" "$@"; fi
}
# Vérification d'email : lien lu dans la boîte d'envoi de test (NODE_ENV=test), ouvert avec le bocal de cookies donné
OUTBOX=${OUTBOX:-/tmp/lp-test.db.outbox.jsonl}
vlink(){ python3 -c "import sys,json,re;L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()];m=[x for x in L if x['to']==sys.argv[2].lower()];print(re.search(r'/verifier-email\?token=[A-Za-z0-9_-]+',m[-1]['text']).group(0) if m else '')" "$OUTBOX" "$1" 2>/dev/null; }
vfy(){ local L=$(vlink "$1"); [ -n "$L" ] && curl -s -c "$2" -b "$2" -o /dev/null "$B$L"; }
ok(){ if eval "$2"; then echo "✅ $1"; P=$((P+1)); else echo "❌ $1"; F=$((F+1)); fi; }
U=testeur$RANDOM
c(){ curl -s -b $J -c $J "$@"; }
# Base vierge : vérification des états vides, puis l'admin crée les tournois utilisés par les tests
ok "Liste tournois vide (état vide)" 'curl -s $B/tournois | grep -q "Aucun tournoi pour le moment"'
ok "Accueil : 0 tournoi" 'curl -s $B/ | grep -q "<b>0</b><span>tournois"'
ok "Classement vide (état vide)" 'curl -s "$B/classement" | grep -q "Aucun joueur classé"'
A=$(mktemp); curl -s -c $A -b $A -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
D(){ date -d "$1" +%Y-%m-%dT%H:%M; }
mkT(){ curl -s -c $A -b $A -o /dev/null -w %{redirect_url} --data-urlencode "name=$1" -d "$2" $B/admin/tournois | grep -o "[0-9]*$"; }
TE=$(mkT "CoD Squad Cup $RANDOM" "game=Call+of+Duty&platform=PC&format=equipe&team_size=5&max_slots=16&start_date=$(D '+10 days')&reg_close=$(D '+8 days')")
TR=$(mkT "CoD Duo $RANDOM" "game=Call+of+Duty&platform=Multiplateforme&format=equipe&team_size=2&max_slots=16&start_date=$(D '+5 days')&reg_close=$(D '+4 days')")
TF=$(mkT "CoD League $RANDOM" "game=Call+of+Duty&platform=PlayStation&format=solo&max_slots=8&start_date=$(D '+3 days')&reg_close=$(D '+2 days')")
TC=$(mkT "CoD Open $RANDOM" "game=Call+of+Duty&platform=PC&format=solo&max_slots=8&start_date=$(D '+1 day')&reg_close=$(D '+12 hours')")
TX=$(mkT "CoD Clos $RANDOM" "game=Call+of+Duty&platform=PC&format=solo&max_slots=8&start_date=$(D '+1 day')&reg_close=$(D '-1 day')")
ok "Admin crée les tournois de test" '[ -n "$TE" ] && [ -n "$TR" ] && [ -n "$TF" ] && [ -n "$TC" ] && [ -n "$TX" ]'
# 4 joueurs inscrits au CoD Open puis bracket généré par l'admin
for i in 1 2 3 4; do K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=c$i$U&email=c$i$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; vfy c$i$U@t.gg $K; curl -s -c $K -b $K -o /dev/null -d rules=on $B/tournois/$TC/inscription; done
curl -s -c $A -b $A -o /dev/null -d x=1 $B/admin/tournois/$TC/bracket
ok "Accueil 200" '[ "$(curl -s -o /dev/null -w %{http_code} $B/)" = 200 ]'
ok "Création de compte → compte inactif, renvoi vers /connexion" '[ "$(c -o /dev/null -w %{redirect_url} -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC&game_id=$U%231" $B/inscription)" = "$B/connexion?verif=1" ] && [ "$(c -o /dev/null -w %{http_code} $B/profil)" = 303 ]'
ok "Vérif email : mail envoyé (HTML néon + texte) avec lien à usage unique" 'python3 -c "import json;m=[json.loads(l) for l in open(\"$OUTBOX\")][-1];assert m[\"to\"]==\"$U@test.gg\".lower() and \"Vérifier mon email\" in m[\"html\"] and \"/verifier-email?token=\" in m[\"text\"]"'
ok "Vérif email : connexion refusée tant que non vérifié (message + formulaire de renvoi)" 'P0=$(c -L -d "login=$U@test.gg&password=MotDePasse1" $B/connexion); echo "$P0" | grep -q "pas encore vérifié" && echo "$P0" | grep -q "Renvoyer le mail" && [ "$(c -o /dev/null -w %{http_code} $B/profil)" = 303 ]'
ok "Vérif email : jeton invalide refusé" 'c "$B/verifier-email?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | grep -q "Lien invalide ou expiré" && c "$B/verifier-email?token=x" | grep -q "Lien invalide"'
OLDL=$(vlink $U@test.gg)
ok "Vérif email : renvoi → nouveau lien, l ancien est invalidé" 'sleep 0; sqlite3 /tmp/lp-test.db "UPDATE email_tokens SET created_at=created_at-120000" 2>/dev/null || node -e "const D=require(\"better-sqlite3\");new D(\"/tmp/lp-test.db\").prepare(\"UPDATE email_tokens SET created_at=created_at-120000\").run()"; c -L -d "email=$U@test.gg" $B/renvoyer-verification | grep -q "Si un compte non vérifié" && [ "$(vlink $U@test.gg)" != "$OLDL" ] && c "$B$OLDL" | grep -q "Lien invalide"'
ok "Vérif email : renvoi pour un email inconnu → même message (pas d énumération)" 'c -L -d "email=inconnu$U@test.gg" $B/renvoyer-verification | grep -q "Si un compte non vérifié"'
NEWL=$(vlink $U@test.gg)
ok "Vérif email : le lien vérifie le compte et connecte (/profil)" '[ "$(c -o /dev/null -w %{redirect_url} "$B$NEWL")" = "$B/profil" ] && c $B/profil | grep -q "$U"'
ok "Vérif email : lien déjà utilisé refusé" 'c "$B$NEWL" | grep -q "Lien invalide ou expiré"'
ok "Profil affiche le pseudo" 'c $B/profil | grep -q "$U"'
ok "Compte en double refusé" 'c -L -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC" $B/inscription | grep -q "déjà utilisé"'
c -X POST $B/deconnexion -o /dev/null
ok "Mauvais mot de passe refusé" 'c -L -d "login=$U&password=faux" $B/connexion | grep -q "Identifiants incorrects"'
ok "Connexion OK" '[ "$(c -o /dev/null -w %{redirect_url} -d "login=$U@test.gg&password=MotDePasse1" $B/connexion)" = "$B/profil" ]'
ok "Inscription solo CoD League" 'c -L -d rules=on $B/tournois/$TF/inscription | grep -q "Inscription confirmée"'
ok "Double inscription refusée" 'c -L -d rules=on $B/tournois/$TF/inscription | grep -q "déjà inscrit"'
ok "Inscription équipe CoD Squad" 'c -L -d "rules=on&team_name=Team_$U&mates=A&mates=B&mates=C&mates=D" $B/tournois/$TE/inscription | grep -q "Team_$U"'
ok "Équipe incomplète refusée (CoD Duo)" 'c -L -d "rules=on&team_name=X$U" $B/tournois/$TR/inscription | grep -q "exactement 1"'
ok "Inscription refusée sur tournoi clos" 'c -L -d rules=on $B/tournois/$TX/inscription | grep -q "fermées"'
ok "Profil liste 2 tournois" 'c $B/profil | grep -q "Mes tournois (2)"'
# Remplir CoD League (8 places) avec d'autres comptes, puis vérifier le refus
for i in 1 2 3 4 5 6 7; do K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=f$i$U&email=f$i$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; vfy f$i$U@t.gg $K; curl -s -c $K -b $K -o /dev/null -d rules=on $B/tournois/$TF/inscription; done
K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=x$U&email=x$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; vfy x$U@t.gg $K
ok "Capacité : 9e joueur refusé (complet)" 'curl -s -c $K -b $K -L -d rules=on $B/tournois/$TF/inscription | grep -q "complet"'
ok "Désinscription CoD League" 'c -L -d x=1 $B/tournois/$TF/desinscription | grep -q "désinscrit"'
ok "Profil liste 1 tournoi" 'c $B/profil | grep -q "Mes tournois (1)"'
ok "Non-admin refusé sur création" '[ "$(c -o /dev/null -w %{http_code} $B/admin/tournois/nouveau)" = 403 ]'
ok "Admin crée un tournoi" 'curl -s -c $A -b $A -L -d "name=Test+Cup&game=Call+of+Duty&platform=PC&format=solo&max_slots=4&cashprize=50&start_date=2030-01-02T20:00&reg_close=2030-01-01T20:00" $B/admin/tournois | grep -q "Tournoi publié"'
ok "Admin génère bracket CoD League" 'curl -s -c $A -b $A -L -d x=1 $B/admin/tournois/$TF/bracket | grep -q "Demi-finales"'
ok "Bracket CoD Open affiché" 'curl -s $B/tournois/$TC | grep -q "Finale"'
ok "Filtre plateforme=Multiplateforme" '[ "$(curl -s "$B/tournois?plateforme=Multiplateforme" | grep -o "class=\"card\"" | wc -l)" = 1 ]'
ok "Filtre format=solo&statut=en_cours" 'curl -s "$B/tournois?format=solo&statut=en_cours" | grep -q "CoD Open"'

# ---------- SR, comptes liés, matchmaking ----------
js(){ curl -s "$B/api/joueurs/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
mk(){ local j=/tmp/mm_$1; rm -f $j; curl -s -c $j -b $j -o /dev/null -d "pseudo=$1&email=$1@t.gg&password=MotDePasse1&platform=PC" $B/inscription; vfy $1@t.gg $j; }
R=$RANDOM; for n in 1 2 3 4 5; do mk q$n$R; done
q(){ curl -s -c /tmp/mm_$1 -b /tmp/mm_$1 "${@:2}"; }
ok "Classement vide au départ (état vide)" 'curl -s "$B/classement" | grep -q "Aucun joueur classé"'
ok "Lier un compte Activision ID (non vérifié)" 'c -L -d "provider=activision&account_id=Test%23123" $B/profil/comptes | grep -q "non vérifié"'
ok "Comptes liés visibles sur profil public" 'curl -s $B/joueurs/$U | grep -q "Test#123"'
ok "Steam OpenID redirige vers steamcommunity" 'c -o /dev/null -w %{redirect_url} $B/auth/steam | grep -q "steamcommunity.com/openid/login.*checkid_setup"'
ok "Retour Steam falsifié refusé" 'c -L "$B/auth/steam/retour?openid.mode=id_res&openid.claimed_id=x" | grep -q "Liaison Steam échouée"'
q q1$R -o /dev/null -d "gm=Call of Duty|1v1" $B/matchmaking/rejoindre
ok "File : 1 joueur en attente, pas de partie" '[ "$(js q1$R "d[\"lobby\"]")" = None ] && [ "$(js q1$R "d[\"queue\"][\"mode\"]")" = 1v1 ]'
q q2$R -o /dev/null -d "gm=Call of Duty|1v1" $B/matchmaking/rejoindre
G1=$(js q1$R 'd["lobby"]')
ok "File → partie auto créée (code 6 car.)" '[ ${#G1} = 6 ] && [ "$(js q2$R "d[\"lobby\"]")" = "$G1" ]'
ok "Équipes formées (1 par équipe)" 'curl -s $B/api/parties/$G1 | grep -q "\"equipe\":1" && curl -s $B/api/parties/$G1 | grep -q "\"equipe\":2"'
q q3$R -o /dev/null -d "gm=Call of Duty|1v1" $B/matchmaking/rejoindre
ok "3e joueur en attente" '[ "$(js q3$R "d[\"lobby\"]")" = None ]'
HOST=$(curl -s $B/api/parties/$G1 | python3 -c "import sys,json;print([p['pseudo'] for p in json.load(sys.stdin)['joueurs'] if p['equipe']==1][0])")
SR0=$(js $HOST 'd["ratings"].get("Call of Duty",1000)')
# l'hôte (premier en file = q1) déclare la victoire de l'équipe 1
q q1$R -o /dev/null -d winner=1 $B/parties/$G1/resultat
ok "Non-hôte ne peut pas déclarer" 'q q3$R -L -d winner=1 $B/parties/$G1/resultat | grep -q "Seul l"'
ok "Partie terminée" 'curl -s $B/api/parties/$G1 | grep -q "\"statut\":\"termine\""'
ok "Partie rapide : SR inchangé (non classée)" '[ "$(js $HOST "d[\"ratings\"].get(\"Call of Duty\",1000)")" = "$SR0" ]'
G2=$(js q3$R 'd["lobby"]')
ok "Fin de partie → joueur en attente tiré dans une nouvelle partie" '[ ${#G2} = 6 ] && [ "$G2" != "$G1" ] && curl -s $B/api/parties/$G2 | grep -q "en_cours"'
CODE=$(q q4$R -o /dev/null -w %{redirect_url} -d "gm=Call of Duty|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$")
ok "Partie privée créée avec code" '[ ${#CODE} = 6 ] && curl -s $B/api/parties/$CODE | grep -q "\"statut\":\"attente\""'
ok "Code invalide refusé" 'q q5$R -L -d code=ZZZZZZ $B/parties/rejoindre | grep -q "introuvable"'
ok "Rejoindre par code → partie complète démarrée" '[ "$(q q5$R -o /dev/null -w %{redirect_url} -d code=${CODE,,} $B/parties/rejoindre)" = "$B/parties/$CODE" ] && curl -s $B/api/parties/$CODE | grep -q "en_cours"'
A2=$(mktemp); curl -s -c $A2 -b $A2 -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
M1=$(curl -s -b $A2 $B/tournois/$TC | grep -o "/admin/tournois/$TC/match/[0-9]*" | head -1); W=$(curl -s -b $A2 $B/tournois/$TC | grep -o "action=\"$M1\"><input type=\"hidden\" name=\"_csrf\" value=\"[0-9a-f]*\"><input type=\"hidden\" name=\"winner\" value=\"[^\"]*\"" | head -1 | sed 's/.*value="//;s/"$//')
SRW=$(js $W 'd["ratings"].get("Call of Duty",1000)'); curl -s -b $A2 -o /dev/null -d "winner=$W" $B$M1
ok "Match de tournoi → SR du vainqueur mis à jour" '[ "$(js $W "d[\"ratings\"][\"Call of Duty\"]")" -gt "$SRW" ]'
# ---------- Chat de pré-partie ----------
mk h$R; mk o$R
CC=$(q h$R -o /dev/null -w %{redirect_url} -d "gm=Call of Duty|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$")
ok "Chat : non-membre refusé (lecture 403)" '[ "$(q o$R -o /dev/null -w %{http_code} $B/api/parties/$CC/chat)" = 403 ]'
ok "Chat : non-membre refusé (envoi 403)" '[ "$(q o$R -o /dev/null -w %{http_code} -d message=intrus $B/api/parties/$CC/chat)" = 403 ]'
ok "Chat : visiteur non connecté refusé" '[ "$(curl -s -o /dev/null -w %{http_code} $B/api/parties/$CC/chat)" = 403 ]'
ok "Chat absent de la page pour un non-membre" '! q o$R $B/parties/$CC | grep -q "chatLog"'
ok "Chat : membre poste un message" 'q h$R -d "message=Salut la team" $B/api/parties/$CC/chat | grep -q "\"ok\":true"'
ok "Chat : message lu via l API (pseudo + heure)" 'q h$R $B/api/parties/$CC/chat | grep -q "\"texte\":\"Salut la team\".*\"heure\""'
ok "Chat : admin peut lire" 'curl -s -b $A2 $B/api/parties/$CC/chat | grep -q "Salut la team"'
ok "Chat : message > 300 caractères refusé" '[ "$(q h$R -o /dev/null -w %{http_code} -d message=$(printf "a%.0s" $(seq 301)) $B/api/parties/$CC/chat)" = 400 ]'
sleep 1
ok "Chat : épingler le code in-game" 'q h$R -d "code=PARTY-42XZ" $B/api/parties/$CC/chat/code | grep -q "PARTY-42XZ"'
ok "Chat : code épinglé affiché + message système" 'q h$R $B/api/parties/$CC/chat | grep -q "\"code_ingame\":{\"code\":\"PARTY-42XZ\"" && q h$R $B/api/parties/$CC/chat | grep -q "\"systeme\":true,[^}]*épinglé"'
ok "Chat : code épinglé en haut de la page" 'q h$R $B/parties/$CC | grep -q "id=\"pinCode\">PARTY-42XZ<"'
sleep 1
q h$R -o /dev/null --data-urlencode "message=<script>alert(1)</script><img src=x onerror=alert(2)>" $B/api/parties/$CC/chat
ok "Chat : XSS échappé dans la page" 'P1=$(q h$R $B/parties/$CC); echo "$P1" | grep -q "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img" && ! echo "$P1" | grep -q "<script>alert(1)" && ! echo "$P1" | grep -q "<img src=x"'
ok "Chat : limite de débit (429)" 'for i in 1 2 3 4 5 6 7; do q h$R -o /dev/null -d message=spam$i $B/api/parties/$CC/chat; done; [ "$(q h$R -o /dev/null -w %{http_code} -d message=encore $B/api/parties/$CC/chat)" = 429 ]'
# ---------- Mode Classé (solo / duo) ----------
for n in r1 r2 r3 r4 r5 r6 r7 r8 r9 qa1 qa2 qa3 qa4 qa5 qb1 qb2 qb3 qb4 qc1 qc2 qc3 qc4 qd1 s1 s2 s3 s4; do mk $n$R; done
api(){ curl -s $B/api/parties/$1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
q r1$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre
ok "Classé : 1 joueur solo en file, pas de partie" '[ "$(js r1$R "d[\"ranked_queue\"]")" = "Call of Duty" ] && [ "$(js r1$R "d[\"lobby\"]")" = None ]'
for n in r2 r3 r4 r5 r6 r7; do q $n$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre; done
ok "Classé : 7 joueurs en file, toujours pas de partie (4v4)" '[ "$(js r7$R "d[\"lobby\"]")" = None ]'
q r8$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre
RK=$(js r1$R 'd["lobby"]')
ok "Classé solo : partie 4v4 créée (8 joueurs), badge Classé" '[ ${#RK} = 6 ] && [ "$(js r8$R "d[\"lobby\"]")" = "$RK" ] && [ "$(api $RK "d[\"classe\"]")" = True ] && [ "$(api $RK "len(d[\"joueurs\"])")" = 8 ] && curl -s $B/parties/$RK | grep -q "🏆 Classé" && curl -s $B/parties/$RK | grep -q "Call of Duty · 4v4"'
ok "Classé : page de partie avec chat de pré-partie" 'q r1$R $B/parties/$RK | grep -q "Chat de pré-partie"'
RW=$(api $RK '[p["pseudo"] for p in d["joueurs"] if p["equipe"]==1][0]'); RL=$(api $RK '[p["pseudo"] for p in d["joueurs"] if p["equipe"]==2][0]')
q r1$R -o /dev/null -d winner=1 $B/parties/$RK/resultat
ok "Classé : le résultat modifie le SR (gagnant ↑, perdant ↓)" '[ "$(js $RW "d[\"ratings\"][\"Call of Duty\"]")" -gt 1000 ] && [ "$(js $RL "d[\"ratings\"][\"Call of Duty\"]")" -lt 1000 ]'
ok "Classement CoD liste le joueur classé" 'curl -s "$B/classement" | grep -q "$RW"'
ok "Jeu retiré refusé en classé (Valorant)" 'q r9$R -L -d game=Valorant $B/classe/rejoindre | grep -q "Jeu invalide"'
ok "Jeu retiré refusé en partie rapide (Fortnite)" 'q r9$R -L -d "gm=Fortnite|1v1" $B/matchmaking/rejoindre | grep -q "Jeu ou mode invalide"'
ok "Matchmaking : uniquement Call of Duty (classé solo ou quatuor 4 max)" 'P4=$(curl -s $B/matchmaking); echo "$P4" | grep -q "Solo ou quatuor (4 max)" && ! echo "$P4" | grep -qi "duo" && ! echo "$P4" | grep -Eq "Valorant|Fortnite|CS2|Rocket League|EA FC|League of Legends"'
# ---------- Classé : quatuor (groupe pré-formé de 4) ----------
team(){ api $1 '[p["equipe"] for p in d["joueurs"] if p["pseudo"]=="'$2'"][0]'; }
QC=$(q qa1$R -L -d "game=Call of Duty" $B/classe/quatuor | grep -o "code [A-Z0-9]\{5\}" | head -1 | cut -c6-)
ok "Quatuor créé avec code (5 car.) + wording" '[ ${#QC} = 5 ] && q qa1$R $B/matchmaking | grep -q "Mon quatuor · 1/4" && q qa1$R $B/matchmaking | grep -q "Dissoudre le quatuor"'
ok "Quatuor : rejoindre par code (insensible à la casse)" 'q qa2$R -L -d code=${QC,,} $B/classe/quatuor/rejoindre | grep -q "Quatuor rejoint" && q qa3$R -L -d code=$QC $B/classe/quatuor/rejoindre | grep -q "Quatuor rejoint"'
ok "Quatuor : recherche refusée à 3/4 (incomplet)" 'q qa1$R -L -d "game=Call of Duty" $B/classe/rejoindre | grep -q "Quatuor incomplet (3/4)" && [ "$(js qa1$R "d[\"ranked_queue\"]")" = None ]'
q qa4$R -o /dev/null -d code=$QC $B/classe/quatuor/rejoindre
ok "Quatuor : 5e membre refusé (4 max)" 'q qa5$R -L -d code=$QC $B/classe/quatuor/rejoindre | grep -q "Quatuor complet : 4 joueurs maximum"'
ok "Quatuor : un membre ne peut pas lancer la recherche" 'q qa2$R -L -d "game=Call of Duty" $B/classe/rejoindre | grep -q "Seul le chef du quatuor"'
QA4=$(q qa1$R $B/matchmaking | grep -o "name=\"user_id\" value=\"[0-9]*\"" | tail -1 | grep -o "[0-9]\+")
ok "Quatuor : un membre ne peut pas exclure" 'q qa2$R -L -d user_id=$QA4 $B/classe/quatuor/exclure | grep -q "Seul le chef"'
ok "Quatuor : le chef exclut un membre (CSRF requis)" '[ "$(command curl -s -b /tmp/mm_qa1$R -o /dev/null -w %{http_code} -d user_id=$QA4 $B/classe/quatuor/exclure)" = 403 ] && q qa1$R -L -d user_id=$QA4 $B/classe/quatuor/exclure | grep -q "exclu du quatuor" && q qa1$R $B/matchmaking | grep -q "Mon quatuor · 3/4"'
ok "Quatuor : un membre quitte puis revient" 'q qa3$R -L -d x=1 $B/classe/quatuor/quitter | grep -q "Tu as quitté le quatuor" && q qa3$R -L -d code=$QC $B/classe/quatuor/rejoindre | grep -q "Quatuor rejoint"'
q qa5$R -o /dev/null -d code=$QC $B/classe/quatuor/rejoindre
q qa1$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre
ok "Quatuor complet en file (4 joueurs, pas encore de partie)" '[ "$(js qa5$R "d[\"ranked_queue\"]")" = "Call of Duty" ] && [ "$(js qa1$R "d[\"lobby\"]")" = None ]'
for n in s1 s2 s3 s4; do q $n$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre; done
QL=$(js qa1$R 'd["lobby"]')
ok "Classé : quatuor vs 4 solos → partie 4v4, quatuor = une équipe entière" '[ ${#QL} = 6 ] && [ "$(api $QL "len(d[\"joueurs\"])")" = 8 ] && T=$(team $QL qa1$R) && [ "$(team $QL qa2$R)" = $T ] && [ "$(team $QL qa3$R)" = $T ] && [ "$(team $QL qa5$R)" = $T ] && [ "$(team $QL s1$R)" != $T ] && [ "$(team $QL s4$R)" != $T ]'
QB=$(q qb1$R -L -d "game=Call of Duty" $B/classe/quatuor | grep -o "code [A-Z0-9]\{5\}" | head -1 | cut -c6-)
QCC=$(q qc1$R -L -d "game=Call of Duty" $B/classe/quatuor | grep -o "code [A-Z0-9]\{5\}" | head -1 | cut -c6-)
for n in 2 3 4; do q qb$n$R -o /dev/null -d code=$QB $B/classe/quatuor/rejoindre; q qc$n$R -o /dev/null -d code=$QCC $B/classe/quatuor/rejoindre; done
q qb1$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre; q qc1$R -o /dev/null -d "game=Call of Duty" $B/classe/rejoindre
QQ=$(js qb1$R 'd["lobby"]')
ok "Classé : quatuor vs quatuor → chaque quatuor forme une équipe" '[ ${#QQ} = 6 ] && [ "$(js qc1$R "d[\"lobby\"]")" = "$QQ" ] && TB=$(team $QQ qb1$R) && TC=$(team $QQ qc1$R) && [ $TB != $TC ] && for n in 2 3 4; do [ "$(team $QQ qb$n$R)" = $TB ] && [ "$(team $QQ qc$n$R)" = $TC ] || exit 1; done'
QD=$(q qd1$R -L -d "game=Call of Duty" $B/classe/quatuor | grep -o "code [A-Z0-9]\{5\}" | head -1 | cut -c6-)
ok "Quatuor : le chef dissout le quatuor" 'q qd1$R -L -d x=1 $B/classe/quatuor/quitter | grep -q "Quatuor dissous" && q qa4$R -L -d code=$QD $B/classe/quatuor/rejoindre | grep -q "Quatuor introuvable"'
ok "Quatuor : nom du membre échappé / code invalide refusé" 'q qa4$R -L --data-urlencode "code=<b>" $B/classe/quatuor/rejoindre | grep -q "Code de quatuor invalide"'
ok "Site mono-jeu : accueil, tournois et classement sans autre jeu" '! curl -s $B/ | grep -Eq "Valorant|Fortnite|CS2|Rocket League|EA FC|League of Legends" && curl -s $B/ | grep -q "Modes Call of Duty" && ! curl -s $B/tournois | grep -q "name=\"jeu\"" && ! curl -s $B/classement | grep -q "class=\"tabs\""'
ok "Admin : tournoi d un jeu retiré forcé en Call of Duty" 'curl -s -c $A -b $A -L -d "name=Forcé+$R&game=Valorant&platform=PC&format=solo&max_slots=4&start_date=2030-01-02T20:00&reg_close=2030-01-01T20:00" $B/admin/tournois | grep -q "Call of Duty · PC"'
# ---------- Points LiveRoums (LP) & boutique ----------
pj(){ curl -s -b /tmp/mm_$1 $B/api/points | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
LOSER=$(curl -s $B/api/parties/$G1 | python3 -c "import sys,json;print([p['pseudo'] for p in json.load(sys.stdin)['joueurs'] if p['equipe']==2][0])")
ok "LP : victoire partie rapide → +100 (registre) + bonus 1re victoire x2" '[ "$(pj $HOST "sum(h[\"montant\"] for h in d[\"historique\"] if h[\"motif\"]==\"Victoire (partie rapide)\")")" = 100 ] && pj $HOST "d[\"historique\"]" | grep -q "première victoire du jour"'
ok "LP : défaite → +10 de participation" '[ "$(pj $LOSER "sum(h[\"montant\"] for h in d[\"historique\"] if h[\"motif\"].startswith(\"Participation\"))")" = 10 ]'
ok "LP : victoire classée créditée (+100)" '[ "$(js $RW "d[\"points\"]")" -ge 200 ]'
ok "LP : match de tournoi crédité au vainqueur" '[ "$(js $W "d[\"points\"]")" -ge 100 ]'
mk lp1$R; mk lp2$R
ok "LP : bonus de connexion quotidien +25" '[ "$(pj lp1$R "d[\"solde\"]")" = 25 ] && pj lp1$R "d[\"historique\"]" | grep -q "Bonus de connexion quotidien"'
ok "LP : bonus quotidien non cumulable le même jour" 'q lp1$R -o /dev/null $B/profil; [ "$(pj lp1$R "d[\"solde\"]")" = 25 ]'
ok "LP : solde affiché dans l en-tête" 'q lp1$R $B/boutique | grep -q "💎 25 LP"'
ok "Boutique : page /boutique avec raretés et Clutch King" 'curl -s $B/boutique | grep -q "Clutch King" && curl -s $B/boutique | grep -q "Légendaire"'
ok "Boutique : achat refusé (points insuffisants)" 'q lp1$R -L -d item=banner_inferno $B/boutique/acheter | grep -q "Points insuffisants" && [ "$(pj lp1$R "d[\"solde\"]")" = 25 ] && [ "$(pj lp1$R "len(d[\"inventaire\"])")" = 0 ]'
S0=$(pj $HOST 'd["solde"]')
ok "Boutique : achat réussi (−200 LP, inventaire)" 'q $HOST -L -d item=color_cyan $B/boutique/acheter | grep -q "Achat réussi" && [ "$(pj $HOST "d[\"solde\"]")" = $((S0-200)) ] && pj $HOST "d[\"inventaire\"]" | grep -q color_cyan'
ok "Boutique : double achat refusé" 'q $HOST -L -d item=color_cyan $B/boutique/acheter | grep -q "possèdes déjà"'
ok "Boutique : équiper un objet non possédé refusé" 'q lp1$R -L -d item=color_cyan $B/boutique/equiper | grep -q "ne possèdes pas"'
ok "Boutique : équiper → visible sur le profil public" 'q $HOST -L -d item=color_cyan $B/boutique/equiper | grep -q "équipé" && [ "$(pj $HOST "d[\"equipe\"].get(\"color\")")" = color_cyan ] && curl -s $B/joueurs/$HOST | grep -q "color:#00f0ff"'
ok "Boutique : cosmétique visible dans la liste de la partie" 'curl -s $B/parties/$G1 | grep -q "color:#00f0ff"'
ok "Boutique : déséquiper" 'q $HOST -L -d slot=color $B/boutique/desequiper | grep -q "déséquipé" && [ "$(pj $HOST "d[\"equipe\"].get(\"color\")")" = None ]'
ok "Admin : octroi refusé aux non-admins" '[ "$(q lp2$R -o /dev/null -w %{http_code} -d "pseudo=lp2$R&amount=999" $B/admin/points)" = 403 ]'
ok "Admin : octroie 5000 LP puis achat légendaire" 'curl -s -b $A2 -L -d "pseudo=lp2$R&amount=5000&reason=Test" $B/admin/points | grep -q "+5000 LP" && q lp2$R -L -d item=banner_inferno $B/boutique/acheter | grep -q "Achat réussi" && [ "$(pj lp2$R "d[\"solde\"]")" = 2025 ]'
ok "LP : historique des points" 'q lp2$R $B/points | grep -q "Achat boutique : Inferno" && q lp2$R $B/points | grep -q "Défis"'
# ---------- Roue du jour ----------
mk rw1$R; mk rw2$R
ok "Roue : indicateur de tour gratuit dans la nav" 'q rw1$R $B/roue | grep -q "spin-dot"'
ok "Roue : page /roue avec probabilités (Jackpot 1 %)" 'curl -s $B/roue | grep -q "JACKPOT 1000 LP" && curl -s $B/roue | grep -q "Sub Twitch 1 mois"'
ok "Roue : tour gratuit (résultat serveur JSON, +100 LP au registre)" 'q rw1$R -H "Accept: application/json" -d force=lp100 $B/roue/tourner | grep -q "\"segment\":\"lp100\"" && pj rw1$R "d[\"historique\"]" | grep -q "Roue du jour : 100 LP"'
ok "Roue : tirage forcé ignoré hors NODE_ENV=test (production)" 'node test-roue-guard.js >/dev/null 2>&1'
# vider un éventuel tour bonus gagné, puis vérifier le refus
for i in 1 2 3 4 5; do q rw1$R -o /dev/null -d x=1 $B/roue/tourner; done
ok "Roue : 2e tour gratuit du jour refusé" 'q rw1$R -L -d x=1 $B/roue/tourner | grep -q "déjà utilisé ton tour gratuit"'
ok "Roue : nav sans indicateur une fois le tour utilisé" '! q rw1$R $B/roue | grep -q "spin-dot"'
ok "Roue : tour payant refusé sans points" 'q rw2$R -L -d x=1 $B/roue/payer | grep -q "un tour payant coûte 150 LP"'
curl -s -b $A2 -o /dev/null -d "pseudo=rw2$R&amount=1000" $B/admin/points
S1=$(pj rw2$R 'd["solde"]')
ok "Roue : tour payant débite 150 LP" 'q rw2$R -o /dev/null -d x=1 $B/roue/payer; pj rw2$R "d[\"historique\"]" | grep -q "tour payant" && [ "$(pj rw2$R "sum(h[\"montant\"] for h in d[\"historique\"] if h[\"motif\"]==\"Roue du jour : tour payant\")")" = -150 ]'
ok "Roue : max 3 tours payants par jour" 'q rw2$R -o /dev/null -d x=1 $B/roue/payer; q rw2$R -o /dev/null -d x=1 $B/roue/payer; q rw2$R -L -d x=1 $B/roue/payer | grep -q "Maximum 3 tours payants"'
ok "Admin : /admin/lots refusé aux non-admins (403)" '[ "$(q rw2$R -o /dev/null -w %{http_code} $B/admin/lots)" = 403 ]'
mk sub$R
ok "Roue : lot Sub Twitch (tirage forcé en mode test) → lot à réclamer" 'q sub$R -L -d force=sub $B/roue/tourner | grep -q "Lot à réclamer — l.admin te contacte"'
CID=$(q sub$R $B/roue | grep -o "/roue/lots/[0-9]*" | head -1 | grep -o "[0-9]*$")
ok "Roue : le gagnant saisit son pseudo Twitch" 'q sub$R -L -d twitch=Gagnant_$R $B/roue/lots/$CID | grep -q "Pseudo Twitch enregistré"'
ok "Admin : lot visible en attente sur /admin/lots" 'curl -s -b $A2 $B/admin/lots | grep -q "Gagnant_$R"'
ok "Admin : marque le lot livré → visible par le gagnant" 'curl -s -b $A2 -L -d x=1 $B/admin/lots/$CID/livrer | grep -q "marqué comme livré" && q sub$R $B/roue | grep -q "Lot livré"'
ok "Roue : gros gain affiché dans le fil" 'curl -s $B/roue | grep -q "Sub Twitch 1 mois</b>"'
# ---------- Sécurité ----------
H=$(command curl -s -D - -o /tmp/sec_home.html $B/)
ok "Sécu : CSP à nonce + frame-ancestors none + object-src none" 'echo "$H" | grep -i "^content-security-policy:" | grep -q "script-src .self. .nonce-" && echo "$H" | grep -i "^content-security-policy:" | grep -q "frame-ancestors .none." && echo "$H" | grep -qi "object-src .none."'
ok "Sécu : X-Frame-Options DENY, nosniff, Referrer-Policy, pas de X-Powered-By" 'echo "$H" | grep -qi "^x-frame-options: DENY" && echo "$H" | grep -qi "^x-content-type-options: nosniff" && echo "$H" | grep -qi "^referrer-policy: strict-origin-when-cross-origin" && ! echo "$H" | grep -qi "^x-powered-by"'
ok "Sécu : chaque <script> porte le nonce de la CSP, aucun attribut on*" 'N=$(echo "$H" | grep -io "nonce-[^'"'"']*" | head -1 | cut -c7-); [ -n "$N" ] && ! grep -o "<script[^>]*>" /tmp/sec_home.html | grep -vq "nonce=\"$N\"" && ! curl -s $B/tournois | grep -Eq " on(change|submit|click)="'
mk sec1$R; mk sec2$R
ok "Sécu : cookie de session HttpOnly + SameSite=Lax" 'command curl -s -D - -o /dev/null -d "pseudo=ck$R&email=ck$R@t.gg&password=MotDePasse1&platform=PC" -H "X-CSRF-Token: x" $B/inscription | grep -qi "403" || true; command curl -s -c /tmp/ck$R -D - -o /dev/null $B/api/csrf | grep -i "^set-cookie: lr.sid=" | grep -qi "httponly" && grep -q lr.sid /tmp/ck$R && command curl -s -D - -o /dev/null $B/api/csrf | grep -i "^set-cookie" | grep -qi "samesite=lax"'
ok "Sécu : CSRF — POST sans jeton refusé (403) sur la boutique" '[ "$(command curl -s -b /tmp/mm_sec1$R -o /dev/null -w %{http_code} -d item=badge_gg $B/boutique/acheter)" = 403 ]'
ok "Sécu : CSRF — jeton falsifié refusé sur la roue (403)" '[ "$(command curl -s -b /tmp/mm_sec1$R -o /dev/null -w %{http_code} -H "X-CSRF-Token: deadbeef" -d x=1 $B/roue/tourner)" = 403 ]'
ok "Sécu : CSRF — chat API JSON 403 sans jeton" 'command curl -s -b /tmp/mm_h$R -d message=csrf $B/api/parties/$CC/chat | grep -q "CSRF"'
ok "Sécu : CSRF — admin sans jeton refusé" '[ "$(command curl -s -b $A2 -o /dev/null -w %{http_code} -d "pseudo=sec1$R&amount=99999" $B/admin/points)" = 403 ]'
ok "Sécu : CSRF — formulaires rendus avec jeton _csrf" 'q sec1$R $B/boutique | grep -q "name=\"_csrf\" value=\"[0-9a-f]\{64\}\""'
ok "Sécu : connexion — même message compte existant / inexistant (pas d énumération)" '[ "$(q sec2$R -L -d "login=sec2$R&password=mauvais1" $B/connexion | grep -o "Identifiants incorrects")" = "$(q sec2$R -L -d "login=inexistant$R&password=mauvais1" $B/connexion | grep -o "Identifiants incorrects")" ]'
LK=/tmp/lk$R; for i in 1 2 3 4 5; do curl -s -c $LK -b $LK -o /dev/null -d "login=sec1$R&password=faux$i" $B/connexion; done
ok "Sécu : verrouillage après 5 échecs (même avec le bon mot de passe)" 'curl -s -c $LK -b $LK -L -d "login=sec1$R&password=MotDePasse1" $B/connexion | grep -q "Trop de tentatives"'
ok "Sécu : limite de débit inscription (6e compte même IP → 429)" 'for i in 1 2 3 4 5 6; do T=/tmp/rl$R$i; command curl -s -c $T -b $T -o /dev/null -H "X-Forwarded-For: 10.250.250.$((R%200))" $B/api/csrf; TK=$(command curl -s -c $T -b $T -H "X-Forwarded-For: 10.250.250.$((R%200))" $B/api/csrf | sed "s/.*\"csrf\":\"\([0-9a-f]*\)\".*/\1/"); C=$(command curl -s -c $T -b $T -o /dev/null -w %{http_code} -H "X-Forwarded-For: 10.250.250.$((R%200))" -H "X-CSRF-Token: $TK" -d "pseudo=rl$i$R&email=rl$i$R@t.gg&password=MotDePasse1&platform=PC" $B/inscription); done; [ "$C" = 429 ]'
ok "Sécu : open redirect refusé après connexion (next=//evil.com)" '[ "$(q sec2$R -o /dev/null -w %{redirect_url} -d "login=sec2$R&password=MotDePasse1&next=//evil.com" $B/connexion)" = "$B/profil" ] && [ "$(q sec2$R -o /dev/null -w %{redirect_url} -d "login=sec2$R&password=MotDePasse1&next=/\\evil.com" $B/connexion)" = "$B/profil" ]'
ok "Sécu : XSS — pseudo avec balises refusé à l inscription" 'curl -s -c /tmp/x$R -b /tmp/x$R -L --data-urlencode "pseudo=<img src=x>" -d "email=x$R@t.gg&password=MotDePasse1&platform=PC" $B/inscription | grep -q "Pseudo invalide"'
TV=$(mkT "XSS Cup $RANDOM" "game=Call+of+Duty&platform=PC&format=equipe&team_size=2&max_slots=8&start_date=$(D '+10 days')&reg_close=$(D '+8 days')")
q sec2$R -o /dev/null --data-urlencode "team_name=<script>alert(9)</script>" --data-urlencode "mates=<img src=x onerror=alert(8)>" -d rules=on $B/tournois/$TV/inscription
ok "Sécu : XSS — nom d équipe et coéquipier échappés" 'P2=$(curl -s $B/tournois/$TV); echo "$P2" | grep -q "&lt;script&gt;alert(9)" && ! echo "$P2" | grep -q "<script>alert(9)" && ! echo "$P2" | grep -q "<img src=x"'
ok "Sécu : XSS — pseudo Twitch avec balises refusé" 'q sub$R -L --data-urlencode "twitch=<b>x</b>" $B/roue/lots/$CID | grep -q "Pseudo Twitch invalide"'
ok "Sécu : IDOR — impossible de modifier le lot d un autre joueur" 'q sec2$R -L -d twitch=Pirate_$R $B/roue/lots/$CID | grep -q "Lot introuvable" && ! curl -s -b $A2 $B/admin/lots | grep -q "Pirate_$R"'
ok "Sécu : IDOR — non-admin refusé sur actions admin (lots, bracket, match, points)" '[ "$(q sec2$R -o /dev/null -w %{http_code} -d x=1 $B/admin/lots/$CID/livrer)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} -d x=1 $B/admin/tournois/$TC/bracket)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} -d winner=x $B/admin/tournois/$TC/match/1)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} -d "pseudo=sec2$R&amount=5" $B/admin/points)" = 403 ]'
ok "Sécu : IDOR — non-membre ne peut ni lancer ni déclarer une partie" 'q sec2$R -L -d winner=1 $B/parties/$CC/resultat | grep -q "Seul l" && [ "$(api $CC "d[\"statut\"]")" = attente ]'
ok "Sécu : corps de requête trop volumineux → 413" '[ "$(q sec2$R -o /dev/null -w %{http_code} --data-urlencode "message=$(head -c 40000 /dev/zero | tr "\0" a)" $B/api/parties/$CC/chat)" = 413 ]'
ok "Sécu : 404 générique sans pile d appel" 'P3=$(curl -s $B/nexiste/pas); echo "$P3" | grep -q "Page introuvable" && ! echo "$P3" | grep -q "at "'
ok "Sécu : /api/tournois n expose pas created_by" '! curl -s $B/api/tournois | grep -q created_by'
# Anti-farm : la même paire en partie privée ne rapporte des LP que 2 fois par jour
mk fa$R; mk fb$R
farm(){ local C=$(q fa$R -o /dev/null -w %{redirect_url} -d "gm=Call of Duty|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$"); q fb$R -o /dev/null -d code=$C $B/parties/rejoindre; local T=$(api $C '[p["equipe"] for p in d["joueurs"] if p["pseudo"]=="fa'$R'"][0]'); q fa$R -o /dev/null -d winner=$T $B/parties/$C/resultat; }
farm; farm; FW=$(pj fa$R 'sum(h["montant"] for h in d["historique"] if h["motif"]=="Victoire (partie privée)")'); farm
ok "Anti-farm : 3e victoire privée contre le même adversaire sans LP" '[ "$FW" = 200 ] && [ "$(pj fa$R "sum(h[\"montant\"] for h in d[\"historique\"] if h[\"motif\"]==\"Victoire (partie privée)\")")" = 200 ]'
# Export admin des données (page + JSON + CSV + API Bearer)
EX=/tmp/ex$R.json; curl -s -b $A2 -D /tmp/exh$R -o $EX $B/admin/export/liveroums-export.json
ok "Export : page /admin/export accessible à l admin, mention des scores dans l agent" 'curl -s -b $A2 $B/admin/export | grep -q "scores de suspicion sont dans le tableau de bord anti-triche"'
ok "Export : lien Export visible pour l admin (nav + profil), absent pour un joueur" 'curl -s -b $A2 $B/profil | grep -c "href=\"/admin/export\"" | grep -q 2 && ! q sec2$R $B/profil | grep -q "/admin/export"'
ok "Export : joueur non admin → 403 (page, JSON, CSV)" '[ "$(q sec2$R -o /dev/null -w %{http_code} $B/admin/export)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} $B/admin/export/liveroums-export.json)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} $B/admin/export/joueurs.csv)" = 403 ]'
ok "Export : déconnecté → redirection vers /connexion" '[ "$(command curl -s -o /dev/null -w %{http_code} $B/admin/export/liveroums-export.json)" = 303 ] && command curl -s -o /dev/null -w %{redirect_url} $B/admin/export | grep -q "/connexion"'
ok "Export : JSON en pièce jointe, sans cache" 'grep -qi "^content-disposition: attachment; filename=\"liveroums-export-" /tmp/exh$R && grep -qi "^cache-control: no-store" /tmp/exh$R && grep -qi "^content-type: application/json" /tmp/exh$R'
ok "Export : JSON au format de l agent (players/matches + points, tournois, quatuors, lots)" 'python3 -c "import json,sys;d=json.load(open(\"$EX\"));assert {\"players\",\"matches\",\"points\",\"tournaments\",\"quatuors\",\"claims\"}<=d.keys();p=d[\"players\"][0];assert {\"id\",\"pseudo\",\"created_at\",\"member_since\",\"sr\",\"wins\",\"losses\",\"lp_balance\",\"linked\",\"discord_id_hash\",\"email\"}<=p.keys();assert \"T\" in p[\"created_at\"];m=[m for m in d[\"matches\"] if m[\"status\"]==\"termine\"][0];assert {\"code\",\"kind\",\"host\",\"started_at\",\"ended_at\",\"winner_team\",\"players\"}<=m.keys();assert {\"pseudo\",\"team\",\"sr_before\",\"sr_after\"}<=m[\"players\"][0].keys();assert d[\"points\"] and d[\"tournaments\"] and d[\"quatuors\"] and d[\"claims\"]"'
ok "Export : aucun hash de mot de passe ni donnée de session" '! grep -Eq "password|\\\$2[aby]\\\$|lr\.sid|\"sess\"" $EX && ! curl -s -b $A2 $B/admin/export/joueurs.csv | grep -Eq "password|\\\$2[aby]\\\$"'
ok "Export : CSV par jeu de données (en-têtes attendus, pièce jointe)" 'for d in "joueurs:id,pseudo,platform,created_at" "comptes_lies:pseudo,provider,account_id" "parties:code,kind" "participations:code,kind,status,winner_team,host,started_at,ended_at,pseudo,team,sr_before,sr_after" "points:id,pseudo,amount,reason" "tournois:id,name" "quatuors:id,code,leader" "lots:id,pseudo,prize,status"; do curl -s -b $A2 -D /tmp/csvh$R $B/admin/export/${d%%:*}.csv | head -1 | grep -q "${d#*:}" || { echo "  KO $d"; exit 1; }; grep -qi "attachment" /tmp/csvh$R || exit 1; done'
ok "Export : filtre since (futur → aucune partie, joueurs conservés) et since invalide → 400" 'python3 -c "import json,sys;d=json.load(sys.stdin);assert d[\"matches\"]==[] and d[\"points\"]==[] and d[\"players\"]" < <(curl -s -b $A2 "$B/admin/export/liveroums-export.json?since=2099-01-01") && [ "$(curl -s -b $A2 -o /dev/null -w %{http_code} "$B/admin/export/joueurs.csv?since=pasunedate")" = 400 ]'
ok "Export API : désactivée (404) sans ANTICHEAT_EXPORT_TOKEN" '[ "$(command curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer x" $B/api/admin/anticheat-export)" = 404 ]'
# Page admin Anti-triche (iframe de l'agent)
ok "Anti-triche : lien 🛡️ admin seulement (nav + profil), absent pour un joueur et déconnecté" 'curl -s -b $A2 $B/profil | grep -c "href=\"/admin/anti-triche\"" | grep -q 2 && ! q sec2$R $B/profil | grep -q "/admin/anti-triche" && ! command curl -s $B/ | grep -q "/admin/anti-triche"'
ok "Anti-triche : joueur → 403, déconnecté → redirection /connexion" '[ "$(q sec2$R -o /dev/null -w %{http_code} $B/admin/anti-triche)" = 403 ] && [ "$(command curl -s -o /dev/null -w %{http_code} $B/admin/anti-triche)" = 303 ] && command curl -s -o /dev/null -w %{redirect_url} $B/admin/anti-triche | grep -q "/connexion"'
ok "Anti-triche : CSP frame-src autorise uniquement l agent, frame-ancestors du site inchangé" 'command curl -s -D - -o /dev/null $B/ | grep -i "^content-security-policy" | grep -q "frame-src .self. https://liveroums-anticheat.onrender.com;.*frame-ancestors .none."'
# Vérification d'email : expiration, renvoi limité, validation admin, blocage au niveau session
SQL(){ node -e "const D=require(\"better-sqlite3\");const d=new D(\"/tmp/lp-test.db\");d.pragma(\"busy_timeout = 3000\");console.log(JSON.stringify(d.prepare(process.argv[1]).run()))" "$1" >/dev/null; }
EV=/tmp/ev$R; rm -f $EV; curl -s -c $EV -b $EV -o /dev/null -d "pseudo=ev$R&email=ev$R@t.gg&password=MotDePasse1&platform=PC" $B/inscription
ELK=$(vlink ev$R@t.gg); SQL "UPDATE email_tokens SET expires_at=1 WHERE user_id=(SELECT id FROM users WHERE pseudo='ev$R')"
ok "Vérif email : lien expiré (24 h) refusé, compte toujours inactif" 'curl -s -c $EV -b $EV "$B$ELK" | grep -q "Lien invalide ou expiré" && curl -s -c $EV -b $EV -L -d "login=ev$R&password=MotDePasse1" $B/connexion | grep -q "pas encore vérifié"'
ok "Vérif email : non vérifié → actions bloquées (file, roue, boutique, tournoi)" '[ "$(curl -s -b $EV -o /dev/null -w %{http_code} -d "gm=Call of Duty|1v1" $B/matchmaking/rejoindre)" = 303 ] && [ "$(curl -s -b $EV -o /dev/null -w %{redirect_url} -d x=1 $B/roue/tourner | grep -c connexion)" = 1 ] && [ "$(curl -s -b $EV -o /dev/null -w %{redirect_url} -d item=badge_gg $B/boutique/acheter | grep -c connexion)" = 1 ] && [ "$(curl -s -b $EV -o /dev/null -w %{redirect_url} -d rules=on $B/tournois/$TC/inscription | grep -c connexion)" = 1 ]'
ok "Vérif email : renvoi limité (1 mail/min par compte, 5 demandes/15 min par IP → 429)" 'N0=$(grep -c "ev$R@t.gg" $OUTBOX); RL=/tmp/rv$R; for i in 1 2 3 4 5 6; do C=$(curl -s -c $RL -b $RL -o /dev/null -w %{http_code} -d "email=ev$R@t.gg" $B/renvoyer-verification); done; [ "$C" = 429 ] && [ "$(grep -c "ev$R@t.gg" $OUTBOX)" = $((N0+1)) ]'
ok "Vérif email : renvoi sans jeton CSRF refusé (403)" '[ "$(command curl -s -o /dev/null -w %{http_code} -d "email=ev$R@t.gg" $B/renvoyer-verification)" = 403 ]'
ok "Vérif email : admin valide manuellement le compte, qui peut alors se connecter" 'EID=$(curl -s -b $A2 $B/admin/verifications | grep -o "/admin/utilisateurs/[0-9]*/verifier" | head -1); curl -s -b $A2 $B/admin/verifications | grep -q "ev$R" && curl -s -b $A2 -o /dev/null -d x=1 "$B$(curl -s -b $A2 $B/admin/verifications | grep -B3 "ev$R" | grep -o "/admin/utilisateurs/[0-9]*/verifier" | head -1)" && [ "$(curl -s -c $EV -b $EV -o /dev/null -w %{redirect_url} -d "login=ev$R&password=MotDePasse1" $B/connexion)" = "$B/profil" ]'
ok "Vérif email : page admin des vérifications refusée aux joueurs" '[ "$(q sec2$R -o /dev/null -w %{http_code} $B/admin/verifications)" = 403 ] && [ "$(q sec2$R -o /dev/null -w %{http_code} -d x=1 $B/admin/utilisateurs/1/verifier)" = 403 ]'
SQL "UPDATE users SET email_verified=0 WHERE pseudo='ev$R'"
ok "Vérif email : session existante coupée si le compte n est plus vérifié" '[ "$(curl -s -c $EV -b $EV -o /dev/null -w %{http_code} $B/profil)" = 303 ]'
ok "Vérif email : compte admin existant toujours connectable" '[ "$(command curl -s -o /dev/null -w %{redirect_url} -c /tmp/adm$R -b /tmp/adm$R -H "X-CSRF-Token: $(command curl -s -c /tmp/adm$R -b /tmp/adm$R $B/api/csrf | sed "s/.*\"csrf\":\"\([0-9a-f]*\)\".*/\1/")" -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion)" = "$B/profil" ]'
echo "Résultat : $P réussis, $F échoués"
