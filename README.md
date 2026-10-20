# ⚡ LiveRoums Arena

Plateforme de tournois esport 100 % gaming (inspirée de Toornament, Battlefy, start.gg, FACEIT).
Node.js + Express + SQLite (better-sqlite3), mots de passe hachés avec bcrypt, sessions express-session.

## Démarrage
```bash
npm install
npm run seed     # (ré)initialise la base avec les données d'exemple
npm start        # http://localhost:3000  (PORT=xxxx pour changer)
```
Variable conseillée en production : `SESSION_SECRET`.

**Comptes d'exemple**
- Admin : `admin@liveroums.gg` / `Admin123!`

Le site est **100 % Call of Duty** : un seul jeu (tournois, classé 4v4 solo/duo, parties rapides 4v4/2v2/1v1, parties privées). Seul le compte admin est créé au démarrage (mot de passe remplaçable via `ADMIN_PASSWORD`).

## Fonctionnalités
- **Accueil** : hero, tournois à la une, modes Call of Duty.
- **/tournois** : recherche + filtres plateforme, format (solo/équipe), statut.
- **/tournois/:id** : règlement, cashprize, dates, places, liste des inscrits, bracket.
- **Comptes** : inscription (pseudo, email, mot de passe, plateforme, ID de jeu), connexion, déconnexion.
- **Inscription tournoi** : solo, ou équipe (création d'équipe + coéquipiers). Capacité maximale et double inscription bloquées (transaction + contrainte UNIQUE).
- **Profil** : tournois inscrits, désinscription (tant que le bracket n'est pas lancé).
- **Admin** : création de tournoi (`/admin/tournois/nouveau`), génération/régénération du bracket, saisie des vainqueurs (✔) avec progression automatique.
- **Bracket** : élimination directe générée automatiquement à la clôture des inscriptions (byes gérés).
- API lecture : `GET /api/tournois`.

## Tests
`./test-e2e.sh` (serveur lancé avec `NODE_ENV=test WHEEL_TEST_FORCE=1`, base fraîche, `BASE_URL` optionnel) : 126 tests curl de bout en bout ; `node --test test-discord-oauth.js`. `python3 screenshots.py` : captures Playwright dans `screenshots/`.

## Structure
`server.js` (routes) · `db.js` (schéma + seed) · `bracket.js` (bracket) · `views.js` (gabarits HTML) · `public/style.css`

## Skill rating (SR)
- SR par joueur (Call of Duty), système Elo (départ 1000, K=32, moyenne d'équipe pour le calcul) mis à jour après chaque match de tournoi (solo : joueur ; équipe : capitaine) et chaque partie de matchmaking.
- Rangs : Bronze (<900) → Argent (900) → Or (1050) → Platine (1200) → Diamant (1350) → Maître (1500) → Légende (1700+), affichés en badge à côté des pseudos.
- Classement : `/classement`. Profil public : `/joueurs/<pseudo>`.

## Comptes liés
- **Steam** : vraie connexion OpenID 2.0 (`/auth/steam` → steamcommunity.com → `/auth/steam/retour`, signature vérifiée par `check_authentication`, SteamID64 extrait). Aucune clé API nécessaire, mais Steam doit pouvoir rediriger le navigateur vers une **URL publique** : définir `PUBLIC_URL=https://mon-domaine.fr` (en local `localhost` fonctionne côté navigateur mais le `realm` affiché sera localhost).
- **Activision ID, PlayStation Network, Xbox Live, Battle.net** : saisie manuelle de l'ID, marquée « non vérifié ». Une vérification réelle demande les API partenaires officielles (PSN/Xbox : programmes partenaires fermés ; Activision, Battle.net : OAuth avec application approuvée et clés client).

## Matchmaking & parties
- `/matchmaking` : files Call of Duty par mode (4v4, 2v2, 1v1) + file classée 4v4 (solo ou duo, 2 max). Dès que 2×N joueurs attendent, une partie est créée avec un **code à 6 caractères**, équipes équilibrées par SR (tri décroissant + affectation à l'équipe la plus faible). L'hôte est le premier joueur en file.
- Fin de partie (hôte ou admin déclare l'équipe gagnante) : SR mis à jour, les joueurs d'une partie publique sont remis **en fin de file**, et les joueurs en attente sont immédiatement placés dans une nouvelle partie.
- Partie privée : création avec code, « Rejoindre avec un code », démarrage automatique quand elle est complète (ou « Lancer maintenant » par l'hôte).
- Mises à jour en direct par polling toutes les 3 s (`/api/matchmaking`, `/api/parties/<code>`), redirection automatique vers la partie trouvée.

Captures : `python3 screenshots-sr.py`.
