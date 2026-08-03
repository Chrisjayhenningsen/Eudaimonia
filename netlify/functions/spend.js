// Authenticated, transactional token spends.
//
// Replaces the client-side "deduct from chrome.storage.sync + PATCH Firestore"
// flow. Two actions:
//   promote   – create a new promotion (flat cost of 1 token)
//   addBudget – add N tokens of budget to a promotion the caller owns
//
// The server recomputes cost itself and never trusts a cost/budget sent by the
// client. All balance + promotion writes happen in a single transaction, so a
// spend and its effect can't get out of sync.

const crypto = require('crypto');
const { db, FieldValue, json, preflight, uidFromRequest } = require('./_admin');

const PROMOTION_COST = 1; // keep in sync with promote.js

// One-way, unsalted SHA-256 of a normalized (trimmed, lowercased) email — the
// SAME hashing the client used (see hashEmail in firebase-config.js), so a hash
// computed here matches any previously written for the same address. This is a
// "does this address already belong to a registered user?" anti-spam/dedup
// check; the plaintext email is only ever used to derive this hash and is never
// stored.
function hashEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Server-side copy of the submission blocklist check (defense in depth — the
// client checks too, but the client can be bypassed).
async function isBlocked(title, description, keywords) {
  try {
    const snap = await db.collection('config').doc('blocklist').get();
    const terms = (snap.exists ? snap.data().terms : []) || [];
    if (!terms.length) return false;
    const combined = `${title} ${description} ${keywords}`.toLowerCase();
    return terms.some((t) => t && combined.includes(String(t).toLowerCase()));
  } catch (e) {
    return false; // fail open — same policy as the client
  }
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const uid = await uidFromRequest(event);
  if (!uid) return json(401, { error: 'Sign in required' });

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return json(400, { error: 'Invalid body' }); }
  const { action } = body;

  try {
    if (action === 'promote') {
      const { url, title, description, keywords } = body;
      if (!url || !title || !description || !Array.isArray(keywords) || !keywords.length) {
        return json(400, { error: 'Missing promotion fields' });
      }
      try { new URL(url); } catch (e) { return json(400, { error: 'Invalid URL' }); }
      if (await isBlocked(title, description, keywords.join(' '))) {
        return json(422, { error: 'BLOCKED_CONTENT' });
      }

      // First-promotion anti-spam dedup (moved server-side from the client).
      // The client can no longer write emailHashes directly (locked rules), so
      // we record the hash here, inside the same transaction as the spend, so
      // it commits only if the promotion actually goes through. Best-effort:
      // guarded by isFirstPromotion + a non-empty email, both sent by the client.
      const email = (body.email || '').trim();
      const isFirstPromotion = !!body.isFirstPromotion;
      const emailHashRef = (isFirstPromotion && email)
        ? db.collection('emailHashes').doc(hashEmail(email))
        : null;

      const promoRef = db.collection('promotions').doc();
      const newBalance = await db.runTransaction(async (tx) => {
        const uref = db.collection('users').doc(uid);
        const bal = (await tx.get(uref)).data()?.tokens || 0;
        if (bal < PROMOTION_COST) throw new Error('INSUFFICIENT_TOKENS');
        tx.update(uref, { tokens: bal - PROMOTION_COST, updatedAt: new Date().toISOString() });
        tx.set(promoRef, {
          userId: uid,
          url, title, description,
          keywords: keywords.map((k) => String(k).trim().toLowerCase()),
          cost: PROMOTION_COST,
          budget: PROMOTION_COST,
          clicks: 0,
          timestamp: new Date().toISOString(),
        });
        if (emailHashRef) {
          tx.set(emailHashRef, {
            registered: true,
            createdAt: new Date().toISOString(),
          }, { merge: true });
        }
        return bal - PROMOTION_COST;
      });
      return json(200, { ok: true, promoId: promoRef.id, balance: newBalance });
    }

    if (action === 'addBudget') {
      const promoId = body.promoId;
      const amount = Math.floor(Number(body.amount));
      if (!promoId || !Number.isFinite(amount) || amount < 1) {
        return json(400, { error: 'Invalid promoId/amount' });
      }
      const promoRef = db.collection('promotions').doc(promoId);
      const newBalance = await db.runTransaction(async (tx) => {
        const promoSnap = await tx.get(promoRef);
        if (!promoSnap.exists) throw new Error('PROMO_NOT_FOUND');
        if (promoSnap.data().userId !== uid) throw new Error('NOT_OWNER'); // can't top up others'
        const uref = db.collection('users').doc(uid);
        const bal = (await tx.get(uref)).data()?.tokens || 0;
        if (bal < amount) throw new Error('INSUFFICIENT_TOKENS');
        tx.update(uref, { tokens: bal - amount, updatedAt: new Date().toISOString() });
        tx.update(promoRef, { budget: FieldValue.increment(amount) });
        return bal - amount;
      });
      return json(200, { ok: true, balance: newBalance });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    const known = ['INSUFFICIENT_TOKENS', 'PROMO_NOT_FOUND', 'NOT_OWNER'];
    if (known.includes(err.message)) return json(409, { error: err.message });
    console.error('spend error:', err);
    return json(500, { error: 'Internal error' });
  }
};
