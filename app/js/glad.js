// Eudaimonia: "Glad you tried it?" - asked once per pick opened since the
// last check-in.
//
// WRITTEN TO BE BACK-PORTED. Nothing here knows about the web app. It needs:
//   store : { get(key, fallback), set(key, value) }  - may be sync or return
//           promises, so a chrome.storage adapter drops straight in
//   send  : async (promoId, 'yes' | 'no') => boolean - true once the count
//           is safely recorded
// To use it in the extension's check-in: call EudGlad.noteOpened() where the
// sidebar card is clicked, EudGlad.render() into checkin.html, and
// `await EudGlad.settle()` inside saveCheckin() BEFORE navigating away (an
// unawaited call before navigation silently loses the write).
//
// Storage (device only):
//   openedPicks  { [promoId]: { title, url, openedAt, deferrals, answer? } }
//   gladAnswered { [promoId]: 'yes' | 'no' }   never ask about these again
// Only anonymous yes/no counts leave the device, one increment per answer.
var EudGlad = (function () {
  'use strict';

  var MAX_DEFERRALS = 3; // "Haven't tried it yet" carries over this many check-ins

  async function noteOpened(store, promo) {
    var answered = await store.get('gladAnswered', {});
    if (answered[promo.id]) return;
    var opened = await store.get('openedPicks', {});
    if (!opened[promo.id]) {
      opened[promo.id] = { title: promo.title, url: promo.url, openedAt: new Date().toISOString(), deferrals: 0 };
      await store.set('openedPicks', opened);
    }
  }

  // Picks still waiting for an answer (not ones answered but unsent).
  async function pending(store) {
    var opened = await store.get('openedPicks', {});
    return Object.keys(opened)
      .filter(function (id) { return !opened[id].answer; })
      .map(function (id) { return { id: id, title: opened[id].title, url: opened[id].url }; });
  }

  function render(container, picks) {
    container.textContent = '';
    picks.forEach(function (pick, i) {
      var fs = document.createElement('fieldset');
      fs.className = 'glad-item';
      fs.dataset.promoId = pick.id;

      var legend = document.createElement('legend');
      legend.textContent = pick.title || 'A pick you opened';
      fs.appendChild(legend);

      var row = document.createElement('div');
      row.className = 'choice-row';
      [['yes', 'Yes'], ['no', 'No'], ['later', "Haven't tried it yet"]].forEach(function (opt) {
        var id = 'glad-' + i + '-' + opt[0];
        var label = document.createElement('label');
        label.className = 'choice';
        label.setAttribute('for', id);
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'glad-' + i;
        input.id = id;
        input.value = opt[0];
        var span = document.createElement('span');
        span.textContent = opt[1];
        label.appendChild(input);
        label.appendChild(span);
        row.appendChild(label);
      });
      fs.appendChild(row);
      container.appendChild(fs);
    });
  }

  // -> { [promoId]: 'yes' | 'no' | 'later' }   (unanswered picks are absent)
  function read(container) {
    var out = {};
    Array.prototype.forEach.call(container.querySelectorAll('.glad-item'), function (fs) {
      var checked = fs.querySelector('input:checked');
      if (checked) out[fs.dataset.promoId] = checked.value;
    });
    return out;
  }

  // Applies answers. Resolves { sent, unsent, deferred }.
  // yes/no  -> send the count. On success the pick is retired for good. On
  //            failure the answer is kept on the device and retried by flush().
  // later   -> ask again next check-in, up to MAX_DEFERRALS, then drop.
  // absent  -> untouched; it will simply be asked again.
  async function settle(store, answers, send) {
    var opened = await store.get('openedPicks', {});
    var answered = await store.get('gladAnswered', {});
    var result = { sent: 0, unsent: 0, deferred: 0 };

    var ids = Object.keys(answers);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], a = answers[id];
      if (!opened[id]) continue;
      if (a === 'later') {
        opened[id].deferrals = (opened[id].deferrals || 0) + 1;
        if (opened[id].deferrals >= MAX_DEFERRALS) delete opened[id];
        result.deferred++;
      } else if (a === 'yes' || a === 'no') {
        // Record the answer locally BEFORE the network call, so it can never
        // be asked twice even if the request dies midway.
        answered[id] = a;
        opened[id].answer = a;
      }
    }
    await store.set('gladAnswered', answered);
    await store.set('openedPicks', opened);

    var flushed = await flush(store, send);
    result.sent = flushed.sent;
    result.unsent = flushed.unsent;
    return result;
  }

  // Sends any answered-but-unsent counts. Safe to call on every page load.
  async function flush(store, send) {
    var opened = await store.get('openedPicks', {});
    var out = { sent: 0, unsent: 0 };
    var ids = Object.keys(opened).filter(function (id) { return opened[id].answer; });
    for (var i = 0; i < ids.length; i++) {
      var ok = false;
      try { ok = await send(ids[i], opened[ids[i]].answer); } catch (e) { ok = false; }
      if (ok) {
        delete opened[ids[i]];
        out.sent++;
      } else {
        // Give up after a few tries so a permanently failing count (for
        // example a promotion that has since been removed) can't retry forever.
        opened[ids[i]].tries = (opened[ids[i]].tries || 0) + 1;
        if (opened[ids[i]].tries >= 5) delete opened[ids[i]];
        out.unsent++;
      }
    }
    if (ids.length) await store.set('openedPicks', opened);
    return out;
  }

  var api = { noteOpened: noteOpened, pending: pending, render: render, read: read, settle: settle, flush: flush, MAX_DEFERRALS: MAX_DEFERRALS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
