// Grants the one-time setup bonus (the 12 tokens promised on the welcome
// screen), server-side and exactly once per user.
//
// IMPORTANT CAVEAT: identity is a Firebase ANONYMOUS uid. A user who clears
// extension data or reinstalls gets a fresh uid and can claim the bonus again.
// This function makes the grant once-per-uid, which stops the trivial "re-run
// setup" farm, but does NOT stop determined re-installation farming. If that
// matters at scale, gate the bonus behind a durable identity (email link) — see
// BACKEND_SECURITY_PLAN.md §6. Keeping the bonus small also limits the upside.

const { db, FieldValue, json, preflight, uidFromRequest } = require('./_admin');

const ONBOARDING_BONUS = 12; // keep in sync with setup.js

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const uid = await uidFromRequest(event);
  if (!uid) return json(401, { error: 'Sign in required' });

  try {
    const granted = await db.runTransaction(async (tx) => {
      const uref = db.collection('users').doc(uid);
      const data = (await tx.get(uref)).data() || {};
      if (data.onboardingClaimed) return false; // already granted
      tx.set(uref, {
        tokens: FieldValue.increment(ONBOARDING_BONUS),
        onboardingClaimed: true,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      return true;
    });
    return json(200, { ok: true, granted, amount: granted ? ONBOARDING_BONUS : 0 });
  } catch (err) {
    console.error('claim-onboarding error:', err);
    return json(500, { error: 'Internal error' });
  }
};
