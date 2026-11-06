-- Notes go into the notification emails. Writing/changing a note is logged as
-- activity (action 'note'), so a note added later also sends one message
-- (after the same 10 quiet minutes).
alter table public.activity drop constraint if exists activity_action_check;
alter table public.activity add constraint activity_action_check check (action in ('booked', 'removed', 'note'));
alter table public.activity add column if not exists note text;

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
