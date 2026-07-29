// Awards check-in tokens, server-side, with the cadence enforced in Firestore
// so the reward can't be farmed by repeatedly submitting.
//
// The user's habit list lives only in the extension (chrome.storage.sync), so
// the server can't independently verify what was completed. We therefore accept
// a `responses` count from the client but (a) enforce the weekly/daily cadence
// from the server's own record of the last check-in, and (b) cap the count so a
// tampered client can't claim an unbounded reward. This is intentionally a
// "good enough" control — check-in farming is low-value compared to purchases.

const { db, FieldValue, json, preflight, uidFromRequest } = require('./_admin');

const MAX_RESPONSES = 20; // hard cap on rewarded items per check-in

const WINDOW_DAYS = { daily: 1, weekly: 7, biweekly: 14 };

async function getFlags() {
  try {
    const snap = await db.collection('config').doc('featureFlags').get();
    const f = snap.exists ? snap.data() : {};
    return {
      tokenEarningRate: parseInt(f.tokenEarningRate ?? 2),
      checkInFrequency: f.checkInFrequency || 'weekly',
    };
  } catch (e) {
    return { tokenEarningRate: 2, checkInFrequency: 'weekly' };
  }
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const uid = await uidFromRequest(event);
  if (!uid) return json(401, { error: 'Sign in required' });

  let responses;
  try { ({ responses } = JSON.parse(event.body)); } catch (e) { return json(400, { error: 'Invalid body' }); }
  responses = Math.max(0, Math.min(MAX_RESPONSES, Math.floor(Number(responses) || 0)));

  const flags = await getFlags();
  const windowMs = (WINDOW_DAYS[flags.checkInFrequency] || 7) * 86400000;

  try {
    const result = await db.runTransaction(async (tx) => {
      const uref = db.collection('users').doc(uid);
      const data = (await tx.get(uref)).data() || {};
      const last = data.lastCheckinAt ? new Date(data.lastCheckinAt).getTime() : 0;
      const now = Date.now();

      // Always record the check-in; only award tokens if the window has elapsed.
      const eligible = now - last >= windowMs;
      const earned = eligible ? responses * flags.tokenEarningRate : 0;

      tx.set(uref, {
        lastCheckinAt: new Date(now).toISOString(),
        ...(earned > 0 ? { tokens: FieldValue.increment(earned) } : {}),
        updatedAt: new Date(now).toISOString(),
      }, { merge: true });

      return { earned, eligible };
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('earn-checkin error:', err);
    return json(500, { error: 'Internal error' });
  }
};
