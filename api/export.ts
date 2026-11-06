// Monthly export: emails ALL reservations (all years) as a .csv file to the
// admin's Gmail (GMAIL_USER). Called by the database timer on the last day of
// every month (see supabase/migrations/005_monthly_export.sql).
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

type Row = { day: string; team: string; note: string | null; half?: boolean; booked_at: string };
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Semicolons + a BOM so Excel (Swiss/German settings) opens it in columns with umlauts intact.
const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const swiss = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}.${m}.${y}`; };

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  const url = process.env.VITE_SUPABASE_URL!, key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  if (!secret || !url || !key || !user || !pass) return new Response('unauthorised', { status: 401 });

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc('export_bookings', { p_secret: secret });
  if (error) return new Response(error.message, { status: 403 });
  const rows = data as Row[];

  const zurich = (iso: string) => new Date(iso).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' });
  const lines = [['Datum', 'Wochentag', 'Team', 'Wohnung', 'Notiz', 'Gebucht am'].join(';'),
    ...rows.map(r => [swiss(r.day), WD[new Date(r.day + 'T12:00:00Z').getUTCDay()], r.team, r.half ? 'halb' : 'ganz', r.note || '', zurich(r.booked_at)].map(cell).join(';'))];
  const csv = '﻿' + lines.join('\r\n') + '\r\n';

  // Short summary in the email body: days per team per year.
  const count = new Map<string, number>();
  for (const r of rows) { const k = `${r.day.slice(0, 4)}|${r.team}`; count.set(k, (count.get(k) || 0) + (r.half ? 0.5 : 1)); } // halbe Wohnung = ½ Tag
  const summary = [...count].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => { const [y, t] = k.split('|'); return `${y}  ${t}: ${n} Tage`; });

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Zurich' }));
  const label = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const file = `schluechti-reservationen-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.csv`;

  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await mail.sendMail({
    from: `"Schluechti Planner" <${user}>`, to: user,
    subject: `Schluechti Planner – alle Reservationen (Stand ${label})`,
    text: [`Im Anhang alle ${rows.length} gebuchten Tage (alle Jahre) als CSV-Datei – öffnet sich in Excel oder Numbers.`, '',
      'Übersicht:', ...(summary.length ? summary : ['(keine Reservationen)']), '', 'https://schluechti-planner.vercel.app'].join('\n'),
    attachments: [{ filename: file, content: csv, contentType: 'text/csv; charset=utf-8' }],
  });
  return Response.json({ sent: true, rows: rows.length, file });
}
