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
