// Eudaimonia web: views and wiring. One page, five views switched by the URL
// hash (#/start, #/picks, #/checkin, #/profile, #/add) so links such as a
// future calendar reminder can point straight at #/checkin.
//
// Order of work on every action: save to the device first, show the result,
// then talk to the network. Nothing on screen ever waits on a request that
// could be blocked.
(function () {
  'use strict';

  var VISIBLE_PICKS = 8;
  var WINDOW_DAYS = { daily: 1, weekly: 7, biweekly: 14 };
  var FREQ_WORDS = { daily: 'once a day', weekly: 'once a week', biweekly: 'once every two weeks' };
  var PROFILE_KEYS = ['moveToward', 'moveAway', 'dailyHabits', 'productCategories'];
  var ALL_KEYS = PROFILE_KEYS.concat([
    'setupComplete', 'setupDate', 'lastCheckin', 'checkinHistory', 'shareKeywords', 'promoterEmail',
    'authToken', 'userId', 'refreshToken', 'tokenExpiry', 'cachedBalance',
    'promoPoolCache', 'promoExposures', 'openedPicks', 'gladAnswered', 'myPromotions'
  ]);
  var VIEWS = ['start', 'picks', 'checkin', 'profile', 'add'];
  var TITLES = { start: 'Eudaimonia', picks: 'Picks · Eudaimonia', checkin: 'Check-in · Eudaimonia', profile: 'Profile · Eudaimonia', add: 'Add a pick · Eudaimonia' };

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var exposuresBumped = false; // count one exposure per page load, not per tab switch
  var lastClickAt = {};
  var firstRoute = true;
  var checkinCtx = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function show(node, on) { node.hidden = !on; }
  function getProfile() { return EudStore.getMany(PROFILE_KEYS); }
  function lines(text) { return (text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }

  // ─── Router ───────────────────────────────────────────────────────────────
  function route() {
    var name = (location.hash || '').replace(/^#\/?/, '') || 'picks';
    var ready = !!EudStore.get('setupComplete', false);
    if (!ready) name = 'start';
    else if (name === 'start' || !TITLES[name]) name = 'picks';

    VIEWS.forEach(function (v) { show($('view-' + v), v === name); });
    show($('nav'), ready);
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = TITLES[name];

    if (name === 'picks') renderPicks();
    if (name === 'checkin') renderCheckin();
    if (name === 'profile') renderProfile();
    if (name === 'add') renderAdd();

    if (!firstRoute) {
      window.scrollTo(0, 0);
      var h = $('view-' + name).querySelector('h1');
      if (h) h.focus();
    }
    firstRoute = false;
  }

  function go(name) {
    if (location.hash === '#/' + name) route();
    else location.hash = '#/' + name;
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  function submitStart() {
    var text = $('startGoals').value.trim();
    if (text.length < 3) {
      show($('startError'), true);
      $('startGoals').focus();
      return;
    }
    var email = $('startEmail').value.trim();
    if (email && !EMAIL_RE.test(email)) {
      show($('startEmailError'), true);
      $('startEmail').focus();
      return;
    }
    if (email) EudStore.set('promoterEmail', email); // device only; never sent
    var share = $('startShare').checked;
    EudStore.setMany({
      moveToward: text,
      shareKeywords: share,
      setupComplete: true,
      setupDate: new Date().toISOString()
    });
    go('picks');

    // After the page has moved on. Both are best-effort; this is a single
    // page, so there is no navigation to cut them off.
    if (share) EudApi.aggregateKeywords(getProfile());
    EudApi.claimOnboarding();
  }

  // ─── Picks ────────────────────────────────────────────────────────────────
  function safeUrl(url) {
    try {
      var u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (e) { return null; }
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function onPickOpened(promo) {
    // Synchronous, inside the tap itself. The card is a real link, so the
    // browser opens the tab; nothing here is awaited first (awaiting before
    // window.open is what gets a tab blocked as a pop-up on phones).
    var now = Date.now();
    if (lastClickAt[promo.id] && now - lastClickAt[promo.id] < 10000) return; // double-tap
    lastClickAt[promo.id] = now;

    EudGlad.noteOpened(EudStore, promo);
    var ex = EudStore.get('promoExposures', {});
    if (ex[promo.id]) { delete ex[promo.id]; EudStore.set('promoExposures', ex); }
    EudApi.recordClick(promo.id); // keepalive request; survives the tab switch
  }

  // `preview` builds an inert copy (no link, no click counting) for the
  // add-a-pick form.
  function buildCard(promo, flags, preview) {
    var href = safeUrl(promo.url);
    var kids = [];
    if (flags.promotionDisplay === 'url' && domainOf(promo.url)) {
      kids.push(el('div', { class: 'card-domain', text: domainOf(promo.url) }));
    }
    kids.push(el('h3', { class: 'card-title', text: promo.title || domainOf(promo.url) || 'Untitled pick' }));
    if (promo.description) kids.push(el('p', { class: 'card-desc', text: promo.description }));

    var meta = el('div', { class: 'card-meta' });
    if (flags.showKeywordsInPromo) {
      (promo.keywords || []).slice(0, 4).forEach(function (k) { meta.appendChild(el('span', { class: 'tag', text: k })); });
    }
    if (href) meta.appendChild(el('span', { class: 'card-open', text: 'Open ↗' }));
    kids.push(meta);

    if (!href || preview) return el('div', { class: 'card' }, kids);

    var a = el('a', { class: 'card', href: href, target: '_blank', rel: 'noopener' }, kids);
    a.addEventListener('click', function () { onPickOpened(promo); });
    a.addEventListener('auxclick', function (e) { if (e.button === 1) onPickOpened(promo); });
    return a;
  }

  function bumpExposures(shownIds, poolIds) {
    if (exposuresBumped || !shownIds.length) return;
    exposuresBumped = true;
    var ex = EudStore.get('promoExposures', {});
    shownIds.forEach(function (id) { ex[id] = (ex[id] || 0) + 1; });
    var keep = {};
    poolIds.forEach(function (id) { keep[id] = true; });
    Object.keys(ex).forEach(function (id) { if (!keep[id]) delete ex[id]; });
    EudStore.set('promoExposures', ex);
  }

  function emptyState(title, body, action) {
    var box = $('picksEmpty');
    box.textContent = '';
    box.appendChild(el('h2', { text: title }));
    box.appendChild(el('p', { text: body }));
    if (action) box.appendChild(action);
    show(box, true);
  }

  async function renderPicks(forceRefresh) {
    var status = $('picksStatus');
    var list = $('picksList');
    list.textContent = '';
    $('picksOtherList').textContent = '';
    show($('picksEmpty'), false);
    show($('picksOther'), false);
    show($('picksFoot'), false);
    status.className = 'note';
    status.textContent = 'Finding your picks…';
    show(status, true);

    var results = await Promise.all([EudApi.getPromotionPool(!!forceRefresh), EudApi.getFeatureFlags()]);
    var pool = results[0], flags = results[1];
    if ($('view-picks').hidden) return; // the visitor moved on while this loaded

    // Your own picks are left out: opening one would spend your own budget.
    var mineIds = myPromoIds();
    var promos = pool.promos.filter(function (p) { return !mineIds[p.id]; });
    var ranked = EudMatch.rankPicks(promos, getProfile(), EudStore.get('promoExposures', {}));
    var shown = ranked.slice(0, VISIBLE_PICKS);

    if (pool.state === 'offline-cache') {
      status.className = 'note note-amber';
      status.textContent = "I couldn't reach the server just now, so these are the picks I saved last time.";
    } else {
      show(status, false);
    }

    if (pool.state === 'failed') {
      var retry = el('button', { class: 'btn', type: 'button', text: 'Try again' });
      retry.addEventListener('click', function () { renderPicks(true); });
      emptyState("I couldn't load any picks",
        'The request to the server failed. That is usually a network, VPN or content-blocker issue. Your goals are saved on this device, so nothing is lost.',
        retry);
      return;
    }

    if (shown.length) {
      shown.forEach(function (p) { list.appendChild(buildCard(p, flags)); });
      show($('picksFoot'), true);
      bumpExposures(shown.map(function (p) { return p.id; }), pool.promos.map(function (p) { return p.id; }));
      return;
    }

    var others = EudMatch.unmatchedPicks(promos, ranked).slice(0, VISIBLE_PICKS);
    if (!others.length) {
      emptyState('Nothing has been shared yet',
        "There are no picks with any budget left right now. This fills up as people share things they've found useful, so it's worth looking again in a few days.");
      return;
    }
    emptyState('Nothing matches what you wrote yet',
      "I match on the words in your goals, so naming a few products or services you'd find useful usually helps.",
      el('a', { class: 'btn', href: '#/profile', text: 'Improve my matches' }));
    others.forEach(function (p) { $('picksOtherList').appendChild(buildCard(p, flags)); });
    show($('picksOther'), true);
    show($('picksFoot'), true);
  }

  // ─── Weekly check-in ──────────────────────────────────────────────────────
  // Ported from the extension's checkin.js. The extension checks in on the
  // habit list (dailyHabits). The web asks one question, so when no separate
  // habit list exists each line of that first answer becomes a check-in item.
  function checkinItems() {
    var p = getProfile();
    var habits = lines(p.dailyHabits);
    if (habits.length) return { source: 'dailyHabits', items: habits, moveToward: p.moveToward || '' };
    return { source: 'moveToward', items: lines(p.moveToward), moveToward: p.moveToward || '' };
  }

  function canEarnTokens(lastCheckin, frequency) {
    if (!lastCheckin) return true;
    var days = (Date.now() - new Date(lastCheckin).getTime()) / 86400000;
    return days >= (WINDOW_DAYS[frequency] || 7);
  }

  function choice(name, id, value, label) {
    var input = el('input', { type: 'radio', name: name, id: id, value: value });
    return { input: input, node: el('label', { class: 'choice', for: id }, [input, el('span', { text: label })]) };
  }

  function buildSystemItem(text, index, ctx) {
    var fs = el('fieldset', { class: 'system-item' }, [el('legend', { text: text })]);
    var done = choice('system-' + index, 'sys-done-' + index, 'completed', 'Did it');
    var trouble = choice('system-' + index, 'sys-trouble-' + index, 'trouble', 'Ran into trouble');
    fs.appendChild(el('div', { class: 'choice-row' }, [done.node, trouble.node]));

    var reflect = el('div', { class: 'reflect', hidden: '' });
    var ta = el('textarea', { id: 'reflect-' + index, rows: '3' });
    var label = el('label', { for: 'reflect-' + index, text: 'What would work better? Edit the line and I\'ll replace it.' });

    if (ctx.source === 'dailyHabits') {
      // Same two options as the extension: change the habit, or the goal.
      var sys = choice('adjust-' + index, 'adjust-system-' + index, 'system', 'Adjust this habit');
      var goal = choice('adjust-' + index, 'adjust-goal-' + index, 'goal', 'Adjust my goals');
      sys.input.checked = true;
      sys.input.addEventListener('change', function () {
        label.textContent = 'What would work better? Edit the line and I\'ll replace it.';
        ta.value = text;
      });
      goal.input.addEventListener('change', function () {
        label.textContent = 'Edit your goals. What you save replaces the current version.';
        ta.value = ctx.moveToward;
      });
      reflect.appendChild(el('div', { class: 'choice-row' }, [sys.node, goal.node]));
    }
    reflect.appendChild(label);
    reflect.appendChild(ta);
    fs.appendChild(reflect);

    done.input.addEventListener('change', function () { reflect.hidden = true; });
    trouble.input.addEventListener('change', function () {
      reflect.hidden = false;
      if (!ta.value) ta.value = text;
    });
    return fs;
  }

  async function renderCheckin() {
    show($('checkinForm'), true);
    show($('checkinDone'), false);
    $('checkinSave').disabled = false;
    $('checkinSave').textContent = 'Save check-in';

    var ctx = checkinItems();
    checkinCtx = ctx;
    var list = $('systemsList');
    list.textContent = '';
    ctx.items.forEach(function (text, i) { list.appendChild(buildSystemItem(text, i, ctx)); });
    show($('systemsHeading'), ctx.items.length > 0);

    var pending = await EudGlad.pending(EudStore);
    EudGlad.render($('gladList'), pending);
    show($('gladSection'), pending.length > 0);

    var msg = $('tokenMessage');
    msg.textContent = 'You can check in any time.';
    var flags = await EudApi.getFeatureFlags();
    var freq = FREQ_WORDS[flags.checkInFrequency] || FREQ_WORDS.weekly;
    if (canEarnTokens(EudStore.get('lastCheckin', null), flags.checkInFrequency)) {
      msg.textContent = 'This check-in earns ' + flags.tokenEarningRate + ' tokens for each line you answer. ' +
        "Tokens pay for sharing a pick of your own. You can't spend them on the web yet; that comes later.";
    } else {
      msg.textContent = 'You can check in any time. Tokens are earned ' + freq + ', and you have already earned yours.';
    }
  }

  async function saveCheckin() {
    var ctx = checkinCtx || checkinItems();
    var btn = $('checkinSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    var completed = 0, reflected = 0;
    var data = [];
    var updated = ctx.items.slice();
    var goalEdit = null;

    ctx.items.forEach(function (text, i) {
      var doneEl = $('sys-done-' + i), troubleEl = $('sys-trouble-' + i);
      if (doneEl && doneEl.checked) {
        completed++;
        data.push({ system: text, completed: true });
      } else if (troubleEl && troubleEl.checked) {
        reflected++;
        var adjustGoal = $('adjust-goal-' + i);
        var toGoal = !!(adjustGoal && adjustGoal.checked);
        var edit = ($('reflect-' + i).value || '').trim();
        data.push({ system: text, completed: false, adjustType: toGoal ? 'goal' : 'system', reflection: edit });
        if (edit) {
          if (toGoal) goalEdit = edit;
          else updated[i] = edit;
        }
      }
    });

    // 1. Save on the device first, so the check-in exists whatever the network does.
    var linesChanged = updated.some(function (s, i) { return s !== ctx.items[i]; });
    var update = { lastCheckin: new Date().toISOString() };
    update[ctx.source] = updated.join('\n');
    if (goalEdit && ctx.source === 'dailyHabits') update.moveToward = goalEdit;
    EudStore.setMany(update);

    // 2. Tokens (server decides the amount and enforces the weekly cadence)
    //    and glad counts. Both awaited here, before the result is shown.
    var answers = EudGlad.read($('gladList'));
    var outcome = await Promise.all([
      EudApi.earnCheckin(completed + reflected),
      EudGlad.settle(EudStore, answers, EudApi.recordGlad)
    ]);
    var earn = outcome[0], glad = outcome[1];
    var earned = (earn.ok && earn.data && earn.data.earned) || 0;

    var history = EudStore.get('checkinHistory', []);
    history.push({ date: update.lastCheckin, data: data, tokensEarned: earned });
    if (history.length > 10) history.shift();
    EudStore.set('checkinHistory', history);

    // 3. Say exactly what happened.
    var done = $('checkinDone');
    done.textContent = '';
    done.appendChild(el('p', { class: 'done-mark', text: 'Check-in saved on this device.' }));

    var tokenLine;
    if (!earn.ok) {
      tokenLine = "I couldn't reach the token server (a VPN or blocker can do this), so no tokens were added this time.";
    } else if (earned > 0) {
      tokenLine = 'You earned ' + earned + " tokens. You can't spend them on the web yet; that comes later.";
    } else if (completed + reflected === 0) {
      tokenLine = 'No tokens this time: they are earned per line you answer.';
    } else {
      tokenLine = "No tokens this time: you've already earned them for this period.";
    }
    done.appendChild(el('p', { text: tokenLine }));

    if (glad.sent > 0) {
      done.appendChild(el('p', { text: 'Thank you. ' + glad.sent + (glad.sent === 1 ? ' answer was' : ' answers were') + ' counted anonymously.' }));
    }
    if (glad.unsent > 0) {
      done.appendChild(el('p', { text: "I couldn't send " + glad.unsent + (glad.unsent === 1 ? ' answer' : ' answers') + " about your picks. They're kept here and I'll try again next time you open this page." }));
    }
    if (linesChanged || update.moveToward) {
      done.appendChild(el('p', { text: 'Your goals have been updated, and your picks will follow.' }));
      if (EudStore.get('shareKeywords', false)) EudApi.aggregateKeywords(getProfile());
    }
    done.appendChild(el('div', { class: 'actions' }, [el('a', { class: 'btn btn-fill', href: '#/picks', text: 'Back to my picks' })]));

    show($('checkinForm'), false);
    show(done, true);
    $('checkinTitle').focus();
  }

  // ─── Profile ──────────────────────────────────────────────────────────────
  function renderProfile() {
    var p = getProfile();
    $('pGoals').value = p.moveToward || '';
    $('pAway').value = p.moveAway || '';
    $('pProducts').value = p.productCategories || '';
    $('pHabits').value = p.dailyHabits || '';
    $('pShare').checked = !!EudStore.get('shareKeywords', false);
    show($('profileStatus'), false);
    show($('pEmailError'), false);

    var email = EudStore.get('promoterEmail', '');
    $('pEmail').value = email;
    showPromoterPanel(!!email || EudStore.get('myPromotions', []).length > 0);
  }

  function saveProfile() {
    var goals = $('pGoals').value.trim();
    if (goals.length < 3) {
      var st = $('profileStatus');
      st.className = 'note note-amber';
      st.textContent = 'I need at least a few words in the first box to match anything.';
      show(st, true);
      $('pGoals').focus();
      return;
    }
    var share = $('pShare').checked;
    EudStore.setMany({
      moveToward: goals,
      moveAway: $('pAway').value.trim(),
      productCategories: $('pProducts').value.trim(),
      dailyHabits: $('pHabits').value.trim(),
      shareKeywords: share
    });
    if (share) EudApi.aggregateKeywords(getProfile());
    go('picks');
  }

  async function showPromoterPanel(on) {
    show($('promoterPanel'), on);
    if (!on) return;
    var line = $('balanceLine');
    line.textContent = 'Checking your tokens…';
    var b = await EudApi.getBalance();
    line.textContent = b.live
      ? 'You have ' + b.tokens + (b.tokens === 1 ? ' token' : ' tokens') + ' on this device\'s anonymous sign-in.'
      : "I couldn't check your tokens just now (sign-in may be blocked by a VPN). Last known: " + b.tokens + '.';
    renderMyPicks();
  }

  function myPromoIds() {
    var ids = {};
    EudStore.get('myPromotions', []).forEach(function (p) { if (p.id) ids[p.id] = true; });
    return ids;
  }

  async function renderMyPicks() {
    var mine = EudStore.get('myPromotions', []);
    show($('myPicks'), mine.length > 0);
    if (!mine.length) return;
    var pool = await EudApi.getPromotionPool(false);
    var byId = {};
    pool.promos.forEach(function (p) { byId[p.id] = p; });
    var list = $('myPicksList');
    list.textContent = '';
    mine.slice().reverse().forEach(function (m) {
      var live = byId[m.id];
      var line;
      if (live) {
        line = live.clicks + (live.clicks === 1 ? ' open' : ' opens') + ' · ' +
          (live.budget > 0 ? live.budget + ' left in budget' : 'budget used up, so it isn\'t being shown');
        var votes = live.gladYes + live.gladNo;
        if (votes) line += ' · ' + live.gladYes + ' of ' + votes + ' glad they tried it';
      } else if (Date.now() - Date.parse(m.timestamp || 0) < 2 * 60 * 60 * 1000) {
        line = 'Just added. Counts show up after the next refresh.';
      } else {
        line = 'Not in the current list.';
      }
      list.appendChild(el('li', {}, [el('strong', { text: m.title || m.url }), el('span', { text: line })]));
    });
  }

  // ─── Add a pick ───────────────────────────────────────────────────────────
  // Same checks and order as the extension's promote.js: local validation,
  // blocklist, Safe Browsing (fails open), then one server-side spend that
  // creates the promotion and debits the token together.
  var adding = false;
  var urlChecks = {};       // href -> Promise<{unsafe, threatType}>, per page load
  var duplicateArmed = '';  // href the person has been warned about once
  var addFlags = null;
  var ADD_FIELDS = { url: 'aUrl', title: 'aTitle', description: 'aDesc', keywords: 'aKeywords', email: 'aEmail' };
  var ADD_ERRORS = { url: 'aUrlError', title: 'aTitleError', description: 'aDescError', keywords: 'aKeywordsError', email: 'aEmailError' };

  function addInput() {
    return { url: $('aUrl').value, title: $('aTitle').value, description: $('aDesc').value, keywords: $('aKeywords').value, email: $('aEmail').value };
  }

  function setAddStatus(text, amber) {
    var st = $('addStatus');
    st.className = amber ? 'note note-amber' : 'note';
    st.textContent = text || '';
    show(st, !!text);
  }

  function showAddErrors(errors) {
    Object.keys(ADD_ERRORS).forEach(function (k) {
      var node = $(ADD_ERRORS[k]);
      node.textContent = errors[k] || '';
      show(node, !!errors[k]);
      if (errors[k]) $(ADD_FIELDS[k]).setAttribute('aria-invalid', 'true');
      else $(ADD_FIELDS[k]).removeAttribute('aria-invalid');
    });
  }

  function updatePreview() {
    var i = addInput();
    $('aTitleCount').textContent = i.title.length + ' / ' + EudPromote.TITLE_MAX;
    $('aDescCount').textContent = i.description.length + ' / ' + EudPromote.DESC_MAX;
    var box = $('aPreview');
    box.textContent = '';
    box.appendChild(buildCard({
      url: EudPromote.cleanUrl(i.url) || '',
      title: i.title.trim() || 'Your title',
      description: i.description.trim() || 'Why it\'s worth a look.',
      keywords: EudPromote.parseKeywords(i.keywords)
    }, addFlags || EudApi.getDefaultFlags(), true));
  }

  function checkUrlOnce(href) {
    if (!urlChecks[href]) urlChecks[href] = EudApi.checkUrl(href);
    return urlChecks[href];
  }

  async function onUrlBlur() {
    var href = EudPromote.cleanUrl($('aUrl').value);
    var note = $('aUrlCheck');
    if (!href) { show(note, false); return; }
    if (EudPromote.isBlockedDomain(href)) { showAddErrors({ url: 'This address can\'t be added.' }); return; }
    note.textContent = 'Checking this link with Google Safe Browsing…';
    show(note, true);
    var r = await checkUrlOnce(href);
    if (EudPromote.cleanUrl($('aUrl').value) !== href) return; // edited meanwhile
    show(note, false);
    if (r.unsafe) showAddErrors({ url: 'Google Safe Browsing flags this link as ' + (r.threatType || 'unsafe').replace(/_/g, ' ').toLowerCase() + ', so it can\'t be added.' });
  }

  async function showAddBalance() {
    var line = $('addBalance');
    line.className = 'note';
    line.textContent = 'Checking your tokens…';
    var b = await EudApi.getBalance();
    // The setup bonus may never have arrived (blocked at the time). Claiming
    // is once per sign-in on the server, so asking again is safe.
    if (b.live && b.tokens < EudPromote.COST) {
      var c = await EudApi.claimOnboarding();
      if (c.ok && c.data.granted) b = await EudApi.getBalance();
    }
    if (!b.live) {
      line.className = 'note note-amber';
      line.textContent = "I couldn't check your tokens just now (sign-in may be blocked by a VPN). You can still try; nothing is spent unless it goes through.";
    } else if (b.tokens < EudPromote.COST) {
      line.className = 'note note-amber';
      line.textContent = 'You have no tokens yet. A weekly check-in earns some.';
    } else {
      line.textContent = 'You have ' + b.tokens + (b.tokens === 1 ? ' token.' : ' tokens.');
    }
  }

  async function renderAdd() {
    if (adding) return;
    show($('addForm'), true);
    show($('addDone'), false);
    setAddStatus('');
    showAddErrors({});
    var first = EudStore.get('myPromotions', []).length === 0;
    show($('aEmailGroup'), first);
    if (first && !$('aEmail').value) $('aEmail').value = EudStore.get('promoterEmail', '');
    updatePreview();
    showAddBalance();
    addFlags = await EudApi.getFeatureFlags();
    updatePreview();
  }

  async function submitAdd() {
    if (adding) return;
    var mine = EudStore.get('myPromotions', []);
    var isFirst = mine.length === 0;
    var v = EudPromote.validate(addInput(), isFirst);
    showAddErrors(v.errors);
    setAddStatus('');
    if (!v.ok) {
      var firstBad = Object.keys(ADD_FIELDS).filter(function (k) { return v.errors[k]; })[0];
      $(ADD_FIELDS[firstBad]).focus();
      return;
    }
    var p = v.value;
    $('aUrl').value = p.url; // show the https:// that was assumed

    if (EudPromote.alreadyAdded(mine, p.url) && duplicateArmed !== p.url) {
      duplicateArmed = p.url;
      setAddStatus('You\'ve already added this link from this device. Tap the button again to add it again with a fresh token.', true);
      return;
    }

    var btn = $('addBtn');
    adding = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      var checks = await Promise.all([EudApi.getBlocklist(), checkUrlOnce(p.url)]);
      if (EudPromote.blocklistHit(checks[0], p.title, p.description, p.keywords)) {
        setAddStatus(EudPromote.errorMessage('BLOCKED_CONTENT'), true);
        return;
      }
      if (checks[1].unsafe) {
        showAddErrors({ url: 'Google Safe Browsing flags this link, so it can\'t be added.' });
        $('aUrl').focus();
        return;
      }

      btn.textContent = 'Adding…';
      var r = await EudApi.promote(p, isFirst);
      if (!r.ok) {
        if (r.code === 'Invalid URL') showAddErrors({ url: 'The server didn\'t accept that address.' });
        else setAddStatus(EudPromote.errorMessage(r.code), true);
        return;
      }

      // Saved on the device before anything else happens.
      mine.push({ id: r.data.promoId, url: p.url, title: p.title, timestamp: new Date().toISOString() });
      EudStore.set('myPromotions', mine);
      if (isFirst && p.email) EudStore.set('promoterEmail', p.email);
      duplicateArmed = '';
      ['aUrl', 'aTitle', 'aDesc', 'aKeywords'].forEach(function (id) { $(id).value = ''; });
      EudApi.getPromotionPool(true); // so the new pick is in the list next time

      var done = $('addDone');
      done.textContent = '';
      var left = r.data.balance;
      done.appendChild(el('p', { class: 'note note-green', text:
        'Your pick is live. People whose goals contain ' + p.keywords.map(function (k) { return '\u201c' + k + '\u201d'; }).join(', ') +
        ' will see it.' + (typeof left === 'number' ? ' You have ' + left + (left === 1 ? ' token' : ' tokens') + ' left.' : '') }));
      done.appendChild(el('div', { class: 'actions' }, [
        el('a', { class: 'btn btn-fill', href: '#/profile', text: 'See how it\'s doing' }),
        el('a', { class: 'btn', href: '#/picks', text: 'Back to my picks' })
      ]));
      var again = el('button', { class: 'btn', type: 'button', text: 'Add another' });
      again.addEventListener('click', function () { renderAdd(); $('aUrl').focus(); });
      done.lastChild.appendChild(again);
      show($('addForm'), false);
      show(done, true);
      $('addTitle').focus();
    } finally {
      adding = false;
      btn.disabled = false;
      btn.textContent = 'Add my pick for 1 token';
    }
  }

  function saveEmail() {
    var value = $('pEmail').value.trim();
    var ok = value === '' || EMAIL_RE.test(value);
    show($('pEmailError'), !ok);
    if (!ok) { $('pEmail').focus(); return; }
    if (value) EudStore.set('promoterEmail', value);
    else EudStore.remove('promoterEmail');
    showPromoterPanel(!!value);
  }

  var eraseArmedUntil = 0;
  function erase() {
    var btn = $('eraseBtn');
    if (Date.now() > eraseArmedUntil) {
      eraseArmedUntil = Date.now() + 6000;
      btn.textContent = 'Tap again to erase';
      setTimeout(function () { btn.textContent = 'Erase everything on this device'; eraseArmedUntil = 0; }, 6000);
      return;
    }
    ALL_KEYS.forEach(function (k) { EudStore.remove(k); });
    eraseArmedUntil = 0;
    btn.textContent = 'Erase everything on this device';
    $('startGoals').value = '';
    $('startEmail').value = '';
    $('aEmail').value = '';
    exposuresBumped = false;
    go('start');
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    show($('storageNote'), !EudStore.isPersistent());

    $('startBtn').addEventListener('click', submitStart);
    $('startGoals').addEventListener('input', function () { show($('startError'), false); });
    $('startEmail').addEventListener('input', function () { show($('startEmailError'), false); });
    $('checkinSave').addEventListener('click', saveCheckin);
    $('profileSave').addEventListener('click', saveProfile);
    $('emailSave').addEventListener('click', saveEmail);
    $('eraseBtn').addEventListener('click', erase);
    $('addBtn').addEventListener('click', submitAdd);
    $('aUrl').addEventListener('blur', onUrlBlur);
    ['aUrl', 'aTitle', 'aDesc', 'aKeywords'].forEach(function (id) { $(id).addEventListener('input', updatePreview); });

    window.addEventListener('hashchange', route);
    route();

    // Retry any glad answers that couldn't be sent last time.
    EudGlad.flush(EudStore, EudApi.recordGlad);
  });
})();
