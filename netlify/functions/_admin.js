// Shared backend helpers for Eudaimonia Netlify Functions.
//
// This module initializes the Firebase Admin SDK ONCE per warm function
// instance. The Admin SDK authenticates with a service account and therefore
// BYPASSES Firestore Security Rules entirely — it is the only thing that may
// write value-bearing data (token balances, promotion budgets) once the locked
// rules are published. Never expose the service-account key to the client.
//
// Required env vars (set in Netlify → Site settings → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT  – the full service-account JSON, as a string
//   STRIPE_SECRET_KEY         – (used by checkout/webhook)
//   STRIPE_WEBHOOK_SECRET     – (used by webhook)
//   STRIPE_PRICE_ID, SITE_URL – (used by checkout)

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ─── CORS ────────────────────────────────────────────────────────────────────
// The extension calls these functions from chrome-extension:// pages and from
// content scripts. We don't use cookies (auth travels in the Authorization
// header as a Bearer token), so a permissive ACAO is safe here.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(obj) };
}

// Handle CORS preflight. Call at the top of each handler.
function preflight(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  return null;
}

// ─── Auth ────────────────────────────────────────────────────────────────────
// Verifies the Firebase ID token the extension sends in the Authorization
// header. Returns the uid, or null if missing/invalid. The extension already
// mints these tokens in ensureAuthenticated() (identitytoolkit signUp →
// idToken); anonymous tokens verify fine here.
async function uidFromRequest(event) {
  const h = event.headers.authorization || event.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (err) {
    console.warn('idToken verification failed:', err.message);
    return null;
  }
}

// ─── Balance helpers ─────────────────────────────────────────────────────────
async function getBalance(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? (snap.data().tokens || 0) : 0;
}

// Atomically credit a user's balance. `reason` is stored for auditing.
async function creditTokens(uid, amount, reason) {
  await db.collection('users').doc(uid).set({
    tokens: FieldValue.increment(amount),
    lastCreditReason: reason || null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

module.exports = { admin, db, FieldValue, json, preflight, uidFromRequest, getBalance, creditTokens };
