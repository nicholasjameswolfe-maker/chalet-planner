// Sends the email + push notifications. Runs on Vercel.
// The database calls this every minute (pg_cron, see supabase/setup.sql) while
// some family has made changes and then been quiet for 10 minutes. Each such
// family's changes go out as ONE message: "Wolfe booked Mon 4 – Sat 9 Jan".
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import webpush from 'web-push';

const COLORS = ['#1F4FD1', '#0E8A5A', '#E0870B', '#7A3FD6', '#C2185B', '#0F8C9E', '#6D4C2F', '#4A5568'];
type Lang = 'en' | 'de';
type Claim = {
  actor: { name: string; color_idx: number };
  changes: { action: 'booked' | 'removed' | 'note'; day: string }[];
  notes: { day: string; note: string }[];
  emails: { email: string; lang: Lang }[];
  phones: { endpoint: string; p256dh: string; auth: string; lang: Lang }[];
};

const WD = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] };
const MON = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], de: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'] };
const WORD = { en: { booked: 'booked', removed: 'released' }, de: { booked: 'gebucht', removed: 'freigegeben' } };

function fmt(day: string, l: Lang, withYear = true) {
  const [y, m, d] = day.split('-').map(Number);
  const wd = WD[l][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const s = l === 'de' ? `${wd} ${d}. ${MON[l][m - 1]}` : `${wd} ${d} ${MON[l][m - 1]}`;
  return withYear ? `${s} ${y}` : s;
}
const range = ([a, b]: [string, string], l: Lang) => (a === b ? fmt(a, l) : `${fmt(a, l, a.slice(0, 4) !== b.slice(0, 4))} – ${fmt(b, l)}`);
const nextDay = (day: string) => new Date(Date.parse(day + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);

// Book + release of the same day cancel out (e.g. "Undo"). Then join
// neighbouring days into ranges: 1, 2, 3 Feb → "1 – 3 Feb".
export function summarise(changes: Claim['changes']) {
  const net = new Map<string, number>();
  for (const c of changes) if (c.action !== 'note') net.set(c.day, (net.get(c.day) || 0) + (c.action === 'booked' ? 1 : -1));
  const out: Record<'booked' | 'removed', [string, string][]> = { booked: [], removed: [] };
  for (const [day, n] of [...net].sort(([a], [b]) => a.localeCompare(b))) {
    if (n === 0) continue;
    const list = out[n > 0 ? 'booked' : 'removed'];
    const last = list[list.length - 1];
    if (last && nextDay(last[1]) === day) last[1] = day; else list.push([day, day]);
  }
  return out;
}

export function lines(name: string, s: ReturnType<typeof summarise>, l: Lang, notes: Claim['notes'] = []) {
  const changed = (['booked', 'removed'] as const).flatMap(a => s[a].map(r => (l === 'de' ? `Team ${name} hat ${range(r, l)} ${WORD[l][a]}` : `Team ${name} ${WORD[l][a]} ${range(r, l)}`)));
  // Notes: "✎ Sat 9 Jan 2027: arriving at 19h". Only notes → a heading first.
  const noteLines = notes.map(n => `✎ ${fmt(n.day, l)}: ${n.note}`);
  if (!changed.length && noteLines.length) changed.push(l === 'de' ? `Team ${name} hat eine Notiz geschrieben:` : `Team ${name} added a note:`);
  return [...changed, ...noteLines];
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  const url = process.env.VITE_SUPABASE_URL!, key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
  if (!secret || !url || !key) return new Response('unauthorised', { status: 401 });

  // The database checks the secret itself, then hands over the due changes
  // (marking them as sent so nothing goes out twice).
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc('claim_due_notifications', { p_secret: secret });
  if (error) return new Response(error.message, { status: 403 });

  const appUrl = new URL(request.url).origin;
  const results = { emails: 0, phones: 0, errors: [] as string[] };
  for (const claim of data as Claim[]) await send(claim, appUrl, sb, secret, results);
  if (results.errors.length) console.error(results.errors);
  return Response.json(results);
}

type Results = { emails: number; phones: number; errors: string[] };

async function send(claim: Claim, appUrl: string, sb: SupabaseClient, secret: string, results: Results) {
  const s = summarise(claim.changes);
  const notes = claim.notes || [];
  if (!s.booked.length && !s.removed.length && !notes.length) return;
  const changeCount = s.booked.length + s.removed.length;
  const color = COLORS[claim.actor.color_idx] || COLORS[0];

  // ── Emails ──
  const gUser = process.env.GMAIL_USER, gPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  if (gUser && gPass && claim.emails.length) {
    const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: gUser, pass: gPass } });
    await Promise.all(claim.emails.map(async r => {
      const l = r.lang;
      const ls = lines(claim.actor.name, s, l, notes);
      const subject = changeCount === 1 || changeCount === 0 ? ls[0].replace(/:$/, '') : l === 'de' ? `Team ${claim.actor.name} hat ${changeCount} Zeiträume geändert` : `Team ${claim.actor.name} changed ${changeCount} dates`;
      const button = l === 'de' ? 'Kalender öffnen' : 'Open calendar';
      const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px">
        <div style="background:#DA291C;color:#fff;padding:14px 16px;font-weight:800;letter-spacing:.04em;text-transform:uppercase">✚ Schluechti Planner</div>
        <div style="height:4px;background:${color}"></div>
        <div style="padding:16px;font-size:15px;line-height:1.5;color:#222">${ls.map(x => `<div>${esc(x)}</div>`).join('')}
        <a href="${appUrl}" style="display:inline-block;margin-top:14px;background:#DA291C;color:#fff;text-decoration:none;border-radius:9px;padding:12px 16px;font-weight:700">${button} ›</a></div></div>`;
      try {
        await mail.sendMail({ from: `"Schluechti Planner" <${gUser}>`, to: r.email, subject, text: ls.join('\n') + '\n\n' + appUrl, html });
        results.emails++;
      } catch (e) { results.errors.push('email ' + r.email + ': ' + (e as Error).message); }
    }));
  }

  // ── Push notifications ──
  const pub = process.env.VITE_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv && claim.phones.length) {
    webpush.setVapidDetails('mailto:' + (gUser || 'admin@example.com'), pub, priv);
    await Promise.all(claim.phones.map(async p => {
      const body = lines(claim.actor.name, s, p.lang, notes).join('\n');
      try {
        await webpush.sendNotification({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, JSON.stringify({ title: 'Schluechti Planner', body, url: appUrl }));
        results.phones++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.rpc('forget_push_subscription', { p_secret: secret, p_endpoint: p.endpoint }); // phone unsubscribed
        else results.errors.push('push: ' + (e as Error).message);
      }
    }));
  }
}
