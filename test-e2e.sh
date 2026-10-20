#!/bin/bash
# Test de bout en bout : inscription, connexion, inscription tournoi, doublon, capacité, désinscription
B=http://localhost:3000; J=$(mktemp); P=0; F=0
ok(){ if eval "$2"; then echo "✅ $1"; P=$((P+1)); else echo "❌ $1"; F=$((F+1)); fi; }
U=testeur$RANDOM
c(){ curl -s -b $J -c $J "$@"; }
ok "Accueil 200" '[ "$(curl -s -o /dev/null -w %{http_code} $B/)" = 200 ]'
ok "Création de compte → /profil" '[ "$(c -o /dev/null -w %{redirect_url} -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC&game_id=$U%231" $B/inscription)" = "$B/profil" ]'
ok "Profil affiche le pseudo" 'c $B/profil | grep -q "$U"'
ok "Compte en double refusé" 'c -L -d "pseudo=$U&email=$U@test.gg&password=MotDePasse1&platform=PC" $B/inscription | grep -q "déjà utilisé"'
c -X POST $B/deconnexion -o /dev/null
ok "Mauvais mot de passe refusé" 'c -L -d "login=$U&password=faux" $B/connexion | grep -q "Identifiants incorrects"'
ok "Connexion OK" '[ "$(c -o /dev/null -w %{redirect_url} -d "login=$U@test.gg&password=MotDePasse1" $B/connexion)" = "$B/profil" ]'
ok "Inscription solo EA FC (#4)" 'c -L -d rules=on $B/tournois/4/inscription | grep -q "Inscription confirmée"'
ok "Double inscription refusée" 'c -L -d rules=on $B/tournois/4/inscription | grep -q "déjà inscrit"'
ok "Inscription équipe Valorant (#1)" 'c -L -d "rules=on&team_name=Team_$U&mates=A&mates=B&mates=C&mates=D" $B/tournois/1/inscription | grep -q "Team_$U"'
ok "Équipe incomplète refusée (Rocket League #3)" 'c -L -d "rules=on&team_name=X$U" $B/tournois/3/inscription | grep -q "exactement 1"'
ok "Inscription refusée sur tournoi clos (CS2 #6)" 'c -L -d rules=on $B/tournois/6/inscription | grep -q "fermées"'
ok "Profil liste 2 tournois" 'c $B/profil | grep -q "Mes tournois (2)"'
# Remplir EA FC (8 places) avec d'autres comptes, puis vérifier le refus
for i in 1 2 3; do K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=f$i$U&email=f$i$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription; curl -s -c $K -b $K -o /dev/null -d rules=on $B/tournois/4/inscription; done
K=$(mktemp); curl -s -c $K -b $K -o /dev/null -d "pseudo=x$U&email=x$U@t.gg&password=MotDePasse1&platform=PC" $B/inscription
ok "Capacité : 9e joueur refusé (complet)" 'curl -s -c $K -b $K -L -d rules=on $B/tournois/4/inscription | grep -q "complet"'
ok "Désinscription EA FC" 'c -L -d x=1 $B/tournois/4/desinscription | grep -q "désinscrit"'
ok "Profil liste 1 tournoi" 'c $B/profil | grep -q "Mes tournois (1)"'
ok "Non-admin refusé sur création" '[ "$(c -o /dev/null -w %{http_code} $B/admin/tournois/nouveau)" = 403 ]'
A=$(mktemp); curl -s -c $A -b $A -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
ok "Admin crée un tournoi" 'curl -s -c $A -b $A -L -d "name=Test+Cup&game=CS2&platform=PC&format=solo&max_slots=4&cashprize=50&start_date=2030-01-02T20:00&reg_close=2030-01-01T20:00" $B/admin/tournois | grep -q "Tournoi publié"'
ok "Admin génère bracket EA FC" 'curl -s -c $A -b $A -L -d x=1 $B/admin/tournois/4/bracket | grep -q "Demi-finales"'
ok "Bracket auto CS2 (clôturé) affiché" 'curl -s $B/tournois/6 | grep -q "Finale"'
ok "Filtre jeu=Valorant" '[ "$(curl -s "$B/tournois?jeu=Valorant" | grep -o "class=\"card\"" | wc -l)" = 1 ]'
ok "Filtre format=solo&statut=en_cours" 'curl -s "$B/tournois?format=solo&statut=en_cours" | grep -q "CS2 Open"'

# ---------- SR, comptes liés, matchmaking ----------
js(){ curl -s "$B/api/joueurs/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2"; }
mk(){ local j=/tmp/mm_$1; rm -f $j; curl -s -c $j -b $j -o /dev/null -d "pseudo=$1&email=$1@t.gg&password=MotDePasse1&platform=PC" $B/inscription; }
R=$RANDOM; for n in 1 2 3 4 5; do mk q$n$R; done
q(){ curl -s -c /tmp/mm_$1 -b /tmp/mm_$1 "${@:2}"; }
ok "Classement 200 + rangs" 'curl -s "$B/classement?jeu=CS2" | grep -q "Légende\|Maître\|Diamant"'
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
ok "SR mis à jour (gagnant ↑)" '[ "$(js $HOST "d[\"ratings\"][\"Fortnite\"]")" -gt "$SR0" ]'
G2=$(js q3$R 'd["lobby"]')
ok "Fin de partie → joueur en attente tiré dans une nouvelle partie" '[ ${#G2} = 6 ] && [ "$G2" != "$G1" ] && curl -s $B/api/parties/$G2 | grep -q "en_cours"'
CODE=$(q q4$R -o /dev/null -w %{redirect_url} -d "gm=Rocket League|1v1" $B/parties | grep -o "[A-Z0-9]\{6\}$")
ok "Partie privée créée avec code" '[ ${#CODE} = 6 ] && curl -s $B/api/parties/$CODE | grep -q "\"statut\":\"attente\""'
ok "Code invalide refusé" 'q q5$R -L -d code=ZZZZZZ $B/parties/rejoindre | grep -q "introuvable"'
ok "Rejoindre par code → partie complète démarrée" '[ "$(q q5$R -o /dev/null -w %{redirect_url} -d code=${CODE,,} $B/parties/rejoindre)" = "$B/parties/$CODE" ] && curl -s $B/api/parties/$CODE | grep -q "en_cours"'
ok "Lobby d'exemple DEMO42 affiché" 'curl -s $B/parties/DEMO42 | grep -q "DEMO42"'
A2=$(mktemp); curl -s -c $A2 -b $A2 -o /dev/null -d "login=admin@liveroums.gg&password=Admin123!" $B/connexion
M1=$(curl -s -b $A2 $B/tournois/6 | grep -o "/admin/tournois/6/match/[0-9]*" | head -1); W=$(curl -s -b $A2 $B/tournois/6 | grep -o "action=\"$M1\"><input type=\"hidden\" name=\"winner\" value=\"[^\"]*\"" | head -1 | sed 's/.*value="//;s/"$//')
SRW=$(js $W 'd["ratings"]["CS2"]'); curl -s -b $A2 -o /dev/null -d "winner=$W" $B$M1
ok "Match de tournoi → SR du vainqueur mis à jour" '[ "$(js $W "d[\"ratings\"][\"CS2\"]")" -gt "$SRW" ]'
echo "Résultat : $P réussis, $F échoués"
