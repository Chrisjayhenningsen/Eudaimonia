// Records a FALSE POSITIVE — content the auto scanner hid that the user told
// us was not an ad, via the "not an ad" control on the blocked badge. Writes
// into the shared analytics doc aggregations/falsePositives.
//
// This is the mirror image of report-ad-signature.js: that one collects ads our
// selectors MISSED, this one collects page content our selectors WRONGLY CAUGHT.
// Read together they're the tuning signal for the selector list — a signature
// showing up here with a high count is a selector that needs narrowing.
//
// No auth is required (same choice as record-click / aggregate-keywords /
// report-ad-signature): it fires from the background service worker whenever a
// user corrects a block, where an authenticated token isn't guaranteed, and it
// writes only anonymized telemetry — a normalized selector, a size bucket, a
// bare hostname, which scanning pass produced the block, and a count. The
// read-modify-write runs in a transaction so concurrent reporters can't clobber
// each other's counts.
//
// RATE LIMITING: being open, this endpoint is spammable, and the whole map
// lives in one Firestore document (1 MB ceiling). Capped at 30 reports / hour
// per IP — deliberately tighter than report-ad-signature's 120, because
// correcting a false positive is a rare, deliberate user action, not something
// that fires on every page load. Over-limit callers get 429 and are dropped
// (telemetry is best-effort; the client ignores the response). Limiter fails
// open.
//
// NOTE: nothing here gates the user-visible fix. The restore and the local
// per-domain allowlist happen entirely client-side before this is called — if
// this endpoint is down, rate-limited, or disabled by the falsePositiveReporting
// feature flag, the user's correction still works and still persists.

const { db, json, preflight, clientIp, checkRateLimit } = require('./_admin');

// Doc-size guard. Each entry is roughly 150–200 bytes, so this keeps the
// document comfortably under Firestore's 1 MB per-document ceiling with room
// to spare. Once full we keep COUNTING signatures we already track and drop
// only novel ones — losing the long tail is much better than the whole
// document failing to write.
const MAX_SIGNATURES = 1500;

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // Rate limit before any work.
  const ip = clientIp(event);
  const rl = await checkRateLimit(`fp:${ip}`, 30, 3600);
  if (!rl.allowed) return json(429, { error: 'rate_limited' });

  let sig;
  try { sig = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid body' }); }

  // Mirror the client's guard: a signature is meaningless without a key + selector.
  if (!sig.key || !sig.selector) return json(400, { error: 'Missing key or selector' });

  // Clamp lengths so a malicious client can't stuff huge strings into the
  // shared document (which everyone reads/rewrites).
  const key = String(sig.key).slice(0, 200);
  const selector = String(sig.selector).slice(0, 500);
  const size = sig.size ? String(sig.size).slice(0, 40) : '';
  const domain = sig.domain ? String(sig.domain).slice(0, 200) : '';
  const blockValue = sig.blockValue ? String(sig.blockValue).slice(0, 80) : '';

  try {
    const ref = db.collection('aggregations').doc('falsePositives');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = (snap.exists && snap.data() && snap.data().signatures) || {};

      // Clone so we never mutate the snapshot's data in place.
      const signatures = {};
      for (const [k, v] of Object.entries(existing)) {
        signatures[k] = {
          count: v.count || 0,
          selector: v.selector || '',
          size: v.size || '',
          domain: v.domain || '',
          blockValue: v.blockValue || '',
          updated: v.updated || '',
        };
      }

      const prev = signatures[key];

      // Bounded growth: keep incrementing keys we already track, but stop
      // accepting new ones once the map is full.
      if (!prev && Object.keys(signatures).length >= MAX_SIGNATURES) return;

      signatures[key] = {
        count: (prev ? prev.count : 0) + 1,
        selector,
        // Preserve previously-seen values if this report omits them — same
        // fallback behavior as report-ad-signature.
        size: size || (prev ? prev.size : ''),
        domain: domain || (prev ? prev.domain : ''),
        blockValue: blockValue || (prev ? prev.blockValue : ''),
        updated: new Date().toISOString(),
      };

      // merge:true preserves any other top-level fields; `signatures` is the
      // full recomputed map.
      tx.set(ref, {
        signatures,
        lastUpdated: new Date().toISOString(),
      }, { merge: true });
    });

    return json(200, { ok: true });
  } catch (err) {
    console.error('report-false-positive error:', err);
    return json(500, { error: 'Internal error' });
  }
};
