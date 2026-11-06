# Schluechti Planner

The shared calendar for booking the Wengen chalet. Built from the Claude Design
prototype in `../design_handoff/`.

**Everything is free:** GitHub stores the code, Supabase stores the data and the
logins, Vercel puts the app online.

## How it works

- Each family has a coloured lane. You can only tap days in **your own** lane.
- A day can belong to one family only. If it's taken, you'll see who has it.
- Everyone's phone updates live when someone books or releases a day.
- **Activity** lists every change. The red number shows changes you haven't seen yet.
- **Settings**: the admin (currently Wolfe) can rename families, change their
  emails, add new families (up to 8) and hand the admin role to someone else.

## Logging in

Everyone uses the **same family password: `wengen`**. Open the app, type your
email and the password, and tap **Log in**. That's all, even the first time.

Only emails on the family list can log in. To add someone, the admin goes to
**Settings → Add family**. They can then log in with their email and `wengen`.

(Anyone who knows a family email and `wengen` can log in. That's fine for a
family calendar, but don't reuse `wengen` for anything important.)

## Notes on days

Tap the **date** on the left of a day in the month view to read its note. On
days you've booked you can write one, such as "arriving at 19h". Everyone sees
notes under the date (✎). Only the family who booked a day can change its note.
Notes are included in the notification emails, and a note added later also
sends one message, after the same 10 quiet minutes.

## Notifications

When a family books or releases days, the **other** families get:
- an **email** (sent from the Gmail address in the settings file), and
- a **push notification** on every phone where it's switched on.

The app waits until you've made **no changes for 10 minutes**, then sends **one**
message covering all the days you changed. For example, booking a whole week
gives one email: "Wolfe booked Mon 4 – Sat 9 Jan 2027". If you book a day and
release it again within that time, nobody is told. The database does this
itself (a timer that checks every minute), so it works even after you close
the app. The Activity list groups changes the same way.

Each family chooses in **Settings** whether they want emails, and switches on
push notifications for each phone. **On iPhone:** open the app in Safari, tap
**Share ⬆︎ → Add to Home Screen**, open it from the Home Screen, then switch
on "Push notifications". Apple only allows this for apps on the Home Screen.

## Staying awake

Free Supabase projects go to sleep after 7 days without use. Vercel runs a
small check every morning (`api/keepalive.ts`, scheduled in `vercel.json`),
which counts as use, so the database never sleeps. Vercel itself never sleeps.

## One-time setup

### 1. Supabase (database)
1. In your Supabase project, open **SQL Editor** in the left menu and click **New query**.
2. Open `supabase/setup.sql` from this folder, copy all of it, paste it in, and click **Run**.
   You should see "Success. No rows returned".
3. Go to **Authentication → Sign In / Providers → Email** and switch **off**
   "Confirm email". Click **Save**.

### 2. Gmail App Password (so the app can send emails)
1. Go to **myaccount.google.com/security** and make sure **2-Step Verification** is on.
2. Go to **myaccount.google.com/apppasswords**, type the name `Schluechti`, and
   click **Create**.
3. Google shows a 16-letter password. Paste it after `GMAIL_APP_PASSWORD=` in
   `.env.local`. This is **not** your normal Gmail password. It's a separate key just for this
   app, and you can cancel it on the same page at any time. Keep it secret like a password.

### 3. The settings file `.env.local`
It's already in this folder, with the push keys filled in. Add the two Supabase
values from **Project Settings → API**, plus the Gmail App Password. **Never**
upload this file to GitHub or share it.

### 4. Put it online (Vercel)
Upload this folder to a GitHub repository (`.env.local` is left out
automatically). In Vercel, choose **Add New → Project** and pick the repository.
Under **Environment Variables**, paste the whole contents of `.env.local`.
Click **Deploy**.

## For whoever programs this later

- `src/App.tsx`: all screens. `src/Login.tsx`: the login screen.
  `src/i18n.ts`: all English and German text.
- `src/data.ts`: the only browser file that talks to Supabase.
- `api/notify-due.ts`: sends the emails and push notifications (runs on Vercel). The database's timer
  (`pg_cron`, set up at the end of `setup.sql`) calls it every minute while a change has waited 10+ minutes.
  `api/keepalive.ts`: the daily keep-awake check. `public/sw.js`: shows push notifications on the phone.
- `supabase/setup.sql`: tables, security rules, and the `toggle_day` /
  `set_admin` / `claim_due_notifications` functions. Bookings can only be changed through
  those functions, and the database itself blocks double-booking.
- Run locally: `npm install`, then `npm run dev`.
