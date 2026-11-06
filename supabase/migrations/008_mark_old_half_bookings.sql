-- After 007. Team Inserlis wrote "half" in the note instead of booking half
-- the apartment (there was no option yet). This turns those days into real
-- half-apartment bookings. Other teams' bookings are not touched.
--
-- STEP A: run ONLY this first. It lists every Inserlis booking that has a note,
-- and says which ones will become "half".
select b.day,
       f.name as team,
       b.note,
       case when b.note ~* '(half|halb|hälfte|demi|1/2|½|nur 2 pl)' then 'YES → half' else 'no' end as becomes_half
from public.bookings b join public.families f on f.id = b.family_id
where f.name ilike '%inserli%' and b.note is not null
order by b.day;

-- STEP B: only once the list in step A is right. Remove the "-- " at the
-- start of the two lines below, select ONLY those two lines, and click Run.
-- update public.bookings set half = true
-- where note ~* '(half|halb|hälfte|demi|1/2|½|nur 2 pl)' and family_id in (select id from public.families where name ilike '%inserli%');
