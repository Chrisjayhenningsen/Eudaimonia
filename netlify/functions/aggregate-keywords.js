// Aggregates a user's setup keywords into the shared analytics doc
// (aggregations/keywords) — server-side, replacing the direct client PATCH in
// firebase-config.js (aggregateUserKeywords).
//
// No auth is required (same choice as record-click): this is called during
// setup, where an authenticated token isn't guaranteed (first run / VPN), and
// it writes ONLY anonymized keyword counts — nothing tied to a uid, goals, or
// any profile. The read-modify-write runs in a transaction so concurrent
// setups can't clobber each other's counts.
//
// NOTE: being open, this endpoint is spammable to inflate keyword counts —
// the same accepted-for-launch tradeoff as record-click. Add rate-limiting
// (per-IP per-window) later if the aggregation ever feeds anything load-bearing.

const { db, json, preflight } = require('./_admin');

// ─── Keyword extraction ───────────────────────────────────────────────────────
// Moved here from the client so the counting logic is server-authoritative and
// lives in one place. Kept byte-for-byte equivalent to the old client version:
// lowercase, split on newlines/commas/semicolons, drop words < 3 chars and a
// small stop-word list, de-dupe.
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have',
  'but', 'not', 'are', 'was', 'been', 'more', 'will', 'can',
  'all', 'would', 'there', 'their', 'what', 'about', 'which',
  'when', 'make', 'than', 'then', 'them', 'these', 'could',
  'into', 'time', 'has', 'look', 'two', 'way', 'how', 'who'
]);

function extractKeywords(text) {
  if (!text) return [];
  const words = String(text)
    .toLowerCase()
    .split(/[\n,;]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2)
    .filter(w => !COMMON_WORDS.has(w));
  return [...new Set(words)];
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid body' }); }

  // Goal signal = things they're moving toward / habits / product interests.
  // Obstacle signal = things they're moving away from.
  const goalText = [body.moveToward, body.dailyHabits, body.productCategories]
    .filter(Boolean).join(' ');
  const obstacleText = body.moveAway || '';

  const goalKeywords = extractKeywords(goalText);
  const obstacleKeywords = extractKeywords(obstacleText);

  // Nothing meaningful to record — succeed quietly so the client never treats
  // an empty profile as an error.
  if (goalKeywords.length === 0 && obstacleKeywords.length === 0) {
    return json(200, { ok: true, updated: 0 });
  }

  try {
    const ref = db.collection('aggregations').doc('keywords');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = (snap.exists && snap.data() && snap.data().keywords) || {};

      // Clone so we never mutate the snapshot's data in place.
      const keywords = {};
      for (const [word, counts] of Object.entries(existing)) {
        keywords[word] = {
          goals: counts.goals || 0,
          obstacles: counts.obstacles || 0,
        };
      }

      const bump = (word, field) => {
        if (!keywords[word]) keywords[word] = { goals: 0, obstacles: 0 };
        keywords[word][field] += 1;
      };
      goalKeywords.forEach(w => bump(w, 'goals'));
      obstacleKeywords.forEach(w => bump(w, 'obstacles'));

      // merge:true preserves any other top-level fields; `keywords` itself is
      // the full recomputed map, matching the shape insights.js reads
      // (keywords -> {word -> {goals:int, obstacles:int}}).
      tx.set(ref, {
        keywords,
        lastUpdated: new Date().toISOString(),
      }, { merge: true });
    });

    return json(200, { ok: true, updated: goalKeywords.length + obstacleKeywords.length });
  } catch (err) {
    console.error('aggregate-keywords error:', err);
    return json(500, { error: 'Internal error' });
  }
};
