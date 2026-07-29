// Stripe webhook: the ONLY place purchased tokens are minted.
//
// CHANGE FROM CURRENT VERSION: instead of writing an open `pendingTokenAwards`
// doc that the client later "claims", we credit the buyer's balance directly
// via the Admin SDK, keyed by the uid we stamped into the session metadata in
// create-checkout.js. This closes the forge-your-own-award hole, because the
// balance now lives in a collection no client can write to.
//
// Idempotency: Stripe can deliver the same event more than once. We record each
// processed session id and skip duplicates inside a transaction.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db, FieldValue } = require('./_admin');

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  // Stripe requires the exact raw body for signature verification.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const uid = session.metadata?.uid;
    const tokenQty = parseInt(session.metadata?.token_quantity || '0');

    if (!uid) {
      // Older sessions created before this change won't have a uid. Log loudly;
      // these have to be reconciled manually.
      console.error(`checkout.session.completed with no uid (session ${session.id}) — cannot credit.`);
      return { statusCode: 200, body: 'No uid on session' };
    }
    if (tokenQty < 1) return { statusCode: 200, body: 'No tokens to award' };

    try {
      const seen = db.collection('processedSessions').doc(session.id);
      await db.runTransaction(async (tx) => {
        if ((await tx.get(seen)).exists) return; // already credited — no-op
        tx.set(db.collection('users').doc(uid), {
          tokens: FieldValue.increment(tokenQty),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        tx.set(seen, { uid, tokenQty, at: new Date().toISOString() });
      });
      console.log(`Credited ${tokenQty} tokens to ${uid} (session ${session.id})`);
    } catch (err) {
      console.error('Failed to credit tokens:', err);
      // Non-200 tells Stripe to retry, which is what we want on a transient error.
      return { statusCode: 500, body: 'Failed to credit tokens' };
    }
  }

  return { statusCode: 200, body: 'OK' };
};
