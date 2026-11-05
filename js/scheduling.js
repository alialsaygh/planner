/* =====================================================================
   Planner — js/scheduling.js
   SECTION: SCHEDULING
   - deterministic scheduling engine (no AI, no randomness):
     places study/work sessions for tasks around existing events,
     honouring the focus window, a daily focus cap, break time between
     sessions, deadlines, priority, and spreading work across days
   - rule-based "Schedule Assistant" parser behind a stable interface:
        Planner.assistant.interpret(text) -> [structured requests]
     so a real AI model can replace interpret() later with no UI change
   - nothing touches the calendar until the user taps Accept
   ===================================================================== */
(function () {
  'use strict';

  var W = (typeof window !== 'undefined') ? window : globalThis;
  var P = W.Planner;
  var D = P.date;

  var MIN_CHUNK = 25;   // shortest useful session (minutes)
  var MAX_CHUNK = 60;   // longest single session before a break

  var Sched = P.sched = {};

  /* ------------------------------------------------------------------
     Busy / free time
     ------------------------------------------------------------------ */

  // Busy blocks for a day: real occurrences + any extra (proposed) blocks
  Sched.busyFor = function (dateStr, extra) {
    var busy = P.data.occurrencesOn(dateStr).map(function (o) {
      return { s: o.startMin, e: o.endMin };
    });
    ((extra && extra[dateStr]) || []).forEach(function (b) { busy.push({ s: b.s, e: b.e }); });
    busy.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    return busy;
  };

  // Free slots inside the user's focus window (clipped to wake/sleep),
  // never in the past for today. Slots shorter than MIN_CHUNK are dropped.
  Sched.freeSlots = function (dateStr, extra) {
    var st = P.store.state.settings;
    var a = Math.max(D.min(st.focusStart), D.min(st.wake));
    var b = Math.min(D.min(st.focusEnd), D.min(st.sleep));
    if (dateStr === D.todayStr()) {
      a = Math.max(a, Math.ceil(D.nowMin() / 15) * 15);
    }
    if (b - a < MIN_CHUNK) return [];
    var out = [], cur = a;
    Sched.busyFor(dateStr, extra).forEach(function (o) {
      if (o.e <= cur || o.s >= b) return;
      if (o.s > cur) out.push({ s: cur, e: Math.min(o.s, b) });
      cur = Math.max(cur, o.e);
    });
    if (cur < b) out.push({ s: cur, e: b });
    return out.filter(function (x) { return x.e - x.s >= MIN_CHUNK; });
  };

  // Free minutes left today between now and sleep, outside events
  // (whole waking day, not just the focus window — used on the Today tab)
  Sched.freeMinutesLeftToday = function () {
    var st = P.store.state.settings;
    var today = D.todayStr();
    var a = Math.max(D.min(st.wake), D.nowMin());
    var b = D.min(st.sleep);
    if (b <= a) return 0;
    var total = 0, cur = a;
    Sched.busyFor(today, null).forEach(function (o) {
      if (o.e <= cur || o.s >= b) return;
      if (o.s > cur) total += Math.min(o.s, b) - cur;
      cur = Math.max(cur, o.e);
    });
    if (cur < b) total += b - cur;
    return total;
  };

  // Minutes already auto-scheduled (today or later) for one task
  Sched.scheduledMinutesFor = function (taskId) {
    var today = D.todayStr();
    return P.store.state.events.reduce(function (sum, e) {
      if (e.kind === 'session' && e.taskId === taskId && e.date >= today) {
        sum += D.min(e.end) - D.min(e.start);
      }
      return sum;
    }, 0);
  };

  /* ------------------------------------------------------------------
     The engine.
     propose({tasks?, strategy?}) -> {sessions, warnings, strategy}
     - 'spread' strategy divides each task evenly across the days left
       before its deadline; 'pack' front-loads it as early as possible.
     - Deterministic: same inputs always give the same plan.
     ------------------------------------------------------------------ */
  Sched.propose = function (opts) {
    opts = opts || {};
    var strategy = opts.strategy === 'pack' ? 'pack' : 'spread';
    var st = P.store.state.settings;
    var brk = Math.max(0, st.breakMin || 0);
    var cap = Math.max(MIN_CHUNK, st.dailyCapMin || 180);
    var today = D.todayStr();
    var horizonEnd = D.addDays(today, 13); // plan at most two weeks out

    var tasks = opts.tasks || P.data.tasksActive().filter(function (t) { return (t.estMin || 0) > 0; });
    var rank = { high: 0, medium: 1, low: 2 };
    var sorted = tasks.slice().sort(function (a, b) {
      var da = a.due || '9999-12-31', db = b.due || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      var ra = (rank[a.priority] !== undefined ? rank[a.priority] : 1);
      var rb = (rank[b.priority] !== undefined ? rank[b.priority] : 1);
      if (ra !== rb) return ra - rb;
      return String(a.id) < String(b.id) ? -1 : 1;
    });

    var extra = {};    // proposed blocks per day (+break padding)
    var capUsed = {};  // focus minutes used per day
    var sessions = [], warnings = [];

    // seed extra with any blocks the caller already knows about
    // (e.g. new recurring events in the same proposal)
    if (opts.extraBusy) {
      Object.keys(opts.extraBusy).forEach(function (day) {
        extra[day] = opts.extraBusy[day].slice();
      });
    }

    sorted.forEach(function (t) {
      var rem = (t.estMin || 0) - (t.id && String(t.id).indexOf('v_') !== 0 ? Sched.scheduledMinutesFor(t.id) : 0);
      if (rem <= 0) return;

      // Which days may this task use?
      var endDay;
      if (t.due && t.due < today) endDay = D.addDays(today, 1); // overdue → next 2 days
      else if (t.due) endDay = t.due;
      else endDay = D.addDays(today, 6);
      if (endDay > horizonEnd) endDay = horizonEnd;

      var days = [];
      for (var d = today; d <= endDay; d = D.addDays(d, 1)) days.push(d);
      if (!days.length) days = [today];

      // Spreading: an even share per day, rounded up to a neat chunk
      var perDay = (strategy === 'spread')
        ? Math.max(MIN_CHUNK, Math.ceil(rem / days.length / MIN_CHUNK) * MIN_CHUNK)
        : rem;

      days.forEach(function (day) {
        if (rem <= 0) return;
        var budget = Math.min(rem, perDay, cap - (capUsed[day] || 0));
        if (budget < MIN_CHUNK) return;
        var slots = Sched.freeSlots(day, extra);
        for (var i = 0; i < slots.length && budget >= MIN_CHUNK && rem > 0; i++) {
          var s = slots[i].s, end = slots[i].e;
          while (end - s >= MIN_CHUNK && budget >= MIN_CHUNK && rem > 0) {
            var chunk = Math.min(MAX_CHUNK, budget, rem, end - s);
            if (chunk < MIN_CHUNK) break;
            sessions.push({
              id: P.uid('ps'),
              taskId: t.id, title: t.title,
              categoryId: t.categoryId || 'cat_personal',
              date: day, start: D.hm(s), end: D.hm(s + chunk)
            });
            (extra[day] = extra[day] || []).push({ s: s, e: s + chunk + brk });
            capUsed[day] = (capUsed[day] || 0) + chunk;
            budget -= chunk; rem -= chunk; s += chunk + brk;
          }
        }
      });

      if (rem > 0) warnings.push({ taskId: t.id, title: t.title, unplaced: rem });
    });

    sessions.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : D.min(a.start) - D.min(b.start);
    });
    return { sessions: sessions, warnings: warnings, strategy: strategy };
  };

  /* ------------------------------------------------------------------
     The Schedule Assistant — rule-based parser.

     THE INTERFACE (keep this stable):
       Planner.assistant.interpret(text) -> array of request objects:
         {type:'task',      title, due|null, estMin, priority}
         {type:'course',    courseId, title, estMin, due}
         {type:'recurring', title, timesPerWeek, start, end, categoryId}
         {type:'move',      query, date}
         {type:'unknown',   text}
     A future AI model only needs to return the same shapes.
     ------------------------------------------------------------------ */
  var Assist = P.assistant = {};

  var WORD_NUM = { one: 1, once: 1, two: 2, twice: 2, three: 3, thrice: 3, four: 4, five: 5, six: 6 };

  function parseWhen(s) {
    s = String(s || '').trim().toLowerCase().replace(/[.?!]+$/, '');
    var today = D.todayStr();
    if (!s) return null;
    if (s === 'today' || s === 'tonight') return today;
    if (s === 'tomorrow') return D.addDays(today, 1);
    var isNext = /^next\s+/.test(s);
    var core = s.replace(/^(this|next)\s+/, '');
    var names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (var i = 0; i < 7; i++) {
      if (core === names[i] || core === names[i].slice(0, 3)) {
        var delta = (i - D.weekdayIndex(today) + 7) % 7; // 0 means today
        if (isNext && delta === 0) delta = 7;
        return D.addDays(today, delta);
      }
    }
    // "20/11", "20-11", "2026-11-20"
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      var now = D.now();
      var cand = new Date(now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (D.toStr(cand) < today) cand.setFullYear(cand.getFullYear() + 1);
      return D.toStr(cand);
    }
    // "20 nov" / "nov 20"
    var months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    m = s.match(/^(\d{1,2})\s+([a-z]{3,})$/) || s.match(/^([a-z]{3,})\s+(\d{1,2})$/);
    if (m) {
      var dayN = parseInt(/^\d/.test(m[1]) ? m[1] : m[2], 10);
      var monName = (/^\d/.test(m[1]) ? m[2] : m[1]).slice(0, 3);
      var mi = months.indexOf(monName);
      if (mi >= 0 && dayN >= 1 && dayN <= 31) {
        var now2 = D.now();
        var cand2 = new Date(now2.getFullYear(), mi, dayN);
        if (D.toStr(cand2) < today) cand2.setFullYear(cand2.getFullYear() + 1);
        return D.toStr(cand2);
      }
    }
    return null;
  }
  Assist.parseWhen = parseWhen; // exposed for tests

  function parseEstMin(clause) {
    var m = clause.match(/(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\b/) || clause.match(/(\d+(?:\.\d+)?)\s*h\b/);
    if (m) return Math.round(parseFloat(m[1]) * 60);
    m = clause.match(/(\d+)\s*m(?:in(?:ute)?s?)?\b/);
    if (m) return parseInt(m[1], 10);
    return null;
  }
  function parsePriority(clause) {
    if (/\b(urgent|important|high priority|asap)\b/.test(clause)) return 'high';
    if (/\blow priority\b/.test(clause)) return 'low';
    return 'medium';
  }
  function cleanTitle(s) {
    return s.replace(/^(please\s+|can you\s+|i need to\s+|i want to\s+|add\s+|do\s+|finish\s+|work on\s+|complete\s+|the\s+|my\s+)+/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function guessCategory(title) {
    var t = title.toLowerCase();
    var cats = P.store.state.categories;
    function has(id) { return cats.some(function (c) { return c.id === id; }); }
    if (/\b(gym|run|swim|workout|training|football|exercise)\b/.test(t) && has('cat_fitness')) return 'cat_fitness';
    if (/\b(course|module|aws|ibm|udemy|coursera|certificat)/.test(t) && has('cat_course')) return 'cat_course';
    if (/\b(assignment|report|essay|dissertation|coursework|revision|exam|lecture|lab|uni)\b/.test(t) && has('cat_uni')) return 'cat_uni';
    if (/\b(deadline|submit|submission|due)\b/.test(t) && has('cat_deadline')) return 'cat_deadline';
    if (/\b(pray|prayer|quran|mosque|dua|ziyarat)\b/.test(t) && has('cat_islamic')) return 'cat_islamic';
    if (/\b(shift|meeting|client|office|work)\b/.test(t) && has('cat_work')) return 'cat_work';
    return has('cat_personal') ? 'cat_personal' : (cats[0] ? cats[0].id : 'none');
  }
  Assist.guessCategory = guessCategory;

  Assist.interpret = function (text) {
    var reqs = [];
    var t = String(text || '').trim();
    if (!t) return reqs;

    var clauses = t.split(/(?:,|;|\n|\.\s+|\band then\b|\balso\b)+/i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);

    clauses.forEach(function (raw) {
      var c = raw.toLowerCase().replace(/\s+/g, ' ').trim();
      var m;

      // "move the gym to thursday"
      if ((m = c.match(/^move\s+(?:the\s+|my\s+)?(.+?)\s+to\s+(.+)$/))) {
        var when = parseWhen(m[2]);
        if (when) { reqs.push({ type: 'move', query: m[1].trim(), date: when }); return; }
      }

      // "gym three times (a week)" / "run 2x"
      if ((m = c.match(/\b(gym|workout|run|swim|training|football|exercise)\b(?:\s+(?:sessions?\s+)?)?(once|twice|thrice|one|two|three|four|five|six|\d+)\s*(?:times?|x)?(?:\s*(?:a|per)\s*week)?/))) {
        var n = WORD_NUM[m[2]] || parseInt(m[2], 10) || 3;
        reqs.push({
          type: 'recurring',
          title: capFirst(m[1]),
          timesPerWeek: P.clamp(n, 1, 6),
          start: '07:00', end: '08:00',
          categoryId: guessCategory(m[1])
        });
        return;
      }

      // "finish my AWS course" — match against the user's real courses
      if (/course/.test(c) || /\bfinish\b/.test(c)) {
        var course = P.store.state.courses.find(function (co) {
          var name = (co.name + ' ' + (co.provider || '')).toLowerCase();
          var words = c.replace(/\b(finish|my|the|course|complete)\b/g, ' ').trim().split(/\s+/).filter(Boolean);
          return words.length && words.every(function (w) { return name.indexOf(w) !== -1; }) ||
            name.split(/\s+/).some(function (w) { return w.length > 2 && c.indexOf(w) !== -1; });
        });
        if (course && /\b(finish|complete|work (on|through)|continue)\b/.test(c)) {
          var remaining = course.modules.filter(function (mm) { return !mm.done; });
          var mins = remaining.reduce(function (s, mm) { return s + (mm.durationMin || 60); }, 0) || 60;
          var lastDue = remaining.map(function (mm) { return mm.due; }).filter(Boolean).sort().pop();
          reqs.push({
            type: 'course', courseId: course.id,
            title: 'Course: ' + course.name,
            estMin: mins,
            due: lastDue || D.addDays(D.todayStr(), 10),
            moduleCount: remaining.length
          });
          return;
        }
      }

      // "assignment due friday (3 hours, urgent)" / "report by 20 nov"
      if ((m = c.match(/^(.*?)\s+(?:is\s+)?(?:due|by|before|deadline)\s+(?:on\s+)?(.+)$/))) {
        var when2 = parseWhen(m[2]) || parseWhen(m[2].split(/\s+/)[0]);
        if (when2) {
          var title = capFirst(cleanTitle(m[1])) || 'Task';
          reqs.push({
            type: 'task', title: title, due: when2,
            estMin: parseEstMin(c) || 120,
            priority: parsePriority(c)
          });
          return;
        }
      }

      // "revise networks for 2 hours"
      if ((m = c.match(/^(.*?)\s+for\s+(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\b.*$/)) ||
          (m = c.match(/^(.*?)\s+for\s+(\d+)\s*min(?:ute)?s?\b.*$/))) {
        var est = parseEstMin(c) || 60;
        reqs.push({
          type: 'task', title: capFirst(cleanTitle(m[1])) || 'Task',
          due: null, estMin: est, priority: parsePriority(c)
        });
        return;
      }

      reqs.push({ type: 'unknown', text: raw });
    });

    return reqs;
  };

  /* ------------------------------------------------------------------
     Build a full proposal from requests. Pure preview: NOTHING is saved
     until applyProposal() runs after the user taps Accept.
     ------------------------------------------------------------------ */
  Assist.buildProposal = function (requests, strategy) {
    var today = D.todayStr();
    var vtasks = [], newEvents = [], moves = [], notes = [];
    var vi = 0;

    requests.forEach(function (r) {
      if (r.type === 'task') {
        vtasks.push({
          id: 'v_' + (vi++), title: r.title, due: r.due,
          estMin: r.estMin, priority: r.priority || 'medium',
          categoryId: guessCategory(r.title)
        });
      } else if (r.type === 'course') {
        vtasks.push({
          id: 'v_' + (vi++), title: r.title, due: r.due,
          estMin: r.estMin, priority: 'medium', categoryId: 'cat_course',
          courseId: r.courseId
        });
        notes.push(r.moduleCount + ' module' + (r.moduleCount === 1 ? '' : 's') + ' left in that course (' + D.fmtDuration(r.estMin) + ').');
      } else if (r.type === 'recurring') {
        var patterns = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 5], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5] };
        var daysIdx = patterns[r.timesPerWeek] || [0, 2, 4];
        daysIdx.forEach(function (wi) {
          // first occurrence: that weekday, today or later
          var delta = (wi - D.weekdayIndex(today) + 7) % 7;
          var date = D.addDays(today, delta);
          newEvents.push({
            title: r.title, date: date, start: r.start, end: r.end,
            categoryId: r.categoryId || 'cat_fitness',
            repeat: 'weekly', priority: 'low', kind: 'event'
          });
        });
      } else if (r.type === 'move') {
        // find a real event whose title matches the query
        var q = r.query.toLowerCase();
        var ev = P.store.state.events.find(function (e) {
          return e.kind !== 'session' && (e.title.toLowerCase().indexOf(q) !== -1 || q.indexOf(e.title.toLowerCase()) !== -1);
        });
        if (ev) {
          // the occurrence being moved: next occurrence from today
          var from = null;
          for (var i = 0; i < 14; i++) {
            var dd = D.addDays(today, i);
            if (P.data.occursOn(ev, dd)) { from = dd; break; }
          }
          moves.push({ eventId: ev.id, title: ev.title, from: from, to: r.date, start: ev.start, end: ev.end });
        } else {
          notes.push('I could not find an event called “' + r.query + '” to move.');
        }
      } else if (r.type === 'unknown') {
        notes.push('I didn’t understand: “' + r.text + '”. Try e.g. “report due Friday 3 hours”, “gym three times”, “finish my AWS course” or “move the gym to Thursday”.');
      }
    });

    // New recurring events occupy time — the engine must plan around them
    var extraBusy = {};
    newEvents.forEach(function (ev) {
      for (var i = 0; i < 14; i++) {
        var dd = D.addDays(today, i);
        var same = D.weekdayIndex(ev.date) === D.weekdayIndex(dd) && dd >= ev.date;
        if (same) (extraBusy[dd] = extraBusy[dd] || []).push({ s: D.min(ev.start), e: D.min(ev.end) });
      }
    });

    var plan = vtasks.length
      ? P.sched.propose({ tasks: vtasks, strategy: strategy, extraBusy: extraBusy })
      : { sessions: [], warnings: [], strategy: strategy || 'spread' };

    return {
      requests: requests, vtasks: vtasks, newEvents: newEvents, moves: moves,
      sessions: plan.sessions, warnings: plan.warnings, notes: notes,
      strategy: plan.strategy,
      isEmpty: !vtasks.length && !newEvents.length && !moves.length
    };
  };

  // Retarget parts of a pending proposal ("move the gym to Thursday"
  // while the proposal is still on screen). Returns true if it changed.
  Assist.adjustProposal = function (proposal, moveReq) {
    var q = moveReq.query.toLowerCase();
    var hit = false;
    proposal.newEvents.forEach(function (ev) {
      if (ev.title.toLowerCase().indexOf(q) !== -1) {
        // keep just ONE occurrence, on the requested day
        hit = true;
      }
    });
    if (hit) {
      var kept = null;
      proposal.newEvents = proposal.newEvents.filter(function (ev) {
        if (ev.title.toLowerCase().indexOf(q) === -1) return true;
        if (!kept) { kept = ev; kept.date = moveReq.date; return true; }
        return false;
      });
    }
    proposal.sessions.forEach(function (s) {
      if (s.title.toLowerCase().indexOf(q) !== -1) { s.date = moveReq.date; hit = true; }
    });
    return hit;
  };

  // Accept: write everything in one commit. Only now does data change.
  Assist.applyProposal = function (p) {
    var idMap = {};
    P.store.commit(function (s) {
      p.vtasks.forEach(function (vt) {
        var t = {
          id: P.uid('t'), title: vt.title, due: vt.due || null,
          priority: vt.priority, categoryId: vt.categoryId,
          estMin: vt.estMin, done: false
        };
        idMap[vt.id] = t.id;
        s.tasks.push(t);
      });
      p.newEvents.forEach(function (ev) {
        s.events.push(Object.assign({}, ev, { id: P.uid('ev') }));
      });
      p.moves.forEach(function (mv) {
        var ev = s.events.find(function (e) { return e.id === mv.eventId; });
        if (!ev) return;
        if (ev.repeat && ev.repeat !== 'none' && mv.from) {
          // move just this week's occurrence: skip the old day, add a copy
          s.skips[mv.eventId + '@' + mv.from] = true;
          s.events.push({
            id: P.uid('ev'), title: ev.title, date: mv.to,
            start: ev.start, end: ev.end, location: ev.location,
            categoryId: ev.categoryId, notes: ev.notes,
            reminderMin: ev.reminderMin, repeat: 'none',
            priority: ev.priority, kind: 'event'
          });
        } else {
          ev.date = mv.to;
        }
      });
      p.sessions.forEach(function (sess) {
        s.events.push({
          id: P.uid('ev'), title: sess.title,
          date: sess.date, start: sess.start, end: sess.end,
          categoryId: sess.categoryId, kind: 'session',
          taskId: idMap[sess.taskId] || sess.taskId,
          repeat: 'none', priority: 'medium', auto: true
        });
      });
    });
  };

})();
