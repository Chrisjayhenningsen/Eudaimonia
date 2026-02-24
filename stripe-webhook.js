const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  // Verify the webhook came from Stripe
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const tokenQty = parseInt(session.metadata?.token_quantity || '0');
    const sessionId = session.id;

    if (tokenQty < 1) {
      return { statusCode: 200, body: 'No tokens to award' };
    }

    try {
      // Write a pending token award to Firebase
      // The extension polls this collection on open and claims pending awards
      await fetch(`${FIRESTORE_URL}/pendingTokenAwards/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            tokenQty: { integerValue: tokenQty.toString() },
            claimed: { booleanValue: false },
            createdAt: { stringValue: new Date().toISOString() },
            stripeSessionId: { stringValue: sessionId }
          }
        })
      });

      console.log(`Token award created: ${tokenQty} tokens for session ${sessionId}`);
    } catch (err) {
      console.error('Failed to write token award to Firebase:', err);
      return { statusCode: 500, body: 'Failed to record token award' };
    }
  }

  return { statusCode: 200, body: 'OK' };
};
