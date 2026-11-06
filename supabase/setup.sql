-- Schluechti Planner — complete database setup.
-- Paste this whole file into Supabase → SQL Editor → "New query" → Run.
-- Safe to run once on a fresh project.

-- ───────────────────────── Tables ─────────────────────────

create table public.families (
  id               bigint generated always as identity primary key,
  name             text not null,
  email            text not null unique,
  color_idx        int  not null unique check (color_idx between 0 and 7),
  is_admin         boolean not null default false,
  notify_email     boolean not null default true,
  lang             text not null default 'en' check (lang in ('en', 'de')),
  activity_seen_at timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
-- Only one family can be the admin at a time.
create unique index families_one_admin on public.families (is_admin) where is_admin;

-- One row per booked day. The day is the primary key, so two families can
-- never book the same day (the prototype's "allowOverlap = false" rule).
create table public.bookings (
  day        date primary key,
  family_id  bigint not null references public.families (id) on delete cascade,
  note       text check (char_length(note) <= 200),   -- e.g. "arriving at 19h"
  created_at timestamptz not null default now()
);

create table public.activity (
  id         bigint generated always as identity primary key,
  family_id  bigint not null references public.families (id) on delete cascade,
  action     text not null check (action in ('booked', 'removed', 'note')),
  note       text,                   -- for action 'note': the new note text
  day_from   date not null,
  day_to     date not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz            -- when the email/push went out
);
create index activity_created_at on public.activity (created_at desc);

-- One row per phone that switched on push notifications.
create table public.push_subscriptions (
  endpoint   text primary key,
  family_id  bigint not null references public.families (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Emails are always stored lower-case so logins match.
create function public.families_normalize() returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  new.name  := trim(new.name);
  return new;
end $$;
create trigger families_normalize before insert or update on public.families
  for each row execute function public.families_normalize();

-- ───────────────────────── Helpers ─────────────────────────

-- The family of whoever is logged in (matched by email), or null.
create function public.my_family_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from public.families where email = lower(auth.jwt() ->> 'email')
$$;

create function public.i_am_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.families where email = lower(auth.jwt() ->> 'email')), false)
$$;

-- ───────────────────────── Security rules (RLS) ─────────────────────────

alter table public.families enable row level security;
alter table public.bookings enable row level security;
alter table public.activity enable row level security;
alter table public.push_subscriptions enable row level security; -- no policies: only via functions

-- Any logged-in family member can see everything.
create policy "members read families" on public.families for select to authenticated using (public.my_family_id() is not null);
create policy "members read bookings" on public.bookings for select to authenticated using (public.my_family_id() is not null);
create policy "members read activity" on public.activity for select to authenticated using (public.my_family_id() is not null);

-- Only the admin can add families or change names/emails.
create policy "admin adds families" on public.families for insert to authenticated with check (public.i_am_admin() and not is_admin);
create policy "admin edits families" on public.families for update to authenticated using (public.i_am_admin()) with check (public.i_am_admin());

-- Bookings and activity are only changed through the functions below.

-- ───────────────────────── Actions ─────────────────────────

-- Tap a day in your own lane: books it if free, releases it if it's yours.
create function public.toggle_day(p_day date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint := public.my_family_id();
  cur bigint;
  act text;
  aid bigint;
begin
  if fam is null then raise exception 'not a family member'; end if;
  select family_id into cur from public.bookings where day = p_day for update;
  if cur = fam then
    delete from public.bookings where day = p_day;
    act := 'removed';
  elsif cur is not null then
    return jsonb_build_object('status', 'taken', 'family_id', cur);
  else
    begin
      insert into public.bookings (day, family_id) values (p_day, fam);
    exception when unique_violation then
      select family_id into cur from public.bookings where day = p_day;
      return jsonb_build_object('status', 'taken', 'family_id', cur);
    end;
    act := 'booked';
  end if;
  insert into public.activity (family_id, action, day_from, day_to)
    values (fam, act, p_day, p_day) returning id into aid;
  return jsonb_build_object('status', 'ok', 'action', act, 'activity_id', aid);
end $$;

-- Hand the admin role to another family (admin only).
create function public.set_admin(p_family_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.i_am_admin() then raise exception 'only the admin can do this'; end if;
  if not exists (select 1 from public.families where id = p_family_id) then raise exception 'no such family'; end if;
  update public.families set is_admin = false where is_admin;
  update public.families set is_admin = true where id = p_family_id;
end $$;

-- Your own settings: receive emails? which language?
create function public.set_my_prefs(p_email boolean, p_lang text) returns void
language sql security definer set search_path = public as $$
  update public.families set notify_email = p_email, lang = p_lang where id = public.my_family_id()
$$;

-- This phone wants push notifications (or not any more).
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_family_id() is null then raise exception 'not a family member'; end if;
  insert into public.push_subscriptions (endpoint, family_id, p256dh, auth)
    values (p_endpoint, public.my_family_id(), p_p256dh, p_auth)
    on conflict (endpoint) do update set family_id = excluded.family_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- Endpoints are long secret URLs, so knowing one is proof enough to remove it
-- (the notification server also uses this to clean up dead phones).
create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and public.my_family_id() is not null
$$;

-- Clears the red number on the Activity tab.
create function public.mark_activity_seen() returns void
language sql security definer set search_path = public as $$
  update public.families set activity_seen_at = now() where id = public.my_family_id()
$$;

-- Login screen: is this email on the family list, and does it have a password yet?
-- Returns 'unknown', 'new' or 'existing'.
create function public.email_status(p_email text) returns text
language sql stable security definer set search_path = public, auth as $$
  select case
    when not exists (select 1 from public.families where email = lower(trim(p_email))) then 'unknown'
    when exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) then 'existing'
    else 'new'
  end
$$;

-- Only people on the family list can create a login.
create function public.only_family_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.families where email = lower(new.email)) then
    raise exception 'not_on_family_list';
  end if;
  return new;
end $$;
create trigger only_family_signups before insert on auth.users
  for each row execute function public.only_family_signups();

-- Who may call what.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.my_family_id, public.i_am_admin, public.toggle_day, public.set_admin,
  public.set_my_prefs, public.save_push_subscription, public.remove_push_subscription,
  public.mark_activity_seen, public.email_status to authenticated;
grant execute on function public.email_status to anon;

-- Live updates: everyone's screen refreshes when anything changes.
alter publication supabase_realtime add table public.families, public.bookings, public.activity;

-- ───────────────────────── Starting data ─────────────────────────

insert into public.families (name, email, color_idx, is_admin) values
  ('Wolfe', 'nicholasjameswolfe@gmail.com', 0, true),
  ('Etter', 'nathalie.jacot@gmail.com',     1, false);

-- ───────────────────────── Notifications (10 minutes after the last change) ─────────────────────────
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- A private place for the timer's password. The "private" schema is not
-- reachable through the website API at all.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (key text primary key, value text not null);
alter table private.settings enable row level security; -- extra lock; only the functions below read it
insert into private.settings (key, value)
  values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;

-- Called by api/notify-due.ts (with the timer's password): returns, per family
-- that changed something and has been quiet for 10 minutes, what to send to whom
-- — and marks those changes as sent.
create or replace function public.claim_due_notifications(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint;
  changes jsonb;
  result jsonb := '[]';
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'cron_secret') then
    raise exception 'forbidden';
  end if;
  for fam in
    select family_id from public.activity
    where notified_at is null and created_at > now() - interval '2 days'
    group by family_id
    having max(created_at) < now() - interval '10 minutes'
  loop
    with c as (
      update public.activity set notified_at = now()
      where family_id = fam and notified_at is null and created_at > now() - interval '2 days'
      returning id, action, day_from
    )
    select coalesce(jsonb_agg(jsonb_build_object('action', action, 'day', day_from) order by id), '[]') into changes from c;
    result := result || jsonb_build_array(jsonb_build_object(
      'actor', (select jsonb_build_object('name', name, 'color_idx', color_idx) from public.families where id = fam),
      'changes', changes,
      'emails', (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'lang', lang)), '[]')
                 from public.families where id <> fam and notify_email),
      'phones', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'lang', f.lang)), '[]')
                 from public.push_subscriptions s join public.families f on f.id = s.family_id where s.family_id <> fam)
    ));
  end loop;
  return result;
end $$;

-- Lets the sender drop phones that no longer accept notifications.
create or replace function public.forget_push_subscription(p_secret text, p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_secret is distinct from (select value from private.settings where key = 'cron_secret') then raise exception 'forbidden'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
end $$;

revoke execute on function public.claim_due_notifications, public.forget_push_subscription from public;
grant execute on function public.claim_due_notifications, public.forget_push_subscription to anon, authenticated;

-- Every minute: if some change has been waiting 10+ minutes, ask the website
-- to send. (Nothing waiting = no call, so this costs nothing.)
select cron.unschedule('schluechti-notify') where exists (select 1 from cron.job where jobname = 'schluechti-notify');
select cron.schedule('schluechti-notify', '* * * * *', $job$
  select net.http_post(
    url := 'https://schluechti-planner.vercel.app/api/notify-due',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from private.settings where key = 'cron_secret')),
    body := '{}'::jsonb)
  where exists (select 1 from public.activity
                where notified_at is null and created_at > now() - interval '2 days'
                  and created_at < now() - interval '10 minutes')
$job$);

-- ───────────────────────── Notes on booked days ─────────────────────────
-- Notes on booked days ("arriving at 19h"). Everyone can read them; only the
-- family that booked the day can write. Releasing the day removes its note.
create or replace function public.set_day_note(p_day date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint := public.my_family_id();
begin
  if fam is null then raise exception 'not a family member'; end if;
  update public.bookings set note = nullif(trim(p_note), '')
    where day = p_day and family_id = fam;
  if not found then return jsonb_build_object('status', 'not_yours'); end if;
  return jsonb_build_object('status', 'ok');
end $$;

revoke execute on function public.set_day_note from public, anon;
grant execute on function public.set_day_note to authenticated;

-- ───────────────────────── Notes in notifications (newer versions of two functions above) ─────────────────────────
create or replace function public.set_day_note(p_day date, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint := public.my_family_id();
  old_note text;
  new_note text := nullif(trim(p_note), '');
begin
  if fam is null then raise exception 'not a family member'; end if;
  select note into old_note from public.bookings where day = p_day and family_id = fam;
  if not found then return jsonb_build_object('status', 'not_yours'); end if;
  if old_note is distinct from new_note then
    update public.bookings set note = new_note where day = p_day;
    insert into public.activity (family_id, action, day_from, day_to, note) values (fam, 'note', p_day, p_day, new_note);
  end if;
  return jsonb_build_object('status', 'ok');
end $$;

create or replace function public.claim_due_notifications(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint;
  changes jsonb;
  notes jsonb;
  result jsonb := '[]';
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'cron_secret') then
    raise exception 'forbidden';
  end if;
  for fam in
    select family_id from public.activity
    where notified_at is null and created_at > now() - interval '2 days'
    group by family_id
    having max(created_at) < now() - interval '10 minutes'
  loop
    with c as (
      update public.activity set notified_at = now()
      where family_id = fam and notified_at is null and created_at > now() - interval '2 days'
      returning id, action, day_from
    )
    select coalesce(jsonb_agg(jsonb_build_object('action', action, 'day', day_from) order by id), '[]') into changes from c;
    -- the current notes on the days that changed (only days still booked by this family)
    select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'note', b.note) order by b.day), '[]') into notes
      from public.bookings b
      where b.family_id = fam and b.note is not null
        and b.day in (select (x ->> 'day')::date from jsonb_array_elements(changes) x);
    result := result || jsonb_build_array(jsonb_build_object(
      'actor', (select jsonb_build_object('name', name, 'color_idx', color_idx) from public.families where id = fam),
      'changes', changes,
      'notes', notes,
      'emails', (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'lang', lang)), '[]')
                 from public.families where id <> fam and notify_email),
      'phones', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'lang', f.lang)), '[]')
                 from public.push_subscriptions s join public.families f on f.id = s.family_id where s.family_id <> fam)
    ));
  end loop;
  return result;
end $$;

-- ───────────────────────── Monthly CSV export ─────────────────────────
-- Monthly CSV export: on the last day of every month (18:00 UTC) the database
-- asks the website (api/export) to email all reservations as a .csv file.

-- All reservations, for the export (only with the timer's password).
create or replace function public.export_bookings(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'cron_secret') then
    raise exception 'forbidden';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'team', f.name, 'note', b.note, 'booked_at', b.created_at) order by b.day), '[]')
          from public.bookings b join public.families f on f.id = b.family_id);
end $$;
revoke execute on function public.export_bookings from public;
grant execute on function public.export_bookings to anon, authenticated;

-- "$" = last day of the month (pg_cron). 18:00 UTC = 19:00/20:00 in Switzerland.
select cron.unschedule('schluechti-monthly-export') where exists (select 1 from cron.job where jobname = 'schluechti-monthly-export');
select cron.schedule('schluechti-monthly-export', '0 18 $ * *', $job$
  select net.http_post(
    url := 'https://schluechti-planner.vercel.app/api/export',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from private.settings where key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000)
$job$);

-- ───────────────────────── Several email addresses per team (newer versions of functions above) ─────────────────────────
-- Several email addresses per team. Every address can log in (with the shared
-- password) and every address gets the team's notification emails.
-- The old single families.email column is kept (filled for old teams) but no
-- longer used by the app.

create table if not exists public.team_emails (
  email      text primary key,
  family_id  bigint not null references public.families (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists team_emails_family on public.team_emails (family_id);

create or replace function public.team_emails_normalize() returns trigger language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;
drop trigger if exists team_emails_normalize on public.team_emails;
create trigger team_emails_normalize before insert or update on public.team_emails
  for each row execute function public.team_emails_normalize();

-- Copy every team's current address across.
insert into public.team_emails (email, family_id)
  select email, id from public.families where email is not null
  on conflict (email) do nothing;

alter table public.families alter column email drop not null;

-- Who is logged in → which team (now via the address list).
create or replace function public.my_family_id() returns bigint
language sql stable security definer set search_path = public as $$
  select family_id from public.team_emails where email = lower(auth.jwt() ->> 'email')
$$;

create or replace function public.i_am_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select f.is_admin from public.families f where f.id = public.my_family_id()), false)
$$;

create or replace function public.email_status(p_email text) returns text
language sql stable security definer set search_path = public, auth as $$
  select case
    when not exists (select 1 from public.team_emails where email = lower(trim(p_email))) then 'unknown'
    when exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) then 'existing'
    else 'new'
  end
$$;

create or replace function public.only_family_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.team_emails where email = lower(new.email)) then
    raise exception 'not_on_family_list';
  end if;
  return new;
end $$;

-- Security: every member can see the list; only the admin can change it.
alter table public.team_emails enable row level security;
drop policy if exists "members read team emails" on public.team_emails;
drop policy if exists "admin adds team emails" on public.team_emails;
drop policy if exists "admin edits team emails" on public.team_emails;
drop policy if exists "admin removes team emails" on public.team_emails;
create policy "members read team emails" on public.team_emails for select to authenticated using (public.my_family_id() is not null);
create policy "admin adds team emails" on public.team_emails for insert to authenticated with check (public.i_am_admin());
create policy "admin edits team emails" on public.team_emails for update to authenticated using (public.i_am_admin()) with check (public.i_am_admin());
create policy "admin removes team emails" on public.team_emails for delete to authenticated using (public.i_am_admin());
grant select, insert, update, delete on public.team_emails to authenticated;

-- Notifications go to ALL addresses of the other teams.
create or replace function public.claim_due_notifications(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint;
  changes jsonb;
  notes jsonb;
  result jsonb := '[]';
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'cron_secret') then
    raise exception 'forbidden';
  end if;
  for fam in
    select family_id from public.activity
    where notified_at is null and created_at > now() - interval '2 days'
    group by family_id
    having max(created_at) < now() - interval '10 minutes'
  loop
    with c as (
      update public.activity set notified_at = now()
      where family_id = fam and notified_at is null and created_at > now() - interval '2 days'
      returning id, action, day_from
    )
    select coalesce(jsonb_agg(jsonb_build_object('action', action, 'day', day_from) order by id), '[]') into changes from c;
    select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'note', b.note) order by b.day), '[]') into notes
      from public.bookings b
      where b.family_id = fam and b.note is not null
        and b.day in (select (x ->> 'day')::date from jsonb_array_elements(changes) x);
    result := result || jsonb_build_array(jsonb_build_object(
      'actor', (select jsonb_build_object('name', name, 'color_idx', color_idx) from public.families where id = fam),
      'changes', changes,
      'notes', notes,
      'emails', (select coalesce(jsonb_agg(jsonb_build_object('email', e.email, 'lang', f.lang)), '[]')
                 from public.team_emails e join public.families f on f.id = e.family_id
                 where f.id <> fam and f.notify_email),
      'phones', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'lang', f.lang)), '[]')
                 from public.push_subscriptions s join public.families f on f.id = s.family_id where s.family_id <> fam)
    ));
  end loop;
  return result;
end $$;

-- Live updates when an address is added or removed.
do $$ begin
  alter publication supabase_realtime add table public.team_emails;
exception when duplicate_object then null; end $$;

-- Admin: create a team together with its addresses, all or nothing.
create or replace function public.add_team(p_name text, p_emails text[], p_color int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fid bigint;
  e text;
begin
  if not public.i_am_admin() then raise exception 'only the admin can do this'; end if;
  if coalesce(array_length(p_emails, 1), 0) = 0 then raise exception 'at least one email'; end if;
  foreach e in array p_emails loop
    if exists (select 1 from public.team_emails where email = lower(trim(e))) then
      return jsonb_build_object('status', 'email_in_use', 'email', lower(trim(e)));
    end if;
  end loop;
  insert into public.families (name, color_idx) values (trim(p_name), p_color) returning id into fid;
  insert into public.team_emails (email, family_id) select distinct lower(trim(x)), fid from unnest(p_emails) x where trim(x) <> '';
  return jsonb_build_object('status', 'ok', 'id', fid);
end $$;
revoke execute on function public.add_team from public, anon;
grant execute on function public.add_team to authenticated;
