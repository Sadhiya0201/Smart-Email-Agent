/**
 * Smart Email Agent — backend (v3)
 * ----------------------------------------------------------
 * Pipeline:  Email -> AI extraction (structured JSON) -> alert text/voice written
 *            from that JSON -> AI accuracy analysis against the ORIGINAL email.
 *
 * Time-based escalation (applies to high/critical emails):
 *   far         more than FAR_MIN (120) min left : normal notification, no vibration, no voice
 *   approaching URGENT_MIN..FAR_MIN              : heads-up notification, more frequent reminders, no vibration/voice
 *   urgent      FINAL_MIN..URGENT_MIN (30) : notification + vibration/alarm + VOICE alert
 *   final       FINAL_MIN (10) or less     : same, repeats every 2 min
 *
 * Reschedules: a new email is matched (by AI) against existing events. If it is the
 * same event, the old schedule is replaced, old reminders are cancelled, and the
 * escalation timeline restarts from the new time. Unsure matches are flagged, and
 * both events are kept until you confirm in the app.
 *
 * Required in .env: GEMINI_API_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * Optional: TEST_KEY, TIMEZONE (default Asia/Kolkata),
 *           FAR_MIN, URGENT_MIN, FINAL_MIN
 * Required file: firebase-service-account.json
 * Run: npm start
 */

require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Settings ----------

const TZ_NAME = process.env.TIMEZONE || 'Asia/Kolkata';
const POLL_EVERY_MIN = 2;
const FAR_MIN = Number(process.env.FAR_MIN || 120);
const URGENT_MIN = Number(process.env.URGENT_MIN || 30);
const FINAL_MIN = Number(process.env.FINAL_MIN || 10);
const AUTO_MATCH = 0.8;  // at or above: treat as the same event and update it
const ASK_MATCH = 0.5;   // between ASK_MATCH and AUTO_MATCH: keep both, ask the user

const STAGES = ['far', 'approaching', 'urgent', 'final'];
const GAP_MIN = { far: 180, approaching: 15, urgent: 5, final: 2 }; // minutes between reminders
const CLOSED = ['done', 'dismiss', 'expired', 'cancelled', 'superseded'];
const LANG_CODES = {
  English: 'en-US', Telugu: 'te-IN', Hindi: 'hi-IN', Tamil: 'ta-IN',
  Kannada: 'kn-IN', Malayalam: 'ml-IN', Marathi: 'mr-IN', Bengali: 'bn-IN'
};

// ---------- Firebase (data-only push, works when the app is closed) ----------

const serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json'));
const firebaseApp = initializeApp({ credential: cert(serviceAccount) });

async function sendDataPush({ to, data }) {
  if (!to) return;
  try {
    await getMessaging(firebaseApp).send({
      token: to,
      data, // all values must be strings
      android: { priority: 'high' }
    });
  } catch (e) {
    console.error('FCM push error:', e.message);
    const dead =
      e.code === 'messaging/registration-token-not-registered' ||
      /not a valid FCM registration token/i.test(e.message);
    if (dead && state.device?.pushToken === to) {
      state.device.pushToken = null;
      saveState();
    }
  }
}

// ---------- Gemini ----------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

// Ask Gemini for a JSON object. Retries once.
async function askJson(prompt) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await geminiModel.generateContent(prompt);
      const m = result.response.text().match(/\{[\s\S]*\}/);
      if (!m) throw new Error('No JSON in Gemini reply');
      return JSON.parse(m[0]);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ---------- Gmail ----------

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

function getBodyText(payload) {
  const parts = [];
  (function walk(p) {
    if (!p) return;
    if (p.parts) p.parts.forEach(walk);
    else if (p.body?.data && /^text\/(plain|html)/.test(p.mimeType || '')) {
      parts.push({ type: p.mimeType, text: Buffer.from(p.body.data, 'base64url').toString('utf8') });
    }
  })(payload);
  const plain = parts.find(x => x.type === 'text/plain');
  const raw = plain
    ? plain.text
    : (parts[0]?.text || '')
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
  return raw.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// ---------- State (saved to state.json) ----------

const STATE_FILE = './state.json';

let state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE))
  : { seenIds: [], items: {}, device: null, monitoringSince: null };

state.seenIds = state.seenIds || [];
state.items = state.items || {};
state.device = state.device || null;
state.monitoringSince = state.monitoringSince || null;
state.filtered = state.filtered || []; // emails the AI judged unimportant (view only)

// Items saved by an older version have no structured data: retire them.
for (const id of Object.keys(state.items)) {
  if (!state.items[id].ev) state.items[id].status = 'expired';
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Helpers ----------

const toMs = iso => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function fmtTime(ms) {
  if (ms == null) return 'no set time';
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: TZ_NAME, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

const isHigh = item => ['high', 'critical'].includes(item.ev.priority);

// Live countdown in minutes (null when the email has no time).
function minutesLeft(item) {
  if (item.deadlineAt == null) return null;
  return (item.deadlineAt - Date.now()) / 60000;
}

function stageOf(item) {
  if (!isHigh(item)) return 'far'; // only high/critical emails escalate
  const left = minutesLeft(item);
  if (left === null || left > FAR_MIN) return 'far';
  if (left > URGENT_MIN) return 'approaching';
  if (left > FINAL_MIN) return 'urgent';
  return 'final';
}

const rankOf = s => STAGES.indexOf(s);

function senderDomain(from) {
  const m = String(from || '').match(/@([^>\s]+)/);
  return m ? m[1].toLowerCase() : '';
}

function compactEv(ev) {
  const { event, organization, eventAt, dateText, timeText, location, link, instructions, action } = ev;
  return { event, organization, eventAt, dateText, timeText, location, link, instructions, action };
}

function testKeyOk(key) {
  return !!process.env.TEST_KEY && key === process.env.TEST_KEY;
}

// ---------- Step 1: AI extraction (email -> structured JSON) ----------

function normalizeEvent(ev) {
  const str = v => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t && !['null', 'none', 'n/a'].includes(t.toLowerCase()) ? t : null;
  };
  return {
    category: str(ev.category) || 'Other',
    priority: ['critical', 'high', 'medium', 'low', 'none'].includes(ev.priority) ? ev.priority : 'medium',
    event: str(ev.event),
    organization: str(ev.organization),
    eventAt: str(ev.eventAt),
    dateText: str(ev.dateText),
    timeText: str(ev.timeText),
    location: str(ev.location),
    link: str(ev.link),
    instructions: str(ev.instructions),
    action: str(ev.action),
    requiresResponse: !!ev.requiresResponse,
    isUpdate: !!ev.isUpdate,
    updateKind: ['new', 'rescheduled', 'cancelled', 'confirmed'].includes(ev.updateKind) ? ev.updateKind : 'new',
    previousEventAt: str(ev.previousEventAt)
  };
}

async function extractEvent({ subject, from, text, receivedAt }) {
  const prompt = `You extract structured scheduling data from an email.

The email was received at ${new Date(receivedAt).toISOString()} (local time in ${TZ_NAME}: ${fmtTime(receivedAt)}).
Resolve words like "today", "tomorrow", "next Monday" against that time. Use the ${TZ_NAME} time zone unless the email states another.

Subject: ${subject}
From: ${from}
Body: ${text}

Return ONLY a JSON object with exactly these keys (use null when unknown):
category: Internship/Interview/Hackathon/Assessment/Exam/Meeting/Appointment/Registration/Deadline/Promotional/Social/Security/Other
priority: critical/high/medium/low/none
  (critical = needs action within hours; high = interview, exam, assessment, meeting or deadline with a fixed time;
   medium = other actionable email; low = informational; none = promotional, social or spam)
event: short event name, for example "Interview"
organization: company, person or institution
eventAt: ISO 8601 date-time WITH time zone offset of the moment that matters (start time or due time), or null
dateText: the date as written in the email
timeText: the time as written in the email
location: place or meeting platform
link: meeting or registration URL
instructions: the important instructions in one short sentence
action: short imperative instruction
requiresResponse: true or false
isUpdate: true if this email changes, reschedules, postpones, preponed, cancels or confirms an earlier event
updateKind: new/rescheduled/cancelled/confirmed
previousEventAt: ISO 8601 of the OLD time if the email mentions it, else null

No markdown. No explanations.`;

  return normalizeEvent(await askJson(prompt));
}

// ---------- Step 2: item creation, AI event matching and schedule updates ----------

function newItem({ id, subject, from, text, ev }) {
  return {
    id, emailIds: [id], subject, from, ev,
    sourceText: String(text || '').slice(0, 1500),
    deadlineAt: toMs(ev.eventAt),
    version: 1, history: [],
    status: 'open', snoozeUntil: null, createdAt: Date.now(),
    firstNotifiedAt: Date.now(), lastNotifiedAt: 0, lastStageRank: -1, seenRank: -1,
    alerts: [], analyzedKeys: [], pendingMatch: null
  };
}

function candidatesFor(ev, from) {
  const now = Date.now();
  const org = (ev.organization || '').toLowerCase();
  const kind = (ev.event || '').toLowerCase();
  return Object.values(state.items)
    .filter(it =>
      it.ev &&
      !['cancelled', 'superseded', 'expired'].includes(it.status) &&
      (it.deadlineAt == null || it.deadlineAt > now - 6 * 3600000) &&
      (senderDomain(it.from) === senderDomain(from) ||
        (org && (it.ev.organization || '').toLowerCase() === org) ||
        (kind && (it.ev.event || '').toLowerCase() === kind))
    )
    .slice(0, 6);
}

async function findMatch(ev, subject, from, cands) {
  const brief = c => ({
    id: c.id, from: c.from, subject: c.subject, event: c.ev.event,
    organization: c.ev.organization, startsAt: fmtTime(c.deadlineAt),
    location: c.ev.location, link: c.ev.link
  });

  const prompt = `A new email arrived. Decide whether it is an UPDATE to one of the existing events
(the same real-world event, for example the same interview that was rescheduled, postponed or preponed).

NEW EMAIL
${JSON.stringify({
    from, subject, event: ev.event, organization: ev.organization,
    startsAt: fmtTime(toMs(ev.eventAt)),
    previousStartsAt: ev.previousEventAt ? fmtTime(toMs(ev.previousEventAt)) : null,
    location: ev.location, link: ev.link, instructions: ev.instructions,
    isUpdate: ev.isUpdate, updateKind: ev.updateKind
  })}

EXISTING EVENTS
${JSON.stringify(cands.map(brief))}

Signals for the same event: same sender or company, same event type, same meeting link or location,
the old time mentioned in the new email matches an existing start time, words like rescheduled,
postponed, preponed, changed, updated, new time, revised schedule.
Different company or a different kind of event means they are NOT the same.
If unsure, give a low confidence.

Return ONLY JSON: {"matchId": "<id of the existing event, or null>", "confidence": <0 to 1>, "reason": "<short>"}`;

  const out = await askJson(prompt);
  const id = cands.find(c => c.id === out.matchId)?.id || null;
  return {
    matchId: id,
    confidence: id ? Math.max(0, Math.min(1, Number(out.confidence) || 0)) : 0,
    reason: String(out.reason || '').slice(0, 200)
  };
}

async function sendCancel(id) {
  if (state.device?.pushToken) {
    await sendDataPush({ to: state.device.pushToken, data: { type: 'cancel', emailId: id } });
  }
}

// Replace the old schedule with the new one and restart the escalation timeline.
async function applyUpdate(item, { id, subject, text, ev }) {
  const oldAt = item.deadlineAt;
  const newAt = toMs(ev.eventAt) ?? oldAt;

  if (ev.updateKind === 'cancelled') {
    item.status = 'cancelled';
    item.history.push({ at: Date.now(), emailId: id, kind: 'cancelled', fromAt: oldAt, toAt: null });
    saveState();
    await sendCancel(item.id);
    console.log(`Event cancelled: "${item.subject}"`);
    return;
  }

  for (const k of ['category', 'event', 'organization', 'location', 'link', 'instructions', 'action', 'dateText', 'timeText']) {
    if (ev[k]) item.ev[k] = ev[k];
  }
  if (ev.priority !== 'none') item.ev.priority = ev.priority;
  if (ev.eventAt) item.ev.eventAt = ev.eventAt;
  item.emailIds.push(id);
  item.sourceText = String(text || '').slice(0, 1500);

  const changed = oldAt != null && newAt != null ? Math.abs(newAt - oldAt) > 60000 : oldAt !== newAt;
  if (!changed) {
    saveState();
    return; // a confirmation with the same time: no duplicate alert
  }

  const kind = oldAt == null ? 'rescheduled' : newAt > oldAt ? 'postponed' : 'preponed';
  item.deadlineAt = newAt;
  item.version += 1;
  item.history.push({ at: Date.now(), emailId: id, kind, fromAt: oldAt, toAt: newAt });

  // The old schedule no longer takes part in escalation.
  Object.assign(item, {
    status: 'open', snoozeUntil: null, firstNotifiedAt: Date.now(), lastNotifiedAt: 0,
    lastStageRank: -1, seenRank: -1, pendingMatch: null
  });
  console.log(`Schedule ${kind}: "${item.subject}" ${fmtTime(oldAt)} -> ${fmtTime(newAt)}`);
  await sendAlert(item, { updateNote: `${kind}: was ${fmtTime(oldAt)}, now ${fmtTime(newAt)}` });
}

async function processEmail({ id, subject, from, text, receivedAt }) {
  const ev = await extractEvent({ subject, from, text, receivedAt });
  if (ev.priority === 'none') {
    state.filtered.unshift({
      emailId: id, subject, from,
      snippet: String(text || '').slice(0, 200),
      category: ev.category || 'Other',
      at: receivedAt || Date.now()
    });
    state.filtered = state.filtered.slice(0, 200);
    saveState();
    return { skipped: 'promotional or social email' };
  }

  let match = null;
  const cands = candidatesFor(ev, from);
  if (cands.length) {
    try {
      match = await findMatch(ev, subject, from, cands);
    } catch (e) {
      console.error('Event matching failed:', e.message);
    }
  }
  const target = match?.matchId ? state.items[match.matchId] : null;

  if (target && match.confidence >= AUTO_MATCH) {
    await applyUpdate(target, { id, subject, text, ev });
    return { action: 'updated existing event', eventId: target.id, confidence: match.confidence, reason: match.reason };
  }

  if (ev.updateKind === 'cancelled') return { skipped: 'cancellation for an event we are not tracking' };

  const item = newItem({ id, subject, from, text, ev });
  if (target && match.confidence >= ASK_MATCH) {
    item.pendingMatch = { matchId: target.id, confidence: match.confidence, reason: match.reason };
  }
  state.items[id] = item;
  saveState();
  await sendAlert(item);
  return { action: 'created new event', eventId: id, needsConfirmation: !!item.pendingMatch };
}

// ---------- Step 3: alert text (written from the structured data) ----------

async function buildAlert(item, stage, updateNote) {
  const d = state.device || {};
  const written = d.writtenLang || 'English';
  const voiceLang = d.voiceLang || written;
  const wantVoice = (stage === 'urgent' || stage === 'final') && d.notifyMode !== 'text';
  const ev = item.ev;
  const left = minutesLeft(item);

  const facts = {
    event: ev.event || ev.category,
    organization: ev.organization,
    startsAt: fmtTime(item.deadlineAt),
    minutesLeft: left == null ? null : Math.max(0, Math.round(left)),
    location: ev.location,
    hasMeetingLink: !!ev.link,
    instructions: ev.instructions,
    action: ev.action,
    scheduleChange: updateNote || null
  };

  const prompt = `Write a phone notification${wantVoice ? ' and a short spoken alert' : ''} using ONLY these facts. Do not invent anything and keep every date and time exactly right.

FACTS: ${JSON.stringify(facts)}
URGENCY STAGE: ${stage}

Rules:
- title: at most 60 characters. body: at most 140 characters, in ${written}.
- Never print a full URL; say "meeting link" if there is one.
- If scheduleChange is present, say clearly that the schedule changed and give the NEW time.
${wantVoice ? `- voice: one or two short sentences to be spoken aloud, in ${voiceLang}, including the time.` : '- voice: null'}

Return ONLY JSON: {"title": "", "body": "", "voice": ${wantVoice ? '""' : 'null'}}`;

  try {
    const out = await askJson(prompt);
    if (out.title && out.body) {
      return { title: String(out.title), body: String(out.body), voice: wantVoice && out.voice ? String(out.voice) : null };
    }
  } catch (e) {
    console.error('Alert generation failed, using plain template:', e.message);
  }

  const title = `${facts.event}${ev.organization ? ' - ' + ev.organization : ''}`;
  const body = `${facts.startsAt}${ev.instructions ? '. ' + ev.instructions : ''}`;
  return { title, body, voice: wantVoice ? `${title}. ${facts.startsAt}.` : null };
}

// ---------- Step 4: AI accuracy analysis (alert vs ORIGINAL email) ----------

const FIELD_WEIGHTS = { event: 20, date: 20, time: 25, organization: 10, location: 15, instructions: 10 };

// Overall = weighted average of the fields that exist in the email,
// minus 10 per incorrect fact and 3 per invented (extra) fact.
function scoreReport(r) {
  if (!r || typeof r !== 'object') return null;
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(FIELD_WEIGHTS)) {
    const s = r.fields?.[k];
    if (typeof s === 'number') {
      num += w * Math.max(0, Math.min(100, s));
      den += w;
    }
  }
  for (const k of ['matched', 'missing', 'incorrect', 'extra']) r[k] = Array.isArray(r[k]) ? r[k].map(String) : [];
  let overall = den ? num / den : 0;
  overall -= 10 * r.incorrect.length + 3 * r.extra.length;
  r.overall = Math.max(0, Math.min(100, Math.round(overall)));
  return r;
}

async function analyzeAlert(item, rec) {
  const left = minutesLeft(item);
  const prompt = `You verify how accurately app alerts represent an ORIGINAL email. Judge MEANING and facts, not exact wording. Alerts may be written in another language.

ORIGINAL EMAIL (ground truth)
Subject: ${item.subject}
From: ${item.from}
Body: ${item.sourceText}

DATA EXTRACTED FROM THE EMAIL (reference only)
${JSON.stringify(compactEv(item.ev))}

ALERTS TO CHECK
Notification: ${rec.title} - ${rec.body}
Voice alert: ${rec.voice || 'none'}

Context: about ${left == null ? 'unknown' : Math.round(left)} minutes were left when the alert was made, so statements about time remaining are allowed. An alert may say "meeting link" instead of printing a URL.

For each alert, score these fields from 0 to 100, or null if the original email does not contain that information:
event, date, time, organization, location, instructions
(100 = present and correct, lower if vague or missing, 0 if wrong.)
Also list short strings:
matched = correct information that was kept
missing = important information that was left out
incorrect = facts that contradict the email (say what the email says and what the alert says)
extra = information that is not in the email

Return ONLY JSON:
{"notification": {"fields": {"event": 0, "date": 0, "time": 0, "organization": 0, "location": 0, "instructions": 0}, "matched": [], "missing": [], "incorrect": [], "extra": [], "summary": ""},
 "voice": <same shape, or null if there is no voice alert>}`;

  const out = await askJson(prompt);
  rec.analysis = {
    at: Date.now(),
    notification: scoreReport(out.notification),
    voice: rec.voice ? scoreReport(out.voice) : null
  };
  saveState();
}

// ---------- Sending alerts ----------

async function sendAlert(item, opts = {}) {
  const stage = stageOf(item);
  const built = await buildAlert(item, stage, opts.updateNote);

  const rec = {
    at: Date.now(), stage, version: item.version,
    title: built.title, body: built.body, voice: built.voice, analysis: null
  };
  item.alerts.push(rec);
  if (item.alerts.length > 30) item.alerts = item.alerts.slice(-30);
  item.lastNotifiedAt = Date.now();
  item.lastStageRank = rankOf(stage);
  saveState();

  if (state.device?.pushToken) {
    await sendDataPush({
      to: state.device.pushToken,
      data: {
        type: 'alert',
        title: built.title,
        body: built.body,
        emailId: item.id,
        priority: item.ev.priority,
        stage,
        speak: built.voice ? '1' : '0',
        speakText: built.voice || '',
        speakLang: LANG_CODES[state.device.voiceLang] || 'en-US'
      }
    });
  }

  // Analyse the first alert of each stage (and of each schedule version), in the background.
  const key = `${item.version}:${stage}`;
  if (!item.analyzedKeys.includes(key)) {
    item.analyzedKeys.push(key);
    analyzeAlert(item, rec).catch(e => console.error('Accuracy analysis failed:', e.message));
  }
}

// ---------- Escalation (runs every minute) ----------

async function runEscalations() {
  if (!state.device) return;
  const now = Date.now();

  for (const id in state.items) {
    const item = state.items[id];
    if (!item.ev || CLOSED.includes(item.status)) continue;
    if (!isHigh(item)) continue;

    const left = minutesLeft(item);
    if (left !== null && left < -5) {
      item.status = 'expired';
      saveState();
      continue;
    }

    const stage = stageOf(item);
    const r = rankOf(stage);

    // "Seen" pauses alerts, but a closer stage escalates again.
    if (item.status === 'seen') {
      if (r > item.seenRank) item.status = 'open';
      else continue;
    }
    if (item.status === 'snooze') {
      if (item.snoozeUntil > now && stage !== 'final') continue;
      item.status = 'open';
    }

    // 1. Alert: immediately when a new stage starts, then at that stage's reminder gap.
    const gapMin = left === null ? 24 * 60 : GAP_MIN[stage];
    if (r > item.lastStageRank || now - item.lastNotifiedAt >= gapMin * 60000) {
      await sendAlert(item).catch(console.error);
    }
  }
}

// ---------- Routes ----------

app.get('/', (req, res) => res.send('Smart Email Agent backend OK'));

app.post('/register-device', (req, res) => {
  const b = req.body || {};

  let pushToken = b.pushToken || null;
  if (pushToken && String(pushToken).startsWith('ExponentPushToken')) {
    console.warn('Ignoring Expo push token. The app must send an FCM token.');
    pushToken = null;
  }

  if (!state.device || !state.monitoringSince) {
    state.monitoringSince = Date.now();
    console.log('Monitoring started. Only new emails from now on will be processed.');
  }

  state.device = {
    pushToken: pushToken || state.device?.pushToken || null,
    writtenLang: b.writtenLang || 'English',
    voiceLang: b.voiceLang || b.writtenLang || 'English',
    notifyMode: b.notifyMode || 'text+voice'
  };

  saveState();
  res.json({ ok: true });
});

// action: 'done' | 'dismiss' | 'snooze' | 'seen'
app.post('/ack', (req, res) => {
  const { emailId, action } = req.body || {};
  const item = state.items[emailId];

  if (item && ['done', 'dismiss', 'snooze', 'seen'].includes(action)) {
    if (action === 'seen') {
      if (!CLOSED.includes(item.status)) {
        item.status = 'seen';
        item.seenRank = rankOf(stageOf(item));
      }
    } else {
      item.status = action;
      if (action === 'snooze') {
        item.snoozeUntil = Date.now() + (Number(req.body.minutes) || 20) * 60000;
      }
    }
    saveState();
  }
  res.json({ ok: true });
});

// Emails the AI filtered out (promotional / social / no action). View only: no alerts.
app.get('/filtered', (req, res) => res.json({ filtered: state.filtered || [] }));

app.delete('/filtered', (req, res) => { state.filtered = []; saveState(); res.json({ ok: true }); });

app.get('/status', (req, res) => {
  res.json({ monitoringSince: state.monitoringSince, device: state.device });
});

function publicItem(it) {
  const scores = [];
  for (const a of it.alerts) {
    if (a.version !== it.version || !a.analysis) continue;
    for (const k of ['notification', 'voice']) {
      if (a.analysis[k] && typeof a.analysis[k].overall === 'number') scores.push(a.analysis[k].overall);
    }
  }
  const left = minutesLeft(it);
  return {
    id: it.id,
    subject: it.subject,
    from: it.from,
    status: it.status,
    createdAt: it.createdAt,
    stage: CLOSED.includes(it.status) ? null : stageOf(it),
    priority: it.ev.priority,
    event: {
      category: it.ev.category, event: it.ev.event, organization: it.ev.organization,
      when: fmtTime(it.deadlineAt), location: it.ev.location, link: it.ev.link,
      instructions: it.ev.instructions, action: it.ev.action
    },
    minutesLeft: left == null ? null : Math.round(left),
    version: it.version,
    history: it.history.map(h => ({ kind: h.kind, from: fmtTime(h.fromAt), to: h.toAt ? fmtTime(h.toAt) : null, at: h.at })),
    originalText: it.sourceText.slice(0, 700),
    pendingMatch: it.pendingMatch
      ? { ...it.pendingMatch, matchSubject: state.items[it.pendingMatch.matchId]?.subject }
      : null,
    alerts: it.alerts.slice(-6).reverse().map(a => ({
      at: a.at, stage: a.stage, version: a.version, title: a.title, body: a.body, voice: a.voice, analysis: a.analysis
    })),
    quality: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null
  };
}

app.get('/dashboard', (req, res) => {
  const items = Object.values(state.items)
    .filter(i => i.ev)
    .map(publicItem)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ monitoringSince: state.monitoringSince, now: Date.now(), items });
});

// The user answers "is this the same event?" for an uncertain match.
app.post('/resolve-match', async (req, res) => {
  const { emailId, same } = req.body || {};
  const item = state.items[emailId];
  if (!item?.pendingMatch) return res.status(404).json({ ok: false });

  const target = state.items[item.pendingMatch.matchId];
  item.pendingMatch = null;
  if (same && target) {
    item.status = 'superseded';
    saveState();
    await sendCancel(item.id);
    await applyUpdate(target, { id: item.id, subject: item.subject, text: item.sourceText, ev: item.ev });
  }
  saveState();
  res.json({ ok: true });
});

// ---------- Dataset export (needs TEST_KEY in .env) ----------
// /export?key=KEY&format=csv|json&redact=1
// Every email the agent has processed (actionable and filtered) as one dataset.
// redact=1 masks email addresses, phone numbers and links, and keeps only the sender domain.
function redactText(t) {
  return String(t == null ? '' : t)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, '[phone]');
}

function datasetRows(redact) {
  const r = v => (redact ? redactText(v) : String(v == null ? '' : v));
  const rows = [];
  for (const it of Object.values(state.items)) {
    if (!it.ev || String(it.id).startsWith('test')) continue;
    rows.push({
      id: it.id,
      received_at: new Date(it.createdAt).toISOString(),
      from: redact ? senderDomain(it.from) : it.from,
      subject: r(it.subject),
      body: r(it.sourceText),
      label: 'actionable',
      category: it.ev.category || '',
      priority: it.ev.priority || '',
      event: r(it.ev.event),
      organization: r(it.ev.organization),
      event_time: it.ev.eventAt || '',
      action: r(it.ev.action),
      requires_response: it.ev.requiresResponse ? 'true' : 'false',
      status: it.status
    });
  }
  for (const f of state.filtered || []) {
    if (String(f.emailId).startsWith('test')) continue;
    rows.push({
      id: f.emailId,
      received_at: new Date(f.at).toISOString(),
      from: redact ? senderDomain(f.from) : f.from,
      subject: r(f.subject),
      body: r(f.snippet),
      label: 'filtered',
      category: f.category || '',
      priority: 'none',
      event: '', organization: '', event_time: '', action: '',
      requires_response: 'false',
      status: 'filtered'
    });
  }
  return rows.sort((a, b) => a.received_at.localeCompare(b.received_at));
}

app.get('/export', (req, res) => {
  if (!testKeyOk(req.query.key)) return res.status(404).send('Not found');
  const rows = datasetRows(req.query.redact === '1');

  if (req.query.format === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="email-dataset.json"');
    return res.json(rows);
  }

  const cols = ['id', 'received_at', 'from', 'subject', 'body', 'label', 'category', 'priority',
    'event', 'organization', 'event_time', 'action', 'requires_response', 'status'];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const csv = '﻿' + [cols.join(',')].concat(rows.map(row => cols.map(c => q(row[c])).join(','))).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="email-dataset.csv"');
  res.send(csv);
});

// ---------- Test routes (need TEST_KEY in .env) ----------

// /test-push?key=KEY -> sends one bare notification straight through Firebase
// (no Gemini, no Gmail) and shows Firebase's exact answer.
app.get('/test-push', async (req, res) => {
  if (!testKeyOk(req.query.key)) return res.status(404).send('Not found');
  const token = state.device?.pushToken;
  if (!token) {
    return res.status(400).send('No push token saved. In the app tap Start monitoring and check it says "with a Firebase token".');
  }
  try {
    const id = await getMessaging(firebaseApp).send({
      token,
      data: {
        type: 'alert', title: 'Test notification', body: 'If you can read this, push works.',
        emailId: 'push-test', priority: 'high', stage: 'approaching',
        speak: '0', speakText: '', speakLang: 'en-US'
      },
      android: { priority: 'high' }
    });
    res.send(`Firebase accepted the message (${id}). If nothing appears on the phone, the problem is on the phone: notification permission, battery settings, or the app build.`);
  } catch (e) {
    res.status(500).send(`Firebase error ${e.code || ''}: ${e.message}`);
  }
});

// /test-alert?key=KEY&minutes=25  -> fake interview that many minutes from now
app.get('/test-alert', async (req, res) => {
  if (!testKeyOk(req.query.key)) return res.status(404).send('Not found');
  if (!state.device) return res.status(400).send('Register the app first.');

  const minutes = Number(req.query.minutes || 25);
  const at = Date.now() + minutes * 60000;
  const id = `test-${Date.now()}`;
  const ev = normalizeEvent({
    category: 'Interview', priority: 'critical', event: 'Interview', organization: 'ABC Technologies',
    eventAt: new Date(at).toISOString(), timeText: fmtTime(at), location: 'Google Meet',
    link: 'https://meet.google.com/abc-defg-hij', instructions: 'Join 10 minutes before the interview',
    action: 'Join the meeting'
  });
  const item = newItem({
    id, subject: 'Interview with ABC Technologies', from: 'hr@abctech.example',
    text: `Your interview with ABC Technologies is scheduled for ${fmtTime(at)}. Please join the Google Meet link 10 minutes before the interview.`,
    ev
  });
  state.items[id] = item;
  saveState();
  await sendAlert(item);
  res.send(`Test alert sent for an interview in ${minutes} minutes (stage: ${stageOf(item)}). Open the dashboard in the app to see the accuracy analysis.`);
});

// /test-email?key=KEY&from=hr@abc.com&subject=...&text=...  -> runs a fake email through the full pipeline
app.all('/test-email', async (req, res) => {
  const p = { ...req.query, ...(req.body || {}) };
  if (!testKeyOk(p.key)) return res.status(404).send('Not found');
  try {
    const result = await processEmail({
      id: `test-${Date.now()}`,
      subject: p.subject || '(test)',
      from: p.from || 'test@example.com',
      text: p.text || '',
      receivedAt: Date.now()
    });
    res.json(result);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ---------- Poll Gmail (only after the user has logged in) ----------

async function handleNewEmail(id) {
  const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const headers = full.data.payload.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
  const from = headers.find(h => h.name === 'From')?.value || 'unknown';
  const text = getBodyText(full.data.payload) || full.data.snippet || '';
  const receivedAt = Number(full.data.internalDate) || Date.now();

  await processEmail({ id, subject, from, text, receivedAt });

  state.seenIds.push(id);
  if (state.seenIds.length > 500) state.seenIds = state.seenIds.slice(-500);
  saveState();
}

async function pollGmail() {
  if (!state.device || !state.monitoringSince) return;

  const list = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults: 25,
    q: `after:${Math.floor(state.monitoringSince / 1000)}`
  });

  const messages = (list.data.messages || []).reverse(); // oldest first, so updates come after originals
  for (const m of messages) {
    if (state.seenIds.includes(m.id)) continue;
    try {
      await handleNewEmail(m.id);
    } catch (e) {
      console.error('Could not process email', m.id, e.message);
    }
  }
}

// ---------- Schedulers (a run never overlaps the previous one) ----------

function every(ms, fn) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(`${fn.name} error:`, e.message);
    } finally {
      busy = false;
    }
  };
  setInterval(run, ms);
  run();
}

every(POLL_EVERY_MIN * 60 * 1000, pollGmail);
every(60 * 1000, runEscalations);

// ---------- Start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Email Agent backend running on port ${PORT}`);
  console.log('Push token saved:', state.device?.pushToken ? 'yes' : 'NO');
  console.log(`Stages: normal > ${FAR_MIN} min, alarm + voice at ${URGENT_MIN} min or less, repeating every 2 min at ${FINAL_MIN} min or less`);
});