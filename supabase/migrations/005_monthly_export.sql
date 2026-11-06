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
