// Everything that talks to Supabase lives in this one file.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configured = !!(url && key);
export const supabase = createClient(url || 'https://missing.supabase.co', key || 'missing');

export type Family = {
  id: number; name: string; color_idx: number; is_admin: boolean;
  notify_email: boolean; lang: 'en' | 'de'; activity_seen_at: string;
};
export type TeamEmail = { email: string; family_id: number };
export type Booking = { day: string; family_id: number; note: string | null; half: boolean };
export type Activity = { id: number; family_id: number; action: 'booked' | 'removed' | 'note'; day_from: string; day_to: string; created_at: string; notified_at: string | null; note?: string | null };

export const COLORS = ['#1F4FD1', '#0E8A5A', '#E0870B', '#7A3FD6', '#C2185B', '#0F8C9E', '#6D4C2F', '#4A5568'];

export async function loadFamilies() {
  const { data, error } = await supabase.from('families').select('*').order('color_idx');
  if (error) throw error;
  return data as Family[];
}

// All login/notification addresses of all teams (several per team).
export async function loadTeamEmails() {
  const { data, error } = await supabase.from('team_emails').select('email, family_id').order('created_at');
  if (error) throw error;
  return data as TeamEmail[];
}

export async function addTeamEmail(familyId: number, email: string) {
  const { error } = await supabase.from('team_emails').insert({ email, family_id: familyId });
  if (error) throw error;
}

export async function removeTeamEmail(email: string) {
  const { error } = await supabase.from('team_emails').delete().eq('email', email);
  if (error) throw error;
}

export async function changeTeamEmail(oldEmail: string, newEmail: string) {
  const { error } = await supabase.from('team_emails').update({ email: newEmail }).eq('email', oldEmail);
  if (error) throw error;
}

export async function loadBookings() {
  // Supabase returns at most 1000 rows per request, so page through them.
  const all: Booking[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('bookings').select('day, family_id, note, half').order('day').range(from, from + 999);
    if (error) throw error;
    all.push(...(data as Booking[]));
    if (data.length < 1000) return all;
  }
}

export async function loadActivity() {
  const { data, error } = await supabase.from('activity').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data as Activity[];
}

// 'full' = whole apartment, 'half' = half the apartment (two families can share a day).
export type DayState = 'full' | 'half' | 'free';
export type SetDayResult = { status: 'ok'; action: 'booked' | 'removed' | 'changed' | 'none' } | { status: 'taken'; family_id: number };

export async function setDay(day: string, state: DayState) {
  const { data, error } = await supabase.rpc('set_day', { p_day: day, p_state: state });
  if (error) throw error;
  return data as SetDayResult;
}

// Write (or clear, with '') the note on one of my booked days.
export async function setDayNote(day: string, note: string) {
  const { data, error } = await supabase.rpc('set_day_note', { p_day: day, p_note: note });
  if (error) throw error;
  return (data as { status: 'ok' | 'not_yours' }).status;
}

export async function setAdmin(familyId: number) {
  const { error } = await supabase.rpc('set_admin', { p_family_id: familyId });
  if (error) throw error;
}

export async function setMyPrefs(email: boolean, lang: 'en' | 'de') {
  const { error } = await supabase.rpc('set_my_prefs', { p_email: email, p_lang: lang });
  if (error) throw error;
}

// ── Notifications ──

const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
export const pushSupported = () => !!vapid && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhones only allow push for apps added to the Home Screen.
export const needsHomeScreen = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as { standalone?: boolean }).standalone && !matchMedia('(display-mode: standalone)').matches;

export async function pushIsOn() {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && (await reg.pushManager.getSubscription()) && Notification.permission === 'granted');
}

export async function turnPushOn(): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(vapid!.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - vapid!.length % 4) % 4)), c => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  const j = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', { p_endpoint: sub.endpoint, p_p256dh: j.keys!.p256dh, p_auth: j.keys!.auth });
  if (error) throw error;
  return 'ok';
}

export async function turnPushOff() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  await supabase.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
}

export async function markActivitySeen() {
  const { error } = await supabase.rpc('mark_activity_seen');
  if (error) throw error;
}

export async function updateFamily(id: number, patch: { name?: string }) {
  const { error } = await supabase.from('families').update(patch).eq('id', id);
  if (error) throw error;
}

// New team with its first email addresses (all or nothing).
export async function addFamily(name: string, emails: string[], colorIdx: number) {
  const { data, error } = await supabase.rpc('add_team', { p_name: name, p_emails: emails, p_color: colorIdx });
  if (error) throw error;
  if ((data as { status: string }).status !== 'ok') throw new Error('email_in_use');
}

export async function emailStatus(email: string) {
  const { data, error } = await supabase.rpc('email_status', { p_email: email });
  if (error) throw error;
  return data as 'unknown' | 'new' | 'existing';
}
