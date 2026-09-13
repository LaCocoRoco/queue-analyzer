// lib/i18n.ts
//
// Lightweight, hand-rolled i18n -- no framework needed for a handful of
// strings on a single page. Locale is detected from the browser
// (navigator.languages), never chosen by the user explicitly: this is a
// personal tool with no account/profile to store a preference in anyway.
// Covers the WoW client's own EU locales (the same languages Blizzard
// itself ships EU realms in) plus English.

export type Locale = "en" | "de" | "fr" | "es" | "it" | "ru";

export const LOCALES: Locale[] = ["en", "de", "fr", "es", "it", "ru"];
export const DEFAULT_LOCALE: Locale = "en";

export interface Dict {
  onboardingHeading: string;
  introInstruction: string; // text before the "warcraftlogs.com/api/clients" link
  introStore: string;
  clientIdPlaceholder: string;
  clientSecretPlaceholder: string;
  saveButton: string;
  savingButton: string;
  validationEmptyError: string;
  logoutButton: string;
  buttonIdle: string;
  buttonLoading: string;
  buttonDone: string;
  buttonErrorRetry: string;
  buttonWrongVersion: string;
  errorClipboardUnavailable: string;
  errorNoNames: string;
  noValidEntries: string;
  configIncomplete: string;
  wrongAddonVersion: string;
  apiKeyInvalid: string;
}

const en: Dict = {
  onboardingHeading: "WarcraftLogs Credentials",
  introInstruction: "Create your own API client at",
  introStore:
    "Then enter your Client ID and Client Secret below. Both are stored locally in your browser only and sent only to this application, never to a third-party server.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Save",
  savingButton: "Checking...",
  validationEmptyError: "Please enter Client ID and Secret.",
  logoutButton: "Logout",
  buttonIdle: "Import from Clipboard",
  buttonLoading: "Analyze...",
  buttonDone: "Saved to Clipboard",
  buttonErrorRetry: "Error",
  buttonWrongVersion: "Update Add-on!",
  errorClipboardUnavailable: "Clipboard access unavailable (needs HTTPS or localhost).",
  errorNoNames: "Clipboard contains no names.",
  noValidEntries: 'No valid "Name-Realm" entries found.',
  configIncomplete: "Configuration incomplete: WCL zone ID/partition not set.",
  wrongAddonVersion: "This webapp expects a different addon version. Please update the addon.",
  apiKeyInvalid: "Your API key has expired or is invalid. Please re-enter it.",
};

const de: Dict = {
  onboardingHeading: "WarcraftLogs Zugangsdaten",
  introInstruction: "Erstelle deinen eigenen API-Client auf",
  introStore:
    "Gib deine Client ID und Client Secret ein. Sie werden ausschließlich lokal in deinem Browser gespeichert.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Speichern",
  savingButton: "Prüfe...",
  validationEmptyError: "Bitte Client ID und Secret eingeben.",
  logoutButton: "Ausloggen",
  buttonIdle: "Aus Zwischenablage importieren",
  buttonLoading: "Analysiere...",
  buttonDone: "In Zwischenablage gespeichert",
  buttonErrorRetry: "Fehler",
  buttonWrongVersion: "Addon aktualisieren!",
  errorClipboardUnavailable: "Zwischenablage-Zugriff nicht verfügbar (braucht HTTPS oder localhost).",
  errorNoNames: "Zwischenablage enthält keine Namen.",
  noValidEntries: 'Keine gültigen "Name-Realm"-Einträge gefunden.',
  configIncomplete: "Konfiguration unvollständig: WCL Zone-ID/Partition nicht gesetzt.",
  wrongAddonVersion: "Diese Webapp erwartet eine andere Addon-Version. Bitte Addon aktualisieren.",
  apiKeyInvalid: "Dein API-Schlüssel ist abgelaufen oder ungültig. Bitte neu eingeben.",
};

const fr: Dict = {
  onboardingHeading: "Identifiants WarcraftLogs",
  introInstruction: "Crée ton propre client API sur",
  introStore:
    "Saisis ensuite ton Client ID et ton Client Secret ci-dessous. Les deux sont stockés uniquement en local dans ton navigateur et envoyés uniquement à cette application, jamais à un serveur tiers.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Enregistrer",
  savingButton: "Vérification...",
  validationEmptyError: "Merci de saisir le Client ID et le Secret.",
  logoutButton: "Déconnexion",
  buttonIdle: "Importer du presse-papiers",
  buttonLoading: "Analyse...",
  buttonDone: "Enregistré dans le presse-papiers",
  buttonErrorRetry: "Erreur",
  buttonWrongVersion: "Mettre à jour l'addon !",
  errorClipboardUnavailable: "Accès au presse-papiers indisponible (HTTPS ou localhost requis).",
  errorNoNames: "Le presse-papiers ne contient aucun nom.",
  noValidEntries: 'Aucune entrée "Nom-Royaume" valide trouvée.',
  configIncomplete: "Configuration incomplète : Zone ID/Partition WCL non définies.",
  wrongAddonVersion: "Cette application attend une version différente de l'addon. Merci de mettre à jour l'addon.",
  apiKeyInvalid: "Ta clé API a expiré ou est invalide. Merci de la ressaisir.",
};

const es: Dict = {
  onboardingHeading: "Credenciales de WarcraftLogs",
  introInstruction: "Crea tu propio cliente API en",
  introStore:
    "Introduce a continuación tu Client ID y Client Secret. Ambos se guardan solo localmente en tu navegador y se envían únicamente a esta aplicación, nunca a un servidor externo.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Guardar",
  savingButton: "Comprobando...",
  validationEmptyError: "Introduce el Client ID y el Secret.",
  logoutButton: "Cerrar sesión",
  buttonIdle: "Importar del portapapeles",
  buttonLoading: "Analizando...",
  buttonDone: "Guardado en el portapapeles",
  buttonErrorRetry: "Error",
  buttonWrongVersion: "¡Actualiza el addon!",
  errorClipboardUnavailable: "Acceso al portapapeles no disponible (requiere HTTPS o localhost).",
  errorNoNames: "El portapapeles no contiene nombres.",
  noValidEntries: 'No se encontraron entradas "Nombre-Reino" válidas.',
  configIncomplete: "Configuración incompleta: Zone ID/Partition de WCL no definidos.",
  wrongAddonVersion: "Esta aplicación espera una versión diferente del addon. Actualiza el addon.",
  apiKeyInvalid: "Tu clave API ha caducado o no es válida. Vuelve a introducirla.",
};

const it: Dict = {
  onboardingHeading: "Credenziali WarcraftLogs",
  introInstruction: "Crea il tuo client API su",
  introStore:
    "Inserisci poi il tuo Client ID e Client Secret qui sotto. Entrambi vengono salvati solo localmente nel tuo browser e inviati solo a questa applicazione, mai a un server terzo.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Salva",
  savingButton: "Verifica...",
  validationEmptyError: "Inserisci Client ID e Secret.",
  logoutButton: "Disconnetti",
  buttonIdle: "Importa dagli appunti",
  buttonLoading: "Analisi...",
  buttonDone: "Salvato negli appunti",
  buttonErrorRetry: "Errore",
  buttonWrongVersion: "Aggiorna l'addon!",
  errorClipboardUnavailable: "Accesso agli appunti non disponibile (richiede HTTPS o localhost).",
  errorNoNames: "Gli appunti non contengono nomi.",
  noValidEntries: 'Nessuna voce "Nome-Reame" valida trovata.',
  configIncomplete: "Configurazione incompleta: Zone ID/Partition WCL non impostati.",
  wrongAddonVersion: "Questa app si aspetta una versione diversa dell'addon. Aggiorna l'addon.",
  apiKeyInvalid: "La tua chiave API è scaduta o non valida. Reinseriscila.",
};

const ru: Dict = {
  onboardingHeading: "Учётные данные WarcraftLogs",
  introInstruction: "Создай собственного API-клиента на",
  introStore:
    "Затем введи Client ID и Client Secret ниже. Оба сохраняются только локально в твоём браузере и отправляются только этому приложению, никогда стороннему серверу.",
  clientIdPlaceholder: "Client ID",
  clientSecretPlaceholder: "Client Secret",
  saveButton: "Сохранить",
  savingButton: "Проверка...",
  validationEmptyError: "Введите Client ID и Secret.",
  logoutButton: "Выйти",
  buttonIdle: "Импорт из буфера обмена",
  buttonLoading: "Анализ...",
  buttonDone: "Сохранено в буфер обмена",
  buttonErrorRetry: "Ошибка",
  buttonWrongVersion: "Обновите аддон!",
  errorClipboardUnavailable: "Доступ к буферу обмена недоступен (нужен HTTPS или localhost).",
  errorNoNames: "В буфере обмена нет имён.",
  noValidEntries: 'Не найдено допустимых записей "Имя-Сервер".',
  configIncomplete: "Неполная конфигурация: Zone ID/Partition WCL не заданы.",
  wrongAddonVersion: "Это веб-приложение ожидает другую версию аддона. Пожалуйста, обновите аддон.",
  apiKeyInvalid: "Срок действия API-ключа истёк или он недействителен. Введите его заново.",
};

export const DICTS: Record<Locale, Dict> = { en, de, fr, es, it, ru };

// navigator.languages is preference-ordered (e.g. ["fr-CH", "de", "en-US"]
// for a Swiss-French user who also reads German) -- walk it and use the
// first entry whose primary subtag we have a translation for, so a
// secondary preferred language can still match even if the top one can't.
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }
  const candidates = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const lang of candidates) {
    const primary = lang.split("-")[0].toLowerCase() as Locale;
    if (LOCALES.includes(primary)) {
      return primary;
    }
  }
  return DEFAULT_LOCALE;
}
