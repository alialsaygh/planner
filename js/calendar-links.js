/* =====================================================================
   Planner — js/calendar-links.js
   SECTION: NOTIFICATIONS & CALENDAR LINKS
   A static page cannot send background push notifications without a
   server (and the UI says so honestly). What this file provides instead:
   - an in-app reminder loop + banner while the page is open
   - "Email me a reminder": a prefilled Google Calendar link (with the
     repeat rule) so Google emails/notifies via the user's own calendar
   - "Add to calendar": a downloadable .ics with an alarm, so the phone's
     own calendar app fires the alert
   - backups: download / restore / Web Share / 14-day reminder
   - account-free sync: "export code / import code" (gzip + base64)
   ===================================================================== */
(function () {
  'use strict';

  var W = (typeof window !== 'undefined') ? window : globalThis;
  var P = W.Planner;
  var D = P.date;

  var Cal = P.cal = {};
  var Backup = P.backup = {};
  var Remind = P.remind = {};

  /* ------------------------------------------------------------------
     Recurrence rules (shared by Google Calendar links and .ics files)
     ------------------------------------------------------------------ */
  var BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

  Cal.rruleFor = function (ev) {
    var rep = ev.repeat || 'none';
    if (rep === 'none') return '';
    var rule = '';
    if (rep === 'daily') rule = 'FREQ=DAILY';
    if (rep === 'weekly') rule = 'FREQ=WEEKLY;BYDAY=' + BYDAY[D.weekdayIndex(ev.date)];
    if (rep === 'monthly') rule = 'FREQ=MONTHLY;BYMONTHDAY=' + D.fromStr(ev.date).getDate();
    if (ev.repeatUntil) rule += ';UNTIL=' + ev.repeatUntil.replace(/-/g, '') + 'T235959Z';
    return rule;
  };

  function stamp(dateStr, timeStr) {
    return dateStr.replace(/-/g, '') + 'T' + String(timeStr).replace(':', '') + '00';
  }
  function tzid() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  }

  /* ------------------------------------------------------------------
     Google Calendar "render" link — opens prefilled; saving it there
     makes Google send the email/notification reminders.
     ------------------------------------------------------------------ */
  Cal.gcalUrl = function (ev, dateStr) {
    dateStr = dateStr || ev.date;
    var params = [
      'action=TEMPLATE',
      'text=' + encodeURIComponent(ev.title),
      'dates=' + stamp(dateStr, ev.start) + '/' + stamp(dateStr, ev.end),
      'ctz=' + encodeURIComponent(tzid())
    ];
    var details = (ev.notes ? ev.notes + '\n' : '') + 'From Planner';
    params.push('details=' + encodeURIComponent(details));
    if (ev.location) params.push('location=' + encodeURIComponent(ev.location));
    var rrule = Cal.rruleFor(ev);
    if (rrule) params.push('recur=' + encodeURIComponent('RRULE:' + rrule));
    return 'https://calendar.google.com/calendar/render?' + params.join('&');
  };

  /* ------------------------------------------------------------------
     .ics download with a VALARM — the phone's calendar app then owns
     the alert, fully offline and server-free.
     ------------------------------------------------------------------ */
  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  Cal.icsFor = function (ev, dateStr) {
    dateStr = dateStr || ev.date;
    var tz = tzid();
    var alarmMin = (ev.reminderMin != null && ev.reminderMin !== '') ? ev.reminderMin : 30;
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Planner//Static PWA//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + ev.id + '-' + dateStr + '@planner.local',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      'DTSTART;TZID=' + tz + ':' + stamp(dateStr, ev.start),
      'DTEND;TZID=' + tz + ':' + stamp(dateStr, ev.end),
      'SUMMARY:' + icsEscape(ev.title)
    ];
    var rrule = Cal.rruleFor(ev);
    if (rrule) lines.push('RRULE:' + rrule);
    if (ev.location) lines.push('LOCATION:' + icsEscape(ev.location));
    if (ev.notes) lines.push('DESCRIPTION:' + icsEscape(ev.notes));
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEscape(ev.title),
      'TRIGGER:-PT' + Math.max(0, parseInt(alarmMin, 10) || 30) + 'M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    );
    return lines.join('\r\n');
  };

  function downloadBlob(filename, mime, content) {
    try {
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) { return false; }
  }

  Cal.downloadICS = function (ev, dateStr) {
    var safe = ev.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'event';
    return downloadBlob(safe + '.ics', 'text/calendar;charset=utf-8', Cal.icsFor(ev, dateStr));
  };

  /* ------------------------------------------------------------------
     Backups
     ------------------------------------------------------------------ */
  function backupFilename() {
    return 'planner-backup-' + D.todayStr() + '.json';
  }

  Backup.markBackedUp = function () {
    P.store.commit(function (s) { s.settings.lastBackupAt = new Date().toISOString(); });
  };

  Backup.isDue = function () {
    var last = P.store.state.settings.lastBackupAt;
    if (!last) {
      // only nag after the app has existed for a day
      var seeded = P.store.state.settings.seededAt;
      return !seeded || (Date.now() - new Date(seeded).getTime()) > 86400000;
    }
    return (Date.now() - new Date(last).getTime()) > 14 * 86400000;
  };

  Backup.download = function () {
    var ok = downloadBlob(backupFilename(), 'application/json', P.store.serialize());
    if (ok) Backup.markBackedUp();
    return ok;
  };

  // One-tap Web Share where available; falls back to a plain download
  Backup.share = function () {
    var json = P.store.serialize();
    try {
      var file = new File([json], backupFilename(), { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: 'Planner backup' })
          .then(function () { Backup.markBackedUp(); return 'shared'; })
          .catch(function (e) { return (e && e.name === 'AbortError') ? 'cancelled' : 'failed'; });
      }
    } catch (e) { /* File/share unsupported */ }
    return Promise.resolve(Backup.download() ? 'downloaded' : 'failed');
  };

  Backup.restoreFromFile = function (file) {
    return new Promise(function (resolve) {
      var r = new FileReader();
      r.onload = function () {
        P.store.importJSON(String(r.result)).then(resolve);
      };
      r.onerror = function () { resolve({ ok: false, error: 'Could not read that file.' }); };
      r.readAsText(file);
    });
  };

  /* ------------------------------------------------------------------
     Account-free sync: export code / import code.
     gzip + base64 where CompressionStream exists ("PLNR1:"),
     plain base64 otherwise ("PLNR0:").
     ------------------------------------------------------------------ */
  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  Backup.exportCode = function () {
    var json = P.store.serialize();
    var plain = new TextEncoder().encode(json);
    if (typeof CompressionStream !== 'undefined') {
      var cs = new CompressionStream('gzip');
      return new Response(new Blob([plain]).stream().pipeThrough(cs)).arrayBuffer()
        .then(function (buf) {
          Backup.markBackedUp();
          return 'PLNR1:' + bytesToB64(new Uint8Array(buf));
        })
        .catch(function () { Backup.markBackedUp(); return 'PLNR0:' + bytesToB64(plain); });
    }
    Backup.markBackedUp();
    return Promise.resolve('PLNR0:' + bytesToB64(plain));
  };

  Backup.importCode = function (code) {
    code = String(code || '').replace(/\s+/g, '');
    var decodeP;
    if (code.indexOf('PLNR1:') === 0) {
      if (typeof DecompressionStream === 'undefined') {
        return Promise.resolve({ ok: false, error: 'This browser cannot read compressed codes.' });
      }
      try {
        var bytes = b64ToBytes(code.slice(6));
        var ds = new DecompressionStream('gzip');
        decodeP = new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
      } catch (e) {
        return Promise.resolve({ ok: false, error: 'That code is not valid.' });
      }
    } else if (code.indexOf('PLNR0:') === 0) {
      try { decodeP = Promise.resolve(new TextDecoder().decode(b64ToBytes(code.slice(6)))); }
      catch (e) { return Promise.resolve({ ok: false, error: 'That code is not valid.' }); }
    } else {
      return Promise.resolve({ ok: false, error: 'Codes start with PLNR0: or PLNR1: \u2014 paste the whole thing.' });
    }
    return decodeP.then(function (json) { return P.store.importJSON(json); })
      .catch(function () { return { ok: false, error: 'That code could not be decoded.' }; });
  };

  /* ------------------------------------------------------------------
     In-app reminder loop (works only while the page is open — the UI
     explains this limitation next to the calendar buttons).
     ------------------------------------------------------------------ */
  var notified = {}; // occurrence keys already announced this session

  Remind.check = function () {
    var due = [];
    var today = D.todayStr();
    var nowM = D.nowMin();
    P.data.occurrencesOn(today).forEach(function (o) {
      var r = o.ev.reminderMin;
      if (r == null || r === '' || o.done) return;
      var lead = o.startMin - nowM;
      if (lead >= 0 && lead <= parseInt(r, 10) && !notified[o.key]) {
        notified[o.key] = true;
        due.push(o);
      }
    });
    return due;
  };

  Remind.start = function (onDue) {
    function tick() {
      var due = Remind.check();
      if (due.length && onDue) onDue(due);
    }
    tick();
    setInterval(tick, 30000);
  };

})();
