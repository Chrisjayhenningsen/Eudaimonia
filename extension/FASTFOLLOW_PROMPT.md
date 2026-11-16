# Eudaimonia — Step F Fast-Follow Prompt

Paste the block below into a new chat to tackle the post-launch hardening items.

---

I'm working on Eudaimonia, a Chrome extension (Manifest V3) with a
server-authoritative token economy. Stack: Firebase Firestore (via REST +
Admin SDK), Netlify Functions for all server logic, Stripe for purchases.
Repo: https://github.com/Chrisjayhenningsen/Eudaimonia — Netlify auto-deploys
from the `main` branch.

The extension just launched (rules locked, Stripe live, purchase verified).
I now want to tackle the post-launch "fast-follow" hardening items below.

IMPORTANT REPO NOTES — read before editing:
- Netlify builds functions from `netlify/functions/` in the GitHub repo. Any
  NEW or edited function MUST be committed to that path to actually deploy.
  (My local folder has an unpushed `backend/` reorg — ignore it; work against
  the `netlify/functions/` layout that's actually on GitHub and deployed.)
- Since Netlify auto-deploys from `main`, treat pushes as deploys. Let me
  review changes before anything is pushed.
- Follow the EXISTING pattern in `netlify/functions/record-click.js`
  (Admin SDK, validate input, write to Firestore server-side) for any new
  function.
- Firestore rules live in `firestore.rules`. Only tighten a rule AFTER the
  client no longer writes that collection directly and the replacement
  function is deployed and tested — otherwise I'll break a live feature.

TASKS (in priority order):

1. Move keyword aggregation server-side.
   - Currently the client aggregates keywords directly (`setup.js` and
     `firebase-config.js` → `aggregateUserKeywords`).
   - Create a Netlify function (same pattern as record-click) that performs
     the aggregation write, and change the client to call it instead of
     writing to Firestore directly.

2. Move ad-signature collection server-side.
   - Currently `background.js` → `reportAdSignature` writes directly.
   - Create/extend a function to handle this write; update the client to call it.

3. After #1 and #2 are deployed and tested: change the `aggregations` rule in
   `firestore.rules` from `allow write: if true` to `allow write: if false`,
   then re-publish rules in the Firebase console.

4. (Optional) Move the email-hash anti-spam write into the spend/promote
   function so first-promotion dedup is recorded again server-side.

5. (Optional) Add `createdAt` to backend-created `users` docs (hygiene, so
   console views sorted by createdAt don't hide them).

6. (Optional) Revisit the performance item: top-frame gating for the ad-block
   scan in `content.js`.

Constraints/workflow:
- Bump `manifest.json` version for any change that ships in the extension.
- Test each change before moving on; there's a test checklist at
  backend/STEP5_TEST_CHECKLIST.md I can share.
- Walk me through it step by step — I'm comfortable with the product but
  still shaky on git and the Firebase/Netlify dashboards.

Start by reviewing the current record-click.js pattern and the client-side
write in setup.js/firebase-config.js, then propose a plan for task 1.
