// All on-screen text, in English and German. Copied from the Claude Design
// prototype; the login/password lines and a few others were added for the
// real app (the prototype used a fake 6-digit code).

export type Lang = 'en' | 'de';

const en = {
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  mshort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ui: {
    standings: 'Standings', tapLane: 'Tap your lane', activity: 'Activity', noChanges: 'No changes yet.', settings: 'Settings',
    families: 'Teams', signedIn: 'Signed in as', logout: 'Log out', makeAdmin: 'Make admin', confirm: 'Confirm', cancel: 'Cancel',
    yourEmail: 'Your email', continue: 'Continue', login: 'Log in', otherEmail: 'Use another email',
    password: 'Password',
    loginHint: 'Only families on the list can log in. Everyone uses the same password.',
    addFamily: 'Add team', add: 'Add', namePh: 'Team name', emailPh: 'Email address', email2Ph: 'Second email address (optional)', addEmailPh: '+ another email address', removeEmail: 'Remove this email', emailRemoved: 'Email removed',
    notify: 'Notify everyone when a day changes', emailSub: 'Sent to all other families', waSub: 'Pops up on everyone’s phone',
    push: 'Push notifications', notifyMe: 'Tell me when another family changes a day',
    emailMe: 'Sent to your email address', pushMe: 'Pops up on this phone',
    pushIphone: 'On iPhone: tap Share ⬆︎ → “Add to Home Screen”, open the app from there, then switch this on.',
    pushDenied: 'Notifications are blocked for this app. Allow them in your phone’s settings.',
    pushUnsupported: 'This browser can’t show notifications.',
    pushAskTitle: 'Turn on notifications', pushAskBody: 'Get a message on this phone when another family books or releases a day. You can switch it off any time in Settings.',
    pushAskYes: 'Turn on', pushAskNo: 'No thanks',
    addNote: '✎ note', addNoteBtn: '✎ Add a note', addNoteEg: 'e.g. arrival time', notePh: 'e.g. arrival time: 19h', saveNote: 'Save note', removeNote: 'Remove note', noteSaved: 'Note saved', noteRemoved: 'Note removed',
    noNote: 'No note.', dayFree: 'Free — nobody has booked this day.', bookFirst: 'Book the day first, then you can add a note.',
    bookedBy: (n: string) => `Booked by ${n}`, noteOnlyOwner: (n: string) => `Only ${n} can change this note.`, notified: 'Others notified',
    undo: 'Undo', details: 'Change', openCal: 'Open calendar', liveSub: 'Others are notified 10 min after your last change',
  },
  tabs: ['Year', 'Month', 'Activity', 'Settings'],
  booked: 'booked', removed: 'removed',
  halfBooked: 'half the apartment booked', fullBooked: 'whole apartment booked', halfHint: 'Tap again: whole ⇄ half ⇄ free',
  halfBy: (n: string) => `${n} has half the apartment`,
  allFree: 'All free',
  ofBooked: (b: number, n: number) => `${b} of ${n} days booked`,
  forYou: (c: number) => `${c} days for you this year`,
  totalLabel: (t: number, n: number) => `${t} OF ${n} DAYS BOOKED`,
  byOther: (n: string) => `Booked by ${n}`,
  onlyEdit: (n: string) => `Only ${n} can edit this lane`,
  switchFam: 'Log in with their email to edit it',
  adminOnly: (n: string) => `Only the admin (${n}) can edit teams and their email addresses.`,
  confirmAdmin: (n: string) => `Make ${n} the admin? You will lose admin rights.`,
  unknownEmail: 'This email is not on the family list. Ask the admin to add you.',
  wrongPassword: 'Wrong password. Try again.',
  pwTooShort: 'The password needs at least 6 characters.',
  emailInUse: 'That email is already used by another family.',
  nowAdmin: (n: string) => `${n} is now the admin`,
  taken: (n: string) => `Already taken by ${n}`,
  undone: 'Undone',
  nowShowing: (y: number) => `Now showing ${y}`,
  offline: 'Could not save — check your internet connection.',
  bodyBooked: (w: string, d: string, y: number) => `Team ${w} booked the apartment for ${d}. The day now shows in their colour in the ${y} calendar.`,
  bodyRemoved: (w: string, d: string) => `Team ${w} released ${d}. The day is free again for anyone to book.`,
};

const de: typeof en = {
  months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  mshort: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  wd: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  ui: {
    standings: 'Rangliste', tapLane: 'Eigene Spur tippen', activity: 'Aktivität', noChanges: 'Noch keine Änderungen.', settings: 'Einstellungen',
    families: 'Teams', signedIn: 'Angemeldet als', logout: 'Abmelden', makeAdmin: 'Zum Admin machen', confirm: 'Bestätigen', cancel: 'Abbrechen',
    yourEmail: 'Deine E-Mail', continue: 'Weiter', login: 'Anmelden', otherEmail: 'Andere E-Mail verwenden',
    password: 'Passwort',
    loginHint: 'Nur Familien auf der Liste können sich anmelden. Alle verwenden dasselbe Passwort.',
    addFamily: 'Team hinzufügen', add: 'Hinzufügen', namePh: 'Teamname', emailPh: 'E-Mail-Adresse', email2Ph: 'Zweite E-Mail-Adresse (optional)', addEmailPh: '+ weitere E-Mail-Adresse', removeEmail: 'Diese E-Mail entfernen', emailRemoved: 'E-Mail entfernt',
    notify: 'Alle benachrichtigen, wenn sich ein Tag ändert', emailSub: 'An alle anderen Familien', waSub: 'Erscheint auf allen Handys',
    push: 'Push-Mitteilungen', notifyMe: 'Mich benachrichtigen, wenn eine andere Familie einen Tag ändert',
    emailMe: 'An deine E-Mail-Adresse', pushMe: 'Erscheint auf diesem Handy',
    pushIphone: 'Auf dem iPhone: Teilen ⬆︎ → „Zum Home-Bildschirm“ tippen, die App von dort öffnen, dann hier einschalten.',
    pushDenied: 'Mitteilungen sind für diese App blockiert. In den Handy-Einstellungen erlauben.',
    pushUnsupported: 'Dieser Browser kann keine Mitteilungen anzeigen.',
    pushAskTitle: 'Mitteilungen einschalten', pushAskBody: 'Erhalte eine Nachricht auf diesem Handy, wenn eine andere Familie einen Tag bucht oder freigibt. Du kannst es jederzeit in den Einstellungen ausschalten.',
    pushAskYes: 'Einschalten', pushAskNo: 'Nein danke',
    addNote: '✎ Notiz', addNoteBtn: '✎ Notiz hinzufügen', addNoteEg: 'z.B. Ankunftszeit', notePh: 'z.B. Ankunftszeit: 19 Uhr', saveNote: 'Notiz speichern', removeNote: 'Notiz löschen', noteSaved: 'Notiz gespeichert', noteRemoved: 'Notiz gelöscht',
    noNote: 'Keine Notiz.', dayFree: 'Frei — niemand hat diesen Tag gebucht.', bookFirst: 'Buche zuerst den Tag, dann kannst du eine Notiz hinzufügen.',
    bookedBy: (n: string) => `Gebucht von ${n}`, noteOnlyOwner: (n: string) => `Nur ${n} kann diese Notiz ändern.`, notified: 'Andere benachrichtigt',
    undo: 'Rückgängig', details: 'Änderung', openCal: 'Kalender öffnen', liveSub: 'Andere werden 10 Min. nach deiner letzten Änderung informiert',
  },
  tabs: ['Jahr', 'Monat', 'Aktivität', 'Einstellungen'],
  booked: 'gebucht', removed: 'freigegeben',
  halfBooked: 'halbe Wohnung gebucht', fullBooked: 'ganze Wohnung gebucht', halfHint: 'Nochmals tippen: ganz ⇄ halb ⇄ frei',
  halfBy: n => `${n} hat die halbe Wohnung`,
  allFree: 'Alles frei',
  ofBooked: (b, n) => `${b} von ${n} Tagen gebucht`,
  forYou: c => `${c} Tage für dich dieses Jahr`,
  totalLabel: (t, n) => `${t} VON ${n} TAGEN GEBUCHT`,
  byOther: n => `Gebucht von ${n}`,
  onlyEdit: n => `Nur ${n} kann diese Spur bearbeiten`,
  switchFam: 'Mit deren E-Mail anmelden, um sie zu bearbeiten',
  adminOnly: n => `Nur der Admin (${n}) kann Teams und ihre E-Mail-Adressen bearbeiten.`,
  confirmAdmin: n => `${n} zum Admin machen? Du verlierst deine Admin-Rechte.`,
  unknownEmail: 'Diese E-Mail ist nicht auf der Familienliste. Bitte den Admin, dich hinzuzufügen.',
  wrongPassword: 'Falsches Passwort. Versuch es nochmal.',
  pwTooShort: 'Das Passwort braucht mindestens 6 Zeichen.',
  emailInUse: 'Diese E-Mail gehört schon einer anderen Familie.',
  nowAdmin: n => `${n} ist jetzt Admin`,
  taken: n => `Bereits gebucht von ${n}`,
  undone: 'Rückgängig gemacht',
  nowShowing: y => `Jetzt wird ${y} angezeigt`,
  offline: 'Konnte nicht speichern — Internetverbindung prüfen.',
  bodyBooked: (w, d, y) => `Team ${w} hat die Wohnung für ${d} gebucht. Der Tag erscheint jetzt in ihrer Farbe im Kalender ${y}.`,
  bodyRemoved: (w, d) => `Team ${w} hat ${d} freigegeben. Der Tag ist wieder frei.`,
};

export const L10N = { en, de };
export type Strings = typeof en;

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

export function fmt(key: string, lang: Lang) {
  const [y, m, d] = key.split('-').map(Number);
  const t = L10N[lang];
  const wd = t.wd[new Date(y, m - 1, d).getDay()];
  return lang === 'de' ? `${wd} ${d}. ${t.mshort[m - 1]} ${y}` : `${wd} ${d} ${t.mshort[m - 1]} ${y}`;
}

export function fmtRange(a: string, b: string, lang: Lang) {
  return a === b ? fmt(a, lang) : `${fmt(a, lang).replace(/ \d{4}$/, '')} – ${fmt(b, lang)}`;
}

export function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}
