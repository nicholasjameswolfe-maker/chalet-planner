// Turns the day-by-day activity log into "bursts": everything one family
// changed in one go becomes ONE entry, e.g. "Wolfe booked Mon 4 – Sat 9 Jan".
// Same rules as the notification email (api/notify.ts).
import type { Activity } from './data';

export type Burst = {
  id: number;                    // id of the newest change in the burst
  family_id: number;
  created_at: string;            // time of the newest change
  notified: boolean;             // every change in it has been sent out
  booked: [string, string][];    // date ranges, oldest first
  removed: [string, string][];
  notes: [string, string][];     // [day, note] written in this burst
};

const GAP_MS = 2 * 60 * 1000; // changes less than 2 minutes apart belong together

const nextDay = (day: string) => new Date(Date.parse(day + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);

export function groupActivity(activity: Activity[]): Burst[] {
  // activity arrives newest first
  const bursts: Activity[][] = [];
  for (const a of activity) {
    const cur = bursts[bursts.length - 1];
    const prev = cur?.[cur.length - 1];
    if (prev && prev.family_id === a.family_id && Date.parse(prev.created_at) - Date.parse(a.created_at) < GAP_MS) cur.push(a);
    else bursts.push([a]);
  }
  return bursts.map(list => {
    // Book + release of the same day cancel out; then join neighbouring days.
    const net = new Map<string, number>();
    const noteOf = new Map<string, string | null>();
    for (const a of [...list].reverse()) {
      if (a.action === 'note') { noteOf.set(a.day_from, a.note ?? null); continue; }
      net.set(a.day_from, (net.get(a.day_from) || 0) + (a.action === 'booked' ? 1 : -1));
    }
    const out = { booked: [] as [string, string][], removed: [] as [string, string][] };
    for (const [day, n] of [...net].sort(([x], [y]) => x.localeCompare(y))) {
      if (n === 0) continue;
      const ranges = n > 0 ? out.booked : out.removed;
      const last = ranges[ranges.length - 1];
      if (last && nextDay(last[1]) === day) last[1] = day; else ranges.push([day, day]);
    }
    const notes = [...noteOf].filter((e): e is [string, string] => !!e[1]).sort(([x], [y]) => x.localeCompare(y));
    return { id: list[0].id, family_id: list[0].family_id, created_at: list[0].created_at, notified: list.every(a => a.notified_at), ...out, notes };
  }).filter(b => b.booked.length || b.removed.length || b.notes.length);
}
