/* =====================================================================
   Planner — js/data.js
   SECTION: DATA
   - storage layer: IndexedDB first, localStorage fallback, written on
     EVERY change, navigator.storage.persist() requested at boot
   - rolling automatic backups (last 5) kept inside the app
   - example-week seeding (only when storage is empty), clearly marked
   - all CRUD + recurrence expansion ("expand on the fly")

   State shape (one JSON document):
   {
     version: 1,
     settings:    { name, wake, sleep, focusStart, focusEnd, dailyCapMin,
                    breakMin, studyPref, onboardingDismissed,
                    lastBackupAt, seededAt },
     categories:  [ {id, name, color, icon, builtin} ],
     events:      [ {id, title, date, start, end, location, categoryId,
                     notes, reminderMin, repeat, repeatUntil, priority,
                     kind ('event'|'session'), taskId?, example?} ],
     tasks:       [ {id, title, due, priority, categoryId, estMin,
                     repeat, done, doneAt, example?} ],
     courses:     [ {id, name, provider, example?,
                     modules:[{id,name,durationMin,due,done}]} ],
     completions: { "<eventId>@<date>": isoTime },   // per-occurrence
     skips:       { "<eventId>@<date>": true }       // one-day deletes
   }
   ===================================================================== */
(function () {
  'use strict';

  var W = (typeof window !== 'undefined') ? window : globalThis;
  var P = W.Planner;
  var D = P.date;

  var DB_NAME = 'planner-db';
  var DB_STORE = 'kv';
  var LS_STATE = 'planner-state-v1';
  var LS_BACKUPS = 'planner-backups-v1';
  var MAX_AUTO_BACKUPS = 5;

  /* ------------------------------------------------------------------
     Low-level IndexedDB wrapper (promise-based, failure-tolerant)
     ------------------------------------------------------------------ */
  var db = null, idbOK = false;

  function openDB() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
        req.onsuccess = function () { db = req.result; idbOK = true; resolve(true); };
        req.onerror = function () { resolve(false); };
        req.onblocked = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }
  function idbGet(key) {
    return new Promise(function (resolve) {
      if (!idbOK) return resolve(undefined);
      try {
        var tx = db.transaction(DB_STORE, 'readonly');
        var rq = tx.objectStore(DB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { resolve(undefined); };
      } catch (e) { resolve(undefined); }
    });
  }
  function idbPut(key, value) {
    return new Promise(function (resolve) {
      if (!idbOK) return resolve(false);
      try {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }

  /* ------------------------------------------------------------------
     The store
     ------------------------------------------------------------------ */
  var Store = P.store = {
    state: null,
    persisted: false,       // did navigator.storage.persist() succeed?
    persistSupported: false,
    storageMode: 'memory',  // 'indexeddb' | 'localstorage' | 'memory'
    _writeQueue: Promise.resolve(),

    init: function () {
      var self = this;
      // Ask the browser to protect our storage from eviction
      var persistP = Promise.resolve();
      try {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
          self.persistSupported = true;
          persistP = navigator.storage.persist()
            .then(function (ok) { self.persisted = !!ok; })
            .catch(function () { });
        }
      } catch (e) { }

      return persistP.then(openDB).then(function () {
        self.storageMode = idbOK ? 'indexeddb' : (lsSet('__t', '1') ? 'localstorage' : 'memory');
        return idbGet('state');
      }).then(function (raw) {
        if (!raw) raw = lsGet(LS_STATE);
        if (raw) {
          try { self.state = JSON.parse(raw); } catch (e) { self.state = null; }
        }
        if (!self.state || !self.state.settings) {
          // Nothing saved yet → seed the clearly-marked example week.
          // This runs ONCE; real data is never overwritten afterwards.
          self.state = P.seed.makeInitialState();
          return self.save();
        }
        self.migrate();
      }).then(function () {
        return self.maybeDailyBackup();
      });
    },

    migrate: function () {
      var s = this.state;
      s.version = s.version || 1;
      s.completions = s.completions || {};
      s.skips = s.skips || {};
      s.events = s.events || [];
      s.tasks = s.tasks || [];
      s.courses = s.courses || [];
      s.categories = (s.categories && s.categories.length) ? s.categories : P.seed.defaultCategories();
    },

    serialize: function () { return JSON.stringify(this.state); },

    // Write on every change: IndexedDB + localStorage mirror, queued so
    // writes never race each other. UI re-renders immediately via 'change'.
    save: function () {
      var raw = this.serialize();
      lsSet(LS_STATE, raw);
      this._writeQueue = this._writeQueue.then(function () { return idbPut('state', raw); });
      P.emit('change');
      return this._writeQueue;
    },

    // All mutations go through commit(fn) so saving can never be forgotten
    commit: function (fn) {
      fn(this.state);
      return this.save();
    },

    /* ----- rolling automatic backups (last 5, inside the app) ----- */

    getBackups: function () {
      return idbGet('backups').then(function (raw) {
        if (!raw) raw = lsGet(LS_BACKUPS);
        try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
      });
    },
    pushBackup: function (reason) {
      var self = this;
      return this.getBackups().then(function (list) {
        list.unshift({ at: new Date().toISOString(), reason: reason || 'auto', data: self.serialize() });
        while (list.length > MAX_AUTO_BACKUPS) list.pop();
        var raw = JSON.stringify(list);
        lsSet(LS_BACKUPS, raw);
        return idbPut('backups', raw);
      });
    },
    maybeDailyBackup: function () {
      var self = this;
      return this.getBackups().then(function (list) {
        var todayUTC = new Date().toISOString().slice(0, 10);
        if (!list.length || list[0].at.slice(0, 10) !== todayUTC) {
          return self.pushBackup('daily');
        }
      });
    },
    restoreBackup: function (index) {
      var self = this;
      return this.getBackups().then(function (list) {
        var b = list[index];
        if (!b) return false;
        return self.pushBackup('before-undo').then(function () {
          self.state = JSON.parse(b.data);
          self.migrate();
          return self.save().then(function () { return true; });
        });
      });
    },

    /* ----- import / reset (always snapshot first) ----- */

    // Validates then replaces state with an imported JSON string.
    importJSON: function (jsonStr) {
      var parsed;
      try { parsed = JSON.parse(jsonStr); } catch (e) { return Promise.resolve({ ok: false, error: 'That file is not valid JSON.' }); }
      if (!parsed || typeof parsed !== 'object' || !parsed.settings || !Array.isArray(parsed.events)) {
        return Promise.resolve({ ok: false, error: 'That file does not look like a Planner backup.' });
      }
      var self = this;
      return this.pushBackup('before-import').then(function () {
        self.state = parsed;
        self.migrate();
        return self.save();
      }).then(function () { return { ok: true }; });
    },

    resetToExample: function () {
      var self = this;
      return this.pushBackup('before-reset').then(function () {
        self.state = P.seed.makeInitialState();
        return self.save();
      });
    }
  };

  /* ------------------------------------------------------------------
     Data helpers & CRUD (everything the UI calls)
     ------------------------------------------------------------------ */
  var Data = P.data = {};

  Data.catById = function (id) {
    return Store.state.categories.find(function (c) { return c.id === id; }) ||
      { id: 'none', name: 'Other', color: '#8E8B82', icon: '•' };
  };

  Data.occKey = function (eventId, dateStr) { return eventId + '@' + dateStr; };

  // Does a (possibly recurring) event occur on this date?
  Data.occursOn = function (ev, dateStr) {
    if (Store.state.skips[Data.occKey(ev.id, dateStr)]) return false;
    if (dateStr < ev.date) return false;
    var rep = ev.repeat || 'none';
    if (rep === 'none') return dateStr === ev.date;
    if (ev.repeatUntil && dateStr > ev.repeatUntil) return false;
    if (rep === 'daily') return true;
    if (rep === 'weekly') return D.weekdayIndex(ev.date) === D.weekdayIndex(dateStr);
    if (rep === 'monthly') return D.fromStr(ev.date).getDate() === D.fromStr(dateStr).getDate();
    return false;
  };

  // All occurrences on one date, sorted by start time
  Data.occurrencesOn = function (dateStr) {
    var out = [];
    Store.state.events.forEach(function (ev) {
      if (Data.occursOn(ev, dateStr)) {
        var key = Data.occKey(ev.id, dateStr);
        out.push({
          ev: ev,
          date: dateStr,
          key: key,
          startMin: D.min(ev.start),
          endMin: Math.max(D.min(ev.end), D.min(ev.start) + 5),
          done: !!Store.state.completions[key]
        });
      }
    });
    out.sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin || (a.ev.title < b.ev.title ? -1 : 1); });
    return out;
  };

  Data.eventById = function (id) {
    return Store.state.events.find(function (e) { return e.id === id; });
  };

  Data.addEvent = function (ev) {
    ev.id = ev.id || P.uid('ev');
    ev.kind = ev.kind || 'event';
    Store.commit(function (s) { s.events.push(ev); });
    return ev;
  };
  Data.updateEvent = function (id, patch) {
    Store.commit(function (s) {
      var ev = s.events.find(function (e) { return e.id === id; });
      if (ev) Object.assign(ev, patch);
    });
  };
  Data.deleteEventSeries = function (id) {
    Store.commit(function (s) {
      s.events = s.events.filter(function (e) { return e.id !== id; });
      Object.keys(s.completions).forEach(function (k) { if (k.indexOf(id + '@') === 0) delete s.completions[k]; });
      Object.keys(s.skips).forEach(function (k) { if (k.indexOf(id + '@') === 0) delete s.skips[k]; });
    });
  };
  // Delete just one day of a recurring event
  Data.skipOccurrence = function (id, dateStr) {
    Store.commit(function (s) { s.skips[Data.occKey(id, dateStr)] = true; });
  };
  // Completing one occurrence only affects that day
  Data.toggleOccurrence = function (id, dateStr) {
    var key = Data.occKey(id, dateStr);
    var nowDone = false;
    Store.commit(function (s) {
      if (s.completions[key]) delete s.completions[key];
      else { s.completions[key] = new Date().toISOString(); nowDone = true; }
    });
    return nowDone;
  };

  /* ----- tasks ----- */

  Data.taskById = function (id) {
    return Store.state.tasks.find(function (t) { return t.id === id; });
  };
  Data.addTask = function (t) {
    t.id = t.id || P.uid('t');
    t.done = !!t.done;
    Store.commit(function (s) { s.tasks.push(t); });
    return t;
  };
  Data.updateTask = function (id, patch) {
    Store.commit(function (s) {
      var t = s.tasks.find(function (x) { return x.id === id; });
      if (t) Object.assign(t, patch);
    });
  };
  Data.deleteTask = function (id) {
    Store.commit(function (s) {
      s.tasks = s.tasks.filter(function (t) { return t.id !== id; });
      // tidy up any auto-planned sessions for it
      s.events = s.events.filter(function (e) { return e.taskId !== id; });
    });
  };
  function nextDue(due, repeat) {
    if (!due) return due;
    if (repeat === 'daily') return D.addDays(due, 1);
    if (repeat === 'weekly') return D.addDays(due, 7);
    if (repeat === 'monthly') {
      var d = D.fromStr(due); d.setMonth(d.getMonth() + 1); return D.toStr(d);
    }
    return due;
  }
  // Completing a repeating task only "ticks" this round and rolls the due
  // date forward; a plain task simply flips done.
  Data.toggleTask = function (id) {
    var becameDone = false;
    Store.commit(function (s) {
      var t = s.tasks.find(function (x) { return x.id === id; });
      if (!t) return;
      if (t.repeat && t.repeat !== 'none' && !t.done) {
        t.lastDoneAt = new Date().toISOString();
        t.due = nextDue(t.due || D.todayStr(), t.repeat);
        becameDone = true; // visually celebrate, but the task lives on
      } else {
        t.done = !t.done;
        t.doneAt = t.done ? new Date().toISOString() : null;
        becameDone = t.done;
      }
    });
    return becameDone;
  };
  Data.tasksActive = function () {
    return Store.state.tasks.filter(function (t) { return !t.done; });
  };
  Data.tasksOverdue = function () {
    var today = D.todayStr();
    return Data.tasksActive().filter(function (t) { return t.due && t.due < today; });
  };

  /* ----- courses ----- */

  Data.courseById = function (id) {
    return Store.state.courses.find(function (c) { return c.id === id; });
  };
  Data.addCourse = function (c) {
    c.id = c.id || P.uid('c');
    c.modules = c.modules || [];
    Store.commit(function (s) { s.courses.push(c); });
    return c;
  };
  Data.updateCourse = function (id, patch) {
    Store.commit(function (s) {
      var c = s.courses.find(function (x) { return x.id === id; });
      if (c) Object.assign(c, patch);
    });
  };
  Data.deleteCourse = function (id) {
    Store.commit(function (s) {
      s.courses = s.courses.filter(function (c) { return c.id !== id; });
    });
  };
  Data.toggleModule = function (courseId, moduleId) {
    var becameDone = false;
    Store.commit(function (s) {
      var c = s.courses.find(function (x) { return x.id === courseId; });
      if (!c) return;
      var m = c.modules.find(function (x) { return x.id === moduleId; });
      if (m) { m.done = !m.done; becameDone = m.done; }
    });
    return becameDone;
  };
  Data.courseProgress = function (c) {
    var total = c.modules.length || 1;
    var done = c.modules.filter(function (m) { return m.done; }).length;
    return { done: done, total: c.modules.length, pct: Math.round(100 * done / total) };
  };
  Data.nextModule = function (c) {
    return c.modules.find(function (m) { return !m.done; }) || null;
  };

  /* ----- example data management ----- */

  Data.hasExamples = function () {
    var s = Store.state;
    return s.events.some(function (e) { return e.example; }) ||
      s.tasks.some(function (t) { return t.example; }) ||
      s.courses.some(function (c) { return c.example; });
  };
  // One tap: remove every example item, keep everything the user made
  Data.deleteExamples = function () {
    Store.commit(function (s) {
      var exIds = {};
      s.events.forEach(function (e) { if (e.example) exIds[e.id] = true; });
      s.events = s.events.filter(function (e) { return !e.example; });
      s.tasks = s.tasks.filter(function (t) { return !t.example; });
      s.courses = s.courses.filter(function (c) { return !c.example; });
      Object.keys(s.completions).forEach(function (k) { if (exIds[k.split('@')[0]]) delete s.completions[k]; });
      Object.keys(s.skips).forEach(function (k) { if (exIds[k.split('@')[0]]) delete s.skips[k]; });
    });
  };

  /* ------------------------------------------------------------------
     Seed: the clearly-marked example week. Runs only when storage is
     empty — never again after that.
     ------------------------------------------------------------------ */
  var Seed = P.seed = {};

  Seed.defaultCategories = function () {
    return [
      { id: 'cat_uni', name: 'University', color: '#4C6FDB', icon: '🎓', builtin: true },
      { id: 'cat_work', name: 'Work', color: '#7A5AF8', icon: '💼', builtin: true },
      { id: 'cat_course', name: 'Course', color: '#D97A1F', icon: '📚', builtin: true },
      { id: 'cat_islamic', name: 'Islamic', color: '#0E7A6F', icon: '☪️', builtin: true },
      { id: 'cat_fitness', name: 'Fitness', color: '#D14D4D', icon: '🏃', builtin: true },
      { id: 'cat_personal', name: 'Personal', color: '#C04E8E', icon: '🌱', builtin: true },
      { id: 'cat_deadline', name: 'Deadline', color: '#B3261E', icon: '⏰', builtin: true }
    ];
  };

  Seed.makeInitialState = function () {
    var today = D.todayStr();
    var mon = D.mondayOf(today); // Monday of the current week
    function wd(i) { return D.addDays(mon, i); } // 0=Mon … 6=Sun

    var events = [
      // University timetable (weekly)
      { title: 'Advanced Software Eng. — lecture', date: wd(0), start: '09:00', end: '11:00', location: 'Headingley Campus, CC-2.11', categoryId: 'cat_uni', repeat: 'weekly', reminderMin: 30, priority: 'medium', notes: 'Bring laptop for the WPF demo.' },
      { title: 'Networks & Security — lecture', date: wd(1), start: '11:00', end: '13:00', location: 'City Campus, Rose Bowl 220', categoryId: 'cat_uni', repeat: 'weekly', reminderMin: 30, priority: 'medium' },
      { title: 'ASE — lab session', date: wd(2), start: '14:00', end: '16:00', location: 'Computing Lab B', categoryId: 'cat_uni', repeat: 'weekly', reminderMin: 15, priority: 'medium' },
      { title: 'Dissertation supervision', date: wd(3), start: '15:00', end: '15:30', location: 'Online (Teams)', categoryId: 'cat_uni', repeat: 'weekly', reminderMin: 15, priority: 'high' },
      // Work shifts
      { title: 'Work shift', date: wd(1), start: '17:30', end: '21:00', location: 'Office', categoryId: 'cat_work', repeat: 'weekly', priority: 'medium' },
      { title: 'Work shift', date: wd(5), start: '10:00', end: '16:00', location: 'Office', categoryId: 'cat_work', repeat: 'weekly', priority: 'medium' },
      // Fitness
      { title: 'Gym', date: wd(0), start: '07:00', end: '08:00', location: 'Campus gym', categoryId: 'cat_fitness', repeat: 'weekly', priority: 'low' },
      { title: 'Gym', date: wd(2), start: '07:00', end: '08:00', location: 'Campus gym', categoryId: 'cat_fitness', repeat: 'weekly', priority: 'low' },
      { title: 'Gym', date: wd(4), start: '07:00', end: '08:00', location: 'Campus gym', categoryId: 'cat_fitness', repeat: 'weekly', priority: 'low' },
      // Islamic (manual entry example — calculated dates are added automatically)
      { title: 'Jumu’ah prayer', date: wd(4), start: '12:30', end: '13:30', location: 'Leeds Grand Mosque', categoryId: 'cat_islamic', repeat: 'weekly', reminderMin: 45, priority: 'high' },
      // A one-off
      { title: 'IBM ML study group', date: D.addDays(today, 2), start: '18:30', end: '19:30', location: 'Library group room 4', categoryId: 'cat_course', repeat: 'none', reminderMin: 30, priority: 'medium' }
    ];
    events.forEach(function (e) { e.id = P.uid('ev'); e.kind = 'event'; e.example = true; });

    var tasks = [
      { title: 'ASE project report — first draft', due: D.addDays(today, 2), priority: 'high', categoryId: 'cat_uni', estMin: 180 },
      { title: 'Dissertation — literature review notes', due: D.addDays(today, 9), priority: 'medium', categoryId: 'cat_uni', estMin: 240 },
      { title: 'IBM ML — finish Module 3 quiz', due: D.addDays(today, 4), priority: 'medium', categoryId: 'cat_course', estMin: 90 },
      { title: 'Networks coursework submission', due: D.addDays(today, 8), priority: 'high', categoryId: 'cat_deadline', estMin: 120 },
      { title: 'Renew gym membership', due: D.addDays(today, 3), priority: 'low', categoryId: 'cat_personal', estMin: 15 },
      { title: 'Weekly review & plan', due: D.addDays(D.mondayOf(today), 6), priority: 'low', categoryId: 'cat_personal', estMin: 30, repeat: 'weekly' }
    ];
    tasks.forEach(function (t) { t.id = P.uid('t'); t.done = false; t.example = true; });

    var courses = [
      {
        name: 'Machine Learning with Python', provider: 'IBM · Coursera', example: true,
        modules: [
          { name: 'Intro to Machine Learning', durationMin: 60, due: D.addDays(today, -7), done: true },
          { name: 'Regression', durationMin: 90, due: D.addDays(today, -2), done: true },
          { name: 'Classification', durationMin: 90, due: D.addDays(today, 4), done: false },
          { name: 'Clustering', durationMin: 75, due: D.addDays(today, 9), done: false },
          { name: 'Recommender systems', durationMin: 80, due: D.addDays(today, 14), done: false },
          { name: 'Final project', durationMin: 120, due: D.addDays(today, 21), done: false }
        ]
      },
      {
        name: 'AWS Cloud Practitioner', provider: 'AWS Skill Builder', example: true,
        modules: [
          { name: 'Cloud concepts', durationMin: 60, due: D.addDays(today, 6), done: false },
          { name: 'Security & compliance', durationMin: 75, due: D.addDays(today, 12), done: false },
          { name: 'Core services', durationMin: 90, due: D.addDays(today, 18), done: false },
          { name: 'Practice exam', durationMin: 60, due: D.addDays(today, 24), done: false }
        ]
      }
    ];
    courses.forEach(function (c) {
      c.id = P.uid('c');
      c.modules.forEach(function (m) { m.id = P.uid('m'); });
    });

    return {
      version: 1,
      settings: {
        name: 'Ali',
        wake: '06:30', sleep: '23:30',
        focusStart: '17:00', focusEnd: '21:30',
        dailyCapMin: 180, breakMin: 15,
        studyPref: 'evening',
        onboardingDismissed: false,
        lastBackupAt: null,
        seededAt: new Date().toISOString()
      },
      categories: Seed.defaultCategories(),
      events: events,
      tasks: tasks,
      courses: courses,
      completions: {},
      skips: {}
    };
  };

})();
