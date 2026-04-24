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

// Base URL for the public site. Used to build absolute cancel/reschedule
// links in customer emails. Falls back to a reasonable request-time value
// if not set, but should be configured in Render env to the real domain.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

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

// ---- Zendesk integration ------------------------------------------------
// When an appointment is booked we POST a ticket to Zendesk instead of
// emailing support@. The ticket's requester is the customer (Zendesk
// auto-creates/matches by email). If the RenewedVision scheduler lookup
// returns an on-phones rep, and that rep's name maps to a Zendesk agent
// email via ZENDESK_AGENT_MAP, the ticket is assigned to that agent.
//
// Env vars:
//   ZENDESK_SUBDOMAIN   — e.g. "renewedvision"  → https://renewedvision.zendesk.com
//   ZENDESK_EMAIL       — API user email (must be a Zendesk admin/agent)
//   ZENDESK_TOKEN       — API token from Admin Center → Apps & integrations → APIs
//   ZENDESK_AGENT_MAP   — comma-separated "Name=email" pairs. The "Name"
//                         is the name returned by the scheduler (e.g.
//                         "Riley Harmon"); the email is that agent's
//                         Zendesk login address.
//                         Example:
//                           "Riley Harmon=riley@rv.com,Michael Seale=michael@rv.com"
//
// If any of the first three are unset, the integration is disabled and we
// log a one-line notice at startup (bookings still work, they just won't
// create tickets).
const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || '').trim();
const ZENDESK_EMAIL     = (process.env.ZENDESK_EMAIL || '').trim();
const ZENDESK_TOKEN     = (process.env.ZENDESK_TOKEN || '').trim();
const ZENDESK_AGENT_MAP_RAW = process.env.ZENDESK_AGENT_MAP || '';
// Comma-separated list of tags to apply to every booking ticket. Unset →
// falls back to the legacy defaults. Zendesk tags are case-sensitive and
// can't contain spaces (Zendesk replaces spaces with underscores), so we
// normalize here: lowercase, trim, and skip empties.
const ZENDESK_TAGS_RAW = process.env.ZENDESK_TAGS || '';
// Override for Zendesk Sandbox (e.g. https://renewedvision1234.zendesk.com)
// or local tests. Leave unset in production.
const ZENDESK_BASE_URL  = (process.env.ZENDESK_BASE_URL || '').replace(/\/+$/, '');

const zendeskEnabled = !!(ZENDESK_SUBDOMAIN && ZENDESK_EMAIL && ZENDESK_TOKEN);

// Parse ZENDESK_AGENT_MAP into a Map<lowercasedName, email>.
const zendeskAgentMap = new Map();
for (const pair of ZENDESK_AGENT_MAP_RAW.split(',')) {
  const [name, email] = pair.split('=').map((s) => (s || '').trim());
  if (name && email) zendeskAgentMap.set(name.toLowerCase(), email);
}

// Parse ZENDESK_TAGS into an array. Empty env var → legacy defaults so
// existing deployments don't lose their tags when this release ships.
const zendeskTags = ZENDESK_TAGS_RAW.trim()
  ? ZENDESK_TAGS_RAW
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      // Zendesk converts spaces to underscores client-side anyway; do it
      // here so what we send matches what'll land in the ticket.
      .map((t) => t.replace(/\s+/g, '_'))
  : ['phone-appointment', 'scheduler'];

// Cache email → Zendesk user_id so we don't hit /users/search.json on every
// booking. Agents don't change emails often; in-memory is fine.
const zendeskUserIdCache = new Map();

function zendeskAuthHeader() {
  return (
    'Basic ' +
    Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64')
  );
}

function zendeskUrl(pathName) {
  const base =
    ZENDESK_BASE_URL || `https://${ZENDESK_SUBDOMAIN}.zendesk.com`;
  return `${base}/api/v2${pathName}`;
}

/** Look up a Zendesk user_id by email. Returns null if not found or on error. */
async function findZendeskUserIdByEmail(email) {
  if (!zendeskEnabled || !email) return null;
  const key = email.toLowerCase();
  if (zendeskUserIdCache.has(key)) return zendeskUserIdCache.get(key);
  try {
    const url = zendeskUrl(
      `/users/search.json?query=${encodeURIComponent('email:' + email)}`
    );
    const res = await fetch(url, {
      headers: { Authorization: zendeskAuthHeader() },
    });
    if (!res.ok) {
      console.warn(`[zendesk] user search for ${email} failed: ${res.status}`);
      zendeskUserIdCache.set(key, null);
      return null;
    }
    const body = await res.json();
    const user = (body.users || []).find(
      (u) => (u.email || '').toLowerCase() === key
    );
    const id = user ? user.id : null;
    if (!id) console.warn(`[zendesk] no Zendesk user found for ${email}`);
    zendeskUserIdCache.set(key, id);
    return id;
  } catch (e) {
    console.warn(`[zendesk] user search for ${email} threw: ${e.message}`);
    return null;
  }
}

/**
 * Given a scheduler-returned name like "Riley Harmon", resolve to a Zendesk
 * user_id through the ZENDESK_AGENT_MAP env var. Returns null if the name
 * isn't in the map or the mapped email doesn't resolve to a Zendesk user.
 */
async function resolveZendeskAssignee(schedulerName) {
  if (!schedulerName) return null;
  const email = zendeskAgentMap.get(String(schedulerName).toLowerCase());
  if (!email) {
    console.log(
      `[zendesk] no ZENDESK_AGENT_MAP entry for "${schedulerName}" — ticket will be unassigned`
    );
    return null;
  }
  return findZendeskUserIdByEmail(email);
}

/**
 * Create a Zendesk ticket for an appointment. Returns the new ticket id,
 * or null if the integration is disabled or the API call failed. Does NOT
 * throw on failure — the booking still succeeds and is logged.
 */
async function createZendeskTicket(appt) {
  if (!zendeskEnabled) return null;

  // The assigned rep was looked up and stored on the appointment before
  // we were called (see POST /api/appointments). Use that name directly.
  const assignedRep = appt.assigned_rep || null;
  const assignee_id = await resolveZendeskAssignee(assignedRep);

  const whenLine = formatWhenForCustomer(appt.date, appt.time, appt.timezone);
  const dateAndTime = `${formatShortDate(appt.date)} at ${formatShortTime(appt.time)}`;

  // Body lines — compact, structured. First line pattern matches the old
  // notification email so it reads naturally in the Zendesk ticket view.
  const bodyLines = [
    `New phone appointment booked.`,
    ``,
    `Name: ${appt.name}`,
    `Email: ${appt.email}`,
    `Phone: ${formatPhone(appt.phone) || '(not provided)'}`,
    `Software Version: ${appt.software_version || '(not provided)'}`,
    ``,
    `When: ${whenLine}`,
    `Assigned Rep (from scheduler): ${assignedRep || '(no one scheduled)'}`,
    ``,
    `Notes / Reason for Appointment:`,
    appt.notes || '(none)',
  ];

  const ticket = {
    subject: `Phone Appointment with ${appt.name} on ${dateAndTime}` +
      (assignedRep ? ` with ${assignedRep}` : ''),
    comment: { body: bodyLines.join('\n'), public: false },
    requester: { name: appt.name, email: appt.email },
    tags: zendeskTags,
  };
  if (assignee_id) ticket.assignee_id = assignee_id;

  try {
    const res = await fetch(zendeskUrl('/tickets.json'), {
      method: 'POST',
      headers: {
        Authorization: zendeskAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[zendesk] ticket create failed: ${res.status} ${text}`);
      return null;
    }
    const data = await res.json();
    const id = data.ticket && data.ticket.id;
    console.log(
      `[zendesk] created ticket #${id} for appt #${appt.id}` +
        (assignee_id ? ` assigned to user ${assignee_id}` : ' (unassigned)')
    );
    return id;
  } catch (e) {
    console.error('[zendesk] ticket create threw:', e.message);
    return null;
  }
}

/**
 * Append a comment to an existing Zendesk ticket, optionally transitioning
 * it to a specific status. Comments default to INTERNAL. Set `isPublic: true`
 * to make the comment customer-facing — Zendesk then fires its own
 * notification trigger that emails the requester. Returns true on
 * success, false on any failure (disabled, missing id, API error).
 */
async function appendZendeskComment(
  ticketId,
  body,
  { status, isPublic = false } = {}
) {
  if (!zendeskEnabled || !ticketId) return false;
  const ticket = { comment: { body, public: !!isPublic } };
  if (status) ticket.status = status;
  try {
    const res = await fetch(zendeskUrl(`/tickets/${ticketId}.json`), {
      method: 'PUT',
      headers: {
        Authorization: zendeskAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        `[zendesk] ticket update #${ticketId} failed: ${res.status} ${text}`
      );
      return false;
    }
    console.log(
      `[zendesk] ${isPublic ? 'public ' : ''}commented on ticket #${ticketId}` +
        (status ? ` (status → ${status})` : '')
    );
    return true;
  } catch (e) {
    console.error('[zendesk] ticket update threw:', e.message);
    return false;
  }
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

/**
 * Any 30-minute start time, "HH:MM" with HH 00-23 and MM either 00 or 30.
 * Loose format check — does NOT guarantee the slot is actually offered
 * (that's what isSlotOffered does).
 */
function isValidSlotFormat(timeStr) {
  return /^([01]\d|2[0-3]):(00|30)$/.test(String(timeStr || ''));
}

/** True if the given HH:MM is inside the default business-hours grid. */
function isDefaultSlotTime(timeStr) {
  return generateSlotsForDay().includes(timeStr);
}

/**
 * Kept for backward compatibility with code that was already validating
 * against the default weekday grid. New callers should prefer
 * `isSlotOffered(date, time)` which also accepts custom slots.
 */
function isValidSlotTime(timeStr) {
  return isDefaultSlotTime(timeStr);
}

/**
 * True if a slot is bookable at all: either it's a default weekday slot or
 * the admin added it explicitly via the custom_slots table. This is the
 * source of truth used by POST /api/appointments and reschedule.
 */
function isSlotOffered(dateStr, timeStr) {
  if (!isValidDate(dateStr)) return false;
  if (!isValidSlotFormat(timeStr)) return false;
  if (isWeekday(dateStr) && isDefaultSlotTime(timeStr)) return true;
  // Statement might not exist yet at module load — guard so the
  // validator remains usable during startup before prepares run.
  if (typeof stmtFindCustomSlotByDateTime === 'undefined') return false;
  return !!stmtFindCustomSlotByDateTime.get(dateStr, timeStr);
}

/**
 * Validate that `tz` is a real IANA time zone name. We use the Intl API
 * itself as the validator: an invalid zone throws a RangeError. Guards
 * against the client sending junk that we'd later feed into formatters.
 */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Hash a password with scrypt + a per-user random salt. The resulting
 * string carries algo, salt, and hash all in one field so we can change
 * the algorithm later without a migration.
 *   Format: "scrypt$<saltHex>$<hashHex>"
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Constant-time verify of a plaintext password against a stored
 * hashPassword() output. Returns false on any malformed input.
 */
function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return (
      expected.length > 0 &&
      actual.length === expected.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch (_) {
    return false;
  }
}

/** Basic username rules: 3–32 chars, ASCII letters/digits/._- only. */
function isValidUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9._-]{3,32}$/.test(u);
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
 * Convert an ET slot (YYYY-MM-DD, HH:MM) into a real Date object. Mirrors
 * etSlotToDate() in booking.html so email-side formatting lines up with
 * what the customer saw in the UI.
 */
function etSlotToDate(dateStr, timeStr) {
  return new Date(etIsoString(dateStr, timeStr));
}

/** "9:00 AM" formatted in the given IANA TZ. */
function formatLocalTimeIn(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(date);
}

/** "CDT", "EDT", "BST", etc. for the given date+TZ. */
function formatTzAbbrIn(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(date);
    return (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  } catch (_) {
    return '';
  }
}

/**
 * Build the "When" line for the confirmation email. If the customer's
 * timezone was captured we render in their TZ with the ET equivalent
 * alongside; otherwise we fall back to ET-only (legacy rows, API clients).
 */
function formatWhenForCustomer(dateStr, timeStr, tz) {
  const date = etSlotToDate(dateStr, timeStr);
  const shortDate = formatShortDate(dateStr);
  const etTime = formatLocalTimeIn(date, 'America/New_York');
  if (!tz || tz === 'America/New_York') {
    return `${shortDate} at ${etTime} Eastern Time`;
  }
  const localTime = formatLocalTimeIn(date, tz);
  const abbr = formatTzAbbrIn(date, tz);
  return `${shortDate} at ${localTime} ${abbr} (${etTime} ET)`;
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
  // Subject uses ET-format lowercase short time ("11:30am") for ET customers
  // (and legacy rows without a TZ); for non-ET customers we show their
  // local-looking time so the subject matches what they booked.
  const useLocal = appt.timezone && appt.timezone !== 'America/New_York';
  const slotDate = etSlotToDate(appt.date, appt.time);
  const localShort = useLocal
    ? formatLocalTimeIn(slotDate, appt.timezone).replace(/\s?(AM|PM)/, (_, p) => p.toLowerCase())
    : formatShortTime(appt.time);

  // Cancel / reschedule links use the per-appointment token. If APP_BASE_URL
  // isn't set we omit that section — we don't want to embed a bare path like
  // "/cancel?token=..." in an email.
  const token = appt.cancel_token || '';
  const haveLinks = APP_BASE_URL && token;
  const cancelUrl     = haveLinks ? `${APP_BASE_URL}/cancel?token=${token}` : '';
  const rescheduleUrl = haveLinks ? `${APP_BASE_URL}/?reschedule=${token}`  : '';

  const whenLine = formatWhenForCustomer(appt.date, appt.time, appt.timezone);
  // Render the editable confirmation_email template. See renderTemplate()
  // for placeholder rules — empty values strip their "Label: " line, so
  // if there's no Zendesk ticket the Ticket Reference Number line vanishes.
  const rendered = renderTemplate(getTemplate('confirmation_email'), {
    first_name: (appt.name || '').split(/\s+/)[0] || 'there',
    name: appt.name || '',
    when: whenLine,
    date: shortDate,
    time: localShort,
    phone:
      formatPhone(appt.phone) ||
      "(we'll use the number you provide during the call)",
    software_version: appt.software_version || '(not provided)',
    notes: appt.notes || '(none)',
    ticket_id: appt.zendesk_ticket_id || '',
  });

  // Plain-text body: template + (optional) change-instructions block.
  // The change-instructions block is NOT templated — it's a product
  // feature with specific button UX that we don't want admins to
  // accidentally break when editing the template.
  const textLines = [rendered.body];
  if (haveLinks) {
    textLines.push(
      '',
      'Need to make a change?',
      `Reschedule: ${rescheduleUrl}`,
      `Cancel:     ${cancelUrl}`
    );
  } else {
    textLines.push(
      '',
      'If you need to change or cancel this appointment, just reply to this',
      'email and our support team will help.'
    );
  }

  // HTML version: escape + wrap paragraphs (blank-line separated) in <p>,
  // keep intra-paragraph newlines as <br>. The change-instructions block
  // is appended as a styled button pair so it renders nicely in Gmail.
  const escHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const btn = (href, label, color) =>
    `<a href="${escHtml(href)}" style="display:inline-block;padding:10px 18px;` +
    `background:${color};color:#fff;text-decoration:none;border-radius:6px;` +
    `font-weight:600;font-family:Arial,sans-serif;font-size:14px;">${escHtml(label)}</a>`;
  const bodyParagraphs = rendered.body
    .split(/\n{2,}/)
    .map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const changeBlock = haveLinks
    ? `<p style="margin:22px 0 6px 0;"><strong>Need to make a change?</strong></p>
       <p style="margin:0;">
         ${btn(rescheduleUrl, 'Reschedule', '#005f9e')}
         &nbsp;&nbsp;
         ${btn(cancelUrl, 'Cancel', '#b03a2e')}
       </p>`
    : `<p>If you need to change or cancel this appointment, just reply to this email and our support team will help.</p>`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.5;max-width:560px;">
      ${bodyParagraphs}
      ${changeBlock}
    </div>
  `;

  try {
    await mailer.sendMail({
      from: NOTIFY_FROM,
      to: appt.email,
      replyTo: NOTIFY_TO, // replies go to support@
      subject: rendered.subject,
      text: textLines.join('\n'),
      html,
    });
    console.log(`[email] sent confirmation for appt #${appt.id} → ${appt.email}`);
  } catch (err) {
    console.error(`[email] confirmation send failed for appt #${appt.id}:`, err.message);
  }
}

/**
 * Compose the customer-facing cancellation body. Used for:
 *   - the PUBLIC Zendesk comment (Zendesk fires its own email on post)
 *   - the SMTP fallback when no ticket exists
 * Kept in one place so the wording stays consistent across paths.
 */
function buildCancellationBody(appt, reason) {
  const whenLine = formatWhenForCustomer(appt.date, appt.time, appt.timezone);
  const rendered = renderTemplate(getTemplate('cancellation_comment'), {
    first_name: String(appt.name || '').split(/\s+/)[0] || 'there',
    name: appt.name || '',
    when: whenLine,
    date: formatShortDate(appt.date),
    time: formatShortTime(appt.time),
    phone: formatPhone(appt.phone) || '',
    reason: String(reason || '').trim() || '(no reason given)',
    ticket_id: appt.zendesk_ticket_id || '',
  });
  return rendered.body;
}

/**
 * Notify the customer that their appointment was canceled. Preferred path
 * is a PUBLIC Zendesk comment (Zendesk emails the requester automatically,
 * keeps the conversation threaded in one ticket, and gives us better
 * deliverability). Falls back to direct SMTP mail when Zendesk isn't
 * available for this appointment (integration disabled, or the appointment
 * has no ticket id — e.g. rows booked before Zendesk was configured).
 *
 * Returns a short string describing the path taken, handy for logs:
 *   'zendesk' | 'email' | 'skipped'
 */
async function notifyCustomerOfCancellation(appt, reason, { status } = {}) {
  const body = buildCancellationBody(appt, reason);
  if (zendeskEnabled && appt.zendesk_ticket_id) {
    const ok = await appendZendeskComment(appt.zendesk_ticket_id, body, {
      status,
      isPublic: true,
    });
    if (ok) return 'zendesk';
    // Fall through to email if the API call failed — at least the customer
    // still gets notified.
  }
  if (mailer) {
    await sendCustomerCancellation(appt, reason);
    return 'email';
  }
  console.warn(
    `[cancel] appt #${appt.id}: no Zendesk ticket and no SMTP — customer not notified`
  );
  return 'skipped';
}

/**
 * Send a cancellation email to the customer. Fallback path, only used when
 * no Zendesk ticket is available for the appointment. Primary path is now
 * a public Zendesk comment — see notifyCustomerOfCancellation above.
 *
 * Fire-and-forget: failures are logged but never thrown. Uses NOTIFY_FROM
 * as the sender (Google Workspace rewrites this to the authenticated
 * SMTP_USER if it differs), and NOTIFY_TO as Reply-To so a reply lands
 * in the support inbox.
 */
async function sendCustomerCancellation(appt, reason) {
  if (!mailer) return;
  const safeReason = String(reason || '').trim();
  const whenLine = formatWhenForCustomer(appt.date, appt.time, appt.timezone);
  const firstName = String(appt.name || '').split(/\s+/)[0] || 'there';
  const subject = `Your Phone Appointment has been canceled`;

  const textLines = [
    `Hi ${firstName},`,
    ``,
    `Your phone appointment on ${whenLine} has been canceled.`,
    ``,
    `Reason: ${safeReason || '(no reason given)'}`,
    ``,
    `If this was a mistake, just reply to this email and our support team will help.`,
    ``,
    `— Renewed Vision Support`,
  ];

  // HTML version — minimal, matches the confirmation email's voice.
  const escHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.5;max-width:560px;">
      <p>Hi ${escHtml(firstName)},</p>
      <p>Your phone appointment on <strong>${escHtml(whenLine)}</strong> has been canceled.</p>
      <p><strong>Reason:</strong> ${escHtml(safeReason || '(no reason given)')}</p>
      <p>If this was a mistake, just reply to this email and our support team will help.</p>
      <p style="color:#666;margin-top:22px;">— Renewed Vision Support</p>
    </div>
  `;

  try {
    await mailer.sendMail({
      from: NOTIFY_FROM,
      to: appt.email,
      replyTo: NOTIFY_TO, // replies go to support@
      subject,
      text: textLines.join('\n'),
      html,
    });
    console.log(`[email] sent cancellation for appt #${appt.id} → ${appt.email}`);
  } catch (err) {
    console.error(`[email] cancellation send failed for appt #${appt.id}:`, err.message);
  }
}

// (The support@ *notification* email that used to fire on new bookings
//  was replaced by Zendesk ticket creation — see createZendeskTicket()
//  above. NOTIFY_FROM / NOTIFY_TO are still used for the customer-facing
//  confirmation and cancellation emails.)

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

  -- Application users (admin + viewer). Separate from the single env-var
  -- ADMIN_PASSWORD, which still works as a built-in "root" login so you
  -- can't lock yourself out.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Custom availability slots. Lets the admin open up times outside the
  -- default Mon–Fri 9:00–17:00 ET schedule — e.g. a Saturday morning or a
  -- 19:00 evening slot. Customers can book these from the normal booking
  -- page just like any other offered slot.
  CREATE TABLE IF NOT EXISTS custom_slots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, time)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_slots_date ON custom_slots(date);

  -- Editable message templates. Powers the customer confirmation email
  -- and the public Zendesk cancellation comment. Placeholders use
  -- {snake_case} syntax (see renderTemplate below). Defaults are seeded
  -- on startup from the DEFAULT_TEMPLATES constant.
  CREATE TABLE IF NOT EXISTS templates (
    name       TEXT PRIMARY KEY,
    subject    TEXT,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- Migration: cancel_token column --------------------------------------
// SQLite's CREATE TABLE IF NOT EXISTS won't add new columns to existing
// tables, so we check pragma and ALTER TABLE if needed. Backfill existing
// rows with random tokens so the cancel/reschedule links work for them too.
(function migrateCancelToken() {
  const cols = db.prepare(`PRAGMA table_info(appointments)`).all();
  const hasCol = cols.some((c) => c.name === 'cancel_token');
  if (!hasCol) {
    db.exec(`ALTER TABLE appointments ADD COLUMN cancel_token TEXT`);
  }
  // Unique index (separate from the column because SQLite can't add UNIQUE
  // inline via ALTER). IF NOT EXISTS means re-runs are safe.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_appts_token ON appointments(cancel_token)`
  );
  // Backfill rows that predate the column.
  const missing = db
    .prepare(`SELECT id FROM appointments WHERE cancel_token IS NULL`)
    .all();
  if (missing.length > 0) {
    const upd = db.prepare(
      `UPDATE appointments SET cancel_token = ? WHERE id = ?`
    );
    for (const row of missing) {
      upd.run(crypto.randomBytes(16).toString('hex'), row.id);
    }
    console.log(`[db] backfilled cancel_token for ${missing.length} rows`);
  }
})();

// ---- Migration: users.full_name ------------------------------------------
// Optional "real name" stored alongside the login username. Used in the UI
// header ("Signed in as Alex Smith") and for matching appointments to
// their assigned rep in the "My appointments" toggle.
(function migrateUsersFullName() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === 'full_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN full_name TEXT`);
  }
})();

// ---- Migration: appointments.assigned_rep --------------------------------
// The name of the rep scheduled to take the call at the appointment's time,
// as returned by the RenewedVision scheduler (e.g. "Riley Harmon"). Stored
// at booking time so the admin appointment list can show it, and so the
// "My appointments" toggle works even when Zendesk is disabled.
(function migrateAssignedRep() {
  const cols = db.prepare(`PRAGMA table_info(appointments)`).all();
  if (!cols.some((c) => c.name === 'assigned_rep')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN assigned_rep TEXT`);
  }
})();

// ---- Migration: zendesk_ticket_id column ---------------------------------
// Stored on each appointment so reschedule/cancel can update the SAME ticket
// instead of spawning new ones. NULL for rows created before the integration
// was wired up (or when Zendesk is disabled).
(function migrateZendeskTicketId() {
  const cols = db.prepare(`PRAGMA table_info(appointments)`).all();
  if (!cols.some((c) => c.name === 'zendesk_ticket_id')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN zendesk_ticket_id INTEGER`);
  }
})();

// ---- Migration: timezone column ------------------------------------------
// The booking page sends the customer's IANA TZ (e.g. "America/Chicago") so
// that the confirmation email renders times in their local zone. We store
// it per-appointment. Legacy rows stay NULL — email falls back to ET only.
(function migrateTimezone() {
  const cols = db.prepare(`PRAGMA table_info(appointments)`).all();
  if (!cols.some((c) => c.name === 'timezone')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN timezone TEXT`);
  }
})();

// ---- Migration: session identity columns ---------------------------------
// The original sessions table only tracked (token, created_at). Now that we
// have user accounts we also store the user identity on each session so
// permission checks don't need a join on every request. Existing rows (if
// any) predate user accounts and therefore came in via ADMIN_PASSWORD — we
// treat them as the built-in "admin" root user.
(function migrateSessions() {
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('user_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id INTEGER`);
  }
  if (!names.has('username')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN username TEXT`);
  }
  if (!names.has('role')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN role TEXT`);
  }
  db.exec(
    `UPDATE sessions
        SET username = COALESCE(username, 'admin'),
            role     = COALESCE(role,     'admin')
      WHERE username IS NULL OR role IS NULL`
  );
})();

// ---- Message templates ---------------------------------------------------
//
// Two customer-facing messages are editable via /api/templates and the
// "Templates" panel on the admin page:
//   confirmation_email    — emailed to the customer on booking & reschedule
//   cancellation_comment  — posted as a PUBLIC Zendesk comment on cancel
//                           (customer or admin); Zendesk auto-emails it
//
// Placeholders are rendered at send time — see renderTemplate(). The
// defaults below match the pre-templating behavior exactly, so upgrading
// a deployment is a no-op until an admin edits something.
const DEFAULT_TEMPLATES = {
  confirmation_email: {
    subject: 'Phone Appointment with Renewed Vision on {date} at {time}',
    body: [
      'Hi {first_name},',
      '',
      'Thanks for booking with Renewed Vision Support! Your appointment is confirmed.',
      '',
      'When: {when}',
      'Phone: {phone}',
      'Software Version: {software_version}',
      'Notes you shared: {notes}',
      '',
      'Ticket Reference Number: {ticket_id}',
      '',
      "We'll reach out at the time above.",
      '',
      '— Renewed Vision Support',
    ].join('\n'),
  },
  cancellation_comment: {
    subject: '',
    body: [
      'Hi {first_name},',
      '',
      'Your phone appointment on {when} has been canceled.',
      '',
      'Reason: {reason}',
      '',
      'If this was a mistake, just reply to this message and our support team will help.',
      '',
      '— Renewed Vision Support',
    ].join('\n'),
  },
};

// Seed defaults on first boot. INSERT OR IGNORE so existing rows aren't
// overwritten when a new release of this server ships updated defaults —
// admins that customized their templates keep their edits.
(function seedTemplates() {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO templates (name, subject, body) VALUES (?, ?, ?)`
  );
  for (const [name, t] of Object.entries(DEFAULT_TEMPLATES)) {
    ins.run(name, t.subject || '', t.body);
  }
})();

/**
 * Load a template by name, falling back to the hard-coded default if the
 * row isn't there (shouldn't happen after seeding, but belt-and-braces).
 */
function getTemplate(name) {
  const row = db
    .prepare('SELECT subject, body FROM templates WHERE name = ?')
    .get(name);
  if (row) return row;
  return DEFAULT_TEMPLATES[name] || null;
}

/**
 * Substitute {snake_case} placeholders in `template.subject` and
 * `template.body` with values from `context`. Empty / missing values
 * render as an empty string, and any line that became "Label: " with
 * nothing after the colon is dropped so empty fields don't leave
 * cosmetic stubs. Also collapses 3+ blank lines down to 2.
 *
 * Unknown placeholders are left intact so the admin sees them literally
 * if they typo a name — clearer than silently losing content.
 */
function renderTemplate(template, context) {
  const replaceIn = (s) =>
    (s || '').replace(/\{(\w+)\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(context, key)) {
        const v = context[key];
        return v == null ? '' : String(v);
      }
      return match;
    });
  const subject = replaceIn(template.subject);
  let body = replaceIn(template.body);
  body = body
    .split('\n')
    .filter((line) => !/^\s*[^:\n]+:\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { subject, body };
}

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO appointments (date, time, name, email, phone, software_version, notes, source, cancel_token, timezone)
  VALUES (@date, @time, @name, @email, @phone, @software_version, @notes, @source, @cancel_token, @timezone)
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
const stmtFindById = db.prepare(`SELECT * FROM appointments WHERE id = ?`);
const stmtUpdateZendeskTicketId = db.prepare(
  `UPDATE appointments SET zendesk_ticket_id = ? WHERE id = ?`
);
const stmtUpdateAssignedRep = db.prepare(
  `UPDATE appointments SET assigned_rep = ? WHERE id = ?`
);

// Cancel / reschedule lookups by the per-appointment secret token.
const stmtFindByToken = db.prepare(`
  SELECT * FROM appointments WHERE cancel_token = ?
`);
const stmtDeleteByToken = db.prepare(`
  DELETE FROM appointments WHERE cancel_token = ?
`);
const stmtUpdateByToken = db.prepare(`
  UPDATE appointments
     SET date = @date,
         time = @time,
         phone = COALESCE(@phone, phone),
         software_version = COALESCE(@software_version, software_version),
         notes = COALESCE(@notes, notes),
         timezone = COALESCE(@timezone, timezone)
   WHERE cancel_token = @cancel_token
`);
const stmtInsertSession = db.prepare(
  `INSERT INTO sessions (token, user_id, username, role) VALUES (?, ?, ?, ?)`
);
const stmtFindSession = db.prepare(
  `SELECT token, user_id, username, role FROM sessions WHERE token = ?`
);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`);
const stmtDeleteSessionsForUser = db.prepare(
  `DELETE FROM sessions WHERE user_id = ?`
);
// Invalidate every session for a user EXCEPT the caller's current one. Used
// by the self-service password change so other devices get logged out but
// the admin doing the change stays signed in.
const stmtDeleteOtherSessionsForUser = db.prepare(
  `DELETE FROM sessions WHERE user_id = ? AND token != ?`
);
// Needed by POST /api/me/password to look up the current user with their
// stored password hash (the public finder omits that column).
const stmtFindUserByIdWithHash = db.prepare(
  `SELECT id, username, password_hash, role FROM users WHERE id = ?`
);

// User-related prepared statements
const stmtInsertUser = db.prepare(
  `INSERT INTO users (username, password_hash, role, full_name)
   VALUES (?, ?, ?, ?)`
);
const stmtListUsers = db.prepare(
  `SELECT id, username, role, full_name, created_at
     FROM users ORDER BY username ASC`
);
const stmtFindUserByName = db.prepare(
  `SELECT id, username, password_hash, role, full_name
     FROM users WHERE username = ?`
);
const stmtFindUserById = db.prepare(
  `SELECT id, username, role, full_name FROM users WHERE id = ?`
);
const stmtUpdateUserRole = db.prepare(
  `UPDATE users SET role = ? WHERE id = ?`
);
const stmtUpdateUserFullName = db.prepare(
  `UPDATE users SET full_name = ? WHERE id = ?`
);
const stmtUpdateUserPassword = db.prepare(
  `UPDATE users SET password_hash = ? WHERE id = ?`
);
const stmtDeleteUser = db.prepare(`DELETE FROM users WHERE id = ?`);

// Custom slot prepared statements
const stmtInsertCustomSlot = db.prepare(
  `INSERT INTO custom_slots (date, time) VALUES (?, ?)`
);
const stmtListCustomSlotsByDate = db.prepare(
  `SELECT id, date, time FROM custom_slots WHERE date = ? ORDER BY time ASC`
);
const stmtListAllCustomSlots = db.prepare(
  `SELECT id, date, time FROM custom_slots ORDER BY date ASC, time ASC`
);
const stmtListCustomSlotsInRange = db.prepare(
  `SELECT id, date, time FROM custom_slots WHERE date BETWEEN ? AND ? ORDER BY date ASC, time ASC`
);
const stmtFindCustomSlotByDateTime = db.prepare(
  `SELECT id, date, time FROM custom_slots WHERE date = ? AND time = ?`
);
const stmtDeleteCustomSlot = db.prepare(`DELETE FROM custom_slots WHERE id = ?`);

// Template prepared statements
const stmtListTemplates = db.prepare(
  `SELECT name, subject, body, updated_at FROM templates ORDER BY name ASC`
);
const stmtFindTemplate = db.prepare(
  `SELECT name, subject, body, updated_at FROM templates WHERE name = ?`
);
const stmtUpdateTemplate = db.prepare(
  `UPDATE templates SET subject = ?, body = ?, updated_at = datetime('now') WHERE name = ?`
);

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

/**
 * Look up the current session from the admin_token cookie. Returns an
 * object { token, user_id, username, role } or null if not logged in.
 * The result is cached on `req` so repeated middleware calls are cheap.
 */
function getSession(req) {
  if (req._session !== undefined) return req._session;
  const token = req.cookies.admin_token;
  if (!token) {
    req._session = null;
    return null;
  }
  const row = stmtFindSession.get(token);
  if (!row) {
    req._session = null;
    return null;
  }
  // Defensive: sessions migrated from the legacy table might have role
  // NULL even after the migration UPDATE; treat those as root admin.
  if (!row.role) row.role = 'admin';
  if (!row.username) row.username = 'admin';
  req._session = row;
  return row;
}

/** Kept for callers that just want a yes/no. */
function isAdmin(req) {
  const s = getSession(req);
  return !!s && s.role === 'admin';
}

/** Require any logged-in user (admin OR viewer). */
function requireUser(req, res, next) {
  const s = getSession(req);
  if (!s) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** Require a logged-in admin. Viewers get a 403. */
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (s.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
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

// POST /login
// Accepts either a username/password pair (new) or just a bare password
// (legacy form — treated as the built-in root admin). We authenticate in
// this priority order:
//   1. ADMIN_PASSWORD env var → session as built-in "admin" root (user_id=NULL)
//   2. Lookup username in users table and verifyPassword()
//
// On failure, re-render the login page with a small error banner so the
// user can try again without losing state.
app.post('/login', (req, res) => {
  const body = req.body || {};
  const rawUsername = String(body.username || '').trim();
  const password = String(body.password || '');

  // Legacy support: if no username was provided, assume "admin".
  const username = rawUsername || 'admin';

  // Root login via ADMIN_PASSWORD. Always accepted for username "admin".
  let session = null;
  if (username === 'admin' && password && password === ADMIN_PASSWORD) {
    session = { user_id: null, username: 'admin', role: 'admin' };
  } else {
    // User-table login. Rate-limiting is intentionally omitted here —
    // this app runs behind a single org's Render instance, not on the
    // open internet. Add fail2ban / rate limiting at the edge if needed.
    const user = stmtFindUserByName.get(username);
    if (user && verifyPassword(password, user.password_hash)) {
      session = {
        user_id: user.id,
        username: user.username,
        role: user.role,
      };
    }
  }

  if (!session) {
    return res
      .status(401)
      .sendFile(path.join(__dirname, 'public', 'login.html'), {}, (err) => {
        // If we can't send the file for some reason, fall back to plain HTML.
        if (err) {
          res.status(401).send(
            '<p>Wrong username or password. <a href="/login">Try again</a>.</p>'
          );
        }
      });
  }

  const token = crypto.randomBytes(24).toString('hex');
  stmtInsertSession.run(token, session.user_id, session.username, session.role);
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

// The /admin page is served to any logged-in user (admin or viewer).
// Role-gating of individual panels is done inside admin.html based on
// the /api/me response.
app.get('/admin', requireUser, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// /api/me — returns the current user's identity so the admin page can
// decide which panels to render. Also returns the Zendesk subdomain (if
// configured) so the page can build links to tickets. Safe for any
// logged-in user.
app.get('/api/me', requireUser, (req, res) => {
  const s = getSession(req);
  // full_name only exists on real user rows (not on the ADMIN_PASSWORD
  // root login, which has user_id = NULL).
  let fullName = '';
  if (s.user_id) {
    const u = stmtFindUserById.get(s.user_id);
    if (u && u.full_name) fullName = u.full_name;
  }
  res.json({
    username: s.username,
    role: s.role,
    full_name: fullName,
    zendesk_subdomain: ZENDESK_SUBDOMAIN || '',
    // Built-in ADMIN_PASSWORD login has no user row — flagged here so the
    // UI can hide self-service password-change (env-var password is
    // managed in Render, not in this app's DB).
    is_root: !s.user_id,
  });
});

// POST /api/me/password — a logged-in user changes their own password.
// Requires them to re-authenticate with their current password (defends
// against a stolen session being used to lock out the real user). The
// built-in ADMIN_PASSWORD root login can't use this — its password lives
// in the environment, not in the database.
app.post('/api/me/password', requireUser, (req, res) => {
  const s = getSession(req);
  if (!s.user_id) {
    return res.status(400).json({
      error:
        'The built-in admin account\'s password is the ADMIN_PASSWORD env var — change it in Render.',
    });
  }
  const body = req.body || {};
  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  if (!current) {
    return res.status(400).json({ error: 'current password is required' });
  }
  if (!next || next.length < 6) {
    return res
      .status(400)
      .json({ error: 'new password must be at least 6 characters' });
  }
  if (next === current) {
    return res
      .status(400)
      .json({ error: 'new password must be different from the current one' });
  }
  const user = stmtFindUserByIdWithHash.get(s.user_id);
  if (!user) {
    // Session refers to a user that was deleted out from under us — sign
    // them out so they're forced to log in again.
    stmtDeleteSession.run(s.token);
    return res.status(401).json({ error: 'account not found' });
  }
  if (!verifyPassword(current, user.password_hash)) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  stmtUpdateUserPassword.run(hashPassword(next), s.user_id);
  // Log out other active sessions for this user (e.g. other devices), but
  // keep the session that made this request so the admin doesn't get
  // bounced to /login immediately after changing their password.
  stmtDeleteOtherSessionsForUser.run(s.user_id, s.token);
  console.log(`[auth] user ${user.username} changed their own password`);
  res.json({ ok: true });
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
  const booked = new Set(stmtListByDate.all(date).map((r) => r.time));
  const blocked = new Set(
    stmtListBlockTimesForDate.all(date).map((r) => r.time)
  );
  const customRows = stmtListCustomSlotsByDate.all(date);
  const customTimes = new Set(customRows.map((r) => r.time));

  // Build the full list: default business grid on weekdays, plus any
  // custom slots the admin added. De-dupe by time and sort.
  const allTimes = new Set(customTimes);
  if (isWeekday(date)) {
    for (const t of generateSlotsForDay()) allTimes.add(t);
  }
  const ordered = [...allTimes].sort();

  const slots = ordered.map((time) => {
    let status = 'available';
    if (booked.has(time)) status = 'booked';
    else if (blocked.has(time)) status = 'blocked';
    else if (isSlotInPast(date, time)) status = 'past';
    return {
      time,
      status,
      available: status === 'available',
      custom: customTimes.has(time),
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

  const dates = [];

  // Look up to 60 days ahead for enough open days. A day counts as "open"
  // if it has at least one bookable time — default weekday slots OR a
  // custom slot — that isn't booked, blocked, or in the past.
  for (let i = 0; i < 60 && dates.length < count; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dateStr = formatLocalDate(d);

    const customTimes = stmtListCustomSlotsByDate.all(dateStr).map((r) => r.time);
    const isBusinessDay = isWeekday(dateStr);
    if (!isBusinessDay && customTimes.length === 0) continue;

    const bookedTimes  = new Set(stmtListByDate.all(dateStr).map(r => r.time));
    const blockedTimes = new Set(stmtListBlockTimesForDate.all(dateStr).map(r => r.time));

    const candidateTimes = new Set(customTimes);
    if (isBusinessDay) {
      for (const t of generateSlotsForDay()) candidateTimes.add(t);
    }
    let hasOpen = false;
    for (const t of candidateTimes) {
      if (bookedTimes.has(t) || blockedTimes.has(t)) continue;
      if (isSlotInPast(dateStr, t)) continue;
      hasOpen = true;
      break;
    }
    if (hasOpen) dates.push(dateStr);
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
  // IANA timezone the customer's browser is in (e.g. "America/Chicago").
  // We only trust real IANA names, not free-form strings.
  const timezone = isValidTimezone(body.timezone) ? body.timezone : null;

  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!time || !isValidSlotFormat(time)) {
    return res
      .status(400)
      .json({ error: 'time must be a 30-minute slot (HH:00 or HH:30)' });
  }
  // Slot must be offered: default weekday 9-5 grid, OR an explicit custom slot.
  if (!isSlotOffered(date, time)) {
    return res.status(400).json({
      error:
        'that time is not available — pick a weekday 9:00–16:30 Eastern or an added slot',
    });
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
    const cancel_token = crypto.randomBytes(16).toString('hex');
    const result = stmtInsert.run({
      date,
      time,
      name: name.trim(),
      email: email.trim(),
      phone: String(phone).trim(),
      software_version: String(software_version).trim(),
      notes: String(notes).trim(),
      source,
      cancel_token,
      timezone,
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
      cancel_token,
      timezone,
    };
    // Fire-and-forget side effects: don't block the customer's response.
    //   1. Ask the RenewedVision scheduler who's on phones at this time and
    //      store that name on the appointment row. This powers the admin
    //      "Assignee" column and the "My appointments" toggle — and it
    //      happens even when Zendesk is disabled.
    //   2. Create a Zendesk ticket (replaces the old support@ email). When
    //      the ticket is created we save its id on the appointment row so
    //      reschedule/cancel can update the SAME ticket later.
    //   3. Send the customer their confirmation email.
    // Each step failing doesn't affect the others.
    (async () => {
      try {
        const assignedRep = await lookupAssignedRep(appt);
        if (assignedRep) {
          stmtUpdateAssignedRep.run(assignedRep, appt.id);
          appt.assigned_rep = assignedRep;
        }
      } catch (e) {
        console.error('[rv-sched] unexpected error (assign):', e);
      }
      try {
        const ticketId = await createZendeskTicket(appt);
        if (ticketId) {
          stmtUpdateZendeskTicketId.run(ticketId, appt.id);
          appt.zendesk_ticket_id = ticketId;
        }
      } catch (e) {
        console.error('[zendesk] unexpected error (create):', e);
      }
      // Send the confirmation email AFTER Zendesk ticket creation so the
      // email can include the ticket reference number. Still inside the
      // same async block so the HTTP response isn't blocked on SMTP.
      try {
        await sendCustomerConfirmation(appt);
      } catch (e) {
        console.error('[email] unexpected error (confirmation):', e);
      }
    })();
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

// ---- Cancel / reschedule via secret token --------------------------------
//
// Every appointment has a random cancel_token generated at booking time.
// The token is included in the customer's confirmation email as a link, so
// anyone holding the link can cancel or reschedule that one appointment
// (and only that one — tokens are 128-bit random, not guessable).

// GET /cancel?token=... — cancels the appointment and redirects to a
// static "canceled" page. Uses GET so it works from any email client with
// no JavaScript. Browsers sometimes pre-fetch links, but doing so here is
// harmless: the worst case is that the booking is canceled a moment early.
// GET /cancel?token=... — render the "Reason for Cancellation" form. The
// form itself is served as a static file and pulls the token out of the
// URL client-side; here we just short-circuit if the token is missing or
// already invalid so the customer gets a clear message instead of a form
// that will immediately fail on submit.
//
// NOTE: this route intentionally does NOT delete anything — the delete
// happens in POST /cancel after the customer supplies a reason. That also
// neutralizes the old "some email clients prefetch links" problem, which
// would previously cancel appointments without the user's consent.
app.get('/cancel', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/canceled.html?status=missing');
  const appt = stmtFindByToken.get(token);
  if (!appt) {
    // Already canceled, or never existed. Show the "already canceled"
    // success page so we don't leak which tokens are valid.
    return res.redirect('/canceled.html?status=already');
  }
  res.sendFile(path.join(__dirname, 'public', 'cancel-form.html'));
});

// POST /cancel — actually cancels the appointment. Body must include:
//   token  — the per-appointment secret from the email
//   reason — non-empty string, what the customer typed in the form
// Posts an internal Zendesk comment with the reason and sets the ticket
// status to "open" so an agent knows to follow up (per product spec:
// cancellation is a signal, not a closing action).
app.post('/cancel', (req, res) => {
  const body = req.body || {};
  const token = String(body.token || '');
  const reason = String(body.reason || '').trim();

  if (!token) return res.redirect('/canceled.html?status=missing');
  const appt = stmtFindByToken.get(token);
  if (!appt) return res.redirect('/canceled.html?status=already');
  if (!reason) {
    // Shouldn't happen — the form requires it — but defend anyway. Send
    // the user back to the form with the token preserved.
    return res.redirect(
      '/cancel?token=' + encodeURIComponent(token) + '&missingReason=1'
    );
  }

  stmtDeleteByToken.run(token);
  console.log(
    `[cancel] appt #${appt.id} canceled via token with reason: ${reason.slice(0, 200)}`
  );

  // Single notification path: a PUBLIC Zendesk comment on the existing
  // ticket, which Zendesk auto-emails to the requester. Status flips to
  // 'open' so an agent picks up the follow-up. Falls back to direct
  // email only if no ticket exists for this appointment.
  notifyCustomerOfCancellation(appt, reason, { status: 'open' })
    .then((path) =>
      console.log(`[cancel] appt #${appt.id}: customer notified via ${path}`)
    )
    .catch((e) =>
      console.error('[cancel] customer notification error:', e)
    );

  res.redirect('/canceled.html?status=ok');
});

// GET /api/appointment-by-token?token=... — returns the fields needed to
// prefill the booking form. Never returns the token itself.
app.get('/api/appointment-by-token', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  const a = stmtFindByToken.get(token);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({
    id: a.id,
    date: a.date,
    time: a.time,
    name: a.name,
    email: a.email,
    phone: a.phone || '',
    software_version: a.software_version || '',
    notes: a.notes || '',
  });
});

// POST /api/appointments/reschedule — update an existing appointment's
// date/time (and optionally phone / software / notes) by token.
app.post('/api/appointments/reschedule', (req, res) => {
  const body = req.body || {};
  const token = String(body.token || '');
  const { date, time } = body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const existing = stmtFindByToken.get(token);
  if (!existing) return res.status(404).json({ error: 'appointment not found' });

  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!time || !isValidSlotFormat(time)) {
    return res.status(400).json({
      error: 'time must be a 30-minute slot (HH:00 or HH:30)',
    });
  }
  if (!isSlotOffered(date, time)) {
    return res.status(400).json({
      error:
        'that time is not available — pick a weekday 9:00–16:30 Eastern or an added slot',
    });
  }
  if (isSlotInPast(date, time)) {
    return res.status(400).json({ error: 'That time slot has already passed.' });
  }
  if (stmtFindBlockByDateTime.get(date, time)) {
    return res.status(409).json({ error: 'That time slot is unavailable.' });
  }
  // Allow "reschedule to the same slot" — no-op. If a different slot, the
  // UNIQUE(date,time) constraint will guard against booking over someone else.
  const sameSlot = date === existing.date && time === existing.time;

  try {
    stmtUpdateByToken.run({
      date,
      time,
      phone: body.phone != null ? String(body.phone).trim() : null,
      software_version:
        body.software_version != null
          ? String(body.software_version).trim()
          : null,
      notes: body.notes != null ? String(body.notes).trim() : null,
      timezone: isValidTimezone(body.timezone) ? body.timezone : null,
      cancel_token: token,
    });
    const updated = stmtFindByToken.get(token);
    console.log(
      `[reschedule] appt #${updated.id}: ${existing.date} ${existing.time} → ${updated.date} ${updated.time}`
    );
    // Fire-and-forget: send a fresh confirmation email reflecting the new time.
    sendCustomerConfirmation(updated).catch((e) =>
      console.error('[email] unexpected error (reschedule confirmation):', e)
    );
    // Post-reschedule side effects (fire-and-forget):
    //   1. The time changed, so the on-phones rep likely changed too.
    //      Re-look up and update assigned_rep.
    //   2. Zendesk: if a ticket was created for this appointment, drop an
    //      internal comment with the old → new times. If for some reason
    //      we don't have a ticket id (legacy row, Zendesk was disabled at
    //      booking time), create a fresh ticket.
    (async () => {
      try {
        const newRep = await lookupAssignedRep(updated);
        if (newRep !== updated.assigned_rep) {
          stmtUpdateAssignedRep.run(newRep || null, updated.id);
          updated.assigned_rep = newRep || null;
        }
      } catch (e) {
        console.error('[rv-sched] unexpected error (reschedule assign):', e);
      }
      try {
        const oldWhen = formatWhenForCustomer(existing.date, existing.time, existing.timezone);
        const newWhen = formatWhenForCustomer(updated.date, updated.time, updated.timezone);
        if (updated.zendesk_ticket_id) {
          await appendZendeskComment(
            updated.zendesk_ticket_id,
            `Appointment rescheduled by the customer.\n\n` +
              `From: ${oldWhen}\n` +
              `To:   ${newWhen}`
          );
        } else if (zendeskEnabled) {
          const ticketId = await createZendeskTicket(updated);
          if (ticketId) {
            stmtUpdateZendeskTicketId.run(ticketId, updated.id);
          }
        }
      } catch (e) {
        console.error('[zendesk] unexpected error (reschedule):', e);
      }
    })();
    res.json(updated);
  } catch (err) {
    if (
      err &&
      (err.errcode === 2067 ||
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message || '').includes('UNIQUE constraint failed'))
    ) {
      if (sameSlot) {
        // Shouldn't happen, but be explicit
        return res.json(existing);
      }
      return res.status(409).json({ error: 'That time slot is already booked.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// List appointments. Any logged-in user (admin or viewer) can read the
// list — viewers see the full list but the admin page hides the
// Availability / Users panels for them. Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD.
app.get('/api/appointments', requireUser, (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to && isValidDate(from) && isValidDate(to)) {
    rows = stmtListRange.all(from, to);
  } else {
    rows = stmtListAll.all();
  }
  res.json({ appointments: rows });
});

// Cancel an appointment (admin-only). Body must include { reason: string }.
// The reason is shared with the customer (in the cancellation email) and
// logged on the Zendesk ticket, so agents should treat it as visible.
app.delete('/api/appointments/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const body = req.body || {};
  const reason = String(body.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ error: 'reason is required' });
  }
  // Grab the row BEFORE we delete it so we can drop a Zendesk cancel
  // comment using the stored ticket id and email the customer. (Once the
  // row is gone, so are the fields we need.)
  const appt = stmtFindById.get(id);
  const result = stmtDelete.run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  const who = (getSession(req) || {}).username || 'admin';
  console.log(
    `[cancel] appt #${id} canceled by admin (${who}) with reason: ${reason.slice(0, 200)}`
  );

  if (appt) {
    // Two Zendesk updates (fire-and-forget):
    //   1. INTERNAL audit note — which admin canceled. Kept private so it
    //      doesn't appear in the customer's email.
    //   2. PUBLIC customer-facing comment — Zendesk fires its own
    //      notification trigger, emailing the requester. Also transitions
    //      the ticket to 'solved' since this is a final disposition from
    //      the team (differs from the customer-initiated cancel which
    //      reopens the ticket).
    // If no ticket id exists (rare — pre-Zendesk rows), the public
    // notification falls back to direct email inside notifyCustomer*.
    if (appt.zendesk_ticket_id) {
      appendZendeskComment(
        appt.zendesk_ticket_id,
        `Canceled by ${who} from the admin page.`,
        { isPublic: false }
      ).catch((e) => console.error('[zendesk] admin audit note error:', e));
    }
    notifyCustomerOfCancellation(appt, reason, { status: 'solved' })
      .then((path) =>
        console.log(`[cancel] appt #${id}: customer notified via ${path}`)
      )
      .catch((e) =>
        console.error('[cancel] admin customer notification error:', e)
      );
  }
  res.json({ ok: true });
});

// ---- User management (admin-only) ----------------------------------------
//
// Users created here sign in via username + password. The ADMIN_PASSWORD
// env var still works as a built-in "admin" root login and cannot be
// managed via these endpoints — there's no row in the users table for it.
// Roles: 'admin' (full access) | 'viewer' (read-only appointment list).

function userRowToPublic(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    full_name: u.full_name || '',
    created_at: u.created_at,
  };
}

app.get('/api/users', requireAdmin, (_req, res) => {
  res.json({ users: stmtListUsers.all().map(userRowToPublic) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '').trim();
  // Optional. Shown in the header and used to match against the scheduler's
  // assigned-rep name when an admin toggles "My appointments only".
  const fullName = body.full_name != null ? String(body.full_name).trim() : '';

  if (!isValidUsername(username)) {
    return res
      .status(400)
      .json({ error: 'username must be 3–32 chars: letters, digits, . _ -' });
  }
  if (username === 'admin') {
    // Avoid shadowing the built-in root login. (Case-insensitive check.)
    return res
      .status(400)
      .json({ error: '"admin" is reserved for the root login' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (role !== 'admin' && role !== 'viewer') {
    return res.status(400).json({ error: 'role must be "admin" or "viewer"' });
  }
  if (fullName.length > 100) {
    return res.status(400).json({ error: 'full name is too long (max 100 chars)' });
  }

  try {
    const result = stmtInsertUser.run(
      username,
      hashPassword(password),
      role,
      fullName || null
    );
    const created = stmtFindUserById.get(result.lastInsertRowid);
    res.status(201).json(userRowToPublic({
      ...created,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }));
  } catch (err) {
    if (
      err &&
      (err.errcode === 2067 ||
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message || '').includes('UNIQUE constraint failed'))
    ) {
      return res.status(409).json({ error: 'username already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const existing = stmtFindUserById.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const body = req.body || {};
  const updates = {};

  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (role !== 'admin' && role !== 'viewer') {
      return res.status(400).json({ error: 'role must be "admin" or "viewer"' });
    }
    updates.role = role;
  }
  if (body.password !== undefined) {
    const pw = String(body.password);
    if (!pw || pw.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    updates.password_hash = hashPassword(pw);
  }
  if (body.full_name !== undefined) {
    const fn = String(body.full_name || '').trim();
    if (fn.length > 100) {
      return res.status(400).json({ error: 'full name is too long (max 100 chars)' });
    }
    updates.full_name = fn || null;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'nothing to update' });
  }

  if (updates.role) stmtUpdateUserRole.run(updates.role, id);
  if (Object.prototype.hasOwnProperty.call(updates, 'full_name')) {
    stmtUpdateUserFullName.run(updates.full_name, id);
  }
  if (updates.password_hash) {
    stmtUpdateUserPassword.run(updates.password_hash, id);
    // Force re-login after a password change.
    stmtDeleteSessionsForUser.run(id);
  }
  res.json(userRowToPublic(stmtFindUserById.get(id)));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const existing = stmtFindUserById.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Don't let an admin delete their own logged-in account and lock themselves
  // out. (The ADMIN_PASSWORD root user has user_id = NULL so it's never
  // deletable via this endpoint anyway.)
  const me = getSession(req);
  if (me && me.user_id === id) {
    return res
      .status(400)
      .json({ error: "you can't delete the account you're logged in as" });
  }

  stmtDeleteUser.run(id);
  stmtDeleteSessionsForUser.run(id); // invalidate any active sessions
  res.json({ ok: true });
});

// ---- Message templates (admin-only writes, admin-only reads) -------------
//
// Two message templates are editable: the customer-facing confirmation
// email and the public Zendesk cancellation comment. Placeholders use
// {snake_case} — the available set is defined below and surfaced in the
// admin UI so customers have a cheat-sheet.

const TEMPLATE_META = {
  confirmation_email: {
    label: 'Confirmation email',
    description:
      'Emailed to the customer when they book or reschedule. ' +
      'The "Reschedule / Cancel" button block is appended automatically ' +
      'when APP_BASE_URL is set; it\'s not part of this template.',
    has_subject: true,
    placeholders: [
      'first_name', 'name', 'when', 'date', 'time',
      'phone', 'software_version', 'notes', 'ticket_id',
    ],
  },
  cancellation_comment: {
    label: 'Cancellation comment (Zendesk public)',
    description:
      'Posted as a public comment on the Zendesk ticket when an ' +
      'appointment is canceled — Zendesk emails it to the customer.',
    has_subject: false,
    placeholders: [
      'first_name', 'name', 'when', 'date', 'time',
      'phone', 'reason', 'ticket_id',
    ],
  },
};

function templateRowToPublic(row) {
  const meta = TEMPLATE_META[row.name] || {};
  return {
    name: row.name,
    subject: row.subject || '',
    body: row.body || '',
    updated_at: row.updated_at,
    label: meta.label || row.name,
    description: meta.description || '',
    has_subject: !!meta.has_subject,
    placeholders: meta.placeholders || [],
  };
}

app.get('/api/templates', requireAdmin, (_req, res) => {
  res.json({ templates: stmtListTemplates.all().map(templateRowToPublic) });
});

app.get('/api/templates/:name', requireAdmin, (req, res) => {
  const row = stmtFindTemplate.get(req.params.name);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(templateRowToPublic(row));
});

app.put('/api/templates/:name', requireAdmin, (req, res) => {
  const name = req.params.name;
  const existing = stmtFindTemplate.get(name);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const body = req.body || {};
  const bodyStr = body.body != null ? String(body.body) : existing.body;
  const meta = TEMPLATE_META[name] || {};
  const subjectStr = meta.has_subject
    ? (body.subject != null ? String(body.subject) : existing.subject)
    : ''; // templates without a subject always have an empty one stored

  if (!bodyStr.trim()) {
    return res.status(400).json({ error: 'body is required' });
  }
  if (bodyStr.length > 10000) {
    return res.status(400).json({ error: 'body is too long (max 10,000 chars)' });
  }
  if (meta.has_subject && !subjectStr.trim()) {
    return res.status(400).json({ error: 'subject is required' });
  }
  if (subjectStr.length > 500) {
    return res.status(400).json({ error: 'subject is too long (max 500 chars)' });
  }

  stmtUpdateTemplate.run(subjectStr, bodyStr, name);
  const updated = stmtFindTemplate.get(name);
  console.log(`[templates] ${name} updated by ${(getSession(req) || {}).username || 'admin'}`);
  res.json(templateRowToPublic(updated));
});

// POST /api/templates/:name/reset — restore the hard-coded default.
app.post('/api/templates/:name/reset', requireAdmin, (req, res) => {
  const name = req.params.name;
  const existing = stmtFindTemplate.get(name);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const def = DEFAULT_TEMPLATES[name];
  if (!def) return res.status(404).json({ error: 'no default known for this template' });
  stmtUpdateTemplate.run(def.subject || '', def.body, name);
  res.json(templateRowToPublic(stmtFindTemplate.get(name)));
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

  if (time && !times) times = [time];
  if (!Array.isArray(times) || times.length === 0) {
    return res
      .status(400)
      .json({ error: 'provide `time` or a non-empty `times` array' });
  }
  for (const t of times) {
    // Allow blocking any slot that's actually offered on this date
    // (default weekday grid OR an admin-added custom slot).
    if (!isSlotOffered(date, t)) {
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

// ---- Custom availability slots (admin-only writes, public reads) ---------
//
// The default schedule is Mon–Fri 9:00–17:00 Eastern. To offer times outside
// that window (a Saturday morning, an after-hours slot on Tuesday, etc.) the
// admin can add them explicitly here. Custom slots show up in /api/slots
// and /api/next-available-dates alongside the default grid, and the normal
// booking flow treats them as bookable.

// Public: list custom slots for a date or range. No auth — customers need
// this if you ever want to render them client-side, and it leaks nothing
// sensitive (just which extra times are offered).
app.get('/api/custom-slots', (req, res) => {
  const { date, from, to } = req.query;
  let rows;
  if (date) {
    if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
    rows = stmtListCustomSlotsByDate.all(date);
  } else if (from && to) {
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ error: 'invalid from/to' });
    }
    rows = stmtListCustomSlotsInRange.all(from, to);
  } else {
    rows = stmtListAllCustomSlots.all();
  }
  res.json({ slots: rows });
});

// Admin: add a custom slot.
app.post('/api/custom-slots', requireAdmin, (req, res) => {
  const body = req.body || {};
  const { date, time } = body;
  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  }
  if (!time || !isValidSlotFormat(time)) {
    return res
      .status(400)
      .json({ error: 'time must be HH:MM on a 30-minute increment (e.g. 08:00, 19:30)' });
  }
  // If this slot is already part of the default weekday grid, there's
  // nothing to add — reject clearly so the admin isn't confused.
  if (isWeekday(date) && isDefaultSlotTime(time)) {
    return res
      .status(409)
      .json({ error: 'that time is already part of the default schedule' });
  }
  try {
    const result = stmtInsertCustomSlot.run(date, time);
    res.status(201).json({ id: result.lastInsertRowid, date, time });
  } catch (err) {
    if (
      err &&
      (err.errcode === 2067 ||
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message || '').includes('UNIQUE constraint failed'))
    ) {
      return res.status(409).json({ error: 'that custom slot already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Admin: remove a custom slot. Refuse if someone has already booked it.
app.delete('/api/custom-slots/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const row = db
    .prepare(`SELECT id, date, time FROM custom_slots WHERE id = ?`)
    .get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const booked = stmtListByDate.all(row.date).some((r) => r.time === row.time);
  if (booked) {
    return res.status(409).json({
      error:
        'that slot has an appointment booked — cancel the appointment before removing the slot',
    });
  }
  stmtDeleteCustomSlot.run(id);
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
  if (zendeskEnabled) {
    console.log(
      `  Zendesk   : enabled — https://${ZENDESK_SUBDOMAIN}.zendesk.com` +
        ` (agent map: ${zendeskAgentMap.size} entries` +
        `, tags: ${zendeskTags.join(', ') || '(none)'})`
    );
  } else {
    console.log(
      `  Zendesk   : disabled (set ZENDESK_SUBDOMAIN/EMAIL/TOKEN to enable)`
    );
  }
});
