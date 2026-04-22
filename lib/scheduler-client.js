// =============================================================================
// RenewedVision Scheduler — client helper
//
// Drop this file into your other web app (e.g. the appointment system) and load
// it with a <script> tag. It lets you query the shared JSONBin schedule to find
// out who's assigned to a given role or role group at a given time.
//
// Quick start:
//
//   <script src="./scheduler-client.js"></script>
//   <script>
//     const sched = RenewedVisionScheduler.create({
//       binId:  "YOUR_BIN_ID",      // same Bin ID used by the scheduler HTML
//       apiKey: "YOUR_X_MASTER_KEY" // same X-Master-Key used by the scheduler
//     });
//
//     // Who's on the "Phone" role right now?
//     const { names } = await sched.whoIsOn({ role: "phone", time: new Date() });
//
//     // Who's on the whole "Phone Group" at 2:00pm on 2026-04-21?
//     const r = await sched.whoIsOn({ group: "Phone Group", time: "2026-04-21T14:00" });
//     console.log(r.names); // => ["Jane Doe", "Joe Smith"]
//   </script>
//
// Caller picks the target: pass either `role` (a role ID like "phone" or
// "phone-2") or `group` (a group name like "Phone Group"). If both are passed,
// the role wins.
//
// Time accepts anything `new Date(x)` understands: Date object, ISO string,
// epoch millis. Weekends and hours outside the scheduled day return [].
//
// The helper caches the fetched schedule for 5 seconds by default so rapid
// queries don't hammer JSONBin. Call `sched.refresh()` to force a re-fetch.
// =============================================================================

(function (global) {
  "use strict";

  const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";

  // Same day ID layout as the scheduler app: Mon=0 .. Fri=4. Sat/Sun have no
  // entry, so weekend lookups return an empty result.
  const DAY_IDS = ["mon", "tue", "wed", "thu", "fri"];

  // Mirror of the scheduler's getMondayOf(): snaps any date to the Monday of
  // its ISO-ish week, with time zeroed out. Sunday is treated as the tail of
  // the previous week (same as the app).
  function getMondayOf(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // YYYY-MM-DD date key, matching toDateKey() in the scheduler. Week buckets
  // in the schedule object are keyed by the Monday date in this format.
  function toDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Turn any user-provided time (Date | ISO string | epoch ms) into the
  // { weekKey, dayId, hour } triple the schedule is keyed on. Returns null if
  // the date falls outside the scheduled days (weekends).
  function timeToSlot(time) {
    const d = new Date(time);
    if (isNaN(d.getTime())) throw new Error("Invalid time: " + time);
    const jsDay = d.getDay(); // 0..6, Sunday..Saturday
    if (jsDay === 0 || jsDay === 6) return null; // no weekend schedule
    const dayId = DAY_IDS[jsDay - 1];
    const hour = d.getHours();
    const weekKey = toDateKey(getMondayOf(d));
    return { weekKey, dayId, hour };
  }

  function create(config) {
    if (!config || !config.binId || !config.apiKey) {
      throw new Error("RenewedVisionScheduler.create: { binId, apiKey } required");
    }

    const cacheTtlMs = typeof config.cacheMs === "number" ? config.cacheMs : 5000;
    let cached = null; // { at: ms, data }

    async function fetchRemote() {
      const res = await fetch(`${JSONBIN_BASE}/${config.binId}/latest`, {
        method: "GET",
        headers: { "X-Master-Key": config.apiKey },
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`Schedule fetch failed: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const record = data.record || {};
      return {
        users: Array.isArray(record.users) ? record.users : [],
        roles: Array.isArray(record.roles) ? record.roles : [],
        schedule: (record.schedule && typeof record.schedule === "object" && !Array.isArray(record.schedule))
          ? record.schedule
          : {},
      };
    }

    async function getState(force) {
      if (!force && cached && Date.now() - cached.at < cacheTtlMs) {
        return cached.data;
      }
      const data = await fetchRemote();
      cached = { at: Date.now(), data };
      return data;
    }

    // Resolve a target (role or group) into the set of role IDs to match.
    function resolveTargetRoleIds(target, roles) {
      if (target.role) {
        return new Set([String(target.role)]);
      }
      if (target.group) {
        const wanted = String(target.group).trim().toLowerCase();
        const ids = new Set();
        (roles || []).forEach(r => {
          const g = (r.group || "").trim().toLowerCase();
          if (g === wanted) ids.add(r.id);
        });
        return ids;
      }
      throw new Error("whoIsOn requires { role } or { group }");
    }

    // Main entry point: returns everyone assigned to the target role/group at
    // the given time. Response shape: { names, usernames, hour, dayId, weekKey }.
    async function whoIsOn(target) {
      if (!target || (!target.role && !target.group)) {
        throw new Error("whoIsOn: pass { role } or { group }");
      }
      const time = target.time != null ? target.time : new Date();
      const state = await getState(false);
      const slot = timeToSlot(time);
      if (!slot) {
        return { names: [], usernames: [], hour: null, dayId: null, weekKey: null, reason: "weekend" };
      }
      const roleIds = resolveTargetRoleIds(target, state.roles);
      if (roleIds.size === 0) {
        return { names: [], usernames: [], ...slot, reason: "no-matching-role" };
      }
      const week = state.schedule[slot.weekKey] || {};
      const day = week[slot.dayId] || {};
      const assigns = day[slot.hour] || [];
      const hits = assigns.filter(a => roleIds.has(a.role));
      const userByName = new Map();
      (state.users || []).forEach(u => {
        if (u && u.username) userByName.set(u.username.toLowerCase(), u);
      });
      const names = [];
      const usernames = [];
      hits.forEach(a => {
        const u = userByName.get((a.username || "").toLowerCase());
        names.push(u ? (u.displayName || u.username) : a.username);
        usernames.push(a.username);
      });
      return { names, usernames, ...slot };
    }

    // Same as whoIsOn({ ..., time: new Date() }) — convenience.
    function whoIsOnNow(target) {
      return whoIsOn({ ...target, time: new Date() });
    }

    // Force the next query to re-fetch from JSONBin (bypass the 5s cache).
    function refresh() {
      cached = null;
    }

    // Expose the raw state if the caller wants to do more elaborate queries.
    async function getSchedule(opts) {
      return getState(opts && opts.force);
    }

    return { whoIsOn, whoIsOnNow, refresh, getSchedule };
  }

  global.RenewedVisionScheduler = { create };
})(typeof window !== "undefined" ? window : globalThis);
