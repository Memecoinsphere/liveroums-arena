#!/bin/bash
# Test de bout en bout : inscription, connexion, inscription tournoi, doublon, capacité, désinscription
# Démarrer le serveur avec NODE_ENV=test WHEEL_TEST_FORCE=1 (tirage forcé de la Roue, test uniquement) ; BASE_URL optionnel. Lancer depuis la racine du dépôt.
B=${BASE_URL:-http://localhost:3000}; J=$(mktemp); P=0; F=0
ok(){ if eval "$2"; then echo "✅ $1"; P=$((P+1)); else echo "❌ $1"; F=$((F+1)); fi; }
U=testeur$RANDOM
c(){ curl -s -b $J -c $J "$@"; }
# Base vierge : vérification des états vides, puis l'admin crée les tournois utilisés par les tests
ok "Liste tournois vide (état vide)" 'curl -s $B/tournois | grep -q "Aucun tournoi pour le moment"'
ok "Accueil : 0 tournoi" 'curl -s $B/ | grep -q "<b>0</b><span>tournois"'
ok "Classement vide (état vide)" 'curl -s "$B/classement?jeu=Valorant" | grep -q "Aucun joueur classé"'
A=$(mktemp); curl -s -c $A -b $A -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
D(){ date -d "$1" +%Y-%m-%dT%H:%M; }
mkT(){ curl -s -c $A -b $A -o /dev/null -w %{redirect_url} --data-urlencode "name=$1" -d "$2" $B/admin/tournois | grep -o "[0-9]*$"; }
TE=$(mkT "Valorant Cup $RANDOM" "game=Valorant&platform=PC&format=equipe&team_size=5&max_slots=16&start_date=$(D '+10 days')&reg_close=$(D '+8 days')")
TR=$(mkT "RL Duo $RANDOM" "game=Rocket+League&platform=Multiplateforme&format=equipe&team_size=2&max_slots=16&start_date=$(D '+5 days')&reg_close=$(D '+4 days')")
TF=$(mkT "EA FC League $RANDOM" "game=EA+FC&platform=PlayStation&format=solo&max_slots=8&start_date=$(D '+3 days')&reg_close=$(D '+2 days')")
TC=$(mkT "CS2 Open $RANDOM" "game=CS2&platform=PC&format=solo&max_slots=8&start_date=$(D '+1 day')&reg_close=$(D '+12 hours')")
TX=$(mkT "Fortnite Clos $RANDOM" "game=Fortnite&platform=PC&format=solo&max_slots=8&start_date=$(D '+1 day')&reg_close=$(D '-1 day')")
ok "Admin crée les tournois de test" '[ -n "$TE" ] && [ -n "$TR" ] && [ -n "$TF" ] && [ -n "$TC" ] && [ -n "$TX" ]'
# 4 joueurs inscrits au CS2 puis bracket généré par l'admin
for i in 1 2 3 4; do K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=c$i$U&email=c$i$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; curl -s -c $K -b $K -o /dev/null -d rules=on $B/tournois/$TC/inscription; done
curl -s -c $A -b $A -o /dev/null -d x=1 $B/admin/tournois/$TC/bracket
ok "Accueil 200" '[ "$(curl -s -o /dev/null -w %{http_code} $B/)" = 200 ]'
ok "Création de compte → /profil" '[ "$(c -o /dev/null -w %{redirect_url} -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC&game_id=$U%231" $B/inscription)" = "$B/profil" ]'
ok "Profil affiche le pseudo" 'c $B/profil | grep -q "$U"'
ok "Compte en double refusé" 'c -L -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC" $B/inscription | grep -q "déjà utilisé"'
c -X POST $B/deconnexion -o /dev/null
ok "Mauvais mot de passe refusé" 'c -L -d "login=$U&password=faux" $B/connexion | grep -q "Identifiants incorrects"'
ok "Connexion OK" '[ "$(c -o /dev/null -w %{redirect_url} -d "login=$U@test.gg&password=MotDePasse1" $B/connexion)" = "$B/profil" ]'
ok "Inscription solo EA FC " 'c -L -d rules=on $B/tournois/$TF/inscription | grep -q "Inscription confirmée"'
ok "Double inscription refusée" 'c -L -d rules=on $B/tournois/$TF/inscription | grep -q "déjà inscrit"'
ok "Inscription équipe Valorant" 'c -L -d "rules=on&team_name=Team_$U&mates=A&mates=B&mates=C&mates=D" $B/tournois/$TE/inscription | grep -q "Team_$U"'
ok "Équipe incomplète refusée (Rocket League)" 'c -L -d "rules=on&team_name=X$U" $B/tournois/$TR/inscription | grep -q "exactement 1"'
ok "Inscription refusée sur tournoi clos" 'c -L -d rules=on $B/tournois/$TX/inscription | grep -q "fermées"'
ok "Profil liste 2 tournois" 'c $B/profil | grep -q "Mes tournois (2)"'
# Remplir EA FC (8 places) avec d'autres comptes, puis vérifier le refus
for i in 1 2 3 4 5 6 7; do K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=f$i$U&email=f$i$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; curl -s -c $K -b $K -o /dev/null -d rules=on $B/tournois/$TF/inscription; done
K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=x$U&email=x$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription
ok "Capacité : 9e joueur refusé (complet)" 'curl -s -c $K -b $K -L -d rules=on $B/tournois/$TF/inscription | grep -q "complet"'
ok "Désinscription EA FC" 'c -L -d x=1 $B/tournois/$TF/desinscription | grep -q "désinscrit"'
ok "Profil liste 1 tournoi" 'c $B/profil | grep -q "Mes tournois (1)"'
ok "Non-admin refusé sur création" '[ "$(c -o /dev/null -w %{http_code} $B/admin/tournois/nouveau)" = 403 ]'
ok "Admin crée un tournoi" 'curl -s -c $A -b $A -L -d "name=Test+Cup&game=CS2&platform=PC&format=solo&max_slots=4&cashprize=50&start_date=2030-01-02T20:00&reg_close=2030-01-01T20:00" $B/admin/tournois | grep -q "Tournoi publié"'
ok "Admin génère bracket EA FC" 'curl -s -c $A -b $A -L -d x=1 $B/admin/tournois/$TF/bracket | grep -q "Demi-finales"'
ok "Bracket CS2 affiché" 'curl -s $B/tournois/$TC | grep -q "Finale"'
ok "Filtre jeu=Valorant" '[ "$(curl -s "$B/tournois?jeu=Valorant" | grep -o "class=\"card\"" | wc -l)" = 1 ]'
ok "Filtre format=solo&statut=en_cours" 'curl -s "$B/tournois?format=solo&statut=en_cours" | grep -q "CS2 Open"'

# ---------- SR, comptes liés, matchmaking ----------
js(){ curl -s "$B/api/joueurs/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
mk(){ local j=/tmp/mm_$1; rm -f $j; curl -s -c $j -b $j -o /dev/null -d "pseudo=$1&email=$1@t.gg&password=MotDePasse1&platform=PC" $B/inscription; }
R=$RANDOM; for n in 1 2 3 4 5; do mk q$n$R; done
q(){ curl -s -c /tmp/mm_$1 -b /tmp/mm_$1 "${@:2}"; }
ok "Classement vide au départ (état vide)" 'curl -s "$B/classement?jeu=Valorant" | grep -q "Aucun joueur classé"'
ok "Lier un compte Riot (non vérifié)" 'c -L -d "provider=riot&account_id=Test%23EUW" $B/profil/comptes | grep -q "non vérifié"'
ok "Comptes liés visibles sur profil public" 'curl -s $B/joueurs/$U | grep -q "Test#EUW"'
ok "Steam OpenID redirige vers steamcommunity" 'c -o /dev/null -w %{redirect_url} $B/auth/steam | grep -q "steamcommunity.com/openid/login.*checkid_setup"'
ok "Retour Steam falsifié refusé" 'c -L "$B/auth/steam/retour?openid.mode=id_res&openid.claimed_id=x" | grep -q "Liaison Steam échouée"'
q q1$R -o /dev/null -d "gm=Fortnite|1v1" $B/matchmaking/rejoindre
ok "File : 1 joueur en attente, pas de partie" '[ "$(js q1$R "d[\"lobby\"]")" = None ] && [ "$(js q1$R "d[\"queue\"][\"mode\"]")" = 1v1 ]'
q q2$R -o /dev/null -d "gm=Fortnite|1v1" $B/matchmaking/rejoindre
G1=$(js q1$R 'd["lobby"]')
ok "File → partie auto créée (code 6 car.)" '[ ${#G1} = 6 ] && [ "$(js q2$R "d[\"lobby\"]")" = "$G1" ]'
ok "Équipes formées (1 par équipe)" 'curl -s $B/api/parties/$G1 | grep -q "\"equipe\":1" && curl -s $B/api/parties/$G1 | grep -q "\"equipe\":2"'
q q3$R -o /dev/null -d "gm=Fortnite|1v1" $B/matchmaking/rejoindre
ok "3e joueur en attente" '[ "$(js q3$R "d[\"lobby\"]")" = None ]'
HOST=$(curl -s $B/api/parties/$G1 | python3 -c "import sys,json;print([p['pseudo'] for p in json.load(sys.stdin)['joueurs'] if p['equipe']==1][0])")
SR0=$(js $HOST 'd["ratings"].get("Fortnite",1000)')
# l'hôte (premier en file = q1) déclare la victoire de l'équipe 1
q q1$R -o /dev/null -d winner=1 $B/parties/$G1/resultat
ok "Non-hôte ne peut pas déclarer" 'q q3$R -L -d winner=1 $B/parties/$G1/resultat | grep -q "Seul l"'
ok "Partie terminée" 'curl -s $B/api/parties/$G1 | grep -q "\"statut\":\"termine\""'
ok "Partie rapide : SR inchangé (non classée)" '[ "$(js $HOST "d[\"ratings\"].get(\"Fortnite\",1000)")" = "$SR0" ]'
G2=$(js q3$R 'd["lobby"]')
ok "Fin de partie → joueur en attente tiré dans une nouvelle partie" '[ ${#G2} = 6 ] && [ "$G2" != "$G1" ] && curl -s $B/api/parties/$G2 | grep -q "en_cours"'
CODE=$(q q4$R -o /dev/null -w %{redirect_url} -d "gm=Rocket League|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$")
ok "Partie privée créée avec code" '[ ${#CODE} = 6 ] && curl -s $B/api/parties/$CODE | grep -q "\"statut\":\"attente\""'
ok "Code invalide refusé" 'q q5$R -L -d code=ZZZZZZ $B/parties/rejoindre | grep -q "introuvable"'
ok "Rejoindre par code → partie complète démarrée" '[ "$(q q5$R -o /dev/null -w %{redirect_url} -d code=${CODE,,} $B/parties/rejoindre)" = "$B/parties/$CODE" ] && curl -s $B/api/parties/$CODE | grep -q "en_cours"'
A2=$(mktemp); curl -s -c $A2 -b $A2 -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
M1=$(curl -s -b $A2 $B/tournois/$TC | grep -o "/admin/tournois/$TC/match/[0-9]*" | head -1); W=$(curl -s -b $A2 $B/tournois/$TC | grep -o "action=\"$M1\"><input type=\"hidden\" name=\"winner\" value=\"[^\"]*\"" | head -1 | sed 's/.*value="//;s/"$//')
SRW=$(js $W 'd["ratings"].get("CS2",1000)'); curl -s -b $A2 -o /dev/null -d "winner=$W" $B$M1
ok "Match de tournoi → SR du vainqueur mis à jour" '[ "$(js $W "d[\"ratings\"][\"CS2\"]")" -gt "$SRW" ]'
# ---------- Chat de pré-partie ----------
mk h$R; mk o$R
CC=$(q h$R -o /dev/null -w %{redirect_url} -d "gm=Valorant|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$")
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
for n in r1 r2 r3 d1 d2 d3 s1 s2 s3 s4; do mk $n$R; done
api(){ curl -s $B/api/parties/$1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
q r1$R -o /dev/null -d game=Fortnite $B/classe/rejoindre
ok "Classé : 1 joueur solo en file, pas de partie" '[ "$(js r1$R "d[\"ranked_queue\"]")" = Fortnite ] && [ "$(js r1$R "d[\"lobby\"]")" = None ]'
q r2$R -o /dev/null -d game=Fortnite $B/classe/rejoindre
RK=$(js r1$R 'd["lobby"]')
ok "Classé solo : partie 1v1 créée, badge Classé" '[ ${#RK} = 6 ] && [ "$(js r2$R "d[\"lobby\"]")" = "$RK" ] && [ "$(api $RK "d[\"classe\"]")" = True ] && curl -s $B/parties/$RK | grep -q "🏆 Classé"'
ok "Classé : page de partie avec chat de pré-partie" 'q r1$R $B/parties/$RK | grep -q "Chat de pré-partie"'
RW=$(api $RK '[p["pseudo"] for p in d["joueurs"] if p["equipe"]==1][0]'); RL=$(api $RK '[p["pseudo"] for p in d["joueurs"] if p["equipe"]==2][0]')
q r1$R -o /dev/null -d winner=1 $B/parties/$RK/resultat
ok "Classé : le résultat modifie le SR (gagnant ↑, perdant ↓)" '[ "$(js $RW "d[\"ratings\"][\"Fortnite\"]")" -gt 1000 ] && [ "$(js $RL "d[\"ratings\"][\"Fortnite\"]")" -lt 1000 ]'
ok "Classement Fortnite liste le joueur classé" 'curl -s "$B/classement?jeu=Fortnite" | grep -q "$RW"'
ok "Duo refusé en jeu 1v1 (Fortnite)" 'q r3$R -L -d game=Fortnite $B/classe/duo | grep -q "Duo impossible"'
ok "Matchmaking : duo non autorisé affiché pour les jeux 1v1" 'curl -s $B/matchmaking | grep -q "Duo non autorisé (1v1)"'
DC=$(q d1$R -L -d "game=Rocket League" $B/classe/duo | grep -o "code [A-Z0-9]\{5\}" | head -1 | cut -c6-)
ok "Duo créé avec code (5 car.)" '[ ${#DC} = 5 ]'
q d1$R -o /dev/null -d pseudo=d2$R $B/classe/duo/inviter
DID=$(q d2$R $B/matchmaking | grep -o "name=\"id\" value=\"[0-9]*\"" | grep -o "[0-9]*")
ok "Invitation duo reçue et acceptée" 'q d2$R -L -d id=$DID $B/classe/duo/accepter | grep -q "Duo rejoint"'
ok "Duo de 3 refusé (2 max)" 'q d3$R -L -d code=$DC $B/classe/duo/rejoindre | grep -q "Duo complet"'
q d1$R -o /dev/null -d "game=Rocket League" $B/classe/rejoindre
for n in s1 s2 s3 s4; do q $n$R -o /dev/null -d "game=Rocket League" $B/classe/rejoindre; done
DL=$(js d1$R 'd["lobby"]')
ok "Duo classé : partie 3v3 créée, duo dans la même équipe" '[ ${#DL} = 6 ] && [ "$(api $DL "d[\"classe\"]")" = True ] && [ "$(api $DL "len(d[\"joueurs\"])")" = 6 ] && [ "$(api $DL "[p[\"equipe\"] for p in d[\"joueurs\"] if p[\"pseudo\"]==\"d1$R\"][0]")" = "$(api $DL "[p[\"equipe\"] for p in d[\"joueurs\"] if p[\"pseudo\"]==\"d2$R\"][0]")" ]'
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
echo "Résultat : $P réussis, $F échoués"
