// Eudaimonia web: every network request the app makes lives in this file.
// Ported from the extension's firebase-config.js (auth, flags, balance,
// callFn) and content.js (getPromotions with budget, the TTL'd pool cache).
//
// COMPLETE LIST OF REQUESTS
//   GET  firestore  config/featureFlags          (public read)
//   GET  firestore  config/blocklist             (public read, only when adding a pick)
//   GET  firestore  promotions                   (public read)
//   POST identitytoolkit accounts:signUp         (anonymous account, no body data)
//   POST securetoken token                       (refresh that anonymous account)
//   GET  firestore  users/{uid}                  (own token balance, signed in)
//   POST functions  claim-onboarding   {}                       (signed in)
//   POST functions  earn-checkin       { responses: n }         (signed in)
//   POST functions  record-click       { promoId }
//   POST functions  record-glad        { promoId, answer }      (new on web)
//   POST functions  aggregate-keywords { moveToward, moveAway, dailyHabits,
//                                        productCategories }    (only if sharing is on)
//   POST functions  check-url          { url }                  (adding a pick)
//   POST functions  spend   { action:'promote', url, title, description,
//                             keywords, email, isFirstPromotion } (signed in)
// Nothing else. The page's CSP (connect-src) enforces that list at the
// browser level. The email is sent once, with the first pick only, exactly
// as the extension does: spend stores a one-way SHA-256 of it (anti-spam
// dedup) and never the address. Every other request carries no email.
//
// Every call here is best-effort: it resolves with a value or null/false and
// never throws to the caller, and every fetch has a timeout, so a blocked
// network can slow a page down but can't hang or break it.
var EudApi = (function () {
  'use strict';

  var FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/eudaimonia-350ce/databases/(default)/documents';
  var FIREBASE_API_KEY = 'AIzaSyBBK2zeQBWA7Gxfb-d4XUvhk3QDdAfdpQU'; // public web key, same as the extension
  var PROD_FUNCTIONS = 'https://eudaimonia-project.netlify.app/.netlify/functions';

  // On Netlify (production or a deploy preview) use the functions deployed
  // with THIS build, so a preview exercises its own record-glad. Anywhere
  // else (localhost, file://) fall back to production, which allows any origin.
  var FUNCTIONS_BASE = (location.protocol === 'https:' && /\.netlify\.app$/.test(location.hostname))
    ? '/.netlify/functions'
    : PROD_FUNCTIONS;

  var TIMEOUT_MS = 9000;
  var FLAGS_CACHE_MS = 5 * 60 * 1000;
  var POOL_TTL_MS = 45 * 60 * 1000; // same as SIDEBAR_CACHE_TTL_MS in content.js

  var flags = null;
  var flagsFetchedAt = 0;
  var authInFlight = null;
  var poolRefreshing = null;

  function timedFetch(url, options) {
    var opts = options || {};
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).finally(function () { if (timer) clearTimeout(timer); });
  }

  // ─── Feature flags ────────────────────────────────────────────────────────
  function getDefaultFlags() {
    return {
      promotionDisplay: 'title',
      tokenEarningRate: 2,
      setupTokenReward: 10,
      checkInFrequency: 'weekly',
      showKeywordsInPromo: true,
      authSystem: 'anonymous',
      requireInvites: true
    };
  }

  async function getFeatureFlags() {
    var now = Date.now();
    if (flags && (now - flagsFetchedAt) < FLAGS_CACHE_MS) return flags;
    try {
      var res = await timedFetch(FIRESTORE_URL + '/config/featureFlags');
      if (!res.ok) return getDefaultFlags();
      var f = (await res.json()).fields || {};
      flags = {
        promotionDisplay: (f.promotionDisplay && f.promotionDisplay.stringValue) || 'title',
        tokenEarningRate: parseInt((f.tokenEarningRate && f.tokenEarningRate.integerValue) || '2', 10),
        setupTokenReward: parseInt((f.setupTokenReward && f.setupTokenReward.integerValue) || '10', 10),
        checkInFrequency: (f.checkInFrequency && f.checkInFrequency.stringValue) || 'weekly',
        showKeywordsInPromo: !(f.showKeywordsInPromo && f.showKeywordsInPromo.booleanValue === false),
        authSystem: (f.authSystem && f.authSystem.stringValue) || 'anonymous',
        requireInvites: !(f.requireInvites && f.requireInvites.booleanValue === false)
      };
      flagsFetchedAt = now;
      return flags;
    } catch (e) {
      return getDefaultFlags();
    }
  }

  // ─── Anonymous auth (same three-step logic as the extension) ──────────────
  // 1. unexpired token -> reuse   2. refresh token -> refresh, SAME uid
  // 3. otherwise sign up a new anonymous account.
  // Concurrent callers share one in-flight promise: two views asking at once
  // must not mint two accounts.
  function ensureAuthenticated() {
    if (authInFlight) return authInFlight;
    authInFlight = doAuth().finally(function () { authInFlight = null; });
    return authInFlight;
  }

  async function doAuth() {
    var f = await getFeatureFlags();
    if (f.authSystem === 'none') return null;

    var d = EudStore.getMany(['authToken', 'userId', 'tokenExpiry', 'refreshToken']);
    var now = Date.now();

    if (d.authToken && d.userId && d.tokenExpiry && d.tokenExpiry > now + 60000) {
      return { uid: d.userId, token: d.authToken };
    }

    if (d.refreshToken && d.userId) {
      try {
        var r = await timedFetch('https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(d.refreshToken)
        });
        var rd = await r.json();
        if (rd.id_token) {
          EudStore.setMany({
            authToken: rd.id_token,
            userId: rd.user_id,
            refreshToken: rd.refresh_token,
            tokenExpiry: now + parseInt(rd.expires_in || '3600', 10) * 1000
          });
          return { uid: rd.user_id, token: rd.id_token };
        }
      } catch (e) {
        // A network failure here must NOT fall through to sign-up: that would
        // orphan the existing account and its tokens over a flaky connection.
        return null;
      }
    }

    try {
      var res = await timedFetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FIREBASE_API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      });
      var a = await res.json();
      if (!a.idToken) {
        console.warn('Eudaimonia: anonymous sign-in refused:', a && a.error && a.error.message);
        return null;
      }
      EudStore.setMany({
        authToken: a.idToken,
        userId: a.localId,
        refreshToken: a.refreshToken,
        tokenExpiry: now + parseInt(a.expiresIn || '3600', 10) * 1000
      });
      return { uid: a.localId, token: a.idToken };
    } catch (e) {
      return null;
    }
  }

  // ─── Netlify functions ────────────────────────────────────────────────────
  // Signed-in call. Resolves { ok:true, data } or { ok:false, code }.
  async function callFn(name, body) {
    try {
      var user = await ensureAuthenticated();
      if (!user) return { ok: false, code: 'AUTH_REQUIRED' };
      var res = await timedFetch(FUNCTIONS_BASE + '/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + user.token },
        body: JSON.stringify(body || {})
      });
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, code: data.error || ('HTTP_' + res.status) };
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, code: 'NETWORK' };
    }
  }

  // Open (unauthenticated) call. keepalive lets the request finish even if
  // the tab is backgrounded or closed right after a tap.
  async function openFn(name, body) {
    try {
      var res = await timedFetch(FUNCTIONS_BASE + '/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        keepalive: true
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function recordClick(promoId) { return openFn('record-click', { promoId: promoId }); }
  // Resolves true once the count is settled: recorded, or the promotion no
  // longer exists (404), in which case retrying could never succeed.
  async function recordGlad(promoId, answer) {
    try {
      var res = await timedFetch(FUNCTIONS_BASE + '/record-glad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promoId: promoId, answer: answer }),
        keepalive: true
      });
      return res.ok || res.status === 404;
    } catch (e) {
      return false;
    }
  }
  function aggregateKeywords(profile) {
    return openFn('aggregate-keywords', {
      moveToward: profile.moveToward || '',
      moveAway: profile.moveAway || '',
      dailyHabits: profile.dailyHabits || '',
      productCategories: profile.productCategories || ''
    });
  }
  // ─── Adding a pick ────────────────────────────────────────────────────────
  // Blocklist terms, lowercased. [] if unreachable: the server checks again.
  async function getBlocklist() {
    try {
      var res = await timedFetch(FIRESTORE_URL + '/config/blocklist');
      if (!res.ok) return [];
      var data = await res.json();
      var vals = (data.fields && data.fields.terms && data.fields.terms.arrayValue && data.fields.terms.arrayValue.values) || [];
      return vals.map(function (v) { return String(v.stringValue || '').toLowerCase(); }).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // Safe Browsing via check-url. Resolves { unsafe, threatType } and fails
  // open ({ unsafe:false }) when the lookup can't run, as the extension does.
  async function checkUrl(url) {
    try {
      var res = await timedFetch(FUNCTIONS_BASE + '/check-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      if (!res.ok) return { unsafe: false };
      var d = await res.json();
      return { unsafe: !!d.unsafe, threatType: d.threatType || '' };
    } catch (e) {
      return { unsafe: false };
    }
  }

  // Spends one token server-side and creates the promotion in one transaction.
  // Resolves { ok:true, data:{ promoId, balance } } or { ok:false, code }.
  async function promote(p, isFirst) {
    var r = await callFn('spend', {
      action: 'promote',
      url: p.url,
      title: p.title,
      description: p.description,
      keywords: p.keywords,
      email: isFirst ? (p.email || '') : '',
      isFirstPromotion: !!isFirst
    });
    if (r.ok && typeof r.data.balance === 'number') EudStore.set('cachedBalance', r.data.balance);
    return r;
  }

  function claimOnboarding() { return callFn('claim-onboarding', {}); }
  function earnCheckin(responses) { return callFn('earn-checkin', { responses: responses }); }

  // Canonical balance from users/{uid}; falls back to the last value seen.
  async function getBalance() {
    try {
      var user = await ensureAuthenticated();
      if (!user) return { tokens: EudStore.get('cachedBalance', 0), live: false };
      var res = await timedFetch(FIRESTORE_URL + '/users/' + user.uid, {
        headers: { 'Authorization': 'Bearer ' + user.token }
      });
      if (!res.ok) return { tokens: EudStore.get('cachedBalance', 0), live: false };
      var data = await res.json();
      var tokens = parseInt((data.fields && data.fields.tokens && data.fields.tokens.integerValue) || '0', 10);
      EudStore.set('cachedBalance', tokens);
      return { tokens: tokens, live: true };
    } catch (e) {
      return { tokens: EudStore.get('cachedBalance', 0), live: false };
    }
  }

  // ─── Promotions ───────────────────────────────────────────────────────────
  // Returns an array, or null when the request itself failed (so the page can
  // tell "nothing shared yet" apart from "couldn't reach the server").
  async function fetchPromotions() {
    try {
      // Explicit pageSize so a growing pool can't be cut off at a page
      // boundary (today all 72 promotions arrive in one page either way).
      var res = await timedFetch(FIRESTORE_URL + '/promotions?pageSize=300');
      if (!res.ok) return null;
      var data = await res.json();
      if (!data.documents) return [];
      return data.documents.map(function (doc) {
        var f = doc.fields || {};
        var int = function (v) { return parseInt((v && v.integerValue) || '0', 10) || 0; };
        var vals = (f.keywords && f.keywords.arrayValue && f.keywords.arrayValue.values) || [];
        return {
          id: doc.name.split('/').pop(),
          url: (f.url && f.url.stringValue) || '',
          title: (f.title && f.title.stringValue) || '',
          description: (f.description && f.description.stringValue) || '',
          keywords: vals.map(function (v) { return v.stringValue; }).filter(Boolean),
          timestamp: (f.timestamp && f.timestamp.stringValue) || '',
          cost: int(f.cost),
          budget: int(f.budget),
          clicks: int(f.clicks),
          gladYes: int(f.gladYes),
          gladNo: int(f.gladNo)
        };
      });
    } catch (e) {
      return null;
    }
  }

  // TTL'd pool, same policy as the extension: fresh cache -> serve; stale ->
  // serve now and refresh behind; none -> fetch. Resolves
  // { promos, state } where state is 'fresh' | 'stale' | 'offline-cache' | 'failed'.
  async function getPromotionPool(forceRefresh) {
    var cache = EudStore.get('promoPoolCache', null);
    var hasCache = cache && Array.isArray(cache.promos);
    var age = hasCache ? Date.now() - (cache.cachedAt || 0) : Infinity;

    if (hasCache && !forceRefresh && age < POOL_TTL_MS) return { promos: cache.promos, state: 'fresh' };
    if (hasCache && !forceRefresh) {
      refreshPool();
      return { promos: cache.promos, state: 'stale' };
    }
    var promos = await refreshPool();
    if (promos) return { promos: promos, state: 'fresh' };
    if (hasCache) return { promos: cache.promos, state: 'offline-cache' };
    return { promos: [], state: 'failed' };
  }

  function refreshPool() {
    if (poolRefreshing) return poolRefreshing;
    poolRefreshing = fetchPromotions().then(function (promos) {
      if (promos) EudStore.set('promoPoolCache', { promos: promos, cachedAt: Date.now() });
      return promos;
    }).finally(function () { poolRefreshing = null; });
    return poolRefreshing;
  }

  return {
    getFeatureFlags: getFeatureFlags,
    getDefaultFlags: getDefaultFlags,
    ensureAuthenticated: ensureAuthenticated,
    getBalance: getBalance,
    getPromotionPool: getPromotionPool,
    recordClick: recordClick,
    recordGlad: recordGlad,
    aggregateKeywords: aggregateKeywords,
    claimOnboarding: claimOnboarding,
    earnCheckin: earnCheckin,
    getBlocklist: getBlocklist,
    checkUrl: checkUrl,
    promote: promote
  };
})();
