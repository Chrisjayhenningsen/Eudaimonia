// Records a click on a promotion: decrement its budget, increment its clicks —
// server-side and transactional, so budgets can't be forged or driven negative.
//
// Replaces the direct client PATCH in content.js. No auth is required (any
// viewer who clicks a recommendation triggers this), but the transaction
// guards budget > 0 so a promo can never be charged below zero.
//
// NOTE: like any click endpoint this is spammable to drain a competitor's
// budget. That's classic click-fraud and is out of scope for launch; add
// rate-limiting / dedup (per-IP or per-uid per-promo per-window) later.

const { db, FieldValue, json, preflight } = require('./_admin');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let promoId;
  try { ({ promoId } = JSON.parse(event.body)); } catch (e) { return json(400, { error: 'Invalid body' }); }
  if (!promoId) return json(400, { error: 'Missing promoId' });

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
