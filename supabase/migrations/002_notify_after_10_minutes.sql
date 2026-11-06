-- Notifications go out after 10 minutes without changes, sent by the
-- database's own timer (pg_cron), so it works even when phones are closed.
-- Already applied to the live project on 2026-10-06; also folded into setup.sql.

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

-- The app no longer sends notifications itself.
drop function if exists public.claim_notifications();

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
