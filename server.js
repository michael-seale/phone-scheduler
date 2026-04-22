/**
 * Appointment Scheduler
 *
 * Routes:
 *   GET  /                      - customer booking page (public)
 *   GET  /admin                 - scheduler view (password-gated)
 *   GET  /login                 - admin login page
 *   POST /login                 - submit admin password
 *   POST /logout                - clear admin session
 *
 *   GET  /api/slots?date=YYYY-MM-DD   - list slots for a day w/ status
 *                                       (available | booked | blocked)
 *   GET  /api/next-available-dates    - next N weekdays with open slots
 *                                       (?count=5, max 30)
 *   POST /api/appointments            - book an appointment (public + external)
 *   GET  /api/appointments            - list appointments (admin-only)
 *   DELETE /api/appointments/:id      - cancel an appointment (admin-only)
 *
 *   GET  /api/blocks?date=YYYY-MM-DD  - list blocked slots (admin-only)
 *   POST /api/blocks                  - block one or more slots (admin-only)
 *                                       body: { date, times: ["10:00","10:30"], reason }
 *   DELETE /api/blocks/:id            - unblock a single slot (admin-only)
 *
 * Auth:
 *   - ADMIN_PASSWORD env var (default: "changeme") gates the /admin UI
 *     and the list/delete endpoints. A cookie "admin_token" is set on login.
 *   - API_KEY env var (optional). If set, POST /api/appointments requires
 *     header "X-API-Key: <key>" for external (non-browser) callers. Browser
 *     requests from the built-in booking page are allowed without a key
 *     (they are same-origin and include no key header).
 *
 * Conflict prevention:
 *   The appointments table has a UNIQUE(date, time) constraint, so a double
 *   booking is rejected at the database level regardless of which path
 *   (web form or external API) tries to insert it.
 */

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('node:fs');
const vm = require('node:vm');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const API_KEY = process.env.API_KEY || ''; // empty = external API is open
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'appointments.db');

// ---- Email notification settings ----------------------------------------
// When an appointment is booked, we send a notification email. Gmail /
// Google Workspace SMTP requires the From address to match the
// authenticated account, so the customer's email goes into Reply-To instead.
const SMTP_HOST  = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT  = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER  = process.env.SMTP_USER || '';
const SMTP_PASS  = process.env.SMTP_PASS || '';
const NOTIFY_TO  = process.env.NOTIFY_TO   || 'support@renewedvision.com';
const NOTIFY_FROM = process.env.NOTIFY_FROM || SMTP_USER;

// Only create the transport if SMTP credentials were configured. That way
// local dev without SMTP creds still works — it just skips the email.
let mailer = null;
if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false for 587/STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// ---- RenewedVision Scheduler integration --------------------------------
// At booking time we look up who's on phones at the appointment and include
// that person's name in the notification email.
//
// `scheduler-client.js` is a browser-only script that exposes a global
// `window.RenewedVisionScheduler`. We load it server-side by reading the
// file and executing it inside a Node `vm` context with a stubbed window
// and browser-ish globals (fetch, URL, etc. — all built into Node 18+).
//
// The integration is OPTIONAL. If the file is missing, or the binId/apiKey
// envvars are unset, we skip silently — booking still works.
//
// Env vars:
//   RV_SCHEDULER_CLIENT_PATH  — path to scheduler-client.js
//                               (default: "./lib/scheduler-client.js")
//   RV_SCHEDULER_BIN_ID       — from the scheduler HTML snippet  (sync:false)
//   RV_SCHEDULER_API_KEY      — from the scheduler HTML snippet  (sync:false)
//   RV_SCHEDULER_GROUP        — which group to query (default "Phone Group")
const RV_BIN_ID      = process.env.RV_SCHEDULER_BIN_ID || '';
const RV_API_KEY     = process.env.RV_SCHEDULER_API_KEY || '';
// Target to query. RV_SCHEDULER_ROLE takes precedence over RV_SCHEDULER_GROUP.
// Role is the role ID (e.g. "phone"); group is a group name (e.g. "Phone Group").
const RV_ROLE        = process.env.RV_SCHEDULER_ROLE || '';
const RV_GROUP       = process.env.RV_SCHEDULER_GROUP || 'Phone Group';
const RV_CLIENT_PATH = process.env.RV_SCHEDULER_CLIENT_PATH
  || path.join(__dirname, 'lib', 'scheduler-client.js');

/**
 * Load `scheduler-client.js` in a sandboxed Node vm context and return the
 * RenewedVisionScheduler global it exposes. Returns null if the file is
 * missing or doesn't expose the expected global.
 */
function loadRvSchedulerClient(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[rv-sched] client file not found at ${filePath} — skipping`);
    console.warn('[rv-sched] drop scheduler-client.js into ./lib/ (or set RV_SCHEDULER_CLIENT_PATH)');
    return null;
  }
  const code = fs.readFileSync(filePath, 'utf8');

  // Browser-ish sandbox. Node 18+ provides fetch, URL, atob, AbortController,
  // TextEncoder/Decoder as globals, so we just re-expose them. `window` and
  // `self` point at the sandbox object itself so UMD-style scripts work.
  const sandbox = {
    console,
    fetch, Headers, Request, Response,
    URL, URLSearchParams,
    atob, btoa,
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask,
    Promise, Date, Math, JSON, Object, Array, Error, Symbol, Map, Set, WeakMap, WeakSet,
    AbortController, AbortSignal,
    TextEncoder, TextDecoder,
    Intl,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: path.basename(filePath) });
  } catch (err) {
    console.error(`[rv-sched] error running client script: ${err.message}`);
    return null;
  }
  const Rvs =
    sandbox.RenewedVisionScheduler ||
    (sandbox.window && sandbox.window.RenewedVisionScheduler);
  if (!Rvs || typeof Rvs.create !== 'function') {
    console.warn('[rv-sched] client script loaded but exposed no RenewedVisionScheduler.create()');
    return null;
  }
  return Rvs;
}

let rvScheduler = null;
if (RV_BIN_ID && RV_API_KEY) {
  const Rvs = loadRvSchedulerClient(RV_CLIENT_PATH);
  if (Rvs) {
    try {
      rvScheduler = Rvs.create({ binId: RV_BIN_ID, apiKey: RV_API_KEY });
      console.log(`[rv-sched] connected using ${RV_CLIENT_PATH}`);
    } catch (err) {
      console.error(`[rv-sched] create() threw: ${err.message}`);
    }
  }
}

// ---- Slot configuration --------------------------------------------------
const SLOT_MINUTES = 30;
const BUSINESS_START_HOUR = 9;   // 9:00
const BUSINESS_END_HOUR = 17;    // 17:00 (last slot starts 16:30)

/** Generate all slot start times (as "HH:MM") for a business day. */
function generateSlotsForDay() {
  const slots = [];
  for (let h = BUSINESS_START_HOUR; h < BUSINESS_END_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      slots.push(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      );
    }
  }
  return slots;
}

/** Returns true if the given YYYY-MM-DD is a weekday (Mon-Fri). */
function isWeekday(dateStr) {
  // Parse as local-date to avoid TZ drift.
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  return day >= 1 && day <= 5;
}

/** Validate date string is YYYY-MM-DD and a real calendar date. */
function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === m - 1 &&
    dt.getDate() === d
  );
}

/** Validate time string is one of our allowed slot starts. */
function isValidSlotTime(timeStr) {
  return generateSlotsForDay().includes(timeStr);
}

/** Format a Date as local YYYY-MM-DD (avoids UTC shift of toISOString). */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Current time expressed in US/Eastern. We build a Date whose local-time
 * fields reflect Eastern wall-clock time, so we can compare it directly to
 * other Dates built the same way (see isSlotInPast).
 */
function nowET() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
}

/** True if the given slot (date + HH:MM) has already passed in Eastern Time. */
function isSlotInPast(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const slot = new Date(y, m - 1, d, hh, mm);
  return slot <= nowET();
}

/** Pretty date for humans: "Monday, April 27, 2026". */
function formatPrettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Pretty time for humans: "10:00 AM". */
function formatPrettyTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Short date for the email body: "April 22". */
function formatShortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
}

/** Short time for the email body: "10:30am" (lowercase, no space). */
function formatShortTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hh12 = ((h + 11) % 12) + 1; // 0→12, 13→1, etc.
  const mm = String(m).padStart(2, '0');
  return `${hh12}:${mm}${suffix}`;
}

/**
 * Normalize a phone number to "(XXX)XXX-XXXX" format for the email body.
 * Accepts any input (spaces, dashes, parens, dots, leading "+1" etc.) and
 * strips it down to 10 digits. If the input can't be reduced to 10 digits,
 * we return it unchanged so the recipient still sees what the customer typed.
 */
function formatPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  // If it's 11 digits and starts with 1 (US country code), strip the leading 1.
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (d.length === 10) {
    return `(${d.slice(0, 3)})${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return String(raw);
}

/**
 * Return an ISO-8601 string for the given (YYYY-MM-DD, HH:MM) interpreted
 * as Eastern Time — e.g. "2026-04-27T14:00:00-04:00".
 * Uses Intl to figure out whether ET is on EST (-05:00) or EDT (-04:00).
 */
function etIsoString(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(anchor);
  const off = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT-5';
  const match = off.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = match ? match[1] : '-';
  const hh = match ? match[2].padStart(2, '0') : '05';
  const mm = match && match[3] ? match[3] : '00';
  return `${dateStr}T${timeStr}:00${sign}${hh}:${mm}`;
}

/**
 * Ask the RenewedVision scheduler who's on phones at the appointment time.
 * Returns a rep name, or null if the lookup isn't configured or fails.
 */
async function lookupAssignedRep(appt) {
  if (!rvScheduler) return null;
  try {
    // scheduler-client.js uses Date.getDay()/getHours() (process-local time),
    // so we build a local-time Date from the appointment's YYYY-MM-DD / HH:MM
    // components. This is correct as long as the process TZ is set to
    // America/New_York (see TZ env var in render.yaml).
    const [y, mo, d] = appt.date.split('-').map(Number);
    const [hh, mm] = appt.time.split(':').map(Number);
    const when = new Date(y, mo - 1, d, hh, mm, 0);

    // Role takes precedence over group if both are configured.
    const query = { time: when };
    if (RV_ROLE) query.role = RV_ROLE;
    else query.group = RV_GROUP;
    const target = RV_ROLE ? `role="${RV_ROLE}"` : `group="${RV_GROUP}"`;

    const result = await rvScheduler.whoIsOn(query);
    const names = result && Array.isArray(result.names) ? result.names : [];
    if (names.length === 0) {
      // Diagnostic: dump what IS in the schedule so it's easy to see the
      // actual role IDs / group names and fix the env var.
      const reason = result && result.reason ? ` (${result.reason})` : '';
      console.log(
        `[rv-sched] appt #${appt.id}: no one matched ${target} at ` +
        `${appt.date} ${appt.time}${reason}`
      );
      try {
        const state = await rvScheduler.getSchedule();
        const allRoles  = (state.roles  || []).map(r => `${r.id}${r.group ? ' (group: '+r.group+')' : ''}`);
        const allGroups = [...new Set((state.roles || []).map(r => r.group).filter(Boolean))];
        console.log(`[rv-sched]   available roles:  ${allRoles.join(', ') || '(none)'}`);
        console.log(`[rv-sched]   available groups: ${allGroups.join(', ') || '(none)'}`);
        // Also dump what's scheduled in the actual slot we queried, if anything.
        if (result && result.weekKey && result.dayId && result.hour != null) {
          const week = state.schedule && state.schedule[result.weekKey];
          const day  = week && week[result.dayId];
          const slot = day && day[result.hour];
          if (Array.isArray(slot) && slot.length > 0) {
            console.log(
              `[rv-sched]   people actually in that slot: ` +
              slot.map(a => `${a.username} (role: ${a.role})`).join(', ')
            );
          } else {
            console.log(`[rv-sched]   that slot is empty in the schedule`);
          }
        }
      } catch (e) {
        console.log('[rv-sched]   (could not fetch state for diagnostics:', e.message, ')');
      }
      return null;
    }
    console.log(`[rv-sched] appt #${appt.id} assigned to ${names[0]}`);
    return names[0];
  } catch (err) {
    console.error('[rv-sched] whoIsOn failed:', err.message);
    return null;
  }
}

/**
 * Send the booking-notification email. Fire-and-forget: any failure is
 * logged but NEVER blocks or fails the HTTP response to the customer.
 */
/**
 * Send a confirmation email to the customer who just booked. Separate from
 * the internal notification to support@. Failures are logged, never thrown.
 * Reply-To points at support@ so if the customer replies, it reaches the team.
 */
async function sendCustomerConfirmation(appt) {
  if (!mailer) return;
  const shortDate = formatShortDate(appt.date);
  const shortTime = formatShortTime(appt.time);
  const subject = `Phone Appointment with Renewed Vision on ${shortDate} at ${shortTime}`;
  const lines = [
    `Hi ${appt.name.split(/\s+/)[0]},`,
    ``,
    `Thanks for booking with Renewed Vision Support! Your appointment is confirmed.`,
    ``,
    `When: ${shortDate} at ${shortTime} Eastern Time`,
    `Phone: ${formatPhone(appt.phone) || '(we\'ll use the number you provide during the call)'}`,
    `Software Version: ${appt.software_version || '(not provided)'}`,
    `Notes you shared: ${appt.notes || '(none)'}`,
    ``,
    `We'll reach out at the time above. If you need to change or cancel this`,
    `appointment, just reply to this email and our support team will help.`,
    ``,
    `— Renewed Vision Support`,
  ];
  try {
    await mailer.sendMail({
      from: NOTIFY_FROM,
      to: appt.email,
      replyTo: NOTIFY_TO, // replies go to support@
      subject,
      text: lines.join('\n'),
    });
    console.log(`[email] sent confirmation for appt #${appt.id} → ${appt.email}`);
  } catch (err) {
    console.error(`[email] confirmation send failed for appt #${appt.id}:`, err.message);
  }
}

async function sendBookingNotification(appt) {
  if (!mailer) {
    console.warn('[email] SMTP not configured — skipping notification for', appt.id);
    return;
  }
  // Figure out who's on phones at that time. Non-blocking for booking —
  // if this fails, we still send the email (without the rep name filled in).
  const assignedRep = await lookupAssignedRep(appt);

  const dateAndTime = `${formatShortDate(appt.date)} at ${formatShortTime(appt.time)}`;
  const subject = `New Event: ${appt.name} on ${dateAndTime}` +
    (assignedRep ? ` with ${assignedRep}` : '');

  const lines = [
    `There has been a new phone appointment booked!`,
    ``,
    `Name: ${appt.name}`,
    ``,
    `Email: ${appt.email}`,
    ``,
    `Phone: ${formatPhone(appt.phone) || '(not provided)'}`,
    ``,
    `Software Version: ${appt.software_version || '(not provided)'}`,
    ``,
    `Date and Time: ${dateAndTime}`,
    ``,
    `Assigned Rep: ${assignedRep || '(no one scheduled)'}`,
    ``,
    `Notes/Reason for Appointment: ${appt.notes || '(none)'}`,
  ];
  const text = lines.join('\n');

  try {
    await mailer.sendMail({
      from: NOTIFY_FROM,
      to: NOTIFY_TO,
      replyTo: appt.email, // Hit "Reply" in support@ inbox → goes to customer
      subject,
      text,
    });
    console.log(`[email] sent notification for appt #${appt.id} → ${NOTIFY_TO}`);
  } catch (err) {
    console.error(`[email] send failed for appt #${appt.id}:`, err.message);
  }
}

// ---- Database setup ------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
try {
  // WAL is faster + safer for concurrent reads, but some sandboxed
  // filesystems don't support it. Fall back silently if it fails.
  db.exec('PRAGMA journal_mode = WAL');
} catch (_) { /* ignore — stick with default rollback journal */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT    NOT NULL,
    time          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL,
    phone         TEXT,
    software_version TEXT,
    notes         TEXT,
    source        TEXT    NOT NULL DEFAULT 'web',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, time)
  );
  CREATE INDEX IF NOT EXISTS idx_appts_date ON appointments(date);

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_slots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    reason      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, time)
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocked_slots(date);
`);

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO appointments (date, time, name, email, phone, software_version, notes, source)
  VALUES (@date, @time, @name, @email, @phone, @software_version, @notes, @source)
`);
const stmtListByDate = db.prepare(`
  SELECT date, time FROM appointments WHERE date = ?
`);
const stmtListAll = db.prepare(`
  SELECT * FROM appointments
  ORDER BY date ASC, time ASC
`);
const stmtListRange = db.prepare(`
  SELECT * FROM appointments
  WHERE date >= ? AND date <= ?
  ORDER BY date ASC, time ASC
`);
const stmtDelete = db.prepare(`DELETE FROM appointments WHERE id = ?`);
const stmtInsertSession = db.prepare(`INSERT INTO sessions (token) VALUES (?)`);
const stmtFindSession = db.prepare(`SELECT token FROM sessions WHERE token = ?`);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`);

// Block-related prepared statements
const stmtInsertBlock = db.prepare(`
  INSERT INTO blocked_slots (date, time, reason)
  VALUES (@date, @time, @reason)
`);
const stmtListBlocksByDate = db.prepare(`
  SELECT * FROM blocked_slots WHERE date = ? ORDER BY time ASC
`);
const stmtListAllBlocks = db.prepare(`
  SELECT * FROM blocked_slots ORDER BY date ASC, time ASC
`);
const stmtListBlockTimesForDate = db.prepare(`
  SELECT time FROM blocked_slots WHERE date = ?
`);
const stmtDeleteBlock = db.prepare(`DELETE FROM blocked_slots WHERE id = ?`);
const stmtDeleteBlockByDateTime = db.prepare(`
  DELETE FROM blocked_slots WHERE date = ? AND time = ?
`);
const stmtFindBlockByDateTime = db.prepare(`
  SELECT id FROM blocked_slots WHERE date = ? AND time = ?
`);

// ---- App setup -----------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Tiny cookie parser (avoid extra dependency)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      req.cookies[k] = decodeURIComponent(rest.join('='));
    }
  }
  next();
});

function isAdmin(req) {
  const token = req.cookies.admin_token;
  if (!token) return false;
  return !!stmtFindSession.get(token);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---- Pages ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (password !== ADMIN_PASSWORD) {
    return res
      .status(401)
      .send(
        '<p>Wrong password. <a href="/login">Try again</a>.</p>'
      );
  }
  const token = crypto.randomBytes(24).toString('hex');
  stmtInsertSession.run(token);
  res.setHeader(
    'Set-Cookie',
    `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 12}`
  );
  res.redirect('/admin');
});

app.post('/logout', (req, res) => {
  const token = req.cookies.admin_token;
  if (token) stmtDeleteSession.run(token);
  res.setHeader(
    'Set-Cookie',
    'admin_token=; HttpOnly; Path=/; Max-Age=0'
  );
  res.redirect('/login');
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- Public API ----------------------------------------------------------

// List slots for a given date. Each slot gets a status of
// "available", "booked", "blocked", or "past". `available` stays in the
// response as a boolean for backwards compatibility with older clients.
app.get('/api/slots', (req, res) => {
  const date = req.query.date;
  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!isWeekday(date)) {
    return res.json({ date, slots: [] });
  }
  const booked = new Set(stmtListByDate.all(date).map((r) => r.time));
  const blocked = new Set(
    stmtListBlockTimesForDate.all(date).map((r) => r.time)
  );
  const slots = generateSlotsForDay().map((time) => {
    let status = 'available';
    if (booked.has(time)) status = 'booked';
    else if (blocked.has(time)) status = 'blocked';
    else if (isSlotInPast(date, time)) status = 'past';
    return {
      time,
      status,
      available: status === 'available',
    };
  });
  res.json({ date, slots });
});

// List the next N upcoming weekdays that have at least one open slot.
// Used by the booking page to populate the date dropdown and to find the
// next day with openings when the current day is full.
//
// ?count=N    (default 5, max 30)   — how many dates to return
// ?from=YYYY-MM-DD (default: today) — start searching from this date (inclusive)
app.get('/api/next-available-dates', (req, res) => {
  const count = Math.min(
    Math.max(parseInt(req.query.count, 10) || 5, 1),
    30
  );
  const todayET = nowET();
  let startDate;
  if (req.query.from && isValidDate(req.query.from)) {
    const [y, m, d] = req.query.from.split('-').map(Number);
    startDate = new Date(y, m - 1, d);
    // Never let callers search into the past.
    const todayKey = formatLocalDate(todayET);
    if (formatLocalDate(startDate) < todayKey) startDate = todayET;
  } else {
    startDate = todayET;
  }

  const slotsPerDay = generateSlotsForDay().length;
  const dates = [];

  // Look up to 60 days ahead for enough open days.
  for (let i = 0; i < 60 && dates.length < count; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dateStr = formatLocalDate(d);
    if (!isWeekday(dateStr)) continue;

    const bookedTimes  = new Set(stmtListByDate.all(dateStr).map(r => r.time));
    const blockedTimes = new Set(stmtListBlockTimesForDate.all(dateStr).map(r => r.time));

    // Count available slots that are also not in the past.
    let openCount = 0;
    for (const t of generateSlotsForDay()) {
      if (bookedTimes.has(t) || blockedTimes.has(t)) continue;
      if (isSlotInPast(dateStr, t)) continue;
      openCount++;
      if (openCount > 0) break; // we only need to know there's ≥1
    }
    if (openCount > 0) dates.push(dateStr);
  }
  res.json({ dates });
});

// Create an appointment. Used by the booking page AND external services.
app.post('/api/appointments', (req, res) => {
  // Enforce API key for external callers (only if configured).
  if (API_KEY) {
    const providedKey = req.header('X-API-Key');
    const sameOriginBrowser =
      (req.header('Sec-Fetch-Site') === 'same-origin') ||
      (req.header('Origin') && req.header('Origin').includes(req.header('Host')));
    if (!providedKey && !sameOriginBrowser) {
      return res.status(401).json({ error: 'Missing X-API-Key header' });
    }
    if (providedKey && providedKey !== API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  const body = req.body || {};
  const { date, time, name, email } = body;
  const phone = body.phone || '';
  const software_version = body.software_version || body.softwareVersion || '';
  const notes = body.notes || '';
  const source = req.header('X-API-Key') ? 'api' : 'web';

  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!isWeekday(date)) {
    return res.status(400).json({ error: 'date must be a weekday' });
  }
  if (!time || !isValidSlotTime(time)) {
    return res
      .status(400)
      .json({ error: `time must be a 30-min slot between 09:00 and 16:30` });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  // Reject blocked slots before we try to insert.
  if (stmtFindBlockByDateTime.get(date, time)) {
    return res
      .status(409)
      .json({ error: 'That time slot is unavailable.' });
  }

  // Reject times that have already passed (in Eastern Time).
  if (isSlotInPast(date, time)) {
    return res
      .status(400)
      .json({ error: 'That time slot has already passed.' });
  }

  try {
    const result = stmtInsert.run({
      date,
      time,
      name: name.trim(),
      email: email.trim(),
      phone: String(phone).trim(),
      software_version: String(software_version).trim(),
      notes: String(notes).trim(),
      source,
    });
    const appt = {
      id: result.lastInsertRowid,
      date,
      time,
      name: name.trim(),
      email: email.trim(),
      phone,
      software_version,
      notes,
      source,
    };
    // Fire-and-forget: don't block the customer's response on SMTP.
    // Two emails go out: the internal notification to support@, and a
    // confirmation to the customer. Either failing doesn't affect the other.
    sendBookingNotification(appt).catch((e) =>
      console.error('[email] unexpected error (notification):', e)
    );
    sendCustomerConfirmation(appt).catch((e) =>
      console.error('[email] unexpected error (confirmation):', e)
    );
    res.status(201).json(appt);
  } catch (err) {
    // node:sqlite raises errcode 2067 (SQLITE_CONSTRAINT_UNIQUE) when our
    // UNIQUE(date, time) is violated. better-sqlite3 sets err.code — we
    // check both so this works with either driver.
    if (
      err &&
      (err.errcode === 2067 ||
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message || '').includes('UNIQUE constraint failed'))
    ) {
      return res
        .status(409)
        .json({ error: 'That time slot is already booked.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// List appointments (admin-only). Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD.
app.get('/api/appointments', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to && isValidDate(from) && isValidDate(to)) {
    rows = stmtListRange.all(from, to);
  } else {
    rows = stmtListAll.all();
  }
  res.json({ appointments: rows });
});

// Cancel an appointment (admin-only).
app.delete('/api/appointments/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const result = stmtDelete.run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

// ---- Block management (admin-only) ---------------------------------------

// List blocked slots. Optional ?date=YYYY-MM-DD filter.
app.get('/api/blocks', requireAdmin, (req, res) => {
  const { date } = req.query;
  let rows;
  if (date) {
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'invalid date' });
    }
    rows = stmtListBlocksByDate.all(date);
  } else {
    rows = stmtListAllBlocks.all();
  }
  res.json({ blocks: rows });
});

// Block one or more slots on a given date.
// Accepts either a single time or an array of times so the admin UI can
// block several at once with one click.
app.post('/api/blocks', requireAdmin, (req, res) => {
  const body = req.body || {};
  const { date, reason } = body;
  let { time, times } = body;

  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!isWeekday(date)) {
    return res.status(400).json({ error: 'date must be a weekday' });
  }

  if (time && !times) times = [time];
  if (!Array.isArray(times) || times.length === 0) {
    return res
      .status(400)
      .json({ error: 'provide `time` or a non-empty `times` array' });
  }
  for (const t of times) {
    if (!isValidSlotTime(t)) {
      return res.status(400).json({ error: `invalid time "${t}"` });
    }
  }

  const created = [];
  const alreadyBlocked = [];
  const booked = [];

  // Find slots already taken by appointments — we refuse to block those.
  const takenTimes = new Set(stmtListByDate.all(date).map((r) => r.time));

  for (const t of times) {
    if (takenTimes.has(t)) {
      booked.push(t);
      continue;
    }
    try {
      const result = stmtInsertBlock.run({ date, time: t, reason: reason || null });
      created.push({ id: result.lastInsertRowid, date, time: t, reason: reason || null });
    } catch (err) {
      if (
        err &&
        (err.errcode === 2067 ||
          err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          (err.message || '').includes('UNIQUE constraint failed'))
      ) {
        alreadyBlocked.push(t);
      } else {
        console.error(err);
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  }

  res.status(201).json({ created, alreadyBlocked, booked });
});

// Unblock by id.
app.delete('/api/blocks/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const result = stmtDeleteBlock.run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

// Unblock by (date, time). Convenience so the UI can "toggle" a slot.
app.delete('/api/blocks', requireAdmin, (req, res) => {
  const { date, time } = req.query;
  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!time || !isValidSlotTime(time)) {
    return res.status(400).json({ error: 'time is required' });
  }
  const result = stmtDeleteBlockByDateTime.run(date, time);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

// ---- Start ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Appointment scheduler running on http://localhost:${PORT}`);
  console.log(`  Booking page : http://localhost:${PORT}/`);
  console.log(`  Admin page   : http://localhost:${PORT}/admin  (password: ${ADMIN_PASSWORD})`);
  if (API_KEY) {
    console.log(`  External API requires X-API-Key header.`);
  } else {
    console.log(`  External API is open (no API_KEY set).`);
  }
});
