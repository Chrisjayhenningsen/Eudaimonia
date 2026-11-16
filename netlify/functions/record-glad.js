// Records one anonymous answer to "Glad you tried it?" for a promotion:
// an atomic +1 on promotions/{id}.gladYes or .gladNo. Nothing else is stored:
// no uid, no IP on the promotion, no timestamp per vote.
//
// Why a function: Firestore rules make promotions client read-only, so the
// count has to go through the Admin SDK, the same way record-click does.
// FieldValue.increment is applied server-side by Firestore, so concurrent
// votes can't overwrite each other (no read-modify-write).
//
// No auth, matching record-click: the web app must work when anonymous
// sign-in is blocked. update() (not set) means an unknown promoId fails with
// NOT_FOUND instead of creating a stray document.
//
// RATE LIMITING: used only if _admin exports checkRateLimit/clientIp (the
// rate-limited _admin isn't deployed yet at the time of writing). Without it
// this endpoint is spammable; glad counts only break ranking ties, so the
// damage is bounded, but deploy the limiter before real promoters depend on it.

const admin = require('./_admin');
const { db, FieldValue, json, preflight } = admin;

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let promoId, answer;
  try { ({ promoId, answer } = JSON.parse(event.body || '{}')); } catch (e) { return json(400, { error: 'Invalid body' }); }
  if (typeof promoId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(promoId)) return json(400, { error: 'Invalid promoId' });
  if (answer !== 'yes' && answer !== 'no') return json(400, { error: 'Invalid answer' });

  if (typeof admin.checkRateLimit === 'function' && typeof admin.clientIp === 'function') {
    const ip = admin.clientIp(event);
    const burst = await admin.checkRateLimit(`glad:${ip}`, 30, 3600);
    if (!burst.allowed) return json(429, { error: 'rate_limited' });
    const perPromo = await admin.checkRateLimit(`glad:${ip}:${promoId}`, 2, 86400);
    if (!perPromo.allowed) return json(429, { error: 'rate_limited' });
  }

  try {
    await db.collection('promotions').doc(promoId).update({
      [answer === 'yes' ? 'gladYes' : 'gladNo']: FieldValue.increment(1),
    });
    return json(200, { ok: true });
  } catch (err) {
    if (err && (err.code === 5 || /NOT_FOUND|No document to update/i.test(err.message || ''))) {
      return json(404, { error: 'PROMO_NOT_FOUND' });
    }
    console.error('record-glad error:', err);
    return json(500, { error: 'Internal error' });
  }
};
