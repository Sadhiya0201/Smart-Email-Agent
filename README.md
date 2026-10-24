# Smart Email Agent — real setup guide

This is a working two-part system: a **backend** that watches your Gmail and
a **phone app** that alarms you. Total setup time: ~30–45 min, all free tier
except a couple dollars a month if you keep the backend running 24/7 long-term.

## Part 1 — Anthropic API key (for classification + translation)
1. console.anthropic.com → Get an API key.
2. Put it in `backend/.env` as `ANTHROPIC_API_KEY`.

## Part 2 — Gmail API access
1. Go to console.cloud.google.com → create a project.
2. Enable the **Gmail API**.
3. Create OAuth 2.0 credentials (Desktop app type) → download client ID + secret.
4. Use Google's OAuth Playground (developers.google.com/oauthplayground) with your
   own client ID/secret in the settings gear, scope `https://www.googleapis.com/auth/gmail.readonly`,
   authorize with your Gmail account, and exchange for a **refresh token**.
5. Put client ID, secret, and refresh token into `backend/.env`.

## Part 3 — Firebase (push notifications, free)
1. console.firebase.google.com → create a project.
2. Project settings → Service accounts → Generate new private key.
3. Save the downloaded file as `backend/firebase-service-account.json`.
4. Add the Firebase config to your Expo app (needed for push tokens) —
   `npx expo install expo-notifications` and follow Expo's one-time
   "Configure push notifications" step at docs.expo.dev/push-notifications/push-notifications-setup/
   (this generates the `projectId` used in `App.js`).

## Part 4 — Twilio (call escalation, optional but you asked for it)
1. twilio.com/try-twilio → free trial account (trial gives you a real
   number and small call credit; upgrade later removes the trial-account
   voice prompt at the start of each call).
2. Console home page → copy **Account SID** and **Auth Token** into `.env`.
3. Get a phone number (Twilio gives you one free on trial) → put it in
   `.env` as `TWILIO_FROM_NUMBER` (E.164 format, e.g. `+1xxxxxxxxxx`).
4. Deploy the backend somewhere public first (Render/Railway — see Part 6),
   then put that public URL in `.env` as `PUBLIC_BASE_URL`. Twilio needs to
   reach your server mid-call for the "press 1 to mark done" step.
5. On a Twilio **trial** account, it can only call numbers you've verified
   in the console (Phone Numbers → Verified Caller IDs) — add your own
   number there first, or upgrade the account to call any number.
6. In the mobile app's setup screen, enter your phone number (E.164 format)
   in the "critical call escalation" field. Leave it blank any time to
   turn calls off again — everything else keeps working.

Note: Twilio's built-in call voice supports English, Hindi, Tamil, Marathi,
Bengali natively. Telugu/Kannada/Malayalam aren't in Twilio's call-voice list
yet, so calls in those languages fall back to English — push notifications
and on-phone spoken alerts still use your real chosen language either way.

## Part 5 — Run the backend
```
cd backend
npm install
cp .env.example .env   # fill in your real keys
node server.js
```
It starts polling your inbox every 3 minutes immediately.
To keep it running when your laptop is off, deploy it for free/cheap on
Render.com or Railway.app (just point them at this folder, add the same
env vars + the firebase-service-account.json as a secret file).

## Part 6 — Run the phone app
```
cd mobile
npm install
npx expo start
```
Scan the QR code with the **Expo Go** app (install it from the Play
Store / App Store first — Expo Go itself is free and lets you run this
without publishing anywhere). Set `BACKEND_URL` at the top of `App.js`
to your deployed backend URL first.

## What you'll actually see
- Low/medium priority emails → normal notification, no alarm.
- High/critical priority (interview tomorrow, confirm-by-today, etc.) →
  full-screen alarm on your phone with sound + vibration, spoken aloud
  in your chosen voice language, with Dismiss/Snooze buttons that stop
  further escalation.
- If a critical one still isn't acknowledged ~15 min after the first push,
  and you've entered a phone number, it escalates to a real phone call
  (repeated every 30 min until you press 1 or mark it done in the app).

## What's intentionally not built yet
- **Multiple email providers** — currently Gmail only; Outlook/IMAP would
  reuse the same classification/push pipeline with a different mail-fetch module.
- **A proper database** — state is a local JSON file (`state.json`), fine
  for one user; swap for SQLite/Postgres if this grows.
