// The red login screen: email + the family password on one screen.
// The first time an email logs in, its login is created automatically.
import { useState } from 'react';
import { emailStatus, supabase } from './data';
import type { Lang, Strings } from './i18n';

export default function Login({ tr, lang, setLang, initialError }: { tr: Strings; lang: Lang; setLang: (l: Lang) => void; initialError?: string }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  type Msg = 'unknownEmail' | 'wrongPassword' | 'offline' | 'confirm' | string;
  const [err, setErr] = useState<Msg>(initialError ? 'unknownEmail' : '');
  const [busy, setBusy] = useState(false);
  const t = tr.ui;

  async function login() {
    if (busy) return;
    const clean = email.trim().toLowerCase();
    setBusy(true); setErr('');
    try {
      const status = clean ? await emailStatus(clean) : 'unknown';
      if (status === 'unknown') setErr('unknownEmail');
      else if (pw.length < 6) setErr('wrongPassword');
      else if (status === 'existing') {
        const { error } = await supabase.auth.signInWithPassword({ email: clean, password: pw });
        if (error) setErr(/invalid/i.test(error.message) ? 'wrongPassword' : error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({ email: clean, password: pw });
        if (error) setErr(/database error/i.test(error.message) ? 'unknownEmail' : error.message);
        else if (!data.session) setErr('confirm');
      }
    } catch {
      setErr('offline');
    }
    setBusy(false);
  }

  const errText = err === 'unknownEmail' || err === 'wrongPassword' || err === 'offline' ? tr[err]
    : err === 'confirm' ? 'Supabase wants an email confirmation. In Supabase → Authentication → Sign In / Providers → Email, switch off “Confirm email”, then log in again.'
    : err;
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') login(); };
  const label: React.CSSProperties = { font: "600 13px 'Barlow',sans-serif", letterSpacing: '.1em', textTransform: 'uppercase', opacity: 0.9, marginBottom: 8 };
  const input: React.CSSProperties = { height: 52, border: 'none', outline: 'none', borderRadius: 12, padding: '0 14px', font: "600 17px 'Barlow',sans-serif", color: '#111', background: '#fff', width: '100%' };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80, background: '#DA291C', display: 'flex', flexDirection: 'column', padding: 'calc(48px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom))', color: '#fff', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flex: 'none' }}>
        <div style={{ width: 64, height: 64, position: 'relative', background: '#fff', borderRadius: 14 }}>
          <div style={{ position: 'absolute', left: 25, top: 12, width: 14, height: 40, background: '#DA291C' }} />
          <div style={{ position: 'absolute', left: 12, top: 25, width: 40, height: 14, background: '#DA291C' }} />
        </div>
        {/* Same EN/DE switch as in the app's red header */}
        <div className="tap" onClick={() => setLang(lang === 'en' ? 'de' : 'en')} style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,.18)', borderRadius: 999, padding: 3, height: 36 }}>
          {(['en', 'de'] as Lang[]).map(c => (
            <div key={c} style={{ height: 30, minWidth: 34, padding: '0 6px', borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 13px 'Barlow',sans-serif", background: lang === c ? '#fff' : 'transparent', color: lang === c ? '#DA291C' : '#fff' }}>{c.toUpperCase()}</div>
          ))}
        </div>
      </div>
      <div style={{ font: "800 44px/0.95 'Barlow Condensed',sans-serif", textTransform: 'uppercase', letterSpacing: '.02em', marginTop: 24 }}>Schluechti<br />Planner</div>
      <div style={{ height: 5, margin: '20px 0 28px', flex: 'none', background: 'repeating-linear-gradient(90deg,#fff 0 14px,transparent 14px 20px)' }} />

      <div style={label}>{t.yourEmail}</div>
      <input value={email} onChange={e => { setEmail(e.target.value); setErr(''); }} onKeyDown={onKey} type="email" autoComplete="username" autoCapitalize="none" placeholder="name@example.ch" style={input} />
      <div style={{ ...label, marginTop: 14 }}>{t.password}</div>
      <input value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} onKeyDown={onKey} type="password" autoComplete="current-password" autoCapitalize="none" placeholder="••••••" style={input} />
      <div className="tap press" onClick={login} style={{ marginTop: 14, height: 52, borderRadius: 12, background: '#111214', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "700 16px 'Barlow',sans-serif", opacity: busy ? 0.6 : 1 }}>{t.login}</div>

      {errText && <div style={{ marginTop: 12, background: '#fff', color: '#B3261E', borderRadius: 10, padding: '10px 12px', font: "600 14px/1.35 'Barlow',sans-serif" }}>{errText}</div>}
      <div style={{ flex: 1, minHeight: 24 }} />
    </div>
  );
}
