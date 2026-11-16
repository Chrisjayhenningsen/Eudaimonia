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
//   SAFE_BROWSING_KEY         – (used by check-url)

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

// ─── Client IP ───────────────────────────────────────────────────────────────
// Netlify sets x-nf-client-connection-ip to the real client IP; x-forwarded-for
// is a comma-separated fallback (client is the first entry). Returns 'unknown'
// if neither is present, so the rate limiter still functions (all unknown-IP
// callers just share one bucket).
function clientIp(event) {
  const h = event.headers || {};
  const nf = h['x-nf-client-connection-ip'] || h['X-Nf-Client-Connection-Ip'];
  if (nf) return String(nf).trim();
  const xff = h['x-forwarded-for'] || h['X-Forwarded-For'] || '';
  const first = String(xff).split(',')[0].trim();
  return first || 'unknown';
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Serverless has no shared memory, so we back a fixed-window counter with
// Firestore. One doc per (bucket, window): its id is `${bucket}_${windowStart}`
// and it holds a running `count`. Each call reads+increments in a transaction
// and reports whether the caller is still under `limit` for the current window.
//
// FAILS OPEN: any error (Firestore blip, etc.) returns { allowed: true } so the
// limiter can never take an endpoint down. Writes land in the `rateLimits`
// collection, which the locked rules already deny to all clients (Admin SDK
// bypasses rules). Set a Firestore TTL policy on `rateLimits.expiresAt` to
// auto-purge old windows; without it the docs are tiny but accumulate.
//
//   bucket        – a stable string identifying the dimension being limited,
//                   e.g. `click:1.2.3.4` or `click:1.2.3.4:promoAbc123`.
//   limit         – max requests allowed within one window.
//   windowSeconds – window length.
function safeDocId(s) {
  // Firestore doc ids can't contain '/', can't be '.'/'..', can't match __*__.
  return String(s).replace(/\//g, '_').replace(/^__+|__+$/g, '_').slice(0, 400) || 'unknown';
}

async function checkRateLimit(bucket, limit, windowSeconds) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - (nowSec % windowSeconds);
    const id = safeDocId(`${bucket}_${windowStart}`);
    const ref = db.collection('rateLimits').doc(id);

    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.exists && snap.data().count) || 0;
      if (count >= limit) return false;
      tx.set(ref, {
        count: count + 1,
        bucket,
        // Kept two windows past the window end so an in-flight window is never
        // purged early; drives an optional Firestore TTL policy on this field.
        expiresAt: new Date((windowStart + windowSeconds * 2) * 1000),
      }, { merge: true });
      return true;
    });

    return { allowed };
  } catch (err) {
    console.warn('checkRateLimit failed open:', err.message);
    return { allowed: true, error: true };
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

module.exports = {
  admin, db, FieldValue,
  json, preflight, uidFromRequest,
  clientIp, checkRateLimit,
  getBalance, creditTokens,
};
