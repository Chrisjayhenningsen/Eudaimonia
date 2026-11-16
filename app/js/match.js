// Eudaimonia web: matching and ranking. Pure functions, no DOM, no network,
// so they run under node for tests (see app/tests/logic.test.js).
//
// matchPromotions() is the extension's function from content.js, unchanged in
// behaviour. rankPicks() adds the web's ordering on top:
//   1. match score (higher first)            - relevance always wins
//   2. smoothed glad rate (higher first)     - only breaks score ties
//   3. exposure rotation                     - picks shown 3 times without
//      being opened sink below fresher ones (same as the extension sidebar)
var EudMatch = (function () {
  'use strict';

  var POOL_SIZE = 25;       // SIDEBAR_POOL_SIZE
  var EXPOSURE_LIMIT = 3;   // SIDEBAR_EXPOSURE_LIMIT

  // Smoothed glad rate: (yes + 2) / (yes + no + 4).
  // A pick with no votes sits at 0.5. The +2/+4 act like two imaginary yes
  // votes and two imaginary no votes, so one early vote can't swing a pick to
  // 0% or 100%; it takes roughly four real votes to move it much.
  var PRIOR_YES = 2;
  var PRIOR_TOTAL = 4;

  function gladRate(promo) {
    var yes = Math.max(0, promo.gladYes || 0);
    var no = Math.max(0, promo.gladNo || 0);
    return (yes + PRIOR_YES) / (yes + no + PRIOR_TOTAL);
  }

  // ── Verbatim logic from content.js matchPromotions() ──
  function matchPromotions(promotions, positiveGoalsText, negativeKeywordsText) {
    if (!promotions || promotions.length === 0) return [];

    var negativeWords = negativeKeywordsText
      .split(/[\s,]+/)
      .filter(function (w) { return w.length > 3; })
      .map(function (w) { return w.toLowerCase().trim(); });

    var scored = promotions
      .filter(function (promo) { return (promo.budget || 0) > 0; })
      .map(function (promo) {
        var score = 0;

        promo.keywords.forEach(function (keyword) {
          if (positiveGoalsText.includes(keyword)) score += 1;
        });

        var promoText = (promo.title + ' ' + promo.description).toLowerCase();
        var promoWords = promoText.split(/[\s,]+/).filter(function (w) { return w.length > 4; });

        promoWords.forEach(function (word) {
          if (positiveGoalsText.includes(word)) score += 0.5;
        });

        negativeWords.forEach(function (negWord) {
          if (promoText.includes(negWord)) score -= 10;
        });

        promo.keywords.forEach(function (keyword) {
          if (negativeKeywordsText.includes(keyword)) score -= 10;
        });

        return Object.assign({}, promo, { score: score });
      });

    return scored
      .filter(function (p) { return p.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, POOL_SIZE);
  }

  // ── Verbatim logic from content.js applyExposureRotation() ──
  function applyExposureRotation(ranked, exposures) {
    var fresh = [], tired = [];
    ranked.forEach(function (p) {
      ((exposures[p.id] || 0) >= EXPOSURE_LIMIT ? tired : fresh).push(p);
    });
    return fresh.concat(tired);
  }

  function goalsText(profile) {
    return [profile.moveToward || '', profile.dailyHabits || '', profile.productCategories || '']
      .join(' ').toLowerCase();
  }

  function rankPicks(promotions, profile, exposures) {
    var matched = matchPromotions(promotions, goalsText(profile), (profile.moveAway || '').toLowerCase());
    // Array.prototype.sort is stable, so equal score + equal glad rate keeps
    // the order matchPromotions produced.
    matched.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return gladRate(b) - gladRate(a);
    });
    return applyExposureRotation(matched, exposures || {});
  }

  // Picks that could still pay for a click but didn't match. Shown, clearly
  // labelled, only when nothing matched, so a first visit isn't a dead end.
  function unmatchedPicks(promotions, matched) {
    var seen = {};
    (matched || []).forEach(function (p) { seen[p.id] = true; });
    return (promotions || [])
      .filter(function (p) { return (p.budget || 0) > 0 && !seen[p.id]; })
      .sort(function (a, b) { return gladRate(b) - gladRate(a); });
  }

  var api = {
    matchPromotions: matchPromotions,
    applyExposureRotation: applyExposureRotation,
    rankPicks: rankPicks,
    unmatchedPicks: unmatchedPicks,
    gladRate: gladRate,
    goalsText: goalsText,
    EXPOSURE_LIMIT: EXPOSURE_LIMIT
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
