// Eudaimonia web: adding a pick of your own. Pure logic only (no DOM, no
// network) so node can test it. Ported from the extension's promote.js:
// same flat cost, same field limits, same URL normalisation, same blocklist
// rule (case-insensitive substring over title + description + keywords).
// The server (spend function) re-checks everything; these checks exist to
// give a clear message before a token is at stake.
var EudPromote = (function () {
  'use strict';

  var COST = 1;          // keep in sync with spend.js PROMOTION_COST
  var TITLE_MAX = 80;    // same maxlength as the extension's form
  var DESC_MAX = 300;
  var KEYWORDS_MAX = 12;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Test domains the extension refuses even when Safe Browsing can't run.
  var BLOCKED_DOMAINS = [
    'malware.testing.google.test',
    'phishing.testing.google.test',
    'testsafebrowsing.appspot.com',
    'eicar.org'
  ];

  // Accepts "example.com/x" as well as full URLs; returns an http(s) href or null.
  function cleanUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    try {
      var u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (u.hostname.indexOf('.') < 1) return null;
      return u.href;
    } catch (e) { return null; }
  }

  function normalizeUrl(url) {
    try {
      var u = new URL(url);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    } catch (e) { return String(url || '').toLowerCase().trim(); }
  }

  function isBlockedDomain(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      return BLOCKED_DOMAINS.some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
    } catch (e) { return false; }
  }

  // "Running, 10k ,running" -> ['running', '10k']
  function parseKeywords(raw) {
    var seen = {};
    return String(raw || '').split(/[,\n]/)
      .map(function (k) { return k.trim().toLowerCase(); })
      .filter(function (k) {
        if (!k || seen[k]) return false;
        seen[k] = true;
        return true;
      })
      .slice(0, KEYWORDS_MAX);
  }

  function blocklistHit(terms, title, description, keywords) {
    if (!terms || !terms.length) return null;
    var combined = (title + ' ' + description + ' ' + (keywords || []).join(' ')).toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      var t = String(terms[i] || '').toLowerCase();
      if (t && combined.indexOf(t) !== -1) return t;
    }
    return null;
  }

  // Returns { ok, errors: {field: message}, value }. `isFirst` means this
  // device has never added a pick, so an email is required.
  function validate(input, isFirst) {
    var errors = {};
    var url = cleanUrl(input.url);
    var title = String(input.title || '').trim();
    var description = String(input.description || '').trim();
    var keywords = parseKeywords(input.keywords);
    var email = String(input.email || '').trim();

    if (!url) errors.url = 'That doesn\'t look like a web address. Try something like https://example.com';
    else if (isBlockedDomain(url)) errors.url = 'This address can\'t be added.';
    if (!title) errors.title = 'Give it a short title.';
    else if (title.length > TITLE_MAX) errors.title = 'Keep the title to ' + TITLE_MAX + ' characters.';
    if (!description) errors.description = 'Say in a sentence or two what it is and why it helped.';
    else if (description.length > DESC_MAX) errors.description = 'Keep this to ' + DESC_MAX + ' characters.';
    if (!keywords.length) errors.keywords = 'Add at least one word people might use for their goals.';
    if (isFirst && !EMAIL_RE.test(email)) errors.email = 'Your first pick needs a valid email address.';

    return {
      ok: Object.keys(errors).length === 0,
      errors: errors,
      value: { url: url, title: title, description: description, keywords: keywords, email: email }
    };
  }

  function alreadyAdded(myPromotions, url) {
    var n = normalizeUrl(url);
    return (myPromotions || []).some(function (p) { return normalizeUrl(p.url) === n; });
  }

  // Server error codes -> what to tell the person.
  function errorMessage(code) {
    switch (code) {
      case 'INSUFFICIENT_TOKENS': return 'You need ' + COST + ' token to add a pick. A weekly check-in earns more.';
      case 'BLOCKED_CONTENT': return 'This was stopped by the content filter. If you think that\'s a mistake, email chrisjayhenningsen@gmail.com.';
      case 'AUTH_REQUIRED': return 'I couldn\'t sign you in, so nothing was spent. A VPN or content blocker is the usual cause.';
      case 'NETWORK': return 'I couldn\'t reach the server, so nothing was spent. Try again in a moment.';
      case 'UNKNOWN': return 'I didn\'t hear back from the server and couldn\'t check whether your pick went through. Look under Your picks on the profile before trying again.';
      default: return 'That didn\'t go through, and nothing was spent. Try again in a moment.';
    }
  }

  var api = {
    COST: COST,
    TITLE_MAX: TITLE_MAX,
    DESC_MAX: DESC_MAX,
    cleanUrl: cleanUrl,
    normalizeUrl: normalizeUrl,
    isBlockedDomain: isBlockedDomain,
    parseKeywords: parseKeywords,
    blocklistHit: blocklistHit,
    validate: validate,
    alreadyAdded: alreadyAdded,
    errorMessage: errorMessage
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
