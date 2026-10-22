// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and status names, the status of
// the integration, the answers of the button and the command errors. None of
// them ever carries the e-mail address or the password of the Huum account.
// -----------------------------------------------------------------------------

import { FEATURES, STATUS } from './constants.js';

export const both = (en, fr) => ({ en, fr });
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Huum sauna', 'Sauna Huum');

export const FEATURE_NAMES = {
  [FEATURES.HEATING]: both('Heating', 'En chauffe'),
  [FEATURES.STATUS]: both('Status', 'Statut'),
  [FEATURES.STATUS_CODE]: both('Status code', 'Code de statut'),
  [FEATURES.ONLINE]: both('Controller online', 'Boîtier en ligne'),
  [FEATURES.DOOR]: both('Door', 'Porte'),
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.TARGET]: both('Setpoint', 'Consigne'),
  [FEATURES.REMAINING]: both('Heating time left', 'Temps de chauffe restant'),
  [FEATURES.LIGHT]: both('Light', 'Lumière'),
  [FEATURES.HEAT_ON]: both('Turn on (heat)', 'Allumer (chauffer)'),
  [FEATURES.HEAT_OFF]: both('Turn off', 'Éteindre'),
};

export const STATUS_NAMES = {
  [STATUS.OFFLINE]: both('Offline', 'Hors ligne'),
  [STATUS.HEATING]: both('Heating', 'En chauffe'),
  [STATUS.IDLE]: both('Online, not heating', 'En ligne, à l’arrêt'),
  [STATUS.LOCKED]: both(
    'In use by another user (locked)',
    'Utilisé par un autre compte (verrouillé)',
  ),
  [STATUS.EMERGENCY_STOP]: both('Emergency stop', 'Arrêt d’urgence'),
};

/** The name of a status code, "Unknown status (code)" for one not listed. */
export const statusText = (code) =>
  STATUS_NAMES[code] ?? both(`Unknown status (${code})`, `Statut inconnu (${code})`);

const LINK = both('then use “Test the connection”.', 'puis utilisez « Tester la connexion ».');

/** Statuses of the integration (configuration screen). */
export const T = {
  noCredentials: both(
    'Enter the e-mail address and the password of your Huum account.',
    'Saisissez l’adresse e-mail et le mot de passe de votre compte Huum.',
  ),
  badUser: both(
    'The e-mail address is not valid (no “:” and no control character).',
    'L’adresse e-mail n’est pas valide (pas de « : » ni de caractère de contrôle).',
  ),
  badSecret: both(
    'The password is not valid (too long, or a control character).',
    'Le mot de passe n’est pas valide (trop long, ou un caractère de contrôle).',
  ),
  connecting: both('Connecting to the Huum cloud…', 'Connexion au cloud Huum…'),
  waiting: (wait) =>
    both(`Next read of the sauna in ${wait.en}.`, `Prochaine lecture du sauna dans ${wait.fr}.`),
  connected: (summary) => both(`Connected: ${summary.en}.`, `Connecté : ${summary.fr}.`),
  lastRead: (when) => both(`Last read ${when.en} ago.`, `Dernière lecture il y a ${when.fr}.`),
  rateLimited: (wait) =>
    both(
      `Huum asks to slow down (429): next read in ${wait.en}. Turning off still works.`,
      `Huum demande de ralentir (429) : prochaine lecture dans ${wait.fr}. L’extinction fonctionne toujours.`,
    ),
  serverError: (wait) =>
    both(
      `The Huum cloud fails (5xx): next read in ${wait.en}. Turning off still works.`,
      `Le cloud Huum est en panne (5xx) : prochaine lecture dans ${wait.fr}. L’extinction fonctionne toujours.`,
    ),
  unreachable: (reason, wait) =>
    both(
      `The Huum cloud does not answer (${reason}): next try in ${wait.en}.`,
      `Le cloud Huum ne répond pas (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  refused: (status) =>
    join(
      both(
        `Huum refused the e-mail address or the password (HTTP ${status}): stopped, never tried again by itself. Fix them and save,`,
        `Huum a refusé l’adresse e-mail ou le mot de passe (HTTP ${status}) : arrêt, jamais réessayé seul. Corrigez-les et enregistrez,`,
      ),
      both(`or, if they are right, ${LINK.en}`, `ou, s’ils sont justes, ${LINK.fr}`),
    ),
  stillRefused: both('Still refused: the stop stays.', 'Toujours refusé : l’arrêt est maintenu.'),
  summary: (sauna) => {
    const status = statusText(sauna.code);
    const temp =
      sauna.temperature === undefined
        ? both('', '')
        : both(`, ${sauna.temperature} °C`, `, ${sauna.temperature} °C`);
    return both(`${status.en}${temp.en}`, `${status.fr}${temp.fr}`);
  },
};

/** Refusals of the commands (shown by Gladys when the ack fails). */
export const ERRORS = {
  readOnly: both('This feature cannot be set.', 'Cette fonctionnalité ne peut pas être commandée.'),
  badButton: both('A button only takes 1.', 'Un bouton ne prend que 1.'),
  badSetpoint: (min, max) =>
    both(
      `The setpoint must be a whole number from ${min} to ${max} °C (“Highest setpoint”).`,
      `La consigne doit être un nombre entier de ${min} à ${max} °C (« Consigne la plus haute »).`,
    ),
  heatingDisabled: both(
    'Heating from Gladys is off: turn on “Allow heating from Gladys” in the configuration. Turning off always works.',
    'Le chauffage depuis Gladys est désactivé : activez « Autoriser le chauffage depuis Gladys » dans la configuration. L’extinction fonctionne toujours.',
  ),
  unknownDevice: both(
    'This sauna is not the one of the Huum account configured.',
    'Ce sauna n’est pas celui du compte Huum configuré.',
  ),
  noConfig: both(
    'No Huum account configured: nothing sent.',
    'Aucun compte Huum configuré : rien envoyé.',
  ),
  paused: (wait) =>
    both(
      `Huum asked to slow down (429): refused for ${wait.en}, nothing sent.`,
      `Huum a demandé de ralentir (429) : refusé pendant ${wait.fr}, rien envoyé.`,
    ),
  serverPaused: (wait) =>
    both(
      `The Huum cloud fails (5xx): refused for ${wait.en}, nothing sent.`,
      `Le cloud Huum est en panne (5xx) : refusé pendant ${wait.fr}, rien envoyé.`,
    ),
  blocked: both(
    'Huum refused the credentials: nothing sent.',
    'Huum a refusé les identifiants : rien envoyé.',
  ),
  stopMeanwhile: both(
    'A turn off was asked meanwhile: nothing sent.',
    'Une extinction a été demandée entre-temps : rien envoyé.',
  ),
  stopPending: both(
    'A turn off is in flight or not confirmed yet: heating refused, nothing sent.',
    'Une extinction est en cours ou pas encore confirmée : chauffe refusée, rien envoyé.',
  ),
  justStopped: both(
    'A turn off was just asked: setpoint refused for 2 min, nothing sent.',
    'Une extinction vient d’être demandée : consigne refusée pendant 2 min, rien envoyé.',
  ),
  sessionEnding: both(
    'The session ends in less than 2 min: setpoint refused (it would start heating again), nothing sent.',
    'La séance se termine dans moins de 2 min : consigne refusée (elle relancerait la chauffe), rien envoyé.',
  ),
  relaunched: (time) =>
    both(
      `Setpoint applied, but Huum started a new session, until ${time} UTC.`,
      `Consigne appliquée, mais Huum a relancé une séance, jusqu’à ${time} UTC.`,
    ),
  busy: both(
    'Another heating command is in progress: nothing sent.',
    'Une autre commande de chauffe est en cours : rien envoyé.',
  ),
  inProgress: both(
    'The previous heating command is not confirmed yet: nothing sent, try again in a minute.',
    'La commande de chauffe précédente n’est pas encore confirmée : rien envoyé, réessayez dans une minute.',
  ),
  tooSlow: both(
    'Huum did not answer in time: nothing sent.',
    'Huum n’a pas répondu à temps : rien envoyé.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the sauna could not be read (${reason}): nothing sent.`,
      `L’état du sauna n’a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  missing: both(
    'The state of the sauna is incomplete (status, door or setpoint missing): nothing sent.',
    'L’état du sauna est incomplet (statut, porte ou consigne manquant) : rien envoyé.',
  ),
  doorOpen: both(
    'The sauna door is open: heating refused, nothing sent.',
    'La porte du sauna est ouverte : chauffe refusée, rien envoyé.',
  ),
  cannotStart: (status) =>
    both(
      `The sauna cannot heat now (${status.en}): nothing sent.`,
      `Le sauna ne peut pas chauffer maintenant (${status.fr}) : rien envoyé.`,
    ),
  notHeating: both(
    'The sauna is not heating: the setpoint is only changed while it heats (the “Turn on” button uses the setpoint of the configuration). Nothing sent.',
    'Le sauna ne chauffe pas : la consigne ne se change que pendant la chauffe (le bouton « Allumer » utilise la consigne de la configuration). Rien envoyé.',
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Non envoyée (${reason}).`),
  refused: (reason) =>
    both(`Huum refused the command (${reason}).`, `Huum a refusé la commande (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): check the sauna.`,
      `Envoyée, sans confirmation (${reason}) : vérifiez le sauna.`,
    ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
  answered: (status) => both(`the sauna answers: ${status.en}`, `le sauna répond : ${status.fr}`),
};
