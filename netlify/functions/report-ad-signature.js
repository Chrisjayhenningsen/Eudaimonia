// Records a crowdsourced ad-block signature into the shared analytics doc
// (aggregations/adSignatures) — server-side, replacing the direct REST
// read-modify-write in background.js (reportAdSignature).
//
// No auth is required (same choice as record-click / aggregate-keywords): this
// fires from the background service worker whenever a user blocks something,
// where an authenticated token isn't guaranteed, and it writes only anonymized
// block telemetry — a selector, a size, a domain, and a count. The
// read-modify-write runs in a transaction so concurrent reporters can't clobber
// each other's counts (the old client version had a known race here).
//
// RATE LIMITING: being open, this endpoint is spammable to inflate signature
// counts, and the whole map lives in one Firestore document (1 MB ceiling). We
// cap it at 120 reports / hour per IP — heavy ad-blocking in a session is
// legitimate (and already session-deduped client-side), but this stops runaway
// inflation. Over-limit callers get 429 and are dropped (telemetry is best-
// effort; the client ignores the response). The limiter fails open.

const { db, json, preflight, clientIp, checkRateLimit } = require('./_admin');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // Rate limit before any work.
  const ip = clientIp(event);
  const rl = await checkRateLimit(`adsig:${ip}`, 120, 3600);
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

  try {
    const ref = db.collection('aggregations').doc('adSignatures');
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
          updated: v.updated || '',
        };
      }

      const prev = signatures[key];
      signatures[key] = {
        count: (prev ? prev.count : 0) + 1,
        selector,
        // Preserve a previously-seen size/domain if this report omits it —
        // same fallback behavior the client had.
        size: size || (prev ? prev.size : ''),
        domain: domain || (prev ? prev.domain : ''),
        updated: new Date().toISOString(),
      };

      // merge:true preserves any other top-level fields; `signatures` is the
      // full recomputed map, matching the shape background.js used to write.
      tx.set(ref, {
        signatures,
        lastUpdated: new Date().toISOString(),
      }, { merge: true });
    });

    return json(200, { ok: true });
  } catch (err) {
    console.error('report-ad-signature error:', err);
    return json(500, { error: 'Internal error' });
  }
};
