// Eudaimonia web: thin localStorage wrapper standing in for chrome.storage.
//
// Key names are identical to the extension's (moveToward, dailyHabits,
// lastCheckin, authToken, promoPoolCache ...) so code and data shapes port
// both ways. chrome.storage.sync and chrome.storage.local share one namespace
// here; no key name is used in both, so nothing collides.
//
// Values are JSON-encoded. If localStorage is unavailable (some private
// modes, blocked storage) everything falls back to memory and `persistent`
// turns false so the page can say honestly that nothing will be remembered.
//
// `var`, not const: this is a shared global read by several scripts.
var EudStore = (function () {
  'use strict';

  var mem = {};
  var persistent = true;

  try {
    var probe = '__eud_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch (e) {
    persistent = false;
  }

  function get(key, fallback) {
    try {
      var raw = persistent ? window.localStorage.getItem(key)
                           : (Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    var raw = JSON.stringify(value);
    if (persistent) {
      try {
        window.localStorage.setItem(key, raw);
        return true;
      } catch (e) {
        // Quota or a storage block that appeared mid-session: keep working
        // from memory rather than losing the write outright.
        persistent = false;
      }
    }
    mem[key] = raw;
    return false;
  }

  function remove(key) {
    try { if (persistent) window.localStorage.removeItem(key); } catch (e) {}
    delete mem[key];
  }

  // Mirrors chrome.storage.get([...]) -> { key: value } with absent keys omitted.
  function getMany(keys) {
    var out = {};
    keys.forEach(function (k) {
      var v = get(k, undefined);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  function setMany(obj) {
    Object.keys(obj).forEach(function (k) { set(k, obj[k]); });
  }

  return {
    get: get,
    set: set,
    remove: remove,
    getMany: getMany,
    setMany: setMany,
    isPersistent: function () { return persistent; }
  };
})();
