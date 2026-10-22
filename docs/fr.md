# Huum pour Gladys

Cette intégration affiche dans Gladys un **poêle de sauna Huum avec son
boîtier UKU Wi-Fi**, par le cloud Huum (le compte de l'application Huum).
**Jamais testé avec un vrai appareil.** Sans lien avec Huum.

> **Sécurité.** Un sauna chauffe très fort. Ne lancez jamais la chauffe à
> distance sans vous assurer que personne n'est dedans et que rien ne repose
> sur le poêle. L'allumage depuis Gladys est **désactivé par défaut** et
> refusé porte ouverte ; l'extinction fonctionne toujours.

## Ce que vous obtenez

Un sauna dans l'onglet Découverte, avec :

- **En chauffe** (oui/non, en lecture seule) et le **statut** en texte (« En
  chauffe », « En ligne, à l'arrêt », « Hors ligne », « Utilisé par un autre
  compte (verrouillé) », « Arrêt d'urgence »), le code de statut, boîtier en
  ligne ;
- **porte** (capteur d'ouverture : ouverte/fermée) ;
- **température** mesurée et **consigne** ;
- **temps de chauffe restant** (minutes), calculé depuis la fin de séance
  prévue par Huum ;
- la **lumière** (lecture seule), si votre sauna en signale une ;
- deux boutons : **Allumer (chauffer)** et **Éteindre**.

Aucun interrupteur : un « tout allumer » de Google Home, Alexa, HomeKit, MCP
ou d'une scène ne peut jamais lancer le sauna.

## Configuration

1. Dans Gladys, ouvrez l'intégration Huum et saisissez l'**adresse e-mail**
   et le **mot de passe** de votre compte Huum (ceux de l'application).
2. Enregistrez, puis ajoutez le sauna depuis l'onglet **Découverte**.
3. Si vous voulez lancer la chauffe depuis Gladys, activez **Autoriser le
   chauffage depuis Gladys**, et réglez la **consigne du bouton « Allumer »**
   (80 °C par défaut) et la **consigne la plus haute** (90 °C par défaut,
   110 °C au plus, la limite du boîtier).

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement au cloud Huum (sauna.huum.eu, en HTTPS, authentification HTTP
Basic). Il n'est jamais écrit dans les journaux ni dans `/data`.

Le sauna est lu toutes les 60 s (réglable de 60 s à 1 h), **jamais plus
souvent**, même après un redémarrage de l'intégration, une reconnexion à
Gladys, le bouton « Tester la connexion » ou un scan de la Découverte.

L'appareil est rattaché au **compte** Huum : l'API ne donne aucun identifiant
propre au sauna (un compte, un sauna). Changer d'adresse e-mail crée donc un
nouvel appareil ; l'ancien est montré injoignable.

## Les commandes

- **Éteindre** fonctionne toujours : même si le chauffage depuis Gladys est
  désactivé, pendant une pause demandée par Huum, après des identifiants
  refusés, ou juste après un redémarrage, avant la première lecture. Elle est
  toujours envoyée (jamais « déjà éteint »), annule une commande de chauffe
  pas encore partie, est renvoyée après une chauffe encore en route, et
  réaffirmée (deux fois au plus) si le sauna se remet à chauffer dans les deux
  minutes.
- **Allumer (chauffer)** et la **consigne** sont refusés tant que
  « Autoriser le chauffage depuis Gladys » est désactivé. Activés, ils
  relisent d'abord le sauna (jamais l'état en mémoire) et refusent si la
  porte est ouverte ou inconnue, si le sauna ne peut pas chauffer (hors
  ligne, verrouillé par un autre compte, arrêt d'urgence, statut inconnu), si
  une extinction a été demandée entre-temps, ou si la commande ne peut pas
  partir dans les 3,5 s. Une seule à la fois, jamais renvoyée.
- **Allumer** demande la consigne du bouton « Allumer », jamais au-dessus de
  la consigne la plus haute. Déjà en chauffe : rien n'est envoyé.
- **La consigne** ne se change que pendant la chauffe (chez Huum, une
  nouvelle consigne est envoyée comme un nouvel allumage). Un nombre entier
  de 40 °C à la consigne la plus haute.
- Une commande n'est confirmée que si la réponse de Huum montre le sauna en
  chauffe à la température demandée (ou à l'arrêt pour l'extinction). Sinon :
  « Envoyée, sans confirmation », et l'intégration relit le sauna 10 s et
  40 s après.

## Quand ça ne va pas

- **Identifiants refusés** (HTTP 401 ou 403) : l'intégration s'arrête et ne
  les réessaie **jamais** d'elle-même (rien en boucle). Corrigez-les et
  enregistrez, ou, s'ils sont justes, utilisez « Tester la connexion » : ce
  bouton fait une seule lecture, et l'arrêt n'est levé que si elle réussit.
  L'arrêt survit à un redémarrage ; seule une empreinte salée des
  identifiants refusés est gardée dans `/data`, effacée au premier succès.
- **429** (Huum demande de ralentir) : pause d'1 min à 6 h (Retry-After),
  gardée dans `/data`. **5xx** : pause gardée dans `/data`. Erreur réseau :
  nouvel essai après 1, 2, 5 puis 15 min, jamais plus vite que l'intervalle.
- Une commande de chauffe refusée par Huum (401, 403) ne bloque pas les
  lectures.

## Limites

- API non documentée publiquement (Huum l'a fournie aux auteurs de la
  bibliothèque pyhuum). Elle peut changer.
- Pas encore de commande de lumière (une bascule : à faire avec une garde),
  ni d'humidité (vapeur), ni de minuterie de séance.
- Un seul sauna par compte.

## Données

`/data/huum-state.json` contient seulement : la fin d'une pause, l'arrêt sur
identifiants refusés (avec l'empreinte salée de ces identifiants), l'heure de
la dernière lecture. Ni adresse e-mail ni mot de passe.

Basée sur la bibliothèque Python huum (MIT, frwickst/pyhuum), portée en
JavaScript : voir `THIRD_PARTY_NOTICES.md`.
