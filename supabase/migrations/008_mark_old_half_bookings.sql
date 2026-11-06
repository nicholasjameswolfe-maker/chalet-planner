-- OPTIONAL, after 007. Old bookings whose NOTE says it was half the apartment.
--
-- Step A: run ONLY this SELECT first and check the list.
select b.day, f.name as team, b.note
from public.bookings b join public.families f on f.id = b.family_id
where b.note ~* '(half|halb|hälfte|demi|1/2|½)'
order by b.day;

-- Step B: if every row in the list really was half the apartment, run this:
-- update public.bookings set half = true
-- where note ~* '(half|halb|hälfte|demi|1/2|½)';
--
-- (Remove the two "-- " at the start of the lines above, then Run.)
-- A row that is wrong can be fixed in the app afterwards: tap the day in
-- your lane until it shows the right state.
