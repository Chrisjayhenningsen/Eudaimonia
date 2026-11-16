# Eudaimonia web app: handoff

Paste this into a new session, with the repo `Chrisjayhenningsen/Eudaimonia` attached (the Claude GitHub App is installed and can push).

## Rules that still apply
- Work on branch `web-app`. Never commit or push to `main`. Merging PR #1 is Chris's decision: it triggers a production deploy (15 Netlify credits). Pushes to `web-app` only rebuild the free Deploy Preview.
- Fewer, bigger pushes. Test offline first (node tests, headless Chrome with mocked network).
- No framework, build step, external scripts, fonts or CDNs. Commonwealth spelling. The app speaks as "I" to "you".
- Privacy: only the requests listed at the top of `app/js/api.js`. The email never leaves the device in Phase 1.
- Don't change the landing page (`index.html` at the root), Firestore rules, or anything in the Firebase, Stripe or Netlify dashboards. Don't move, rename or delete existing files.
- Shared globals use `var`. Await writes before any navigation. Run `node --check` on every JS file before calling anything done.
- Scan for secrets before each commit.
- Chris prefers short sessions, mechanism explained, falsification-first debugging, and short reports.

## Where things are
- PR (draft, do not merge): https://github.com/Chrisjayhenningsen/Eudaimonia/pull/1
- Preview: https://deploy-preview-1--eudaimonia-project.netlify.app/app/
- Production site: https://eudaimonia-project.netlify.app (Firebase project `eudaimonia-350ce`)

## State (2026-11-15)
Phase 1 (the loop) is built, pushed and live on the preview. Chris is testing it on his phone and laptop. Later phases have not been started and wait for his word:
1. Weekly reminder with no backend: an "add to calendar" recurring event linking to `/app/#/checkin`. Test on iOS Safari and Android Chrome; say so if unreliable.
2. Promoting your own pick and topping up tokens on the web.

## What is on the branch
- `app/index.html` one page, four views by URL hash: `#/start`, `#/picks`, `#/checkin`, `#/profile`
- `app/css/app.css` palette from the extension's `ui.css`, light and dark, designed at 380px
- `app/js/store.js` localStorage wrapper, same key names as chrome.storage
- `app/js/api.js` every network request
- `app/js/match.js` `matchPromotions` + `applyExposureRotation` copied from `content.js`, plus `rankPicks` (score, then smoothed glad rate `(yes+2)/(yes+no+4)`, then rotation)
- `app/js/glad.js` "Glad you tried it?", written to back-port to the extension check-in
- `app/js/app.js` views and wiring
- `app/tests/logic.test.js` run with `node app/tests/logic.test.js`
- `netlify/functions/record-glad.js` new: atomic +1 on `promotions/{id}.gladYes|gladNo`
- `netlify/functions/` updated from Chris's disk: rate limiting in `_admin.js`, `record-click`, `aggregate-keywords`, `report-ad-signature`; new `check-url.js`
- `extension/` the v0.9 Chrome extension source from Chris's disk (source of truth from now on). The stale v0.7.7 files in the repo root are untouched; removing them is a later decision for Chris.

## Decisions made with Chris
- One text box for goals and habits, stored in `moveToward`. Check-in uses `dailyHabits` lines if the profile has them, otherwise each line of `moveToward`.
- Sharing goal phrases (`aggregate-keywords`) is opt-out, key `shareKeywords`.
- Glad votes: no auth, IP rate limit only. Yes/No is sent once and never asked again; "Haven't tried it yet" carries over up to three check-ins.
- Optional email on the start screen and the profile (`promoterEmail`, device only). It is the hook for builders: not needed to see picks, needed to add your own. It reveals the promoter panel on the profile.
- Web tokens are a separate anonymous account from the extension's.
- New storage keys beyond the extension's: `shareKeywords`, `promoterEmail`, `openedPicks`, `gladAnswered`.

## Verified
- `node --check` on every JS file; logic tests pass.
- Headless Chrome at 380px, light and dark, mocked network: full loop plus the all-requests-blocked path. No console errors, no overflow.
- On the preview in a real browser: page loads, 72 live promotions fetched and ranked, anonymous sign-up works with the existing API key, `record-glad` returns 400 for a bad answer and 404 for an unknown promotion.

## Not verified
- A real glad vote, check-in reward and click from the web (Chris's own test covers these).
- Real phones.
- The updated functions under production load; they only run on the preview until the PR is merged.

## Open items for Chris
- `check-url` needs a `SAFE_BROWSING_KEY` environment variable in Netlify; without it the function answers "not checked" and lets the URL through.
- `config/featureFlags` is publicly readable and contains `safeBrowsingKey`. Move it to that env var and delete the field.
- The rate limiter writes to a `rateLimits` collection with an `expiresAt` field. Without a Firestore TTL policy on that field the documents accumulate.
- Matching is case-sensitive on promotion keywords (inherited from the extension): a keyword stored as "Running" never matches.
- `backend/` on Chris's disk (runbooks, older function copies, a backfill script) was not added to the repo.
