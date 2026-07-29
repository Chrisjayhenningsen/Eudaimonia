// Creates a Stripe Checkout Session for a token top-up.
//
// CHANGE FROM CURRENT VERSION: requires the caller's Firebase ID token and
// stamps their uid into the session metadata, so stripe-webhook.js knows which
// user's balance to credit. The price stays server-side (STRIPE_PRICE_ID), so
// the client can never set its own price.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { json, preflight, uidFromRequest } = require('./_admin');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const uid = await uidFromRequest(event);
  if (!uid) return json(401, { error: 'Sign in required' });

  let quantity;
  try {
    ({ quantity } = JSON.parse(event.body));
    quantity = Math.max(4, Math.min(10000, parseInt(quantity)));
  } catch (e) {
    return json(400, { error: 'Invalid request body' });
  }
  if (!Number.isFinite(quantity)) return json(400, { error: 'Invalid quantity' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity }],
      mode: 'payment',
      success_url: `${process.env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/#purchase`,
      metadata: {
        token_quantity: quantity.toString(),
        uid, // ← who to credit when the webhook fires
      },
    });
    return json(200, { url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return json(500, { error: 'Could not create checkout session' });
  }
};
