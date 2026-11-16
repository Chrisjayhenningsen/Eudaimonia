# Eudaimonia — Backend Security Plan (token economy)

Goal: make the token economy trustworthy enough for **live** Stripe payments, by
moving all value-changing operations to a trusted backend and locking the
database against direct client writes. Written against extension v0.7.2 and the
current `netlify/functions` (`create-checkout`, `get-session`, `stripe-webhook`).

---

## 1. Why the current design is bypassable

There are two places value lives, and both are client-controlled today:

1. **Spendable balance = `chrome.storage.sync.tokens`.** Every screen reads/writes
   the balance from local extension storage (popup, checkin, insights, promote,
   setup). Local storage is fully editable in DevTools → a user can set their
   balance to any number for free.

2. **`pendingTokenAwards` must be publicly writable.** `stripe-webhook.js` writes
   the award with a plain unauthenticated REST `PATCH`. For that to work, the
   Firestore rules have to allow public writes to that collection — which means
   anyone can forge an award doc (`tokenQty: 999999, claimed:false`), point the
   extension at it, and get credited without paying. The (correct) Stripe
   signature check is bypassed because its *output* lands in an open collection.

Related, same root cause:

- **Promotion budgets are drainable.** `content.js` decrements `budget` / bumps
  `clicks` with a direct client `PATCH` (~line 2342), unauthenticated and with no
  transaction. Anyone can zero out a competitor's budget, or top up their own.
- **Invite reward is written but never read.** `redeemInviteCode` credits the
  inviter's `users/{uid}.tokens` in Firestore, but nothing ever reads that field
  back as a balance (the balance is local). So the inviter likely never receives
  their +6. This gets fixed for free once the balance moves to Firestore.
- **`safeBrowsingKey` is exposed.** It's served from a world-readable
  `config` doc, so anyone can read the API key. Move it to a Netlify env var.

---

## 2. Target trust model

Two distinct ways to reach Firestore:

| Caller | Mechanism | Governed by |
| --- | --- | --- |
| Extension (client) | public REST / client SDK | Security Rules only |
| Netlify Functions (backend) | **Firebase Admin SDK** (service account) | nothing — bypasses rules |

Move every value mutation to the backend column, then lock the rules so the
client column can only *read* value, never write it.

Canonical state after the change:

- **Token balance** lives in `users/{uid}.tokens`, written **only** by backend.
  The client reads its own balance to display it; it never writes it.
- **Purchases**: the webhook credits `users/{uid}.tokens` directly (Admin SDK,
  atomic increment). `pendingTokenAwards` + the client-side "claim" go away.
- **Spends** (create promotion, add budget, per-click decrement, invite rewards)
  go through authenticated functions that check + mutate in a transaction.
- **Reads** the client still needs stay public/own-scoped: `promotions` (read),
  `config` (read), `aggregations` (read), own `users/{uid}` (read).

---

## 3. Draft `firestore.rules`

Default deny; open only the specific reads the client needs. Because the Admin
SDK bypasses rules, backend-only collections just need clients denied.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Shown to everyone; created/updated only by the backend (costs tokens).
    match /promotions/{promoId} {
      allow read: if true;
      allow write: if false;
    }

    // App config + content policy. Read by client, changed out-of-band
    // (Admin SDK / console). DO NOT store secrets here (move safeBrowsingKey out).
    match /config/{doc} {
      allow read: if true;
      allow write: if false;
    }

    // Non-identifying aggregate keyword counts for the insights view.
    match /aggregations/{doc} {
      allow read: if true;
      allow write: if false;
    }

    // Per-user balance: a signed-in user may read ONLY their own doc.
    // Never client-writable — balance is mutated only by trusted backend code.
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false;
    }

    // Everything else (pendingTokenAwards [deprecated], invites, emailHashes)
    // is created/validated by backend functions via the Admin SDK.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

> Test rules in the Firebase console's Rules Playground before publishing, and
> keep a copy of the current rules so you can roll back.

---

## 4. Backend changes (Netlify Functions)

### 4.0 One-time setup
- Create a Firebase **service account** (Project settings → Service accounts →
  Generate new private key). Store the JSON as a Netlify env var
  `FIREBASE_SERVICE_ACCOUNT`.
- Add `firebase-admin` to the functions' dependencies.
- Shared init module `netlify/functions/_admin.js`:

```js
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}
const db = admin.firestore();
async function uidFromRequest(event) {         // verify Firebase idToken
  const h = event.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try { return (await admin.auth().verifyIdToken(token)).uid; }
  catch { return null; }
}
module.exports = { admin, db, uidFromRequest };
```

### 4.1 `create-checkout.js` — attach the buyer's uid
Verify the caller's idToken and stamp `uid` into the Stripe metadata, so the
webhook knows whom to credit.

```js
const uid = await uidFromRequest(event);
if (!uid) return { statusCode: 401, body: 'Sign in required' };
// ...create session with metadata: { token_quantity: qty, uid }
```
The extension must send `Authorization: Bearer <idToken>` when calling this.

### 4.2 `stripe-webhook.js` — credit the balance directly, idempotently
After the existing signature check, on `checkout.session.completed`:

```js
const { db, admin } = require('./_admin');
const uid = session.metadata?.uid;
const qty = parseInt(session.metadata?.token_quantity || '0');
if (uid && qty > 0) {
  const seen = db.collection('processedSessions').doc(session.id);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(seen)).exists) return;              // idempotent
    tx.set(db.collection('users').doc(uid), {
      tokens: admin.firestore.FieldValue.increment(qty),
    }, { merge: true });
    tx.set(seen, { at: new Date().toISOString(), qty });
  });
}
```
This replaces `pendingTokenAwards` and the client-side claim entirely.

### 4.3 `spend.js` (new) — authenticated, transactional debits
One endpoint for promote / add-budget. Verifies idToken, checks balance,
decrements balance and writes the promotion atomically.

```js
const uid = await uidFromRequest(event);
if (!uid) return { statusCode: 401, body: 'Sign in required' };
const { action, payload } = JSON.parse(event.body);
// action 'promote': cost = payload.cost (validate server-side, don't trust it)
await db.runTransaction(async (tx) => {
  const uref = db.collection('users').doc(uid);
  const bal = (await tx.get(uref)).data()?.tokens || 0;
  if (bal < cost) throw new Error('INSUFFICIENT_TOKENS');
  tx.update(uref, { tokens: bal - cost });
  // create promotion doc / add to an existing promo's budget
});
```
Compute `cost` on the server from your own rules (first vs repeat, etc.) — never
trust a cost sent by the client.

### 4.4 `record-click.js` (new) — budget decrement server-side
`content.js` calls this instead of PATCHing Firestore. Transaction guards
`budget > 0`, decrements budget, increments clicks. (Note: like all ad systems
this is spammable to drain a budget; add basic rate-limiting later — not a
launch blocker.)

### 4.5 Invites
Move `registerGeneratedInviteCode` / `redeemInviteCode` into authenticated
functions so both parties' balances are credited server-side. Caveat: your
deliberately-synchronous mailto flow generates the code client-side; keep
generating the string client-side for the link, but do the *registration* and
all *crediting* in a function (the code simply isn't valid until the function
records it — which is already fire-and-forget today).

---

## 5. Client changes (extension)

- On popup open, read balance from `users/{uid}` in Firestore (own-read allowed
  by rules) instead of `chrome.storage.sync.tokens`. Keep a local cache only for
  display.
- Replace every direct Firestore value write with a `fetch` to the matching
  function, sending `Authorization: Bearer <idToken>` (you already mint idTokens
  in `ensureAuthenticated`).
- Remove the `pendingTokenAwards` claim logic from `popup.js` / `content.js`.
- Remove `admin.html` / `admin.js` and `seed-demo-data.html` from the shipped
  build (or gate behind real auth) — they can currently rewrite global config.
- Move `safeBrowsingKey` out of the public `config` doc; if the client needs
  Safe Browsing, proxy it through a function that holds the key in env.

---

## 6. Gotchas / open decisions

- **Anonymous auth is re-farmable.** Balances key off the Firebase anonymous
  uid. Clearing data / reinstalling yields a new uid and re-triggers the setup
  bonus (`setup.js` grants 12 tokens). For a real economy, gate free-token
  grants (setup/invite) or move to email-linked accounts eventually. Decide how
  much free-token farming you'll tolerate at launch.
- **Existing testers' local balances won't carry over** once the balance moves
  to Firestore. Simplest at this stage (one family tester) is to reset and seed
  balances via the Admin SDK. Don't auto-migrate from local storage — that's
  forgeable.
- **Migration order matters** (don't break the live app):
  1. Ship backend: `_admin`, Admin-SDK webhook, `spend`, `record-click`, invite
     functions. Deploy and test with the client still using the old paths.
  2. Ship a client build that calls the new functions and reads balance from
     Firestore.
  3. **Only after** clients are updated, publish the locked `firestore.rules`.
     (Publishing rules first would break the old client for existing users.)
- Keep Stripe in **test mode** through steps 1–2; flip to live only after the
  locked rules are published and verified.
```
