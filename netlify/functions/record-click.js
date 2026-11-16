// Records a click on a promotion: decrement its budget, increment its clicks —
// server-side and transactional, so budgets can't be forged or driven negative.
//
// Replaces the direct client PATCH in content.js. No auth is required (any
// viewer who clicks a recommendation triggers this), but the transaction
// guards budget > 0 so a promo can never be charged below zero.
//
// RATE LIMITING (anti click-fraud): this endpoint is the most abusable one —
// hammering it drains a competitor's promotion budget. We apply two Firestore-
// backed limits before doing anything:
//   • per-IP burst        — 40 requests / minute across all promos, to stop a
//                           script spraying clicks over many promotions.
//   • per-(IP, promo)     —  5 requests / hour on any single promo, so one
//                           source can't drain one promo's budget.
// Over-limit requests are dropped entirely (not counted, not charged) with 429.
// The limiter fails open, so a Firestore hiccup can never break click recording.

const { db, FieldValue, json, preflight, clientIp, checkRateLimit } = require('./_admin');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let promoId;
  try { ({ promoId } = JSON.parse(event.body)); } catch (e) { return json(400, { error: 'Invalid body' }); }
  if (!promoId) return json(400, { error: 'Missing promoId' });

  // ── Rate limits (checked before any write) ────────────────────────────────
  const ip = clientIp(event);
  const burst = await checkRateLimit(`click:${ip}`, 40, 60);
  if (!burst.allowed) return json(429, { error: 'rate_limited' });
  const perPromo = await checkRateLimit(`click:${ip}:${promoId}`, 5, 3600);
  if (!perPromo.allowed) return json(429, { error: 'rate_limited' });

  try {
    const promoRef = db.collection('promotions').doc(promoId);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(promoRef);
      if (!snap.exists) throw new Error('PROMO_NOT_FOUND');
      const budget = snap.data().budget || 0;
      // Always count the click; only spend budget if there's budget left.
      tx.update(promoRef, {
        clicks: FieldValue.increment(1),
        ...(budget > 0 ? { budget: budget - 1 } : {}),
      });
      return { budget: Math.max(0, budget - 1) };
    });
    return json(200, { ok: true, budget: result.budget });
  } catch (err) {
    if (err.message === 'PROMO_NOT_FOUND') return json(404, { error: err.message });
    console.error('record-click error:', err);
    return json(500, { error: 'Internal error' });
  }
};
