# ContractOS

MVP d’acquisition et de préparation d’offres pour un prime contractor de services janitorial/facilities. Implémentation du brief `ContractOS_Developer_Project_Brief_v1.docx`, centrée sur des données vérifiées, des preuves sourcées et les décisions humaines.

Périmètre confirmé : opportunités publiques et dossiers commerciaux ordinaires. **Aucune homologation CUI, CMMC, DFARS ou FedRAMP n’est revendiquée.** Les contrôles techniques ne remplacent pas une analyse juridique de chaque marché.

## Fonctionnalités

- Application Next.js : Command Center propriétaire/VA et portail prestataire.
- Supabase Auth : confirmation d’e-mail, TOTP et MFA obligatoire en base pour les utilisateurs internes.
- PostgreSQL : isolation par organisation et prestataire, écritures uniquement par RPC contrôlées, audit des décisions et actions matérielles.
- Catalogue public commun SAM.gov, filtres enregistrés par organisation et sélection en dossiers privés ; saisie manuelle/Maryland et brief IA non vérifié.
- Documents : bucket privé, limite 10 Mo, PDF/PNG/JPEG contrôlés, quarantaine et scan antivirus obligatoires par défaut, téléchargements en pièce jointe, stockage append-only, vérification et révocation par le propriétaire.
- RFP : extraction PDF texte en processus limité, analyse OpenAI explicitement autorisée, sorties structurées et extraits ancrés dans les pages. Aucun document prestataire n’est envoyé à l’IA.
- Matrice de conformité : distinction obligatoire/informatif, document/page/extrait, preuve et validation humaine. Les amendements rouvrent les exigences obligatoires et invalident les validations.
- Prestataires : invitations liées à l’e-mail, inscription confirmée, W-9/assurance/licence, disponibilité, capacité, matching explicable et tarifs issus de devis vérifiés.
- Prix : unités, coûts complémentaires justifiés et majoration, calcul en cents entiers et arrondi conservateur.
- Offres : brouillon JSON traçable, export, préparation humaine du PDF final, quatre validations et contrôle spécifique de la sous-traitance/set-aside.
- Soumission : blocage sur preuves manquantes/expirées/révoquées, échéance passée, prix/brouillon/package/approbations obsolètes. Autorisation liée au PDF exact ; consignation du reçu après dépôt humain sur le portail officiel.
- Agent de collecte SAM.gov LangChain/LangGraph : outils bornés, pagination, validation et ingestion dédupliquée ; exécution manuelle ou planifiée sans n8n.

Les sections finales, formulaires, signatures et dépôt officiel restent humains. L’OCR des scans, l’ingestion automatique Maryland, les communications externes, DocuSign et les opérations post-attribution (contrats, work orders, QC et facturation) sont des étapes ultérieures : voir [périmètre et critères](docs/acceptance.md). Aucun connecteur non implémenté n’est présenté comme fonctionnel.

## Démarrage cloud/local

Node.js 24, npm et Docker sont nécessaires pour la pile locale complète. Chaque tâche cloud est déjà isolée : utilisez le checkout `/workspace/ContractOS`, sans créer de worktree sauf demande explicite.

```bash
cd /workspace/ContractOS
npm ci --ignore-scripts --cache /workspace/.npm-cache
npm run local:setup
npm run dev
```

`local:setup` démarre une pile légère avec PostgreSQL 17 et les vrais services Supabase Auth (GoTrue), PostgREST et Storage. Les images officielles sont épinglées par digest ; les services internes sont isolés et seuls la passerelle API et Mailpit publient des ports sur loopback. Ce choix évite l’image PostgreSQL Supabase complète, trop volumineuse avec le pilote Docker `vfs` de cet environnement.

Le script génère des mots de passe distincts pour les services et des clés **strictement locales** dans `.env.docker.local` / `.env.local`, ignorés par Git et protégés par les permissions du fichier. Il préserve ces bindings, applique seulement les migrations en attente et ne réinitialise pas les données. Un `.env.local` utilisateur non géré n’est pas remplacé. Aucun compte applicatif privilégié ni mot de passe utilisateur par défaut n’est ajouté.

ClamAV et ses définitions signées récentes doivent être installés séparément à `/usr/bin/clamscan` pour utiliser des documents comme preuves. Sans scanner, les fichiers restent en attente : la politique obligatoire par défaut ne permet pas de les vérifier. Les tests synthétiques qui assouplissent cette politique ne valident pas l’antivirus lui-même.

Le Mailpit local reçoit les confirmations d’inscription. Ne transférez jamais ces services ou clés de développement dans un déploiement public. `supabase/config.toml` fournit aussi une configuration optionnelle pour les outils Supabase usuels ; les projets hébergés ont leur propre configuration Auth et leurs propres secrets.

Sans Docker ou Supabase, l’accueil et la notice de configuration restent disponibles, et les tests PostgreSQL embarqués fonctionnent. Les parcours connectés exigent Auth et Storage : un écran rendu ne suffit pas à déclarer le déploiement prêt.

## Premier propriétaire

1. Créez le compte via le formulaire d’inscription et confirmez son adresse. L’inscription ne donne aucun droit interne.
2. Un administrateur de base de confiance exécute [bootstrap.sql](supabase/bootstrap.sql) après avoir remplacé l’identifiant de l’utilisateur par son UUID vérifié dans Supabase Auth. Ne créez pas de rôle depuis les métadonnées d’inscription.
3. Reconnectez-vous, activez TOTP puis entrez le code. Le JWT `aal2` est exigé par les politiques/fonctions en base, y compris via des appels API directs.
4. Provisionnez les VA par la même procédure administrative avec `role='va'`.

## Vérification

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
# Avec la pile locale et Chromium installé :
npm run test:browser
```

Les tests PostgreSQL utilisent PGlite, un moteur PostgreSQL réel ; seules les interfaces `auth` et `storage` de Supabase sont reproduites. Les tests navigateur utilisent la vraie pile Supabase locale et des comptes temporaires confirmés, enrôlent TOTP, testent l’application et les téléchargements privés, puis nettoient leurs propres fixtures. Ils refusent une URL Supabase distante. Les scénarios et limites sont décrits dans [tests et acceptation](docs/acceptance.md).

## Configuration externe

Copiez `.env.example` vers un fichier local ignoré si vous utilisez un projet hébergé ; pour la production, utilisez le gestionnaire de secrets du déploiement. Ne transmettez aucune valeur secrète dans un ticket ou dans le chat.

| Variable                               | Usage                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | URL du projet Supabase distinct pour cet environnement                                                           |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clé publique publishable/anon ; la RLS reste obligatoire                                                         |
| `APP_ORIGIN`                           | Origine exacte de l’application ; HTTPS en production                                                            |
| `SUPABASE_SERVICE_ROLE_KEY`            | Serveur seulement, nécessaire au scan antivirus et à SAM ; contourne la RLS, ne jamais exposer au navigateur     |
| `INTEGRATION_TOKEN`                    | Jeton serveur aléatoire d’au moins 32 octets encodés base64url pour l’endpoint serveur ; jamais une clé publique |
| `SAM_GOV_API_KEY`                      | Clé SAM.gov côté serveur pour les opportunités                                                                   |
| `CONTRACTOS_OPENAI_API_KEY`            | Clé OpenAI côté serveur, facultative pour les saisies/extractions manuelles                                      |
| `CONTRACTOS_OPENAI_MODEL`              | Modèle compatible avec les sorties JSON structurées ; défaut `gpt-4.1-mini`                                      |

Le préfixe `CONTRACTOS_` évite les noms `OPENAI_*` réservés par la plateforme cloud. Les valeurs secrètes sont à saisir dans les paramètres sécurisés, jamais dans le chat.

Destinations réseau : domaine exact du projet Supabase, `api.sam.gov`, `api.openai.com`, et registres npm/Docker/GitHub nécessaires au développement. Aucun URL fourni par un utilisateur ou par un document n’est téléchargé par le serveur.

Pour le déploiement, la rétention, les sauvegardes, le chiffrement, les limites de charge et l’analyse de risque : [déploiement](docs/deployment.md), [sécurité](docs/security.md), [architecture](docs/architecture.md). Les intégrations SAM/OpenAI doivent être testées avec les identifiants de votre environnement avant activation ; les tests locaux n’établissent pas leur bon fonctionnement en production.

## Agent SAM avec LangChain

Après configuration serveur de `SAM_GOV_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` :

```bash
npm run agent:sam -- --check-config
npm run agent:sam
```

L’agent LangGraph orchestre recherche officielle via un outil LangChain, validation des données et persistance RPC dans le catalogue commun. Il utilise des règles déterministes, sans LLM pour la collecte ; les textes SAM ne deviennent jamais des instructions. Aucun téléchargement de pièces jointes ou dépôt d’offre n’est autorisé. Les clés sont conservées hors état du graphe et les traces externes doivent être désactivées.

Chaque exécution couvre les sept derniers jours, NAICS 561720, au plus cinq pages de 100 résultats et 55 secondes. `paginationRequired=true` et le code de sortie CLI 2 signalent une fenêtre incomplète : ne pas considérer la collecte exhaustive. Les avis sans échéance exploitable sont comptés dans `skipped`. Une relance repart de la première page ; les écritures déjà réussies sont dédupliquées en base. Pas de checkpoint durable, de file de tâches ou de planificateur intégré à ce stade. Un ordonnanceur externe peut lancer cette commande sans chevauchement ; n8n n’est plus nécessaire. L’endpoint authentifié existant appelle le même agent.

Les autres fonctions IA et métier ne sont pas encore converties en agents LangChain autonomes. Le test SAM réel nécessite une clé et reste à effectuer avant activation.

## Catalogue partagé et dossiers privés

La collecte centrale n’utilise plus `INGEST_ORGANIZATION_ID` : cette ancienne variable peut être retirée. Appliquez la migration `202610120009_shared_catalog.sql` dans Supabase (ou relancez `npm run local:setup` pour Docker local). Lancez ensuite `npm run agent:sam`.

Dans le Command Center, ouvrez **Catalogue SAM.gov**, filtrez par métier, zone, NAICS et set-aside, puis enregistrez les critères de votre organisation. **Créer mon dossier privé** copie l’annonce dans votre espace ; les documents, notes, prestataires, prix et validations restent isolés. Une annonce déjà sélectionnée ouvre son dossier existant.

Les changements du catalogue invalident les validations des dossiers ouverts liés. L’actualisation est explicite : elle remplace les métadonnées source du dossier et impose une nouvelle revue des exigences. Les dossiers soumis/clos restent historiques. Les anciens dossiers SAM ne sont jamais exportés vers le catalogue ; leur liaison se fait seulement lors d’une sélection de la même annonce officielle. Le catalogue ne contient que les métadonnées de l’API publique, est lisible par les membres internes avec MFA, et n’est pas exposé aux prestataires ou visiteurs anonymes.
