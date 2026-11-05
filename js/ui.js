/* =====================================================================
   Planner — js/ui.js
   SECTION: UI
   Everything the user sees and taps. Plain DOM, no framework:
   - tab bar + the five views (Today / Calendar / Tasks / Courses / More)
   - floating + (add sheet) and ✦ (Schedule Assistant)
   - bottom sheets, in-page confirm dialogs (never alert/confirm/prompt),
     toasts, reminder banners
   - calendar Day / Week / Month (Monday-first, overlapping events laid
     out side by side)
   - the chat-style Schedule Assistant (Accept / Edit / Regenerate)
   Rendering model: state changes -> Planner.emit('change') -> re-render
   the current tab. Sheets/dialogs live in separate roots so they are
   not disturbed by re-renders.
   ===================================================================== */
(function () {
  'use strict';

  var P = window.Planner;
  var D = P.date;
  var H = P.hijri;

  /* ------------------------------------------------------------------
     UI state (not persisted)
     ------------------------------------------------------------------ */
  var S = {
    tab: 'today',
    calMode: 'week',
    calDate: null,          // set at boot
    addKind: 'event',
    assist: { chat: [], proposal: null, editMode: false, strategy: 'spread' }
  };

  /* ------------------------------------------------------------------
     Inline SVG icons (stroke follows currentColor)
     ------------------------------------------------------------------ */
  function svg(inner, vb) {
    return '<svg viewBox="' + (vb || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var I = {
    today: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 9.8h17M8 2.8v4M16 2.8v4"/>'),
    tasks: svg('<path d="M4 6.5h9M4 12h9M4 17.5h6"/><path d="M15.5 16.5l2.2 2.2 4-4.6"/>'),
    courses: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>'),
    more: svg('<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    spark: svg('<path d="M12 3l1.9 5.6L19.5 11l-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-2.4z"/><path d="M19 17l0.8 2.2L22 20l-2.2 0.8L19 23l-0.8-2.2L16 20l2.2-0.8z"/>'),
    left: svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
    right: svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    check: svg('<path d="M4.5 12.5l5 5L19.5 7"/>'),
    trash: svg('<path d="M4.5 6.5h15M9.5 3.5h5M7 6.5l1 14h8l1-14M10.3 10v7M13.7 10v7"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3.5 7.5l8.5 6 8.5-6"/>'),
    dl: svg('<path d="M12 3.5v11M7.5 10l4.5 4.5L16.5 10"/><path d="M4.5 19.5h15"/>'),
    share: svg('<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="5.5" r="2.4"/><circle cx="17.5" cy="18.5" r="2.4"/><path d="M8.2 10.9l7.1-4.1M8.2 13.1l7.1 4.1"/>'),
    send: svg('<path d="M4 12L20 4l-4.5 16-4-6.5z"/><path d="M11.5 13.5L20 4"/>')
  };

  function el(id) { return document.getElementById(id); }
  var esc = P.esc;

  /* ------------------------------------------------------------------
     Small shared widgets
     ------------------------------------------------------------------ */
  function toast(msg) {
    var root = el('toast-root');
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    root.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2200);
    setTimeout(function () { t.remove(); }, 2700);
  }

  // In-page confirm — never alert()/confirm()/prompt()
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var root = el('dialog-root');
      root.innerHTML =
        '<div class="overlay center" id="dlg-ov"><div class="dialog" role="alertdialog" aria-modal="true">' +
        '<h3>' + esc(opts.title || 'Are you sure?') + '</h3>' +
        '<p>' + esc(opts.message || '') + '</p>' +
        '<div class="row"><button class="btn subtle" id="dlg-no" style="flex:1">' + esc(opts.cancelText || 'Cancel') + '</button>' +
        '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="dlg-yes" style="flex:1">' + esc(opts.confirmText || 'Confirm') + '</button></div>' +
        '</div></div>';
      function done(v) { root.innerHTML = ''; resolve(v); }
      el('dlg-yes').addEventListener('click', function () { done(true); });
      el('dlg-no').addEventListener('click', function () { done(false); });
      el('dlg-ov').addEventListener('click', function (e) { if (e.target.id === 'dlg-ov') done(false); });
      el('dlg-yes').focus();
    });
  }

  function openSheet(html) {
    var root = el('sheet-root');
    root.innerHTML = '<div class="overlay" id="sheet-ov"><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grab"></div>' + html + '</div></div>';
    var ov = el('sheet-ov');
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(); });
    return root.querySelector('.sheet');
  }
  function closeSheet() { el('sheet-root').innerHTML = ''; }

  function reminderBanner(occ) {
    var root = el('banner-root');
    var div = document.createElement('div');
    div.className = 'banner';
    div.innerHTML =
      '<div style="flex:1"><b>' + esc(occ.ev.title) + '</b>' +
      '<span>Starting at ' + esc(D.fmtTime(occ.ev.start)) + (occ.ev.location ? ' · ' + esc(occ.ev.location) : '') + '</span></div>' +
      '<button class="icon-btn" aria-label="Dismiss">' + I.close + '</button>';
    div.querySelector('button').addEventListener('click', function () { div.remove(); });
    root.appendChild(div);
    P.vibrate([30, 40, 30]);
    setTimeout(function () { if (div.parentNode) div.remove(); }, 60000);
  }

  function catChip(cat) {
    return '<span class="chip tiny"><i class="cat-dot" style="background:' + esc(cat.color) + '"></i>' + esc(cat.icon) + ' ' + esc(cat.name) + '</span>';
  }
  var PRIO_COLOR = { high: 'var(--danger)', medium: 'var(--accent)', low: 'var(--line)' };

  function ringSVG(done, total) {
    var p = total ? done / total : 0;
    var C = (2 * Math.PI * 34).toFixed(1);
    var off = (C * (1 - p)).toFixed(1);
    return '<svg class="ring" viewBox="0 0 86 86" role="img" aria-label="' + done + ' of ' + total + ' done">' +
      '<circle class="track" cx="43" cy="43" r="34"/>' +
      '<circle class="bar" cx="43" cy="43" r="34" transform="rotate(-90 43 43)" stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '"/>' +
      '<text x="43" y="48" text-anchor="middle">' + done + '/' + total + '</text></svg>';
  }

  function openExternal(url) {
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 500);
  }

  /* ------------------------------------------------------------------
     RENDER — tab bar + current view
     ------------------------------------------------------------------ */
  var TABS = [
    { id: 'today', label: 'Today', icon: I.today },
    { id: 'calendar', label: 'Calendar', icon: I.calendar },
    { id: 'tasks', label: 'Tasks', icon: I.tasks },
    { id: 'courses', label: 'Courses', icon: I.courses },
    { id: 'more', label: 'More', icon: I.more }
  ];

  function render() {
    // tab bar
    el('tabbar').innerHTML = '<div class="bar">' + TABS.map(function (t) {
      return '<button class="tab-btn' + (S.tab === t.id ? ' on' : '') + '" data-action="tab" data-tab="' + t.id + '" aria-label="' + t.label + '">' +
        t.icon + '<span>' + t.label + '</span></button>';
    }).join('') + '</div>';

    var v = el('view');
    if (S.tab === 'today') v.innerHTML = viewToday();
    else if (S.tab === 'calendar') v.innerHTML = viewCalendar();
    else if (S.tab === 'tasks') v.innerHTML = viewTasks();
    else if (S.tab === 'courses') v.innerHTML = viewCourses();
    else v.innerHTML = viewMore();
  }

  /* ==================================================================
     TODAY
     ================================================================== */
  function greeting() {
    var h = D.now().getHours();
    if (h < 5) return 'Still up';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function viewToday() {
    var st = P.store.state.settings;
    var today = D.todayStr();
    var occs = P.data.occurrencesOn(today);
    var tasksToday = P.store.state.tasks.filter(function (t) { return t.due === today && !t.done; });
    var tasksDoneToday = P.store.state.tasks.filter(function (t) { return t.due === today && t.done; });
    var doneCount = occs.filter(function (o) { return o.done; }).length + tasksDoneToday.length;
    var totalCount = occs.length + tasksToday.length + tasksDoneToday.length;
    var overdue = P.data.tasksOverdue().length;
    var freeMin = P.sched.freeMinutesLeftToday();
    var nowM = D.nowMin();
    var next = occs.find(function (o) { return !o.done && o.endMin > nowM; });
    var hijriStr = H.fmt(today);

    var html = '';
    html += '<h1 class="greeting">' + greeting() + (st.name ? ', ' + esc(st.name) : '') + '</h1>';
    html += '<p class="hijri-line">' + esc(D.fmtDateLong(today)) +
      (hijriStr ? ' &nbsp;·&nbsp; ' + esc(hijriStr) : '') + '</p>';

    // Onboarding (dismissible, never blocks anything)
    if (!st.onboardingDismissed) html += onboardingCard(st);

    // Backup nudge every 14 days
    if (P.backup.isDue()) {
      html += '<div class="card flat" style="border-style:dashed">' +
        '<div class="row"><div style="flex:1"><b>Time to back up</b>' +
        '<p class="hint">It’s been a while — download a copy of your data so nothing can be lost.</p></div>' +
        '<button class="btn small primary" data-action="backup-download">' + I.dl + ' Backup</button></div></div>';
    }

    // Example-data notice with one-tap delete
    if (P.data.hasExamples()) {
      html += '<div class="card flat"><div class="row">' +
        '<div style="flex:1"><span class="example-tag">Example</span> ' +
        '<span class="hint" style="display:inline">This week is pre-filled with sample data so you can explore.</span></div>' +
        '<button class="btn small subtle" data-action="del-examples">Delete examples</button></div></div>';
    }

    // Next up
    if (next) {
      var cat = P.data.catById(next.ev.categoryId);
      html += '<div class="card nextup" style="border-left-color:' + esc(cat.color) + '">' +
        '<div class="row"><div style="flex:1">' +
        '<p class="hint" style="margin:0 0 2px">Next up ' + catChip(cat) + '</p>' +
        '<div class="card-title">' + esc(next.ev.title) + '</div>' +
        '<p class="hint">' + esc(D.fmtTime(next.ev.start)) + ' – ' + esc(D.fmtTime(next.ev.end)) +
        (next.ev.location ? ' · ' + esc(next.ev.location) : '') + '</p></div>' +
        '<div class="time">' + esc(nextIn(next.startMin, nowM)) + '</div></div></div>';
    }

    // Stats: progress ring / free time / overdue
    html += '<div class="card"><div class="stat-grid">' +
      ringSVG(doneCount, totalCount) +
      '<div class="stat"><b>' + D.fmtDuration(freeMin) + '</b><span>free today</span></div>' +
      '<div class="stat"' + (overdue ? ' style="color:var(--danger)"' : '') + '><b>' + overdue + '</b><span>overdue</span></div>' +
      '</div></div>';

    // Upcoming Islamic date
    var keyEv = H.keyEvents()[0];
    if (keyEv) {
      var inDays = D.diffDays(today, keyEv.date);
      html += '<div class="card flat"><div class="row">' +
        '<span style="font-size:22px">☪️</span><div style="flex:1"><b>' + esc(keyEv.name) + '</b>' +
        '<p class="hint">' + esc(D.fmtDateShort(keyEv.date)) + (inDays === 0 ? ' · today' : ' · in ' + inDays + ' day' + (inDays === 1 ? '' : 's')) + '</p></div></div>' +
        '<p class="islamic-note">Calculated with the Umm al-Qura calendar — actual moon sighting can differ by a day.</p></div>';
    }

    // Timeline
    html += '<h2 class="section-title">Today’s timeline</h2>';
    html += occs.length ? '<div class="timeline">' + occs.map(timelineItem).join('') + '</div>'
      : '<div class="empty"><div class="big">🌱</div>A clear day. Tap + to plan something.</div>';

    // Tasks due today
    if (tasksToday.length) {
      html += '<h2 class="section-title">Due today</h2>' + tasksToday.map(taskRow).join('');
    }
    return html;
  }

  function nextIn(startMin, nowM) {
    var d = startMin - nowM;
    if (d <= 0) return 'now';
    if (d < 60) return 'in ' + d + 'm';
    return 'in ' + Math.floor(d / 60) + 'h ' + (d % 60 ? (d % 60) + 'm' : '');
  }

  function timelineItem(o) {
    var cat = P.data.catById(o.ev.categoryId);
    var past = o.endMin < D.nowMin() && o.date === D.todayStr();
    return '<div class="tl-item">' +
      '<div class="tl-time">' + esc(D.fmtTime(o.ev.start)) + '</div>' +
      '<div class="tl-rail"><div class="tl-dot" style="background:' + esc(cat.color) + '"></div></div>' +
      '<div class="tl-card' + (o.done ? ' done' : '') + (past ? ' past' : '') + '" data-action="edit-occ" data-id="' + o.ev.id + '" data-date="' + o.date + '" role="button" tabindex="0">' +
      '<button class="check' + (o.done ? ' on' : '') + '" data-action="toggle-occ" data-id="' + o.ev.id + '" data-date="' + o.date + '" aria-label="Mark done">' + I.check + '</button>' +
      '<div style="flex:1;min-width:0"><div class="tl-title">' + esc(o.ev.title) +
      (o.ev.example ? ' <span class="example-tag">example</span>' : '') +
      (o.ev.kind === 'session' ? ' <span class="chip tiny accent">planned</span>' : '') + '</div>' +
      '<div class="tl-meta">' + esc(D.fmtTime(o.ev.start)) + '–' + esc(D.fmtTime(o.ev.end)) +
      (o.ev.location ? ' · ' + esc(o.ev.location) : '') + ' · ' + esc(cat.name) + '</div></div>' +
      '</div></div>';
  }

  function onboardingCard(st) {
    var cats = P.store.state.categories;
    return '<div class="card" id="onboard">' +
      '<div class="row"><div class="card-title" style="flex:1">Make Planner yours</div>' +
      '<button class="icon-btn" data-action="dismiss-onboarding" aria-label="Dismiss">' + I.close + '</button></div>' +
      '<p class="hint">Optional — you can change all of this later in More.</p>' +
      '<div class="field"><label for="ob-name">Your name</label><input id="ob-name" value="' + esc(st.name || '') + '" autocomplete="off"></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label for="ob-wake">Wake</label><input id="ob-wake" type="time" value="' + esc(st.wake) + '"></div>' +
      '<div class="field"><label for="ob-sleep">Sleep</label><input id="ob-sleep" type="time" value="' + esc(st.sleep) + '"></div>' +
      '</div>' +
      '<div class="field"><label for="ob-pref">Preferred study time</label>' +
      '<select id="ob-pref">' +
      ['morning', 'afternoon', 'evening'].map(function (p) {
        return '<option value="' + p + '"' + (st.studyPref === p ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>Your categories</label><div class="row wrap">' +
      cats.map(function (c) { return catChip(c); }).join(' ') +
      '</div><p class="hint">Edit colours and icons any time in More → Categories.</p></div>' +
      '<button class="btn primary block" data-action="save-onboarding">Save</button>' +
      '</div>';
  }

  /* ==================================================================
     CALENDAR — Day / Week / Month, Monday-first
     ================================================================== */
  var HOUR_START = 6, HOUR_END = 23, PX_PER_MIN = 0.8;

  function viewCalendar() {
    var html = '<h1 class="page-title">Calendar</h1>';
    html += '<div class="cal-head" style="margin-top:12px">' +
      '<button class="icon-btn" data-action="cal-prev" aria-label="Previous">' + I.left + '</button>' +
      '<div style="flex:1;text-align:center"><b>' + esc(calTitle()) + '</b></div>' +
      '<button class="icon-btn" data-action="cal-today" aria-label="Go to today" style="width:auto;padding:0 12px;font-size:13px;font-weight:600">Today</button>' +
      '<button class="icon-btn" data-action="cal-next" aria-label="Next">' + I.right + '</button></div>';
    html += '<div class="seg" style="margin-bottom:14px">' +
      ['day', 'week', 'month'].map(function (m) {
        return '<button class="' + (S.calMode === m ? 'on' : '') + '" data-action="cal-mode" data-mode="' + m + '">' + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
      }).join('') + '</div>';
    if (S.calMode === 'day') html += calDay();
    else if (S.calMode === 'week') html += calWeek();
    else html += calMonth();
    return html;
  }

  function calTitle() {
    if (S.calMode === 'day') return D.fmtDateLong(S.calDate);
    if (S.calMode === 'week') {
      var mon = D.mondayOf(S.calDate);
      return D.fmtDateShort(mon) + ' – ' + D.fmtDateShort(D.addDays(mon, 6));
    }
    return D.fmtMonthYear(S.calDate.slice(0, 8) + '01');
  }

  function calDay() {
    var occs = P.data.occurrencesOn(S.calDate);
    var hijriStr = H.fmt(S.calDate);
    var html = '';
    if (hijriStr) html += '<p class="hijri-line" style="margin:-6px 0 10px">' + esc(hijriStr) + '</p>';
    H.eventsOn(S.calDate).forEach(function (k) {
      html += '<div class="card flat"><b>☪️ ' + esc(k.name) + '</b>' +
        '<p class="islamic-note">Umm al-Qura calculation — moon sighting can differ by a day.</p></div>';
    });
    html += occs.length ? '<div class="timeline">' + occs.map(timelineItem).join('') + '</div>'
      : '<div class="empty"><div class="big">🍃</div>Nothing planned this day.</div>';
    return html;
  }

  // assign side-by-side columns to overlapping events
  function layoutOverlaps(occs) {
    var active = [], cluster = [];
    function flush() {
      if (!cluster.length) return;
      var n = 1;
      cluster.forEach(function (c) { if (c.col + 1 > n) n = c.col + 1; });
      cluster.forEach(function (c) { c.cols = n; });
      cluster = [];
    }
    occs.forEach(function (o) {
      active = active.filter(function (a) { return a.endMin > o.startMin; });
      if (!active.length) flush();
      var used = {};
      active.forEach(function (a) { used[a.col] = true; });
      var col = 0; while (used[col]) col++;
      o.col = col;
      active.push(o); cluster.push(o);
    });
    flush();
    return occs;
  }

  function calWeek() {
    var mon = D.mondayOf(S.calDate);
    var today = D.todayStr();
    var gridH = (HOUR_END - HOUR_START) * 60 * PX_PER_MIN;

    var head = '<div class="wk-days"><div></div>' +
      Array.from({ length: 7 }, function (_, i) {
        var d = D.addDays(mon, i);
        return '<div class="' + (d === today ? 'today' : '') + '">' + D.WEEKDAYS_SHORT[i] +
          '<b>' + D.fromStr(d).getDate() + '</b></div>';
      }).join('') + '</div>';

    var hours = '<div class="wk-hours">';
    for (var h = HOUR_START; h <= HOUR_END; h++) {
      hours += '<div class="wk-hour">' + String(h).padStart(2, '0') + '</div>';
    }
    hours += '</div>';

    var cols = '';
    for (var i = 0; i < 7; i++) {
      var dateStr = D.addDays(mon, i);
      var occs = layoutOverlaps(P.data.occurrencesOn(dateStr));
      var inner = '';
      for (var hh = HOUR_START + 1; hh <= HOUR_END; hh++) {
        inner += '<div class="wk-line" style="top:' + ((hh - HOUR_START) * 60 * PX_PER_MIN) + 'px"></div>';
      }
      occs.forEach(function (o) {
        var top = Math.max(0, (o.startMin - HOUR_START * 60) * PX_PER_MIN);
        var height = Math.max(14, (Math.min(o.endMin, HOUR_END * 60) - Math.max(o.startMin, HOUR_START * 60)) * PX_PER_MIN - 2);
        var cat = P.data.catById(o.ev.categoryId);
        var w = 100 / o.cols;
        inner += '<button class="wk-ev" data-action="edit-occ" data-id="' + o.ev.id + '" data-date="' + dateStr + '"' +
          ' style="top:' + top + 'px;height:' + height + 'px;left:' + (o.col * w) + '%;width:calc(' + w + '% - 2px);background:' + esc(cat.color) + ';opacity:' + (o.done ? 0.45 : 0.93) + '"' +
          ' aria-label="' + esc(o.ev.title) + '">' + esc(o.ev.title) + '</button>';
      });
      if (dateStr === today) {
        var nowTop = (D.nowMin() - HOUR_START * 60) * PX_PER_MIN;
        if (nowTop > 0 && nowTop < gridH) inner += '<div class="wk-now" style="top:' + nowTop + 'px"></div>';
      }
      cols += '<div class="wk-col" style="height:' + gridH + 'px">' + inner + '</div>';
    }

    return '<div class="wk-wrap">' + head +
      '<div class="wk-scroll"><div class="wk-grid">' + hours + cols + '</div></div></div>' +
      '<p class="hint" style="text-align:center">Tap an event to edit it.</p>';
  }

  function calMonth() {
    var first = S.calDate.slice(0, 8) + '01';
    var start = D.mondayOf(first);
    var monthN = D.fromStr(first).getMonth();
    var today = D.todayStr();
    var html = '<div class="mo-grid">' +
      D.WEEKDAYS_SHORT.map(function (w) { return '<div class="mo-wd">' + w + '</div>'; }).join('');
    for (var i = 0; i < 42; i++) {
      var dateStr = D.addDays(start, i);
      var d = D.fromStr(dateStr);
      var occs = P.data.occurrencesOn(dateStr);
      var dots = occs.slice(0, 3).map(function (o) {
        return '<i style="background:' + esc(P.data.catById(o.ev.categoryId).color) + '"></i>';
      }).join('');
      var more = occs.length > 3 ? '<span class="mo-more">+' + (occs.length - 3) + '</span>' : '';
      var star = H.eventsOn(dateStr).length ? '<span class="mo-star">☪️</span>' : '';
      html += '<button class="mo-cell' + (d.getMonth() !== monthN ? ' dim' : '') + (dateStr === today ? ' today' : '') + '"' +
        ' data-action="cal-day" data-date="' + dateStr + '">' +
        '<span class="d">' + d.getDate() + '</span><span class="mo-dots">' + dots + more + '</span>' + star + '</button>';
    }
    html += '</div><p class="hint" style="text-align:center">☪️ marks a calculated Islamic date (moon sighting can differ by a day).</p>';
    return html;
  }

  /* ==================================================================
     TASKS
     ================================================================== */
  function taskRow(t) {
    var cat = P.data.catById(t.categoryId);
    var today = D.todayStr();
    var dueBit = '';
    if (t.due) {
      var late = !t.done && t.due < today;
      dueBit = ' · <span style="' + (late ? 'color:var(--danger);font-weight:600' : '') + '">' + esc(D.relDay(t.due)) + (late ? ' · overdue' : '') + '</span>';
    }
    return '<div class="list-row' + (t.done ? ' done' : '') + '" data-action="edit-task" data-id="' + t.id + '" role="button" tabindex="0">' +
      '<button class="check' + (t.done ? ' on' : '') + '" data-action="toggle-task" data-id="' + t.id + '" aria-label="Mark done">' + I.check + '</button>' +
      '<div style="flex:1;min-width:0"><div class="title">' + esc(t.title) +
      (t.example ? ' <span class="example-tag">example</span>' : '') +
      (t.repeat && t.repeat !== 'none' ? ' <span class="chip tiny">↻ ' + esc(t.repeat) + '</span>' : '') + '</div>' +
      '<div class="meta">' + esc(cat.name) + (t.estMin ? ' · ' + D.fmtDuration(t.estMin) : '') + dueBit + '</div></div>' +
      '<span class="prio" style="background:' + PRIO_COLOR[t.priority || 'medium'] + '"></span></div>';
  }

  function viewTasks() {
    var today = D.todayStr();
    var ts = P.store.state.tasks.slice().sort(function (a, b) {
      return (a.due || '9999') < (b.due || '9999') ? -1 : 1;
    });
    var overdue = ts.filter(function (t) { return !t.done && t.due && t.due < today; });
    var dueToday = ts.filter(function (t) { return !t.done && t.due === today; });
    var upcoming = ts.filter(function (t) { return !t.done && (!t.due || t.due > today); });
    var done = ts.filter(function (t) { return t.done; });

    var html = '<h1 class="page-title">Tasks</h1>' +
      '<p class="page-sub">' + (overdue.length + dueToday.length + upcoming.length) + ' open · tap ✦ to auto-plan them around your events</p>';
    if (overdue.length) html += '<h2 class="section-title" style="color:var(--danger)">Overdue</h2>' + overdue.map(taskRow).join('');
    if (dueToday.length) html += '<h2 class="section-title">Today</h2>' + dueToday.map(taskRow).join('');
    if (upcoming.length) html += '<h2 class="section-title">Upcoming</h2>' + upcoming.map(taskRow).join('');
    if (done.length) html += '<h2 class="section-title">Done</h2>' + done.slice(0, 15).map(taskRow).join('');
    if (!ts.length) html += '<div class="empty"><div class="big">✨</div>No tasks yet. Tap + to add one.</div>';
    return html;
  }

  /* ==================================================================
     COURSES
     ================================================================== */
  function viewCourses() {
    var cs = P.store.state.courses;
    var html = '<h1 class="page-title">Courses</h1>' +
      '<p class="page-sub">Track modules — the assistant can schedule what’s left.</p>';
    if (!cs.length) return html + '<div class="empty"><div class="big">📚</div>No courses yet. Tap + and choose Course.</div>';
    cs.forEach(function (c) {
      var pr = P.data.courseProgress(c);
      var next = P.data.nextModule(c);
      html += '<div class="card">' +
        '<div class="row"><div style="flex:1"><div class="card-title">' + esc(c.name) +
        (c.example ? ' <span class="example-tag">example</span>' : '') + '</div>' +
        '<p class="hint">' + esc(c.provider || '') + ' · ' + pr.done + '/' + pr.total + ' modules</p></div>' +
        '<button class="btn small subtle" data-action="edit-course" data-id="' + c.id + '">Edit</button></div>' +
        '<div class="progress" style="margin:12px 0" role="progressbar" aria-valuenow="' + pr.pct + '"><i style="width:' + pr.pct + '%"></i></div>' +
        (next ? '<div class="row" style="background:var(--card-2);border-radius:var(--r-md);padding:10px 12px">' +
          '<div style="flex:1"><b style="font-size:14px">Next: ' + esc(next.name) + '</b>' +
          '<div class="hint" style="margin:0">' + D.fmtDuration(next.durationMin || 60) + (next.due ? ' · due ' + esc(D.relDay(next.due)) : '') + '</div></div></div>'
          : '<p class="hint">🎉 All modules done!</p>') +
        c.modules.map(function (m) {
          return '<div class="module-row">' +
            '<button class="check' + (m.done ? ' on' : '') + '" data-action="toggle-module" data-cid="' + c.id + '" data-mid="' + m.id + '" aria-label="Mark module done">' + I.check + '</button>' +
            '<div style="flex:1;min-width:0;' + (m.done ? 'text-decoration:line-through;color:var(--muted)' : '') + '">' + esc(m.name) +
            '<div class="m-meta">' + D.fmtDuration(m.durationMin || 60) + (m.due ? ' · due ' + esc(D.relDay(m.due)) : '') + '</div></div></div>';
        }).join('') +
        '</div>';
    });
    return html;
  }

  /* ==================================================================
     MORE — settings, categories, backups, sync, data, about
     ================================================================== */
  function viewMore() {
    var st = P.store.state.settings;
    var cats = P.store.state.categories;
    var html = '<h1 class="page-title">More</h1>';

    // profile & rhythm
    html += '<h2 class="section-title">You &amp; your day</h2><div class="card">' +
      '<div class="field"><label for="set-name">Name</label><input id="set-name" data-setting="name" value="' + esc(st.name || '') + '"></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label for="set-wake">Wake</label><input id="set-wake" type="time" data-setting="wake" value="' + esc(st.wake) + '"></div>' +
      '<div class="field"><label for="set-sleep">Sleep</label><input id="set-sleep" type="time" data-setting="sleep" value="' + esc(st.sleep) + '"></div>' +
      '<div class="field"><label for="set-fs">Focus window from</label><input id="set-fs" type="time" data-setting="focusStart" value="' + esc(st.focusStart) + '"></div>' +
      '<div class="field"><label for="set-fe">Focus window to</label><input id="set-fe" type="time" data-setting="focusEnd" value="' + esc(st.focusEnd) + '"></div>' +
      '<div class="field"><label for="set-cap">Daily focus cap (min)</label><input id="set-cap" type="number" min="25" step="5" data-setting="dailyCapMin" value="' + esc(st.dailyCapMin) + '"></div>' +
      '<div class="field"><label for="set-brk">Break between sessions (min)</label><input id="set-brk" type="number" min="0" step="5" data-setting="breakMin" value="' + esc(st.breakMin) + '"></div>' +
      '</div><p class="hint">The assistant plans study sessions inside your focus window, up to the daily cap, with breaks between.</p></div>';

    // categories
    html += '<h2 class="section-title">Categories</h2><div class="card">' +
      cats.map(function (c) {
        return '<div class="cat-edit">' +
          '<input type="color" data-cat-color data-id="' + c.id + '" value="' + esc(c.color) + '" aria-label="Colour for ' + esc(c.name) + '">' +
          '<input data-cat-icon data-id="' + c.id + '" value="' + esc(c.icon) + '" maxlength="4" aria-label="Icon" style="text-align:center">' +
          '<input data-cat-name data-id="' + c.id + '" value="' + esc(c.name) + '" aria-label="Name">' +
          (c.builtin ? '<span></span>' : '<button class="icon-btn" data-action="delete-category" data-id="' + c.id + '" aria-label="Delete category">' + I.trash + '</button>') +
          '</div>';
      }).join('') +
      '<button class="btn subtle block" data-action="add-category" style="margin-top:8px">' + I.plus + ' Add category</button></div>';

    // backups
    var lastB = st.lastBackupAt ? new Date(st.lastBackupAt).toLocaleDateString() : 'never';
    html += '<h2 class="section-title">Backups</h2><div class="card">' +
      '<p class="hint" style="margin-top:0">Last manual backup: <b>' + esc(lastB) + '</b>. You’ll get a gentle reminder every 14 days.</p>' +
      '<div class="row wrap" style="margin:10px 0">' +
      '<button class="btn primary" data-action="backup-download">' + I.dl + ' Download backup</button>' +
      '<button class="btn" data-action="backup-share">' + I.share + ' Share backup</button>' +
      '<button class="btn" data-action="backup-restore-pick">Restore backup…</button>' +
      '<input type="file" id="restore-file" accept=".json,application/json" style="display:none">' +
      '</div>' +
      '<div class="divider"></div>' +
      '<b style="font-size:15px">Automatic safety copies</b>' +
      '<p class="hint">Planner quietly keeps the last 5 snapshots so you can undo a bad import or reset.</p>' +
      '<div id="auto-backups"><p class="hint">Loading…</p></div></div>';

    // sync
    html += '<h2 class="section-title">Sync between devices (no account)</h2><div class="card">' +
      '<p class="hint" style="margin-top:0">Manual and private: create a code here, paste it into Planner on the other device.</p>' +
      '<div class="row wrap"><button class="btn" data-action="export-code">Create export code</button>' +
      '<button class="btn subtle" data-action="copy-code" id="copy-code-btn" style="display:none">Copy code</button></div>' +
      '<textarea id="export-code-box" class="code-box" style="display:none;margin-top:10px" rows="4" readonly></textarea>' +
      '<div class="field"><label for="import-code-box">Import a code</label>' +
      '<textarea id="import-code-box" class="code-box" rows="3" placeholder="Paste a PLNR… code from your other device"></textarea></div>' +
      '<button class="btn block" data-action="import-code">Import code</button></div>';

    // data
    html += '<h2 class="section-title">Data</h2><div class="card">' +
      (P.data.hasExamples() ? '<button class="btn subtle block" data-action="del-examples" style="margin-bottom:10px">Delete all example items</button>' : '') +
      '<button class="btn danger block" data-action="reset-example">Reset to example data (keeps a backup first)</button></div>';

    // about / honesty
    var mode = { indexeddb: 'IndexedDB', localstorage: 'localStorage (fallback)', memory: 'memory only — data will not survive closing!' }[P.store.storageMode];
    html += '<h2 class="section-title">About your data</h2><div class="card">' +
      '<p class="hint" style="margin-top:0">• Everything is stored <b>on this device</b> (' + mode + '); there is no account and nothing is uploaded.</p>' +
      '<p class="hint">• Protected storage: <b>' + (P.store.persisted ? 'granted' : (P.store.persistSupported ? 'requested — browser decides' : 'not offered by this browser')) + '</b>.</p>' +
      '<p class="hint">• <b>iPhone tip:</b> your data is safest once you add Planner to the Home Screen (Share → Add to Home Screen) — iOS keeps Home-Screen app storage, while plain browser-tab data can be cleared after long inactivity. Download a backup now and then regardless.</p>' +
      '<p class="hint">• <b>Honest limitation:</b> a web page like this cannot send background push notifications without a server. Reminders appear while Planner is open; for alerts when it’s closed, use “Email me a reminder” (Google Calendar) or “Add to calendar” (.ics) on any event — your phone’s calendar then does the notifying.</p>' +
      '<p class="hint">• Planner v1 · works fully offline after the first visit.</p></div>';

    setTimeout(loadAutoBackups, 0);
    return html;
  }

  function loadAutoBackups() {
    var box = el('auto-backups');
    if (!box) return;
    P.store.getBackups().then(function (list) {
      if (!el('auto-backups')) return;
      if (!list.length) { el('auto-backups').innerHTML = '<p class="hint">None yet.</p>'; return; }
      el('auto-backups').innerHTML = list.map(function (b, i) {
        var when = new Date(b.at);
        return '<div class="row" style="padding:7px 0;border-top:1px solid var(--line)">' +
          '<div style="flex:1"><b style="font-size:14px">' + esc(when.toLocaleDateString()) + ' ' + esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</b>' +
          '<div class="hint" style="margin:0">' + esc(b.reason) + '</div></div>' +
          '<button class="btn small subtle" data-action="backup-undo" data-idx="' + i + '">Restore</button></div>';
      }).join('');
    });
  }

  /* ==================================================================
     ADD / EDIT SHEETS
     ================================================================== */
  function fieldSelect(id, label, options, current) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(current) ? ' selected' : '') + '>' + esc(o.t) + '</option>';
      }).join('') + '</select></div>';
  }
  function catOptions() {
    return P.store.state.categories.map(function (c) { return { v: c.id, t: c.icon + ' ' + c.name }; });
  }
  var REPEATS = [{ v: 'none', t: 'Does not repeat' }, { v: 'daily', t: 'Daily' }, { v: 'weekly', t: 'Weekly' }, { v: 'monthly', t: 'Monthly' }];
  var PRIORITIES = [{ v: 'low', t: 'Low' }, { v: 'medium', t: 'Medium' }, { v: 'high', t: 'High' }];
  var REMINDERS = [{ v: '', t: 'No reminder' }, { v: '5', t: '5 min before' }, { v: '10', t: '10 min before' }, { v: '15', t: '15 min before' }, { v: '30', t: '30 min before' }, { v: '45', t: '45 min before' }, { v: '60', t: '1 hour before' }];

  function eventFormHTML(ev, defaults) {
    ev = ev || {};
    var d = defaults || {};
    return '<div class="field"><label for="ef-title">Title</label><input id="ef-title" value="' + esc(ev.title || '') + '" placeholder="e.g. Revision session"></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label for="ef-date">Date</label><input id="ef-date" type="date" value="' + esc(ev.date || d.date || D.todayStr()) + '"></div>' +
      '<div class="field"><label for="ef-loc">Location</label><input id="ef-loc" value="' + esc(ev.location || '') + '" placeholder="Optional"></div>' +
      '<div class="field"><label for="ef-start">Start</label><input id="ef-start" type="time" value="' + esc(ev.start || d.start || '17:00') + '"></div>' +
      '<div class="field"><label for="ef-end">End</label><input id="ef-end" type="time" value="' + esc(ev.end || d.end || '18:00') + '"></div>' +
      '</div>' +
      fieldSelect('ef-cat', 'Category', catOptions(), ev.categoryId || d.categoryId || 'cat_personal') +
      '<div class="field-grid">' +
      fieldSelect('ef-rem', 'Reminder', REMINDERS, ev.reminderMin != null ? ev.reminderMin : '30') +
      fieldSelect('ef-rep', 'Repeat', REPEATS, ev.repeat || 'none') +
      fieldSelect('ef-prio', 'Priority', PRIORITIES, ev.priority || 'medium') +
      '<div class="field"><label for="ef-until">Repeat until (optional)</label><input id="ef-until" type="date" value="' + esc(ev.repeatUntil || '') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="ef-notes">Notes</label><textarea id="ef-notes" placeholder="Optional">' + esc(ev.notes || '') + '</textarea></div>';
  }

  function readEventForm(sheet) {
    function v(id) { var x = sheet.querySelector('#' + id); return x ? x.value : ''; }
    var title = v('ef-title').trim();
    if (!title) { toast('Give it a title first'); return null; }
    var start = v('ef-start') || '09:00', end = v('ef-end') || '10:00';
    if (D.min(end) <= D.min(start)) end = D.hm(D.min(start) + 60);
    return {
      title: title, date: v('ef-date') || D.todayStr(),
      start: start, end: end,
      location: v('ef-loc').trim(),
      categoryId: v('ef-cat'),
      reminderMin: v('ef-rem') === '' ? null : parseInt(v('ef-rem'), 10),
      repeat: v('ef-rep'), repeatUntil: v('ef-until') || null,
      priority: v('ef-prio'), notes: v('ef-notes').trim()
    };
  }

  function taskFormHTML(t) {
    t = t || {};
    return '<div class="field"><label for="tf-title">Title</label><input id="tf-title" value="' + esc(t.title || '') + '" placeholder="e.g. Finish report draft"></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label for="tf-due">Due (optional)</label><input id="tf-due" type="date" value="' + esc(t.due || '') + '"></div>' +
      '<div class="field"><label for="tf-est">Estimated minutes</label><input id="tf-est" type="number" min="0" step="5" value="' + esc(t.estMin != null ? t.estMin : 60) + '"></div>' +
      fieldSelect('tf-prio', 'Priority', PRIORITIES, t.priority || 'medium') +
      fieldSelect('tf-cat', 'Category', catOptions(), t.categoryId || 'cat_personal') +
      fieldSelect('tf-rep', 'Repeat', REPEATS, t.repeat || 'none') +
      '</div>';
  }
  function readTaskForm(sheet) {
    function v(id) { var x = sheet.querySelector('#' + id); return x ? x.value : ''; }
    var title = v('tf-title').trim();
    if (!title) { toast('Give it a title first'); return null; }
    return {
      title: title, due: v('tf-due') || null,
      estMin: Math.max(0, parseInt(v('tf-est'), 10) || 0),
      priority: v('tf-prio'), categoryId: v('tf-cat'), repeat: v('tf-rep')
    };
  }

  function moduleRowHTML(m) {
    m = m || {};
    return '<div class="cm-row field-grid" data-mid="' + esc(m.id || '') + '" data-done="' + (m.done ? '1' : '') + '" style="grid-template-columns:2fr 1fr 1fr auto;align-items:end">' +
      '<div class="field" style="margin:4px 0"><label>Module</label><input class="cm-name" value="' + esc(m.name || '') + '" placeholder="Module name"></div>' +
      '<div class="field" style="margin:4px 0"><label>Min</label><input class="cm-dur" type="number" min="5" step="5" value="' + esc(m.durationMin || 60) + '"></div>' +
      '<div class="field" style="margin:4px 0"><label>Due</label><input class="cm-due" type="date" value="' + esc(m.due || '') + '"></div>' +
      '<button class="icon-btn" data-action="remove-module-row" aria-label="Remove module" style="margin-bottom:12px">' + I.trash + '</button></div>';
  }
  function courseFormHTML(c) {
    c = c || {};
    return '<div class="field"><label for="cf-name">Course name</label><input id="cf-name" value="' + esc(c.name || '') + '" placeholder="e.g. AWS Cloud Practitioner"></div>' +
      '<div class="field"><label for="cf-prov">Provider</label><input id="cf-prov" value="' + esc(c.provider || '') + '" placeholder="e.g. Coursera"></div>' +
      '<label style="font-size:13px;font-weight:600;color:var(--muted)">Modules</label>' +
      '<div id="cf-modules">' + (c.modules && c.modules.length ? c.modules.map(moduleRowHTML).join('') : moduleRowHTML()) + '</div>' +
      '<button class="btn subtle block" data-action="add-module-row">' + I.plus + ' Add module</button>';
  }
  function readCourseForm(sheet) {
    var name = sheet.querySelector('#cf-name').value.trim();
    if (!name) { toast('Give the course a name'); return null; }
    var modules = [];
    sheet.querySelectorAll('.cm-row').forEach(function (row) {
      var mName = row.querySelector('.cm-name').value.trim();
      if (!mName) return;
      modules.push({
        id: row.dataset.mid || P.uid('m'),
        name: mName,
        durationMin: Math.max(5, parseInt(row.querySelector('.cm-dur').value, 10) || 60),
        due: row.querySelector('.cm-due').value || null,
        done: row.dataset.done === '1'
      });
    });
    return { name: name, provider: sheet.querySelector('#cf-prov').value.trim(), modules: modules };
  }

  function openAddSheet() {
    var defaults = { date: S.tab === 'calendar' ? S.calDate : D.todayStr() };
    var seg = '<div class="seg" style="margin-bottom:14px">' +
      [['event', 'Event'], ['task', 'Task'], ['course', 'Course']].map(function (k) {
        return '<button class="' + (S.addKind === k[0] ? 'on' : '') + '" data-action="add-kind" data-kind="' + k[0] + '">' + k[1] + '</button>';
      }).join('') + '</div>';
    var body = S.addKind === 'event' ? eventFormHTML(null, defaults)
      : S.addKind === 'task' ? taskFormHTML(null)
        : courseFormHTML(null);
    var saveAction = 'save-new-' + S.addKind;
    openSheet(
      '<div class="sheet-head"><h2>Add ' + S.addKind + '</h2>' +
      '<button class="icon-btn" data-action="close-sheet" aria-label="Close">' + I.close + '</button></div>' +
      seg +
      body +
      '<button class="btn primary block" data-action="' + saveAction + '" style="margin-top:14px">Save</button>'
    );
  }

  function openEventSheet(evId, dateStr) {
    var ev = P.data.eventById(evId);
    if (!ev) return;
    var recurring = ev.repeat && ev.repeat !== 'none';
    var html =
      '<div class="sheet-head"><h2>Edit event</h2>' +
      '<button class="icon-btn" data-action="close-sheet" aria-label="Close">' + I.close + '</button></div>' +
      (ev.example ? '<p class="hint"><span class="example-tag">example</span> This is sample data — edit or delete it freely.</p>' : '') +
      (ev.kind === 'session' ? '<p class="hint">✨ A study session planned by the assistant — edit it like any event.</p>' : '') +
      eventFormHTML(ev) +
      (recurring ? '<p class="hint">↻ Repeats ' + esc(ev.repeat) + ' — saved changes apply to the whole series. Ticking it off only ever affects one day.</p>' : '') +
      '<button class="btn primary block" data-action="save-event" data-id="' + ev.id + '" style="margin:14px 0 8px">Save changes</button>' +
      '<div class="row" style="margin-bottom:8px">' +
      '<button class="btn small" style="flex:1" data-action="gcal-event" data-id="' + ev.id + '" data-date="' + esc(dateStr) + '">' + I.mail + ' Email me a reminder</button>' +
      '<button class="btn small" style="flex:1" data-action="ics-event" data-id="' + ev.id + '" data-date="' + esc(dateStr) + '">' + I.dl + ' Add to calendar</button></div>' +
      '<p class="kbd-note">“Email me a reminder” opens a prefilled Google Calendar event (repeat rule included); “Add to calendar” downloads an .ics for your phone’s calendar. Either way, your calendar sends the alert — a web page can’t push notifications in the background without a server.</p>' +
      '<div class="divider"></div>' +
      (recurring
        ? '<div class="row"><button class="btn danger" style="flex:1" data-action="delete-event-day" data-id="' + ev.id + '" data-date="' + esc(dateStr) + '">Delete this day</button>' +
        '<button class="btn danger" style="flex:1" data-action="delete-event-series" data-id="' + ev.id + '">Delete series</button></div>'
        : '<button class="btn danger block" data-action="delete-event-series" data-id="' + ev.id + '">' + I.trash + ' Delete event</button>');
    openSheet(html);
  }

  function openTaskSheet(id) {
    var t = P.data.taskById(id);
    if (!t) return;
    openSheet(
      '<div class="sheet-head"><h2>Edit task</h2>' +
      '<button class="icon-btn" data-action="close-sheet" aria-label="Close">' + I.close + '</button></div>' +
      (t.example ? '<p class="hint"><span class="example-tag">example</span> Sample data — edit or delete it freely.</p>' : '') +
      taskFormHTML(t) +
      '<button class="btn primary block" data-action="save-task" data-id="' + t.id + '" style="margin:14px 0 8px">Save changes</button>' +
      '<button class="btn danger block" data-action="delete-task" data-id="' + t.id + '">' + I.trash + ' Delete task</button>'
    );
  }

  function openCourseSheet(id) {
    var c = P.data.courseById(id);
    if (!c) return;
    openSheet(
      '<div class="sheet-head"><h2>Edit course</h2>' +
      '<button class="icon-btn" data-action="close-sheet" aria-label="Close">' + I.close + '</button></div>' +
      courseFormHTML(c) +
      '<button class="btn primary block" data-action="save-course" data-id="' + c.id + '" style="margin:14px 0 8px">Save changes</button>' +
      '<button class="btn danger block" data-action="delete-course" data-id="' + c.id + '">' + I.trash + ' Delete course</button>'
    );
  }

  /* ==================================================================
     SCHEDULE ASSISTANT (chat UI over Planner.assistant)
     ================================================================== */
  function openAssistant() {
    var root = el('assistant-root');
    root.innerHTML =
      '<div class="overlay" id="assist-ov"><div class="assistant">' +
      '<div class="sheet-head" style="padding:14px var(--gutter) 0">' +
      '<h2>' + I.spark.replace('<svg', '<svg style="width:20px;height:20px;vertical-align:-3px;color:var(--accent-ink)"') + ' Schedule Assistant</h2>' +
      '<button class="icon-btn" data-action="close-assistant" aria-label="Close">' + I.close + '</button></div>' +
      '<p class="hint" style="padding:0 var(--gutter)">Rule-based and fully offline — nothing changes until you tap Accept.</p>' +
      '<div class="chat" id="assist-chat"></div>' +
      '<div class="chips">' +
      ['Assignment due Friday, 3 hours', 'Finish my AWS course', 'Gym three times', 'Move the gym to Thursday'].map(function (s) {
        return '<button class="chip" data-action="assistant-chip" data-text="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div>' +
      '<div class="composer">' +
      '<input id="assist-input" placeholder="e.g. report due Friday, gym three times" autocomplete="off">' +
      '<button class="icon-btn" data-action="assistant-send" aria-label="Send" style="background:var(--accent);color:#fff;border-color:var(--accent)">' + I.send + '</button></div>' +
      '</div></div>';
    el('assist-ov').addEventListener('click', function (e) { if (e.target.id === 'assist-ov') closeAssistant(); });
    el('assist-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') assistantSend(); });
    if (!S.assist.chat.length) {
      S.assist.chat.push({ role: 'bot', text: 'Tell me what’s on your plate and I’ll plan study sessions around your events — inside your focus window, with breaks, spread across the days before each deadline. Try the chips below.' });
    }
    renderChat();
  }
  function closeAssistant() { el('assistant-root').innerHTML = ''; }

  function renderChat() {
    var box = el('assist-chat');
    if (!box) return;
    var html = S.assist.chat.map(function (m) {
      return '<div class="msg ' + m.role + '">' + (m.html || esc(m.text)) + '</div>';
    }).join('');
    if (S.assist.proposal) html += proposalHTML(S.assist.proposal);
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function proposalHTML(p) {
    var cats = P.data.catById;
    var html = '<div class="proposal">';
    if (p.isEmpty) {
      html += '<p class="hint" style="margin:0">Nothing I could plan from that — try one of the chips.</p></div>';
      return html;
    }
    html += '<b>Proposed plan</b> <span class="chip tiny">' + (p.strategy === 'spread' ? 'spread across days' : 'packed early') + '</span>';

    if (p.newEvents.length) {
      html += '<div class="p-day">New weekly events</div>';
      p.newEvents.forEach(function (ev) {
        html += '<div class="p-row"><i class="cat-dot" style="background:' + esc(cats(ev.categoryId).color) + '"></i>' +
          '<span style="flex:1">' + esc(ev.title) + ' · every ' + D.WEEKDAYS[D.weekdayIndex(ev.date)] + '</span>' +
          '<span class="p-time">' + esc(D.fmtTime(ev.start)) + '–' + esc(D.fmtTime(ev.end)) + '</span></div>';
      });
    }
    if (p.moves.length) {
      html += '<div class="p-day">Moves</div>';
      p.moves.forEach(function (mv) {
        html += '<div class="p-row"><span style="flex:1">' + esc(mv.title) + '</span>' +
          '<span class="p-time">' + (mv.from ? esc(D.relDay(mv.from)) : '?') + ' → ' + esc(D.relDay(mv.to)) + '</span></div>';
      });
    }
    if (p.sessions.length) {
      var byDay = {};
      p.sessions.forEach(function (s) { (byDay[s.date] = byDay[s.date] || []).push(s); });
      Object.keys(byDay).sort().forEach(function (day) {
        html += '<div class="p-day">' + esc(D.relDay(day)) + ' · ' + esc(D.fmtDateShort(day)) + '</div>';
        byDay[day].forEach(function (s) {
          if (S.assist.editMode) {
            html += '<div class="p-row p-edit" data-sid="' + s.id + '">' +
              '<i class="cat-dot" style="background:' + esc(cats(s.categoryId).color) + '"></i>' +
              '<span style="flex:1;min-width:80px">' + esc(s.title) + '</span>' +
              '<input type="date" class="pe-date" value="' + s.date + '" style="width:124px">' +
              '<input type="time" class="pe-start" value="' + s.start + '" style="width:84px"></div>';
          } else {
            html += '<div class="p-row"><i class="cat-dot" style="background:' + esc(cats(s.categoryId).color) + '"></i>' +
              '<span style="flex:1">' + esc(s.title) + '</span>' +
              '<span class="p-time">' + esc(D.fmtTime(s.start)) + '–' + esc(D.fmtTime(s.end)) + '</span></div>';
          }
        });
      });
    }
    if (p.warnings.length) {
      p.warnings.forEach(function (w) {
        html += '<p class="hint" style="color:var(--danger)">⚠ ' + esc(D.fmtDuration(w.unplaced)) + ' of “' + esc(w.title) + '” didn’t fit before its deadline — free some time or raise your daily cap in More.</p>';
      });
    }
    p.notes.forEach(function (n) { html += '<p class="hint">' + esc(n) + '</p>'; });

    html += '<div class="row" style="margin-top:12px">' +
      (S.assist.editMode
        ? '<button class="btn small primary" style="flex:1" data-action="proposal-apply-edits">Apply edits</button>'
        : '<button class="btn small primary" style="flex:1" data-action="proposal-accept">Accept</button>' +
        '<button class="btn small" data-action="proposal-edit">Edit</button>' +
        '<button class="btn small subtle" data-action="proposal-regen">Regenerate</button>') +
      '</div></div>';
    return html;
  }

  function assistantSend(presetText) {
    var input = el('assist-input');
    var text = presetText != null ? presetText : (input ? input.value.trim() : '');
    if (!text) return;
    if (input && presetText == null) input.value = '';
    S.assist.chat.push({ role: 'me', text: text });

    var reqs = P.assistant.interpret(text);

    // "Move X to Y" while a proposal is on screen → adjust it in place
    if (S.assist.proposal && reqs.length && reqs.every(function (r) { return r.type === 'move'; })) {
      var adjusted = false;
      reqs.forEach(function (r) { if (P.assistant.adjustProposal(S.assist.proposal, r)) adjusted = true; });
      if (adjusted) {
        S.assist.chat.push({ role: 'bot', text: 'Done — updated the proposal below. Accept when it looks right.' });
        renderChat();
        return;
      }
    }

    S.assist.requests = reqs;
    S.assist.editMode = false;
    S.assist.proposal = P.assistant.buildProposal(reqs, S.assist.strategy);
    var p = S.assist.proposal;
    var summary = p.isEmpty
      ? 'I couldn’t turn that into a plan — here’s what I understood:'
      : 'Here’s a plan: ' + (p.sessions.length ? p.sessions.length + ' session' + (p.sessions.length === 1 ? '' : 's') : '') +
      (p.newEvents.length ? (p.sessions.length ? ', ' : '') + p.newEvents.length + ' weekly event' + (p.newEvents.length === 1 ? '' : 's') : '') +
      (p.moves.length ? (p.sessions.length || p.newEvents.length ? ', ' : '') + p.moves.length + ' move' + (p.moves.length === 1 ? '' : 's') : '') +
      '. Nothing is saved until you tap Accept.';
    S.assist.chat.push({ role: 'bot', text: summary });
    renderChat();
  }

  function applyProposalEdits() {
    var box = el('assist-chat');
    if (!box || !S.assist.proposal) return;
    box.querySelectorAll('.p-edit').forEach(function (row) {
      var s = S.assist.proposal.sessions.find(function (x) { return x.id === row.dataset.sid; });
      if (!s) return;
      var dur = D.min(s.end) - D.min(s.start);
      var nd = row.querySelector('.pe-date').value || s.date;
      var ns = row.querySelector('.pe-start').value || s.start;
      s.date = nd; s.start = ns; s.end = D.hm(D.min(ns) + dur);
    });
    S.assist.proposal.sessions.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : D.min(a.start) - D.min(b.start);
    });
    S.assist.editMode = false;
    S.assist.chat.push({ role: 'bot', text: 'Edits applied — tap Accept to save.' });
    renderChat();
  }

  /* ==================================================================
     EVENT DELEGATION — one click handler, one change handler
     ================================================================== */
  function onAction(action, t, e) {
    var id = t.dataset.id, date = t.dataset.date;
    switch (action) {
      /* navigation */
      case 'tab': S.tab = t.dataset.tab; render(); window.scrollTo(0, 0); break;
      case 'cal-mode': S.calMode = t.dataset.mode; render(); break;
      case 'cal-today': S.calDate = D.todayStr(); render(); break;
      case 'cal-prev':
      case 'cal-next': {
        var dir = action === 'cal-next' ? 1 : -1;
        if (S.calMode === 'day') S.calDate = D.addDays(S.calDate, dir);
        else if (S.calMode === 'week') S.calDate = D.addDays(S.calDate, 7 * dir);
        else { var d0 = D.fromStr(S.calDate.slice(0, 8) + '01'); d0.setMonth(d0.getMonth() + dir); S.calDate = D.toStr(d0); }
        render(); break;
      }
      case 'cal-day': S.calDate = t.dataset.date; S.calMode = 'day'; render(); break;

      /* add / edit */
      case 'open-add': S.addKind = 'event'; openAddSheet(); break;
      case 'add-kind': S.addKind = t.dataset.kind; openAddSheet(); break;
      case 'close-sheet': closeSheet(); break;
      case 'save-new-event': {
        var sh = el('sheet-root'); var data = readEventForm(sh);
        if (data) { P.data.addEvent(data); closeSheet(); toast('Event added'); P.vibrate(12); }
        break;
      }
      case 'save-new-task': {
        var sh2 = el('sheet-root'); var td = readTaskForm(sh2);
        if (td) { td.done = false; P.data.addTask(td); closeSheet(); toast('Task added'); P.vibrate(12); }
        break;
      }
      case 'save-new-course': {
        var sh3 = el('sheet-root'); var cd = readCourseForm(sh3);
        if (cd) { P.data.addCourse(cd); closeSheet(); toast('Course added'); P.vibrate(12); }
        break;
      }
      case 'add-module-row':
        el('cf-modules').insertAdjacentHTML('beforeend', moduleRowHTML());
        break;
      case 'remove-module-row': t.closest('.cm-row').remove(); break;

      case 'edit-occ': openEventSheet(id, date); break;
      case 'save-event': {
        var sh4 = el('sheet-root'); var ed = readEventForm(sh4);
        if (ed) { P.data.updateEvent(id, ed); closeSheet(); toast('Saved'); }
        break;
      }
      case 'delete-event-day':
        confirmDialog({ title: 'Delete this day only?', message: 'The rest of the series stays in your calendar.', confirmText: 'Delete this day', danger: true })
          .then(function (yes) { if (yes) { P.data.skipOccurrence(id, date); closeSheet(); toast('Removed for that day'); } });
        break;
      case 'delete-event-series':
        confirmDialog({ title: 'Delete event?', message: 'This removes the event (and its repeats) from your calendar.', confirmText: 'Delete', danger: true })
          .then(function (yes) { if (yes) { P.data.deleteEventSeries(id); closeSheet(); toast('Deleted'); } });
        break;
      case 'toggle-occ': {
        var nowDone = P.data.toggleOccurrence(id, date);
        if (nowDone) P.vibrate(18);
        break;
      }

      case 'edit-task': openTaskSheet(id); break;
      case 'save-task': {
        var sh5 = el('sheet-root'); var td2 = readTaskForm(sh5);
        if (td2) { P.data.updateTask(id, td2); closeSheet(); toast('Saved'); }
        break;
      }
      case 'delete-task':
        confirmDialog({ title: 'Delete task?', message: 'Any study sessions planned for it are removed too.', confirmText: 'Delete', danger: true })
          .then(function (yes) { if (yes) { P.data.deleteTask(id); closeSheet(); toast('Deleted'); } });
        break;
      case 'toggle-task': {
        var done = P.data.toggleTask(id);
        if (done) P.vibrate(18);
        break;
      }

      case 'edit-course': openCourseSheet(id); break;
      case 'save-course': {
        var sh6 = el('sheet-root'); var cd2 = readCourseForm(sh6);
        if (cd2) { P.data.updateCourse(id, cd2); closeSheet(); toast('Saved'); }
        break;
      }
      case 'delete-course':
        confirmDialog({ title: 'Delete course?', message: 'Its modules and progress are removed.', confirmText: 'Delete', danger: true })
          .then(function (yes) { if (yes) { P.data.deleteCourse(id); closeSheet(); toast('Deleted'); } });
        break;
      case 'toggle-module': {
        var md = P.data.toggleModule(t.dataset.cid, t.dataset.mid);
        if (md) P.vibrate(18);
        break;
      }

      /* calendar links */
      case 'gcal-event': {
        var gev = P.data.eventById(id);
        if (gev) openExternal(P.cal.gcalUrl(gev, date));
        break;
      }
      case 'ics-event': {
        var iev = P.data.eventById(id);
        if (iev) { P.cal.downloadICS(iev, date); toast('.ics downloaded — open it to add the event'); }
        break;
      }

      /* onboarding */
      case 'dismiss-onboarding':
        P.store.commit(function (s) { s.settings.onboardingDismissed = true; });
        break;
      case 'save-onboarding': {
        var name = el('ob-name').value.trim();
        var wake = el('ob-wake').value || '06:30';
        var sleep = el('ob-sleep').value || '23:30';
        var pref = el('ob-pref').value;
        var windows = { morning: ['08:00', '12:00'], afternoon: ['13:00', '17:00'], evening: ['17:00', '21:30'] };
        P.store.commit(function (s) {
          s.settings.name = name;
          s.settings.wake = wake; s.settings.sleep = sleep;
          s.settings.studyPref = pref;
          s.settings.focusStart = windows[pref][0];
          s.settings.focusEnd = windows[pref][1];
          s.settings.onboardingDismissed = true;
        });
        toast(name ? 'Welcome, ' + name + '!' : 'Saved');
        break;
      }

      /* examples / reset */
      case 'del-examples':
        confirmDialog({ title: 'Remove example data?', message: 'Every item marked “example” is deleted. Your own items are untouched.', confirmText: 'Remove examples', danger: true })
          .then(function (yes) { if (yes) { P.data.deleteExamples(); toast('Example data removed'); } });
        break;
      case 'reset-example':
        confirmDialog({ title: 'Reset to example data?', message: 'A safety backup of your current data is kept first (restorable under Backups), then the app returns to the sample week.', confirmText: 'Back up & reset', danger: true })
          .then(function (yes) {
            if (yes) P.store.resetToExample().then(function () { toast('Reset done — previous data kept as a backup'); });
          });
        break;

      /* backups & sync */
      case 'backup-download':
        toast(P.backup.download() ? 'Backup downloaded' : 'Could not download here');
        break;
      case 'backup-share':
        P.backup.share().then(function (r) {
          if (r === 'shared') toast('Backup shared');
          else if (r === 'downloaded') toast('Sharing unavailable — downloaded instead');
          else if (r === 'failed') toast('Could not share here');
        });
        break;
      case 'backup-restore-pick': el('restore-file').click(); break;
      case 'backup-undo':
        confirmDialog({ title: 'Restore this snapshot?', message: 'Your current data is backed up first, then replaced by the snapshot.', confirmText: 'Restore' })
          .then(function (yes) {
            if (yes) P.store.restoreBackup(parseInt(t.dataset.idx, 10)).then(function (ok) {
              toast(ok ? 'Snapshot restored' : 'Could not restore');
            });
          });
        break;
      case 'export-code':
        P.backup.exportCode().then(function (code) {
          var box = el('export-code-box');
          box.style.display = 'block'; box.value = code;
          el('copy-code-btn').style.display = '';
          toast('Code ready — copy it to your other device');
        });
        break;
      case 'copy-code': {
        var box2 = el('export-code-box');
        box2.select();
        var copied = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(box2.value).then(function () { toast('Copied'); }, function () { toast('Long-press the code to copy it'); });
          copied = true;
        }
        if (!copied) toast('Long-press the code to copy it');
        break;
      }
      case 'import-code': {
        var code = el('import-code-box').value;
        if (!code.trim()) { toast('Paste a code first'); break; }
        confirmDialog({ title: 'Import this code?', message: 'Your current data is backed up first, then replaced by the imported data.', confirmText: 'Import' })
          .then(function (yes) {
            if (!yes) return;
            P.backup.importCode(code).then(function (r) { toast(r.ok ? 'Imported ✓' : r.error); });
          });
        break;
      }

      /* categories */
      case 'add-category':
        P.store.commit(function (s) {
          s.categories.push({ id: P.uid('cat'), name: 'New category', color: '#5B8DEF', icon: '⭐', builtin: false });
        });
        break;
      case 'delete-category':
        confirmDialog({ title: 'Delete category?', message: 'Items keep working; they just show as “Other”.', confirmText: 'Delete', danger: true })
          .then(function (yes) {
            if (yes) P.store.commit(function (s) {
              s.categories = s.categories.filter(function (c) { return c.id !== id; });
            });
          });
        break;

      /* assistant */
      case 'open-assistant': openAssistant(); break;
      case 'close-assistant': closeAssistant(); break;
      case 'assistant-send': assistantSend(); break;
      case 'assistant-chip': assistantSend(t.dataset.text); break;
      case 'proposal-accept':
        P.assistant.applyProposal(S.assist.proposal);
        S.assist.chat.push({ role: 'bot', text: 'Saved ✓ — check Today and Calendar. You can edit or delete any planned session like a normal event.' });
        S.assist.proposal = null;
        P.vibrate([15, 30, 15]);
        renderChat();
        toast('Plan added to your calendar');
        break;
      case 'proposal-regen':
        S.assist.strategy = S.assist.strategy === 'spread' ? 'pack' : 'spread';
        S.assist.proposal = P.assistant.buildProposal(S.assist.requests || [], S.assist.strategy);
        S.assist.chat.push({ role: 'bot', text: S.assist.strategy === 'pack' ? 'Regenerated — packed as early as possible.' : 'Regenerated — spread evenly across the days.' });
        renderChat();
        break;
      case 'proposal-edit':
        S.assist.editMode = true; renderChat(); break;
      case 'proposal-apply-edits':
        applyProposalEdits(); break;
    }
  }

  function bindGlobal() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      e.preventDefault();
      onAction(t.dataset.action, t, e);
    });

    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'restore-file') {
        var file = t.files && t.files[0];
        t.value = '';
        if (!file) return;
        confirmDialog({ title: 'Restore this backup?', message: 'Your current data is backed up first, then replaced by “' + file.name + '”.', confirmText: 'Restore' })
          .then(function (yes) {
            if (!yes) return;
            P.backup.restoreFromFile(file).then(function (r) { toast(r.ok ? 'Backup restored' : r.error); });
          });
        return;
      }
      if (t.dataset.setting) {
        var key = t.dataset.setting;
        var val = t.type === 'number' ? Math.max(0, parseInt(t.value, 10) || 0) : t.value;
        P.store.commit(function (s) { s.settings[key] = val; });
        return;
      }
      if (t.hasAttribute('data-cat-color') || t.hasAttribute('data-cat-icon') || t.hasAttribute('data-cat-name')) {
        var cid = t.dataset.id, value = t.value;
        var field = t.hasAttribute('data-cat-color') ? 'color' : t.hasAttribute('data-cat-icon') ? 'icon' : 'name';
        P.store.commit(function (s) {
          var c = s.categories.find(function (x) { return x.id === cid; });
          if (c) c[field] = value;
        });
      }
    });
  }

  /* ==================================================================
     BOOT
     ================================================================== */
  function boot() {
    S.calDate = D.todayStr();
    P.store.init().then(function () {
      bindGlobal();
      render();
      P.on('change', render);
      P.remind.start(function (due) { due.forEach(reminderBanner); });
      // Offline-first: register the service worker (relative path keeps
      // it working from a subfolder on any static host)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js').catch(function () { /* e.g. file:// — app still works */ });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
