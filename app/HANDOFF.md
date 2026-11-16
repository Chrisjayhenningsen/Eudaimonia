# Eudaimonia web app: handoff

Branch `web-app`. Never commit to `main`: each production deploy costs 15 Netlify credits. Branch deploys and Deploy Previews are free.

## State (2026-11-15)
Phase 1 (the loop) is built and tested offline. Not yet pushed or tested against the live backend end to end.

## Files
- `app/index.html` one page, four views by URL hash: `#/start`, `#/picks`, `#/checkin`, `#/profile`
- `app/css/app.css` palette from the extension's `ui.css`, light and dark
- `app/js/store.js` localStorage wrapper, same key names as chrome.storage
- `app/js/api.js` every network request (list at the top of the file)
- `app/js/match.js` `matchPromotions` + `applyExposureRotation` copied from `content.js`, plus `rankPicks` (score, then smoothed glad rate, then rotation)
- `app/js/glad.js` "Glad you tried it?", written to back-port to the extension check-in
- `app/js/app.js` views and wiring
- `app/tests/logic.test.js` run with `node app/tests/logic.test.js`
- `netlify/functions/record-glad.js` NEW function: atomic +1 on `promotions/{id}.gladYes|gladNo`

## Decisions made with Chris
- One text box for goals and habits, stored in `moveToward`. Check-in uses `dailyHabits` lines if the profile has them, otherwise each line of `moveToward`.
- Sharing goal phrases (`aggregate-keywords`) is opt-out, key `shareKeywords`.
- Glad votes: no auth, IP rate limit only (and only once the rate-limited `_admin.js` is deployed).
- Email is optional, device-only (`promoterEmail`), and reveals the promoter panel. Never sent anywhere in Phase 1.
- Web tokens are a separate anonymous account from the extension's.

## New storage keys (beyond the extension's)
`shareKeywords`, `promoterEmail`, `openedPicks`, `gladAnswered`

## Verified
- `node --check` on every JS file; logic tests pass.
- Headless Chrome at 380px, light and dark, with mocked network: start, picks, open a pick, check-in, glad answer, profile, and the all-requests-blocked path. No console errors, no horizontal overflow.
- From `https://eudaimonia-project.netlify.app` in a real browser: anonymous sign-up works with the existing API key, flags and promotions are readable (72 promotions, 69 with budget).

## Not verified
- `record-glad` against real Firestore (needs a deploy preview).
- `claim-onboarding`, `earn-checkin`, `record-click` from the web origin (CORS is `*`, so expected to work).
- Real phones (iOS Safari, Android Chrome).
- Whether Deploy Previews run the branch's functions with production env vars (Netlify default: yes).

## Known gaps / follow-ups
- Repo functions are older than Chris's local copies (no rate limiting, no `check-url`). `record-glad` uses the limiter only if `_admin` exports it.
- `config/featureFlags` is publicly readable and contains `safeBrowsingKey`. Move it to a Netlify env var.
- Matching is case-sensitive on promotion keywords (inherited from the extension): a keyword stored as "Running" never matches.
- Later phases, only when asked: calendar reminder linking to `#/checkin`; promoting and token top-up on the web.
- Latest extension source (v0.9) lives only on Chris's disk; proposal is an `extension/` folder in the repo.
