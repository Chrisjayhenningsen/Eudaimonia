// Invite code lifecycle, server-side so both parties' token rewards are real.
//
//   register – record a client-generated EUDA-XXXX code as belonging to uid.
//              (The extension still generates the string client-side for the
//              synchronous mailto: link; this just makes it redeemable.)
//   redeem   – consume a code once: credit the invitee (+2) and inviter (+6),
//              atomically, and mark the code used so it can't be reused.
//
// Rewards are defined here, not by the client.

const { db, FieldValue, json, preflight, uidFromRequest } = require('./_admin');

const INVITEE_REWARD = 2;
const INVITER_REWARD = 6;
const CODE_RE = /^EUDA-[A-Z0-9]{4}$/;

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const uid = await uidFromRequest(event);
  if (!uid) return json(401, { error: 'Sign in required' });

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return json(400, { error: 'Invalid body' }); }
  const { action } = body;
  const code = (body.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return json(400, { error: 'Invalid code format' });

  try {
    if (action === 'register') {
      // Create only if it doesn't already exist (don't clobber someone else's code).
      const ref = db.collection('invites').doc(code);
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) return;
        tx.set(ref, { createdBy: uid, used: false, createdAt: new Date().toISOString() });
      });
      return json(200, { ok: true });
    }

    if (action === 'redeem') {
      const result = await db.runTransaction(async (tx) => {
        const ref = db.collection('invites').doc(code);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('CODE_NOT_FOUND');
        const invite = snap.data();
        if (invite.used) throw new Error('CODE_USED');
        if (invite.createdBy === uid) throw new Error('SELF_REDEEM');

        // Credit invitee
        tx.set(db.collection('users').doc(uid), {
          tokens: FieldValue.increment(INVITEE_REWARD), updatedAt: new Date().toISOString(),
        }, { merge: true });
        // Credit inviter (skip anonymous/legacy 'anonymous' marker)
        if (invite.createdBy && invite.createdBy !== 'anonymous') {
          tx.set(db.collection('users').doc(invite.createdBy), {
            tokens: FieldValue.increment(INVITER_REWARD), updatedAt: new Date().toISOString(),
          }, { merge: true });
        }
        tx.update(ref, { used: true, usedBy: uid, usedAt: new Date().toISOString() });
        return { inviteeReward: INVITEE_REWARD };
      });
      return json(200, { ok: true, ...result });
    }

    return json(400, { error: 'Unknown action' });
  } catch (err) {
    const known = ['CODE_NOT_FOUND', 'CODE_USED', 'SELF_REDEEM'];
    if (known.includes(err.message)) return json(409, { error: err.message });
    console.error('invites error:', err);
    return json(500, { error: 'Internal error' });
  }
};
