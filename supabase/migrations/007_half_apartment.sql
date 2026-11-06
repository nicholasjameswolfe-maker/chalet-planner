-- Half-apartment bookings.
-- A day can now be booked by ONE family for the whole apartment, or by up to
-- TWO families for half each. Whole + anything else on the same day is never
-- allowed. Existing bookings stay "whole apartment".
--
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run twice.

-- 1. Bookings: one row per (day, family) instead of one row per day.
alter table public.bookings add column if not exists half boolean not null default false;
do $$ begin
  if exists (select 1 from information_schema.key_column_usage
             where table_schema = 'public' and table_name = 'bookings'
               and constraint_name = 'bookings_pkey' and column_name = 'family_id') then
    return; -- already done
  end if;
  alter table public.bookings drop constraint bookings_pkey;
  alter table public.bookings add primary key (day, family_id);
end $$;

-- 2. Book / change / release one day for my family.
--    p_state: 'full' (whole apartment), 'half' or 'free'.
--    The rules are checked here, so two phones can never double-book.
create or replace function public.set_day(p_day date, p_state text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fam bigint := public.my_family_id();
  mine public.bookings;
  others int;
  other_full boolean;
  other_fid bigint;
  act text;
  aid bigint;
begin
  if fam is null then raise exception 'not a family member'; end if;
  if p_state not in ('full', 'half', 'free') then raise exception 'bad state'; end if;
  -- One change per day at a time (other days are not blocked).
  perform pg_advisory_xact_lock(hashtext('bookings'), p_day - date '2000-01-01');

  select * into mine from public.bookings where day = p_day and family_id = fam;
  select count(*), coalesce(bool_or(not half), false), min(family_id)
    into others, other_full, other_fid
    from public.bookings where day = p_day and family_id <> fam;

  if p_state = 'free' then
    if mine.day is null then return jsonb_build_object('status', 'ok', 'action', 'none'); end if;
    delete from public.bookings where day = p_day and family_id = fam;
    act := 'removed';
  else
    -- Whole apartment: nobody else that day. Half: at most one other half.
    if (p_state = 'full' and others > 0) or (p_state = 'half' and (other_full or others > 1)) then
      return jsonb_build_object('status', 'taken', 'family_id', other_fid);
    end if;
    if mine.day is null then
      insert into public.bookings (day, family_id, half) values (p_day, fam, p_state = 'half');
      act := 'booked';
    elsif mine.half is distinct from (p_state = 'half') then
      update public.bookings set half = (p_state = 'half') where day = p_day and family_id = fam;
      return jsonb_build_object('status', 'ok', 'action', 'changed');
    else
      return jsonb_build_object('status', 'ok', 'action', 'none');
    end if;
  end if;

  insert into public.activity (family_id, action, day_from, day_to)
    values (fam, act, p_day, p_day) returning id into aid;
  return jsonb_build_object('status', 'ok', 'action', act, 'activity_id', aid);
end $$;
revoke execute on function public.set_day from public, anon;
grant execute on function public.set_day to authenticated;

-- 3. The old "tap = book / release" still works (for phones that haven't
--    reloaded the new app yet): free → whole apartment, mine → free.
create or replace function public.toggle_day(p_day date) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.bookings where day = p_day and family_id = public.my_family_id()) then
    return public.set_day(p_day, 'free');
  end if;
  return public.set_day(p_day, 'full');
end $$;

-- 4. Notes: with two families on one day, only touch MY row's note.
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
    update public.bookings set note = new_note where day = p_day and family_id = fam;
    insert into public.activity (family_id, action, day_from, day_to, note) values (fam, 'note', p_day, p_day, new_note);
  end if;
  return jsonb_build_object('status', 'ok');
end $$;

-- 5. Monthly CSV export: include whether it was half the apartment.
create or replace function public.export_bookings(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'cron_secret') then
    raise exception 'forbidden';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('day', b.day, 'team', f.name, 'note', b.note, 'half', b.half, 'booked_at', b.created_at) order by b.day, f.name), '[]')
          from public.bookings b join public.families f on f.id = b.family_id);
end $$;
revoke execute on function public.export_bookings from public;
grant execute on function public.export_bookings to anon, authenticated;
