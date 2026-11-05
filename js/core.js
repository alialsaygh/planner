/* =====================================================================
   Planner — js/core.js
   SECTION: SHARED HELPERS (used by every other section)
   - Planner namespace
   - tiny utilities (ids, escaping, events, haptics)
   - date helpers (all in the device's local time)
   - Hijri date via Intl (islamic-umalqura calendar, no API)
   - calculated Islamic key dates (Ramadan, both Eids, Ashura)

   Test hook: open the app with ?mockdate=YYYY-MM-DD to pretend "today"
   is another day (used by the automated week-rollover test; harmless
   in normal use).
   ===================================================================== */
(function () {
  'use strict';

  var W = (typeof window !== 'undefined') ? window : globalThis;
  var P = W.Planner = W.Planner || {};

  /* ------------------------------------------------------------------
     Tiny utilities
     ------------------------------------------------------------------ */

  // Unique id with a readable prefix, e.g. "ev_1b2c…"
  P.uid = function (prefix) {
    var tail;
    try { tail = crypto.randomUUID().slice(0, 13); }
    catch (e) { tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    return (prefix || 'id') + '_' + tail;
  };

  // HTML-escape anything that goes into innerHTML
  P.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  P.clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };

  // Haptic tap where the device supports it (Android Chrome mainly)
  P.vibrate = function (ms) {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms || 10);
    } catch (e) { /* no haptics — fine */ }
  };

  // Minimal pub/sub so the UI can re-render when data changes
  var subs = {};
  P.on = function (type, fn) { (subs[type] = subs[type] || []).push(fn); };
  P.emit = function (type, payload) {
    (subs[type] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* a listener failing must not break saves */ }
    });
  };

  /* ------------------------------------------------------------------
     Date helpers.
     Dates travel through the app as "YYYY-MM-DD" strings (sortable,
     timezone-safe) and times as "HH:MM" strings / minutes since 00:00.
     ------------------------------------------------------------------ */

  var D = P.date = {};

  var mockToday = null;
  try {
    var m = new URLSearchParams(W.location.search).get('mockdate');
    if (m && /^\d{4}-\d{2}-\d{2}$/.test(m)) mockToday = m;
  } catch (e) { /* no window.location (tests) */ }

  D.now = function () {
    if (!mockToday) return new Date();
    var real = new Date();
    var d = D.fromStr(mockToday);
    d.setHours(real.getHours(), real.getMinutes(), real.getSeconds(), 0);
    return d;
  };

  D.toStr = function (d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  };
  D.fromStr = function (s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  };
  D.todayStr = function () { return D.toStr(D.now()); };

  D.addDays = function (s, n) {
    var d = D.fromStr(s); d.setDate(d.getDate() + n); return D.toStr(d);
  };
  D.diffDays = function (a, b) { // whole days from a to b
    return Math.round((D.fromStr(b) - D.fromStr(a)) / 86400000);
  };
  // Monday-first helpers
  D.weekdayIndex = function (s) { // 0 = Monday … 6 = Sunday
    return (D.fromStr(s).getDay() + 6) % 7;
  };
  D.mondayOf = function (s) {
    return D.addDays(s, -D.weekdayIndex(s));
  };
  D.WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  D.WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // "HH:MM" <-> minutes since midnight
  D.min = function (t) {
    var p = String(t || '0:0').split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
  };
  D.hm = function (mins) {
    mins = Math.max(0, Math.round(mins));
    return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  };
  D.nowMin = function () {
    var n = D.now(); return n.getHours() * 60 + n.getMinutes();
  };

  // Locale-aware display formatting
  D.fmtTime = function (t) {
    try {
      var p = String(t).split(':').map(Number);
      var d = new Date(); d.setHours(p[0], p[1], 0, 0);
      return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
    } catch (e) { return String(t); }
  };
  D.fmtDateLong = function (s) {
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(D.fromStr(s));
    } catch (e) { return s; }
  };
  D.fmtDateShort = function (s) {
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(D.fromStr(s));
    } catch (e) { return s; }
  };
  D.fmtMonthYear = function (s) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(D.fromStr(s));
    } catch (e) { return s; }
  };
  D.fmtDuration = function (mins) {
    mins = Math.max(0, Math.round(mins));
    var h = Math.floor(mins / 60), mm = mins % 60;
    if (h && mm) return h + 'h ' + mm + 'm';
    if (h) return h + 'h';
    return mm + 'm';
  };
  // Friendly relative day label
  D.relDay = function (s) {
    var diff = D.diffDays(D.todayStr(), s);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return D.WEEKDAYS[D.weekdayIndex(s)];
    return D.fmtDateShort(s);
  };

  /* ------------------------------------------------------------------
     Hijri calendar — entirely via Intl, no network.
     The Umm al-Qura calendar is tabular: real moon sighting can differ
     by a day, and the UI says so wherever these dates appear.
     ------------------------------------------------------------------ */

  var H = P.hijri = {};

  H.supported = (function () {
    try {
      new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric' }).format(new Date());
      return true;
    } catch (e) { return false; }
  })();

  // Pretty Hijri date for a "YYYY-MM-DD" Gregorian date string
  H.fmt = function (dateStr) {
    if (!H.supported) return '';
    try {
      return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        day: 'numeric', month: 'long', year: 'numeric'
      }).format(D.fromStr(dateStr));
    } catch (e) { return ''; }
  };

  // Numeric Hijri parts {y, m, d} — m: 1 = Muharram … 9 = Ramadan … 12 = Dhu al-Hijjah
  var partsFmt = null;
  H.parts = function (dateObj) {
    if (!H.supported) return null;
    try {
      partsFmt = partsFmt || new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        day: 'numeric', month: 'numeric', year: 'numeric'
      });
      var out = {};
      partsFmt.formatToParts(dateObj).forEach(function (p) {
        if (p.type === 'day') out.d = parseInt(p.value, 10);
        if (p.type === 'month') out.m = parseInt(p.value, 10);
        if (p.type === 'year') out.y = parseInt(p.value, 10);
      });
      return (out.y && out.m && out.d) ? out : null;
    } catch (e) { return null; }
  };

  // Scan the next ~400 days for the key Islamic dates. Cached per "today".
  var keyCache = { day: null, list: [] };
  H.keyEvents = function () {
    var today = D.todayStr();
    if (keyCache.day === today) return keyCache.list;
    var list = [];
    if (H.supported) {
      var found = {};
      var d = D.fromStr(today);
      for (var i = 0; i < 400 && Object.keys(found).length < 4; i++) {
        var p = H.parts(d);
        if (p) {
          if (p.m === 9 && p.d === 1 && !found.ramadan) { found.ramadan = true; list.push({ id: 'isl_ramadan', name: 'Ramadan begins', date: D.toStr(d) }); }
          if (p.m === 10 && p.d === 1 && !found.fitr) { found.fitr = true; list.push({ id: 'isl_fitr', name: 'Eid al-Fitr', date: D.toStr(d) }); }
          if (p.m === 12 && p.d === 10 && !found.adha) { found.adha = true; list.push({ id: 'isl_adha', name: 'Eid al-Adha', date: D.toStr(d) }); }
          if (p.m === 1 && p.d === 10 && !found.ashura) { found.ashura = true; list.push({ id: 'isl_ashura', name: 'Ashura', date: D.toStr(d) }); }
        }
        d.setDate(d.getDate() + 1);
      }
      list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    }
    keyCache = { day: today, list: list };
    return list;
  };

  // Key Islamic events falling on one specific date
  H.eventsOn = function (dateStr) {
    return H.keyEvents().filter(function (e) { return e.date === dateStr; });
  };

})();
