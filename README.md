# Appointment Scheduler

A small Node.js app with three things:

1. A **customer-facing booking page** (`/`) — pick a day, pick a 30-min slot, fill in a form.
2. An **admin scheduler page** (`/admin`) — password-protected view of all appointments, with cancel buttons.
3. A **REST API** (`/api/*`) — so external services can read availability and create appointments too.

**Double-booking is impossible**: the database has a `UNIQUE(date, time)` constraint, so whether a booking comes from the web form or from an external API call, the second writer for a given slot gets a **409 Conflict** instead of a silent overwrite.

## Quick start

Requires Node.js **22.5 or newer** (uses the built-in `node:sqlite` module — no native compilation needed).

```bash
npm install                # installs express
npm start                  # runs on http://localhost:3000
```

Then open:

- http://localhost:3000/ — booking page
- http://localhost:3000/admin — scheduler (password below)

### Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | `changeme` | Password for the `/admin` page |
| `API_KEY` | *(unset)* | If set, external API callers must send `X-API-Key: <value>` on `POST /api/appointments`. Leave unset to keep the API open. |
| `DB_PATH` | `./appointments.db` | SQLite file path |

Example:

```bash
ADMIN_PASSWORD=hunter2 API_KEY=sk_live_abc123 PORT=8080 npm start
```

## Slot model

- 30-minute slots, Monday through Friday, 9:00 AM – 5:00 PM
- Last slot starts at 16:30
- To change: edit `SLOT_MINUTES`, `BUSINESS_START_HOUR`, `BUSINESS_END_HOUR` at the top of `server.js`

## REST API

All endpoints accept and return JSON.

### `GET /api/slots?date=YYYY-MM-DD`

List all slots for a given day with their availability.

```bash
curl 'http://localhost:3000/api/slots?date=2026-04-22'
```

```json
{
  "date": "2026-04-22",
  "slots": [
    { "time": "09:00", "available": true },
    { "time": "09:30", "available": false },
    ...
  ]
}
```

Weekends return `{"slots": []}`.

### `POST /api/appointments`

Book an appointment. Public — but enforces the `UNIQUE(date, time)` constraint.

**Required fields:** `date`, `time`, `name`, `email`
**Optional:** `phone`, `software_version`, `notes`

```bash
curl -X POST http://localhost:3000/api/appointments \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: sk_live_abc123' \
  -d '{
    "date": "2026-04-22",
    "time": "10:00",
    "name": "Alice Example",
    "email": "alice@example.com",
    "phone": "+1-555-0100",
    "software_version": "7.12.3",
    "notes": "Upgrade assistance"
  }'
```

Response (201):

```json
{
  "id": 42,
  "date": "2026-04-22",
  "time": "10:00",
  "name": "Alice Example",
  "email": "alice@example.com",
  "phone": "+1-555-0100",
  "software_version": "7.12.3",
  "notes": "Upgrade assistance",
  "source": "api"
}
```

**Errors:**

| Code | Meaning |
|---|---|
| 400 | Missing or invalid field (bad date, weekend, off-grid time, bad email, etc.) |
| 401 | `API_KEY` is set and caller didn't provide a matching `X-API-Key` |
| 409 | Slot is already booked |

The `X-API-Key` header is only required if you set `API_KEY` when starting the server. Appointments created with a key are tagged `source: "api"`; web-form bookings are tagged `source: "web"` and appear as a pill in the admin view.

### `GET /api/appointments` *(admin only)*

List all appointments. Optional `?from=YYYY-MM-DD&to=YYYY-MM-DD`.

Requires a valid `admin_token` cookie (obtained by POSTing to `/login`).

### `DELETE /api/appointments/:id` *(admin only)*

Cancel an appointment. Frees up the slot — another customer or API call can then book it.

## How double-booking is prevented

```sql
CREATE TABLE appointments (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  ...
  UNIQUE (date, time)
);
```

The `UNIQUE` constraint is enforced by SQLite itself, so there's no race window between "check if slot is free" and "insert appointment" that two concurrent writers could slip through. The second writer — whether it's the web form or an external API call — gets SQLite error 2067 (`SQLITE_CONSTRAINT_UNIQUE`), which the server translates to HTTP **409 Conflict** with a friendly message.

## Files

- `server.js` — all routes, DB setup, validation, auth
- `public/booking.html` — customer-facing page
- `public/admin.html` — scheduler page
- `public/login.html` — admin login form
- `appointments.db` — SQLite database (created on first run)

## Production notes

This is a working starting point, not a hardened production service. Before exposing to the internet, you'd want to:

- Put it behind HTTPS (e.g., via a reverse proxy like nginx/Caddy)
- Replace the shared-password auth with real user accounts if multiple admins need access
- Add rate-limiting on `POST /api/appointments` to prevent spam bookings
- Swap SQLite for Postgres if you expect many concurrent users
- Send confirmation emails on booking (currently just stores them)
