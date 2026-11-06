// Free Supabase projects go to sleep after 7 days without use. Vercel calls
// this once a day (see vercel.json), which counts as use, so it never sleeps.
// If the database does NOT answer, it emails the admin (GMAIL_USER) right away.
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

export async function GET() {
  const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  let error: string | undefined;
  try {
    const r = await sb.rpc('email_status', { p_email: 'keepalive' });
    if (r.error) error = r.error.message;
  } catch (e) {
    error = (e as Error).message;
  }

  if (error) await alarm(error).catch(e => console.error('alarm email failed', e));
  return Response.json({ ok: !error, at: new Date().toISOString(), error });
}

async function alarm(error: string) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  if (!user || !pass) return;
  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await mail.sendMail({
    from: `"Schluechti Planner" <${user}>`,
    to: user,
    subject: '⚠️ Schluechti Planner: database is not answering',
    text: [
      'The daily check could not reach the Schluechti Planner database (Supabase).',
      'The app will not load bookings until this is fixed. No data is lost.',
      '',
      'What to do:',
      '1. Go to https://supabase.com/dashboard and sign in with GitHub.',
      '2. Open the project "chalet-planner".',
      '3. If it says "Paused", click "Restore project" and wait a few minutes.',
      '4. Open https://schluechti-planner.vercel.app to check it works again.',
      '',
      'Technical detail: ' + error,
    ].join('\n'),
  });
}
