import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as db from './data';
import { COLORS, supabase, type Activity, type Family, type TeamEmail } from './data';
import { L10N, ago, dayKey, fmt, fmtRange, type Lang, type Strings } from './i18n';
import Login from './Login';
import { groupActivity, type Burst } from './group';

const RED = '#DA291C';
const YEARS = [2026, 2027, 2028, 2029, 2030];
type View = 'year' | 'month' | 'activity' | 'settings';
type Toast = { msg: string; sub: string; kind: 'ok' | 'warn' | 'info' | 'neutral'; undo?: () => void };

// Language, year, month and screen are remembered on this phone only.
const UI_KEY = 'schluechti-ui';
type Ui = { lang: Lang; year: number; month: number; view: View };
function loadUi(): Ui {
  // First visit: German phones start in German.
  const fallback: Ui = { lang: /^de/i.test(navigator.language) ? 'de' : 'en', year: 2027, month: 0, view: 'year' };
  try {
    const u = { ...fallback, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') } as Ui;
    return YEARS.includes(u.year) && L10N[u.lang] ? u : fallback;
  } catch { return fallback; }
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dim = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const isWE = (y: number, m: number, d: number) => { const w = new Date(y, m, d).getDay(); return w === 0 || w === 6; };

export default function App() {
  const [ui, setUi] = useState<Ui>(loadUi);
  const { lang, year, month, view } = ui;
  const tr = L10N[lang];
  const t = tr.ui;
  const patchUi = (p: Partial<Ui>) => setUi(u => ({ ...u, ...p }));
  useEffect(() => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* private mode */ } }, [ui]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // ── Login session ──
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // ── Shared data (live) ──
  const [families, setFamilies] = useState<Family[] | null>(null);
  const [bookings, setBookings] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({}); // day → note, e.g. "arriving at 19h"
  const [activity, setActivity] = useState<Activity[]>([]);

  const reloadFamilies = useCallback(() => db.loadFamilies().then(setFamilies).catch(() => {}), []);
  // Every team can have several email addresses (login + notifications).
  const [teamEmails, setTeamEmails] = useState<TeamEmail[] | null>(null);
  const reloadTeamEmails = useCallback(() => db.loadTeamEmails().then(setTeamEmails).catch(() => {}), []);
  // Only the newest refresh may update the screen (answers can arrive out of order).
  const bookingsReq = useRef(0);
  const reloadBookings = useCallback(() => {
    const n = ++bookingsReq.current;
    return db.loadBookings().then(rows => {
      if (n !== bookingsReq.current) return;
      setBookings(Object.fromEntries(rows.map(r => [r.day, r.family_id])));
      setNotes(Object.fromEntries(rows.filter(r => r.note).map(r => [r.day, r.note as string])));
    }).catch(() => {});
  }, []);
  const reloadActivity = useCallback(() => db.loadActivity().then(setActivity).catch(() => {}), []);

  useEffect(() => {
    if (!session) { setFamilies(null); setTeamEmails(null); return; }
    const all = () => { reloadFamilies(); reloadTeamEmails(); reloadBookings(); reloadActivity(); };
    all();
    const ch = supabase.channel('everything')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'families' }, reloadFamilies)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_emails' }, reloadTeamEmails)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, reloadBookings)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity' }, reloadActivity)
      .subscribe();
    // Phones pause apps in the background — catch up when it comes back.
    const onVis = () => { if (document.visibilityState === 'visible') all(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { supabase.removeChannel(ch); document.removeEventListener('visibilitychange', onVis); };
  }, [session, reloadFamilies, reloadTeamEmails, reloadBookings, reloadActivity]);

  // ── Push on this phone? ──
  // Push is ON by default: the app asks right after login, and keeps asking
  // each time it opens until the person taps "Turn on" or "No thanks".
  // "No thanks" (or switching it off in Settings) is remembered on this phone.
  const PUSH_OFF = 'schluechti-push-off';
  const pushOptedOut = () => { try { return localStorage.getItem(PUSH_OFF) === '1'; } catch { return false; } };
  const setPushOptOut = (off: boolean) => { try { off ? localStorage.setItem(PUSH_OFF, '1') : localStorage.removeItem(PUSH_OFF); } catch { /* private mode */ } };
  const [pushOn, setPushOn] = useState(false);
  const [pushChecked, setPushChecked] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushAskHidden, setPushAskHidden] = useState(false);
  useEffect(() => {
    if (!session) return;
    (async () => {
      let on = await db.pushIsOn().catch(() => false);
      // Phone already allows notifications (e.g. new login) → connect silently.
      if (!on && !pushOptedOut() && db.pushSupported() && Notification.permission === 'granted') {
        on = (await db.turnPushOn().catch(() => 'error')) === 'ok';
      }
      setPushOn(on);
      setPushChecked(true);
    })();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function enablePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (db.needsHomeScreen()) showToast({ msg: L10N[lang].ui.push, sub: L10N[lang].ui.pushIphone, kind: 'info' });
      else {
        const r = await db.turnPushOn();
        if (r === 'ok') { setPushOn(true); setPushOptOut(false); }
        else showToast({ msg: L10N[lang].ui.push, sub: r === 'denied' ? L10N[lang].ui.pushDenied : L10N[lang].ui.pushUnsupported, kind: 'warn' });
      }
    } catch { showToast({ msg: L10N[lang].offline, sub: '', kind: 'warn' }); }
    setPushBusy(false);
    setPushAskHidden(true);
  }
  async function disablePush() {
    setPushOptOut(true);
    setPushAskHidden(true);
    if (!pushOn) return;
    setPushBusy(true);
    try { await db.turnPushOff(); setPushOn(false); } catch { showToast({ msg: L10N[lang].offline, sub: '', kind: 'warn' }); }
    setPushBusy(false);
  }

  const fams = families || [];
  const myEmail = session?.user.email?.toLowerCase();
  const emailsOf = (familyId: number) => (teamEmails || []).filter(e => e.family_id === familyId).map(e => e.email);
  const myFamilyId = (teamEmails || []).find(e => e.email === myEmail)?.family_id;
  const me = fams.findIndex(f => f.id === myFamilyId);
  const meFam = me >= 0 ? fams[me] : null;
  const adminIdx = fams.findIndex(f => f.is_admin);
  const iAmAdmin = !!meFam?.is_admin;
  const idxOf = (familyId: number) => fams.findIndex(f => f.id === familyId);
  // Logged in, but this email is no longer on the family list → log out.
  const [kicked, setKicked] = useState(false);
  useEffect(() => { if (session && families && teamEmails && !teamEmails.some(e => e.email === myEmail)) { setKicked(true); supabase.auth.signOut(); } }, [session, families, teamEmails, myEmail]);
  const color = (i: number) => COLORS[fams[i]?.color_idx ?? 0];
  // Remember my language, so my notification emails come in it.
  useEffect(() => { if (meFam && meFam.lang !== lang) db.setMyPrefs(meFam.notify_email, lang).catch(() => {}); }, [meFam?.id, meFam?.lang, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Little UI bits ──
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = (x: Toast) => { clearTimeout(toastTimer.current); setToast(x); toastTimer.current = window.setTimeout(() => setToast(null), x.undo ? 3500 : 2800); };
  const [pop, setPop] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [noteDay, setNoteDay] = useState<string | null>(null);
  const [noteHint, setNoteHint] = useState<string | null>(null); // day just booked → show "Add a note" button under it
  const [yearOpen, setYearOpen] = useState(false);
  const [confirmAdmin, setConfirmAdmin] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [view]);

  const go = (v: View, extra: Partial<Ui> = {}) => {
    patchUi({ view: v, ...extra });
    setYearOpen(false);
    if (v === 'activity' && meFam) {
      setFamilies(fs => fs && fs.map(f => f.id === meFam.id ? { ...f, activity_seen_at: new Date().toISOString() } : f));
      db.markActivitySeen().catch(() => {});
    }
  };

  // ── Tapping a day ──
  const saving = useRef(new Set<string>());
  async function toggle(key: string, fi: number) {
    if (!meFam) return;
    const owner = bookings[key];
    const ownerIdx = owner === undefined ? -1 : idxOf(owner);
    if (fi !== me) {
      showToast(ownerIdx === fi ? { msg: tr.byOther(fams[fi].name), sub: fmt(key, lang), kind: 'info' } : { msg: tr.onlyEdit(fams[fi].name), sub: tr.switchFam, kind: 'info' });
      return;
    }
    if (ownerIdx >= 0 && ownerIdx !== me) { showToast({ msg: tr.taken(fams[ownerIdx].name), sub: fmt(key, lang), kind: 'warn' }); return; }

    setNoteHint(owner === meFam.id ? null : key); // just booked → offer a note right under it
    // A day that is still saving ignores further taps (no double-taps).
    if (saving.current.has(key)) return;
    saving.current.add(key);

    // Show the change immediately (only this one day), then confirm with the server.
    const setDay = (v: number | undefined) => setBookings(b => { const n = { ...b }; if (v === undefined) delete n[key]; else n[key] = v; return n; });
    setDay(owner === meFam.id ? undefined : meFam.id);
    if (owner === meFam.id) setNotes(ns => { if (!(key in ns)) return ns; const n = { ...ns }; delete n[key]; return n; });
    setPop(key); setTimeout(() => setPop(null), 220);
    try {
      const r = await db.toggleDay(key);
      if (r.status === 'taken') {
        setDay(owner); setNoteHint(null); reloadBookings();
        const who = fams[idxOf(r.family_id)];
        showToast({ msg: tr.taken(who ? who.name : '?'), sub: fmt(key, lang), kind: 'warn' });
        return;
      }
      showToast({
        msg: `${fmt(key, lang)} ${tr[r.action]}`, sub: t.liveSub, kind: r.action === 'booked' ? 'ok' : 'neutral',
        // Undo = tap the day again. Book + release cancel out, so if the
        // notification hasn't gone yet, nobody is told about either.
        undo: async () => {
          setToast(null);
          try {
            const u = await db.toggleDay(key);
            showToast(u.status === 'ok' ? { msg: tr.undone, sub: fmt(key, lang), kind: 'neutral' } : { msg: tr.offline, sub: fmt(key, lang), kind: 'warn' });
          } catch { showToast({ msg: tr.offline, sub: '', kind: 'warn' }); }
          reloadBookings(); reloadActivity();
        },
      });
      reloadActivity();
    } catch {
      setDay(owner);
      showToast({ msg: tr.offline, sub: fmt(key, lang), kind: 'warn' });
    } finally {
      saving.current.delete(key);
    }
  }

  // ── Numbers for the screens ──
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const [k, fid] of Object.entries(bookings)) if (k.startsWith(year + '-')) c[fid] = (c[fid] || 0) + 1;
    return c;
  }, [bookings, year]);
  const countOf = (i: number) => counts[fams[i]?.id] || 0;
  const bursts = useMemo(() => groupActivity(activity), [activity]);
  const unread = meFam ? bursts.filter(b => b.family_id !== meFam.id && b.created_at > meFam.activity_seen_at).length : 0;

  // ── Not logged in / still loading ──
  const shell = (children: React.ReactNode) => (
    <div style={{ height: '100dvh', maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', background: '#F6F4EF', position: 'relative', overflow: 'hidden' }}>{children}</div>
  );
  if (!db.configured) return shell(<div style={{ padding: 24, font: "500 15px/1.5 'Barlow',sans-serif" }}>Supabase isn’t connected yet: the file <b>.env.local</b> is missing its two values. See README.md.</div>);
  if (session === undefined || (session && (families === null || teamEmails === null))) return shell(<div style={{ flex: 1, background: RED }} />);
  if (!session) return shell(<Login tr={tr} lang={lang} setLang={l => patchUi({ lang: l })} initialError={kicked ? tr.unknownEmail : undefined} />);
  if (!meFam) return shell(<Login tr={tr} lang={lang} setLang={l => patchUi({ lang: l })} initialError={tr.unknownEmail} />);

  const sheetEntry = bursts.find(b => b.id === sheetId);
  const toastBg = toast ? { ok: '#111214', warn: '#B3261E', info: '#2B2D31', neutral: '#2B2D31' }[toast.kind] : '#111';

  return shell(
    <>
      {/* ── Red header ── */}
      <div style={{ background: RED, padding: 'max(16px, calc(env(safe-area-inset-top) + 8px)) 16px 12px', color: '#fff', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="tap" onClick={() => go('year')} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, position: 'relative', flex: 'none' }}>
              <div style={{ position: 'absolute', left: 12, top: 5, width: 10, height: 24, background: '#fff' }} />
              <div style={{ position: 'absolute', left: 5, top: 12, width: 24, height: 10, background: '#fff' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0, font: "800 24px/1 'Barlow Condensed',sans-serif", letterSpacing: '.02em', textTransform: 'uppercase' }}>Schluechti Planner</div>
          </div>
          <div className="tap" onClick={() => patchUi({ lang: lang === 'en' ? 'de' : 'en' })} style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,.18)', borderRadius: 999, padding: 3, height: 36 }}>
            {(['en', 'de'] as Lang[]).map(c => (
              <div key={c} style={{ height: 30, minWidth: 34, padding: '0 6px', borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 13px 'Barlow',sans-serif", background: lang === c ? '#fff' : 'transparent', color: lang === c ? RED : '#fff' }}>{c.toUpperCase()}</div>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <div className="tap" onClick={() => setYearOpen(!yearOpen)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', color: RED, borderRadius: 999, padding: '0 12px', height: 36, font: "700 16px 'JetBrains Mono',monospace" }}>
              {year}<span style={{ font: "700 10px 'Barlow',sans-serif" }}>{yearOpen ? '▲' : '▼'}</span>
            </div>
            {yearOpen && (
              <div style={{ position: 'absolute', right: 0, top: 44, zIndex: 60, background: '#fff', borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,.25)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110 }}>
                {YEARS.map(yy => (
                  <div key={yy} className="tap hov-soft" onClick={() => { patchUi({ year: yy }); setYearOpen(false); }} style={{ height: 44, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', font: "700 16px 'JetBrains Mono',monospace", background: yy === year ? '#FBE9E7' : 'transparent', color: yy === year ? RED : '#111' }}>
                    {yy}<span style={{ font: "700 13px 'Barlow',sans-serif" }}>{yy === year ? '✓' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ height: 5, flex: 'none', background: 'repeating-linear-gradient(90deg,#DA291C 0 14px,#fff 14px 20px,#1B3A8C 20px 34px,#fff 34px 40px)' }} />

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }} onClick={() => yearOpen && setYearOpen(false)}>
        {view === 'year' && YearView()}
        {view === 'month' && MonthView()}
        {view === 'activity' && ActivityView()}
        {view === 'settings' && SettingsView()}
      </div>

      {/* ── Toast ── */}
      {toast && (
        // Shown at the TOP, over the red title bar, so the calendar stays free to tap.
        <div style={{ position: 'absolute', left: 10, right: 10, top: 'max(8px, calc(env(safe-area-inset-top) + 4px))', zIndex: 30, pointerEvents: 'none', background: toastBg, color: '#fff', borderRadius: 14, padding: '8px 8px 8px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px rgba(0,0,0,.3)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 14px/1.2 'Barlow',sans-serif", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toast.msg}</div>
            {toast.sub && <div style={{ font: "500 11px/1.3 'Barlow',sans-serif", opacity: 0.8, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toast.sub}</div>}
          </div>
          {toast.undo && <div className="tap" onClick={toast.undo} style={{ pointerEvents: 'auto', flex: 'none', height: 36, padding: '0 14px', borderRadius: 9, background: 'rgba(255,255,255,.16)', display: 'flex', alignItems: 'center', font: "700 14px 'Barlow',sans-serif" }}>{t.undo}</div>}
        </div>
      )}

      {/* ── Bottom sheet with the details of one change ── */}
      {sheetEntry && Sheet(sheetEntry)}

      {/* ── Note on a day ── */}
      {noteDay && (
        <NoteSheet key={noteDay} t={t} title={fmt(noteDay, lang)} note={notes[noteDay] || ''}
          owner={bookings[noteDay] === undefined ? null : fams[idxOf(bookings[noteDay])]?.name || ''}
          ownerColor={bookings[noteDay] === undefined ? '#D6D2C7' : color(idxOf(bookings[noteDay]))}
          mine={bookings[noteDay] === meFam.id}
          onClose={() => setNoteDay(null)}
          onSave={async text => {
            const day = noteDay;
            setNoteDay(null);
            setNotes(ns => { const n = { ...ns }; if (text.trim()) n[day] = text.trim(); else delete n[day]; return n; });
            try { if ((await db.setDayNote(day, text)) !== 'ok') showToast({ msg: tr.offline, sub: fmt(day, lang), kind: 'warn' }); else showToast({ msg: text.trim() ? t.noteSaved : t.noteRemoved, sub: fmt(day, lang), kind: 'ok' }); }
            catch { showToast({ msg: tr.offline, sub: fmt(day, lang), kind: 'warn' }); }
            reloadBookings();
          }} />
      )}

      {/* ── "Turn on notifications" ask, shown after login until answered ── */}
      {!sheetEntry && pushChecked && !pushOn && !pushAskHidden && !pushOptedOut() && (db.needsHomeScreen() || (db.pushSupported() && Notification.permission !== 'denied')) && PushAsk()}

      {/* ── Tab bar ── */}
      <div style={{ flex: 'none', background: '#fff', borderTop: '1px solid #E2DED4', display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', padding: '4px 8px max(10px, env(safe-area-inset-bottom))' }}>
        {(['year', 'month', 'activity', 'settings'] as View[]).map((v, i) => (
          <div key={v} className="tap" onClick={() => go(v)} style={{ height: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, position: 'relative' }}>
            <div style={{ width: 22, height: 4, borderRadius: 2, background: view === v ? RED : 'transparent' }} />
            <div style={{ font: "700 13px 'Barlow Condensed',sans-serif", letterSpacing: '.1em', textTransform: 'uppercase', color: view === v ? '#111' : '#8A877F' }}>{tr.tabs[i]}</div>
            {v === 'activity' && unread > 0 && (
              <div style={{ position: 'absolute', top: 4, right: 16, minWidth: 18, height: 18, borderRadius: 9, background: RED, color: '#fff', font: "700 11px 'JetBrains Mono',monospace", display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{unread}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );

  // ── Saving family edits (admin only) ──
  function saveName(fam: Family, name: string) {
    setFamilies(fs => fs && fs.map(x => x.id === fam.id ? { ...x, name } : x));
    db.updateFamily(fam.id, { name }).catch(() => { showToast({ msg: tr.offline, sub: '', kind: 'warn' }); reloadFamilies(); });
  }
  async function changeEmail(oldEmail: string, newEmail: string) {
    try { await db.changeTeamEmail(oldEmail, newEmail); reloadTeamEmails(); return true; }
    catch { showToast({ msg: tr.emailInUse, sub: newEmail, kind: 'warn' }); return false; }
  }
  async function addEmail(familyId: number, email: string) {
    try { await db.addTeamEmail(familyId, email); reloadTeamEmails(); return true; }
    catch { showToast({ msg: tr.emailInUse, sub: email, kind: 'warn' }); return false; }
  }
  async function removeEmail(email: string) {
    setTeamEmails(es => es && es.filter(e => e.email !== email));
    try { await db.removeTeamEmail(email); showToast({ msg: t.emailRemoved, sub: email, kind: 'neutral' }); }
    catch { showToast({ msg: tr.offline, sub: email, kind: 'warn' }); }
    reloadTeamEmails();
  }
  async function addFam(name: string, emails: string[], colorIdx: number) {
    try { await db.addFamily(name, emails, colorIdx); reloadFamilies(); reloadTeamEmails(); return true; }
    catch { showToast({ msg: tr.emailInUse, sub: emails.join(', '), kind: 'warn' }); return false; }
  }

  // ───────────────────────── Year ─────────────────────────
  function YearView() {
    const max = Math.max(0, ...fams.map((_, i) => countOf(i)));
    const tot = Object.keys(bookings).filter(k => k.startsWith(year + '-')).length;
    return (
      <div style={{ padding: '14px 12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: '#111214', borderRadius: 14, padding: '14px 14px 10px', color: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8 }}>
            <div style={{ font: "800 15px 'Barlow Condensed',sans-serif", letterSpacing: '.12em', textTransform: 'uppercase' }}>{t.standings} {year}</div>
            <div style={{ font: "500 11px 'JetBrains Mono',monospace", color: '#9A9CA3' }}>{tr.totalLabel(tot, isLeap(year) ? 366 : 365)}</div>
          </div>
          {fams.map((f, i) => {
            const days = countOf(i);
            return (
              <div key={f.id} style={{ padding: '5px 0', borderTop: '1px solid #26282C' }}>
                <div style={{ height: 30, background: '#1F2124', borderRadius: 7, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: (max ? Math.round(days / max * 100) : 0) + '%', minWidth: 130, background: color(i), borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 10px', color: '#fff', transition: 'width .3s' }}>
                    {iAmAdmin
                      ? <NameInput fam={f} onSave={saveName} className="focus-u" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: '#fff', font: "600 15px/1 'Barlow',sans-serif", padding: 0 }} />
                      : <div style={{ flex: 1, minWidth: 0, font: "600 15px/1 'Barlow',sans-serif", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>}
                    <div style={{ font: "700 14px 'JetBrains Mono',monospace", flex: 'none' }}>{days}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', padding: '2px 4px' }}>
          {fams.map((f, i) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 5, font: "500 12px 'Barlow',sans-serif", color: '#3A3A3A' }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: color(i) }} />{f.name}
            </div>
          ))}
        </div>

        {tr.months.map((name, m) => {
          const n = dim(year, m);
          const days = Array.from({ length: 31 }, (_, i) => i + 1);
          let booked = 0;
          for (let d = 1; d <= n; d++) if (bookings[dayKey(year, m, d)] !== undefined) booked++;
          const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '14px repeat(31,minmax(0,1fr))', gap: 2 };
          return (
            <div key={m} className="tap hov-ring" onClick={() => go('month', { month: m })} style={{ background: '#fff', borderRadius: 14, padding: 12, boxShadow: '0 1px 0 rgba(0,0,0,.06)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ font: "800 22px/1 'Barlow Condensed',sans-serif", letterSpacing: '.04em', textTransform: 'uppercase', color: '#111' }}>{name}</div>
                  <div style={{ font: "500 12px 'JetBrains Mono',monospace", color: '#8A877F' }}>{String(m + 1).padStart(2, '0')}</div>
                </div>
                <div style={{ font: "600 12px 'Barlow',sans-serif", color: '#6B6860' }}>{booked ? tr.ofBooked(booked, n) : tr.allFree} ›</div>
              </div>
              <div style={{ ...grid, marginBottom: 3 }}>
                <div />
                {days.map(d => <div key={d} style={{ font: "500 7px/1 'JetBrains Mono',monospace", textAlign: 'center', color: d <= n && isWE(year, m, d) ? RED : '#8A877F' }}>{d <= n ? d : ''}</div>)}
              </div>
              {fams.map((f, fi) => (
                <div key={f.id} style={{ ...grid, marginTop: 2, alignItems: 'center' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color(fi) }} />
                  {days.map(d => (
                    <div key={d} style={{ height: 9, borderRadius: 2, background: d > n ? 'transparent' : bookings[dayKey(year, m, d)] === f.id ? color(fi) : isWE(year, m, d) ? '#E6E2D8' : '#F1EEE7' }} />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  // ───────────────────────── Month ─────────────────────────
  function MonthView() {
    const n = dim(year, month);
    let mBooked = 0;
    const rows = [];
    for (let d = 1; d <= n; d++) {
      const key = dayKey(year, month, d);
      const ownerId = bookings[key];
      if (ownerId !== undefined) mBooked++;
      const wd = new Date(year, month, d).getDay();
      const we = wd === 0 || wd === 6;
      const takenByOther = ownerId !== undefined && ownerId !== meFam!.id;
      rows.push(
        <div key={d} style={{ display: 'grid', gridTemplateColumns: '78px', gridAutoFlow: 'column', gridAutoColumns: 'minmax(0,1fr)', gap: 4, alignItems: 'center', minHeight: 46, padding: '4px 12px', borderTop: wd === 1 && d > 1 ? '2px solid #D6D2C7' : '1px solid #E8E4DB', background: we ? '#EFECE4' : 'transparent', margin: '0 -12px' }}>
          {/* Tap the date to read or write the note for that day */}
          <div className="tap" onClick={() => setNoteDay(key)} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'stretch', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <div style={{ font: "700 20px/1 'Barlow Condensed',sans-serif", color: we ? RED : '#111' }}>{d}</div>
              <div style={{ font: "600 11px 'Barlow',sans-serif", color: '#8A877F', textTransform: 'uppercase' }}>{tr.wd[wd]}</div>
            </div>
            {notes[key]
              ? <div style={{ font: "600 10px/1.15 'Barlow',sans-serif", color: ownerId !== undefined ? color(idxOf(ownerId)) : '#6B6860', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✎ {notes[key]}</div>
              : ownerId === meFam!.id && <div style={{ alignSelf: 'flex-start', font: "700 10px/1 'Barlow',sans-serif", color: color(me), background: '#fff', border: `1.5px solid ${color(me)}`, borderRadius: 6, padding: '2px 5px' }}>{t.addNote}</div>}
          </div>
          {fams.map((f, fi) => {
            const on = ownerId === f.id, mine = fi === me;
            let bg = we ? '#EAE6DC' : '#F0EDE6', border = '2px solid transparent', label = '', fg = '#fff';
            if (on) { bg = color(fi); label = mine ? '✓' : ''; }
            else if (mine) {
              bg = takenByOther ? 'repeating-linear-gradient(135deg,#E6E2D8 0 4px,#F6F4EF 4px 8px)' : '#fff';
              border = takenByOther ? '2px solid transparent' : `2px dashed ${color(fi)}`;
              label = takenByOther ? '' : '+'; fg = color(fi);
            }
            return (
              <div key={f.id} className="tap" onClick={() => toggle(key, fi)} style={{ height: 36, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, border, color: fg, font: "800 18px 'Barlow',sans-serif", transition: 'transform .2s cubic-bezier(.3,1.6,.5,1)', transform: pop === key && mine ? 'scale(1.12)' : 'none' }}>{label}</div>
            );
          })}
        </div>
      );
      if (noteHint === key && ownerId === meFam!.id && !notes[key]) {
        rows.push(
          <div key={'hint' + d} style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: 4, padding: '0 12px 8px', background: we ? '#EFECE4' : 'transparent', margin: '0 -12px' }}>
            <div />
            <div className="tap press" onClick={() => { setNoteHint(null); setNoteDay(key); }} style={{ height: 40, borderRadius: 10, background: RED, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, font: "700 14px 'Barlow',sans-serif", boxShadow: '0 2px 8px rgba(218,41,28,.3)' }}>
              {t.addNoteBtn}<span style={{ fontWeight: 500, opacity: 0.85 }}>({t.addNoteEg})</span>
            </div>
          </div>
        );
      }
    }
    const toYear = (y: number, m: number) => { patchUi({ month: m, year: y }); showToast({ msg: tr.nowShowing(y), sub: tr.months[m] + ' ' + y, kind: 'info' }); };
    const prev = () => month === 0 ? (year > YEARS[0] && toYear(year - 1, 11)) : patchUi({ month: month - 1 });
    const next = () => month === 11 ? (year < YEARS[YEARS.length - 1] && toYear(year + 1, 0)) : patchUi({ month: month + 1 });
    const arrow: React.CSSProperties = { width: 44, height: 44, borderRadius: 12, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 22px 'Barlow',sans-serif", color: '#111', boxShadow: '0 1px 0 rgba(0,0,0,.06)' };
    return (
      <>
        <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#F6F4EF', padding: '12px 12px 8px', borderBottom: '1px solid #E2DED4' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div className="tap" onClick={prev} style={arrow}>‹</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ font: "800 30px/1 'Barlow Condensed',sans-serif", letterSpacing: '.04em', textTransform: 'uppercase', color: '#111' }}>{tr.months[month]} {year}</div>
              <div style={{ font: "500 12px 'Barlow',sans-serif", color: '#6B6860', marginTop: 3 }}>{tr.ofBooked(mBooked, n)} · {tr.forYou(countOf(me))}</div>
            </div>
            <div className="tap" onClick={next} style={arrow}>›</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '78px', gridAutoFlow: 'column', gridAutoColumns: 'minmax(0,1fr)', gap: 4, marginTop: 10, alignItems: 'end' }}>
            <div style={{ font: "600 11px 'Barlow',sans-serif", color: '#8A877F', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t.tapLane}</div>
            {fams.map((f, i) => (
              <div key={f.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
                <div style={{ font: "700 10px/1.1 'Barlow',sans-serif", color: i === me ? '#111' : '#8A877F', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                <div style={{ width: '100%', height: 24, borderRadius: 6, background: color(i), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 13px 'JetBrains Mono',monospace", boxShadow: i === me ? `0 0 0 2px #F6F4EF, 0 0 0 4px ${color(i)}` : 'none' }}>{i + 1}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding: '4px 12px 24px' }}>{rows}</div>
      </>
    );
  }

  // ───────────────────────── Activity ─────────────────────────
  function ActivityView() {
    return (
      <div style={{ padding: '16px 12px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ padding: '0 4px', font: "800 26px/1 'Barlow Condensed',sans-serif", letterSpacing: '.04em', textTransform: 'uppercase', color: '#111' }}>{t.activity}</div>
        {bursts.length === 0 && <div style={{ padding: '30px 10px', textAlign: 'center', color: '#8A877F', font: "500 14px 'Barlow',sans-serif" }}>{t.noChanges}</div>}
        {bursts.map(e => {
          const i = idxOf(e.family_id);
          return (
            <div key={e.id} className="tap hov-ring" onClick={() => setSheetId(e.id)} style={{ background: '#fff', borderRadius: 14, padding: 12, display: 'grid', gridTemplateColumns: '34px minmax(0,1fr) auto', gap: 12, alignItems: 'center', boxShadow: '0 1px 0 rgba(0,0,0,.06)' }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: color(i), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 15px 'JetBrains Mono',monospace" }}>{i + 1}</div>
              <div style={{ minWidth: 0 }}>
                {burstLines(e).map((l, k) => <div key={k} style={{ font: "600 15px/1.25 'Barlow',sans-serif", color: '#111', textWrap: 'pretty' }}>{l}</div>)}
                {e.notified && <div style={{ display: 'flex', marginTop: 5 }}><div style={{ font: "600 11px 'Barlow',sans-serif", color: '#0E6B45', background: '#E3F3EA', borderRadius: 5, padding: '2px 6px' }}>{t.notified} ✓</div></div>}
              </div>
              <div style={{ font: "500 11px 'JetBrains Mono',monospace", color: '#8A877F', textAlign: 'right' }}>{ago(e.created_at)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  // "Wolfe booked Mon 4 – Sat 9 Jan 2027", one line per block of days.
  function burstLines(b: Burst) {
    const who = fams[idxOf(b.family_id)]?.name || '';
    return [...b.booked.map(r => `${who} ${tr.booked} ${fmtRange(r[0], r[1], lang)}`), ...b.removed.map(r => `${who} ${tr.removed} ${fmtRange(r[0], r[1], lang)}`),
      ...b.notes.map(([day, note]) => `✎ ${fmt(day, lang)}: ${note}`)];
  }

  function PushAsk() {
    const iphone = db.needsHomeScreen();
    const btn: React.CSSProperties = { height: 52, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 16px 'Barlow',sans-serif" };
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 45, background: 'rgba(17,18,20,.45)', display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ width: '100%', background: '#F6F4EF', borderRadius: '22px 22px 0 0', padding: '10px 16px max(28px, calc(env(safe-area-inset-bottom) + 16px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ width: 40, height: 5, borderRadius: 3, background: '#D6D2C7', alignSelf: 'center' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: RED, position: 'relative', flex: 'none' }}>
              <div style={{ position: 'absolute', left: 17, top: 9, width: 10, height: 26, background: '#fff' }} />
              <div style={{ position: 'absolute', left: 9, top: 17, width: 26, height: 10, background: '#fff' }} />
            </div>
            <div style={{ font: "800 22px/1.05 'Barlow Condensed',sans-serif", textTransform: 'uppercase', letterSpacing: '.03em', color: '#111' }}>{t.pushAskTitle}</div>
          </div>
          <div style={{ font: "500 15px/1.45 'Barlow',sans-serif", color: '#3A3A3A' }}>{iphone ? t.pushIphone : t.pushAskBody}</div>
          {iphone
            ? <div className="tap press" onClick={() => setPushAskHidden(true)} style={{ ...btn, background: '#111214', color: '#fff' }}>OK</div>
            : <div className="tap press" onClick={enablePush} style={{ ...btn, background: RED, color: '#fff', opacity: pushBusy ? 0.6 : 1 }}>{t.pushAskYes}</div>}
          <div className="tap" onClick={disablePush} style={{ ...btn, height: 40, color: '#6B6860', fontWeight: 600, fontSize: 14 }}>{t.pushAskNo}</div>
        </div>
      </div>
    );
  }

  function Sheet(a: Burst) {
    const i = idxOf(a.family_id);
    const who = fams[i]?.name || '';
    const first = [...a.booked, ...a.removed].map(r => r[0]).concat(a.notes.map(n => n[0])).sort()[0];
    const [yy, mm] = first.split('-').map(Number);
    const lines = burstLines(a);
    return (
      <div onClick={() => setSheetId(null)} style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(17,18,20,.45)', display: 'flex', alignItems: 'flex-end' }}>
        <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#F6F4EF', borderRadius: '22px 22px 0 0', padding: '10px 14px max(40px, calc(env(safe-area-inset-bottom) + 20px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ width: 40, height: 5, borderRadius: 3, background: '#D6D2C7', alignSelf: 'center' }} />
          <div style={{ font: "700 12px 'Barlow',sans-serif", letterSpacing: '.1em', textTransform: 'uppercase', color: '#6B6860' }}>{t.details} · {ago(a.created_at)}</div>
          <div style={{ background: '#fff', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #EEEBE4', color: '#111', font: "700 15px 'Barlow',sans-serif" }}>{lines.map((l, k) => <div key={k}>{l}</div>)}</div>
            <div style={{ height: 4, background: color(i) }} />
            <div style={{ padding: 14, font: "500 15px/1.45 'Barlow',sans-serif", color: '#222' }}>
              {a.booked.map((r, k) => { const w = fmtRange(r[0], r[1], lang); return <div key={'b' + k}>{tr.bodyBooked(who, w, Number(r[0].slice(0, 4)))}</div>; })}
              {a.removed.map((r, k) => <div key={'r' + k}>{tr.bodyRemoved(who, fmtRange(r[0], r[1], lang))}</div>)}
              <div className="tap hov-dark" onClick={() => { setSheetId(null); go('month', { year: yy, month: mm - 1 }); }} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, background: RED, color: '#fff', borderRadius: 9, height: 44, padding: '0 16px', font: "700 14px 'Barlow',sans-serif" }}>{t.openCal} ›</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ───────────────────────── Settings ─────────────────────────
  function SettingsView() {
    const m = meFam!;
    const toggleRow = (label: string, sub: string, on: boolean, onClick: () => void, busy = false) => (
      <div className="tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 56, borderTop: '1px solid #EEEBE4', opacity: busy ? 0.5 : 1 }}>
        <div><div style={{ font: "600 16px 'Barlow',sans-serif", color: '#111' }}>{label}</div><div style={{ font: "500 12px 'Barlow',sans-serif", color: '#6B6860' }}>{sub}</div></div>
        <div style={{ width: 50, height: 30, borderRadius: 999, background: on ? '#0E8A5A' : '#D6D2C7', position: 'relative', flex: 'none', transition: 'background .2s' }}>
          <div style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .2s' }} />
        </div>
      </div>
    );
    const toggleEmail = () => {
      const v = !m.notify_email;
      setFamilies(fs => fs && fs.map(f => f.id === m.id ? { ...f, notify_email: v } : f));
      db.setMyPrefs(v, lang).catch(() => { showToast({ msg: tr.offline, sub: '', kind: 'warn' }); reloadFamilies(); });
    };
    const togglePush = () => (pushOn ? disablePush() : enablePush());
    const label: React.CSSProperties = { font: "700 12px 'Barlow',sans-serif", letterSpacing: '.1em', textTransform: 'uppercase', color: '#6B6860' };
    const smallBtn: React.CSSProperties = { height: 32, padding: '0 10px', borderRadius: 8, border: '1.5px solid #D6D2C7', display: 'flex', alignItems: 'center', font: "600 13px 'Barlow',sans-serif", color: '#3A3A3A' };
    return (
      <div style={{ padding: '16px 12px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ font: "800 26px/1 'Barlow Condensed',sans-serif", letterSpacing: '.04em', textTransform: 'uppercase', color: '#111', padding: '0 4px' }}>{t.settings}</div>

        <div style={{ background: '#fff', borderRadius: 14, padding: 14, display: 'grid', gridTemplateColumns: '40px minmax(0,1fr) auto', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: color(me) }} />
          <div style={{ minWidth: 0 }}>
            <div style={label}>{t.signedIn}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <div style={{ font: "700 17px/1.2 'Barlow',sans-serif", color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
              {iAmAdmin && AdminTag()}
            </div>
            <div style={{ font: "500 13px 'Barlow',sans-serif", color: '#6B6860', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{myEmail}</div>
          </div>
          <div className="tap hov-red" onClick={() => supabase.auth.signOut()} style={{ height: 40, padding: '0 12px', borderRadius: 10, border: '1.5px solid #D6D2C7', display: 'flex', alignItems: 'center', font: "600 14px 'Barlow',sans-serif", color: '#111' }}>{t.logout}</div>
        </div>

        <div style={{ background: '#fff', borderRadius: 14, padding: '6px 14px' }}>
          <div style={{ ...label, padding: '8px 0 4px' }}>{t.families}</div>
          {!iAmAdmin && <div style={{ font: "500 13px/1.4 'Barlow',sans-serif", color: '#6B6860', padding: '0 0 8px' }}>{tr.adminOnly(fams[adminIdx]?.name || '')}</div>}
          {fams.map((f, i) => (
            <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 10, alignItems: 'start', padding: '10px 0', borderTop: '1px solid #EEEBE4' }}>
              <div style={{ width: 28, height: 28, marginTop: 6, borderRadius: 6, background: color(i) }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                {iAmAdmin ? (
                  <>
                    <NameInput fam={f} onSave={saveName} className="field" placeholder={t.namePh} style={fieldStyle(16, 40)} />
                    <EmailList t={t} emails={emailsOf(f.id)} myEmail={myEmail || ''}
                      onChange={changeEmail} onAdd={email => addEmail(f.id, email)} onRemove={removeEmail} />
                  </>
                ) : (
                  <div style={{ paddingTop: 2 }}>
                    <div style={{ font: "600 16px/1.3 'Barlow',sans-serif", color: '#111' }}>{f.name}</div>
                    {emailsOf(f.id).map(e => <div key={e} style={{ font: "500 13px 'Barlow',sans-serif", color: '#6B6860', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e}</div>)}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {f.is_admin && AdminTag('3px 6px')}
                  {iAmAdmin && !f.is_admin && confirmAdmin !== i && <div className="tap hov-red" onClick={() => setConfirmAdmin(i)} style={smallBtn}>{t.makeAdmin}</div>}
                  {iAmAdmin && confirmAdmin === i && (
                    <>
                      <div style={{ font: "500 13px/1.3 'Barlow',sans-serif", color: '#111', flexBasis: '100%' }}>{tr.confirmAdmin(f.name)}</div>
                      <div className="tap" onClick={async () => {
                        setConfirmAdmin(null);
                        try { await db.setAdmin(f.id); showToast({ msg: tr.nowAdmin(f.name), sub: emailsOf(f.id).join(', '), kind: 'ok' }); }
                        catch { showToast({ msg: tr.offline, sub: '', kind: 'warn' }); }
                        reloadFamilies();
                      }} style={{ ...smallBtn, border: 'none', padding: '0 12px', background: RED, color: '#fff', fontWeight: 700 }}>{t.confirm}</div>
                      <div className="tap" onClick={() => setConfirmAdmin(null)} style={{ ...smallBtn, padding: '0 12px' }}>{t.cancel}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          {iAmAdmin && fams.length < COLORS.length && <AddFamily key={fams.length} t={t} usedColors={fams.map(f => f.color_idx)} onAdd={addFam} />}
        </div>

        <div style={{ background: '#fff', borderRadius: 14, padding: '6px 14px' }}>
          <div style={{ ...label, padding: '8px 0 4px' }}>{t.notifyMe}</div>
          {toggleRow('Email', t.emailMe, m.notify_email, toggleEmail)}
          {toggleRow(t.push, t.pushMe, pushOn, togglePush, pushBusy)}
          {!pushOn && db.needsHomeScreen() && <div style={{ font: "500 12px/1.4 'Barlow',sans-serif", color: '#6B6860', padding: '4px 0 10px' }}>{t.pushIphone}</div>}
        </div>
      </div>
    );
  }

  // ── Small pieces used above ──
  function AdminTag(pad = '2px 5px') {
    return <div style={{ flex: 'none', font: "700 10px 'Barlow',sans-serif", letterSpacing: '.08em', color: '#fff', background: RED, borderRadius: 4, padding: pad }}>ADMIN</div>;
  }
}

function fieldStyle(size: number, h: number, weight = 600, col = '#111'): React.CSSProperties {
  return { border: '1.5px solid #E2DED4', borderRadius: 9, outline: 'none', font: `${weight} ${size}px 'Barlow',sans-serif`, color: col, height: h, padding: '0 10px', background: '#FAF9F6', width: '100%' };
}

// ── Input boxes (kept outside App so they don't lose what you're typing) ──
// Name/email boxes save when you leave the box or press Enter.
const blurOnEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };

function NameInput({ fam, onSave, style, className, placeholder }: { fam: Family; onSave: (f: Family, name: string) => void; style: React.CSSProperties; className?: string; placeholder?: string }) {
  const [v, setV] = useState(fam.name);
  useEffect(() => setV(fam.name), [fam.name]);
  const save = () => { const name = v.trim(); if (!name || name === fam.name) setV(fam.name); else onSave(fam, name); };
  return <input value={v} onChange={e => setV(e.target.value)} onBlur={save} onKeyDown={blurOnEnter} placeholder={placeholder} className={className} style={style} />;
}

// All addresses of one team (admin view): change, remove (✕) or add another.
// A team keeps at least one address, and you can't remove the one you're logged in with.
function EmailList({ t, emails, myEmail, onChange, onAdd, onRemove }: {
  t: Strings['ui']; emails: string[]; myEmail: string;
  onChange: (oldEmail: string, newEmail: string) => Promise<boolean>; onAdd: (email: string) => Promise<boolean>; onRemove: (email: string) => void;
}) {
  const [adding, setAdding] = useState('');
  const valid = (e: string) => /\S+@\S+\.\S+/.test(e);
  const add = async () => { const e = adding.trim().toLowerCase(); if (valid(e) && await onAdd(e)) setAdding(''); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {emails.map(e => (
        <div key={e} style={{ display: 'flex', gap: 6 }}>
          <OneEmail email={e} placeholder={t.emailPh} onSave={onChange} />
          {emails.length > 1 && e !== myEmail &&
            <div className="tap hov-red" title={t.removeEmail} onClick={() => onRemove(e)} style={{ flex: 'none', width: 36, height: 36, borderRadius: 9, border: '1.5px solid #E2DED4', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 16px 'Barlow',sans-serif", color: '#8A877F' }}>✕</div>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="email" autoCapitalize="none" value={adding} onChange={ev => setAdding(ev.target.value)} onKeyDown={ev => ev.key === 'Enter' && add()}
          placeholder={t.addEmailPh} className="field" style={{ ...fieldStyle(14, 36, 500, '#3A3A3A'), borderStyle: 'dashed' }} />
        <div className="tap" onClick={add} style={{ flex: 'none', height: 36, padding: '0 12px', borderRadius: 9, background: valid(adding.trim()) ? RED : '#E2DED4', color: '#fff', display: 'flex', alignItems: 'center', font: "700 14px 'Barlow',sans-serif" }}>{t.add}</div>
      </div>
    </div>
  );
}

function OneEmail({ email, placeholder, onSave }: { email: string; placeholder: string; onSave: (oldEmail: string, newEmail: string) => Promise<boolean> }) {
  const [v, setV] = useState(email);
  useEffect(() => setV(email), [email]);
  const save = async () => {
    const e = v.trim().toLowerCase();
    if (!e || e === email) { setV(email); return; }
    if (!(await onSave(email, e))) setV(email);
  };
  return <input type="email" autoCapitalize="none" value={v} onChange={ev => setV(ev.target.value)} onBlur={save} onKeyDown={blurOnEnter} placeholder={placeholder} className="field" style={fieldStyle(14, 36, 500, '#3A3A3A')} />;
}

function AddFamily({ t, usedColors, onAdd }: { t: Strings['ui']; usedColors: number[]; onAdd: (name: string, emails: string[], colorIdx: number) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [email2, setEmail2] = useState('');
  if (!open) {
    return <div className="tap hov-dash" onClick={() => setOpen(true)} style={{ margin: '6px 0 10px', height: 46, borderRadius: 10, border: `2px dashed ${RED}`, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, font: "700 15px 'Barlow',sans-serif" }}><span style={{ fontSize: 20, lineHeight: 1 }}>+</span>{t.addFamily}</div>;
  }
  const free = COLORS.findIndex((_, i) => !usedColors.includes(i));
  const valid = (e: string) => /\S+@\S+\.\S+/.test(e.trim());
  const ok = !!name.trim() && valid(email) && (!email2.trim() || valid(email2));
  const emails = [email, email2].map(e => e.trim().toLowerCase()).filter(Boolean);
  const save = async () => { if (ok && await onAdd(name.trim(), emails, free)) setOpen(false); };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 10, padding: '10px 0', borderTop: '1px solid #EEEBE4' }}>
      <div style={{ width: 28, height: 28, marginTop: 6, borderRadius: 6, background: COLORS[free] }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t.namePh} className="field" style={fieldStyle(16, 40)} />
        <input type="email" autoCapitalize="none" value={email} onChange={e => setEmail(e.target.value)} placeholder={t.emailPh} className="field" style={fieldStyle(14, 36, 500, '#3A3A3A')} />
        <input type="email" autoCapitalize="none" value={email2} onChange={e => setEmail2(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} placeholder={t.email2Ph} className="field" style={fieldStyle(14, 36, 500, '#3A3A3A')} />
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="tap" onClick={save} style={{ height: 36, padding: '0 14px', borderRadius: 8, background: RED, color: '#fff', display: 'flex', alignItems: 'center', font: "700 14px 'Barlow',sans-serif", opacity: ok ? 1 : 0.5 }}>{t.add}</div>
          <div className="tap" onClick={() => setOpen(false)} style={{ height: 36, padding: '0 14px', borderRadius: 8, border: '1.5px solid #D6D2C7', display: 'flex', alignItems: 'center', font: "600 14px 'Barlow',sans-serif", color: '#3A3A3A' }}>{t.cancel}</div>
        </div>
      </div>
    </div>
  );
}

// ── Note on a day: everyone can read it, only the family who booked can write ──
function NoteSheet({ t, title, note, owner, ownerColor, mine, onClose, onSave }: {
  t: Strings['ui']; title: string; note: string; owner: string | null; ownerColor: string; mine: boolean;
  onClose: () => void; onSave: (text: string) => void;
}) {
  const [text, setText] = useState(note);
  const btn: React.CSSProperties = { height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 15px 'Barlow',sans-serif", flex: 1 };
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(17,18,20,.45)', display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#F6F4EF', borderRadius: '22px 22px 0 0', padding: '10px 14px max(28px, calc(env(safe-area-inset-bottom) + 16px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ width: 40, height: 5, borderRadius: 3, background: '#D6D2C7', alignSelf: 'center' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, background: ownerColor, flex: 'none' }} />
          <div style={{ font: "800 22px/1.05 'Barlow Condensed',sans-serif", textTransform: 'uppercase', letterSpacing: '.03em', color: '#111' }}>{title}</div>
        </div>
        <div style={{ font: "600 13px 'Barlow',sans-serif", color: '#6B6860' }}>{owner === null ? t.dayFree : t.bookedBy(owner)}</div>
        {mine ? (
          <>
            <textarea value={text} onChange={e => setText(e.target.value.slice(0, 200))} placeholder={t.notePh} rows={3} autoFocus
              className="field" style={{ border: '1.5px solid #E2DED4', borderRadius: 12, outline: 'none', font: "500 16px/1.4 'Barlow',sans-serif", color: '#111', padding: '10px 12px', background: '#fff', width: '100%', resize: 'none' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              {note && <div className="tap" onClick={() => onSave('')} style={{ ...btn, border: '1.5px solid #D6D2C7', color: '#3A3A3A', fontWeight: 600 }}>{t.removeNote}</div>}
              <div className="tap press" onClick={() => onSave(text)} style={{ ...btn, background: RED, color: '#fff' }}>{t.saveNote}</div>
            </div>
          </>
        ) : (
          <>
            <div style={{ background: '#fff', borderRadius: 12, padding: '12px 14px', font: "500 16px/1.4 'Barlow',sans-serif", color: note ? '#111' : '#8A877F', minHeight: 48 }}>{note || t.noNote}</div>
            <div style={{ font: "500 12px/1.4 'Barlow',sans-serif", color: '#6B6860' }}>{owner === null ? t.bookFirst : t.noteOnlyOwner(owner)}</div>
            <div className="tap" onClick={onClose} style={{ ...btn, flex: 'none', border: '1.5px solid #D6D2C7', color: '#3A3A3A', fontWeight: 600 }}>OK</div>
          </>
        )}
      </div>
    </div>
  );
}
