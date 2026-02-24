const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const sessionId = event.queryStringParameters?.session_id;

  if (!sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing session_id' }) };
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      statusCode: 200,
      body: JSON.stringify({
        token_quantity: parseInt(session.metadata?.token_quantity || '0')
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not retrieve session' }) };
  }
};
