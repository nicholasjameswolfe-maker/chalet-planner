-- Notes on booked days ("arriving at 19h"). Everyone can read them; only the
-- family that booked the day can write. Releasing the day removes its note.
alter table public.bookings add column if not exists note text check (char_length(note) <= 200);

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
