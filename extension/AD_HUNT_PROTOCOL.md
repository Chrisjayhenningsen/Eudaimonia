# Eudaimonia — Ad Evasion Test Protocol

Target case: `mangaread.org` chapter pages
Baseline version: 0.6.0 (`content.js`, 1845 lines)
Recon date: 2026-07-22

---

## Part 0 — Live recon findings (already done)

I loaded the target page and ran your `AD_SELECTORS` list against the live DOM as a
simulation. Five concrete gaps, in priority order.

### Gap 1 — PubFuture stack is 100% invisible to the current selector list

Actual ancestry on the page:

```
div.ad.c-ads.custom-code.body-top-ads      1110x275   ← no selector matches
  div.wp-block-columns
    div.wp-block-column
      div.code-block.code-block-10          555x0     ← no selector matches
        div#pf-3242-1.PUBFUTURE             300x0     ← no selector matches
          div.pf-config-6a14105f4ef244020330c759      ← hashed, no selector matches
            div.pf-wrapper                            ← no selector matches
              iframe#iframe_pf-3242-1                 ← NO src attribute
```

**The critical structural problem:** `iframe#iframe_pf-*` has **no `src`**. It is
written via `srcdoc`/JS. Every rule you have of the form `iframe[src*="..."]` is
constitutionally blind to it. This is the single highest-value finding — srcless
iframes are the modern evasion default, and you currently have zero coverage for them.

Second instance found: `#pf-23117-1` (0x100).

### Gap 2 — bare `ad` / `c-ads` class names

`div.ad.c-ads.custom-code.body-top-ads` is a 1110x275 visible ad block. Your list has
`[class*="ad-container"]`, `[class*="ad-banner"]`, `[class*="ad-unit"]`, `[class*="ad-slot"]`
— none match a class that is literally just `ad` or `c-ads`. There is no rule for the
bare token.

### Gap 3 — BidGear SSP wrapper leaves a hole

```
div#bg-ssp-10239-947829586636    330x250   ← uncovered
  div.bg-container-102396d51d7   300x250   ← uncovered
    iframe[src*="a-ads.com"]     300x250   ← COVERED (matches)
```

The iframe gets hidden, the 330x250 wrapper does not. Result is a blank rectangle rather
than a removed ad — which reads to the user as "still there / broken layout."
Note the hex suffixes (`-10239-947829586636`, `-102396d51d7`) are randomized per pageview,
so `[id*="bg-ssp"]` is the only stable handle. Anchor on the *prefix*, never the full id.

### Gap 4 — Ad Inserter plugin wrappers

`div.code-block.code-block-N` is the WordPress Ad Inserter plugin's standard wrapper.
It is a generic name (deliberately), but on this class of site it is essentially always
an ad slot. Treat as a **medium-confidence** signal, not an unconditional block.

### Gap 5 — zero-height at scan time defeats any size heuristic

At the moment `scanAndBlockAds` runs, most of these slots measure `300x0` / `555x0`.
They inflate later when the creative loads. Any heuristic that gates on
`width >= X && height >= Y` will see nothing and pass. Your `MutationObserver` needs to
re-fire on **attribute/style changes and resize**, not just `childList`.

### Environment note

The extension was **not loaded** in the automation browser profile
(`document.querySelector('[data-eudaimonia-blocked]')` → 0 nodes, on a page with 15 ad
suspects). Any test run must first assert the extension is live, or you will
mis-attribute "extension not injected" as "selector failed." Step 1 of the protocol
below exists for exactly this reason.

---

## Part 1 — The repeatable test protocol

### Stage A — Assert the harness (never skip)

Paste into DevTools console on the target page:

```js
// A1: is content.js actually running in this frame?
console.log('badges:', document.querySelectorAll('.eudaimonia-blocked-badge').length);
console.log('blocked:', document.querySelectorAll('[data-eudaimonia-blocked]').length);
// A2: is it running in SUBFRAMES? manifest has all_frames:true — verify.
console.log('frames:', window.frames.length, 'top?', window === window.top);
```

A run where `blocked === 0` on a known-ad page is a **harness failure**, not a
detection failure. Fix that first.

### Stage B — Capture ground truth (before any code change)

Run `probe.js` (Part 3) and save the output as
`testdata/mangaread-<date>.json`. This is your regression baseline. Repeat on at least
three page loads — ad slots are auction-driven and rotate, so a single load
undercounts. Anything appearing in ≥2 of 3 loads is real; a singleton may be noise.

### Stage C — Coverage diff

`probe.js` reports every visible ad-suspect and whether your current `AD_SELECTORS`
cover it (checking the element *and every ancestor*, matching `blockElement`'s climb).
The output field `topLevelUncovered` is your work queue.

### Stage D — Classify each uncovered node

For each, record one of:

| Class | Meaning | Action |
|---|---|---|
| **N** — Network fingerprint | Stable vendor string (`PUBFUTURE`, `pf-`, `bg-ssp`) | Add to `AD_SELECTORS`. Safe. |
| **H** — Hashed/randomized | `pf-config-6a14…`, `bg-container-1023…` | Add **prefix-anchored** selector only (`[class^="pf-config-"]`). Never the full string. |
| **G** — Generic/ambiguous | `code-block-10`, bare `ad` | Route to heuristic layer with a confidence score, not the hard selector list. |
| **S** — Structural | srcless iframe, sandboxed iframe | Needs a new detection *primitive*, not a selector. |

### Stage E — False-positive gate (the part that actually matters)

Every selector added must be run against a control set before it ships. Any rule that
hides a single node on these pages is rejected:

- The same mangaread chapter page — **the manga images themselves must survive.** Note
  `div.read-container` is 1110x**148094** and is the content root; a climb that reaches
  it destroys the page. Your `containsRealContent` guard is what prevents this — test it.
- A Wikipedia article
- A GitHub repo page
- Any site the user actually reads (pick 2–3 from their history)

Assertion: `document.querySelectorAll('[data-eudaimonia-blocked]').length === 0` on
Wikipedia and GitHub.

### Stage F — Timing sweep

Re-run the probe at four points. A rule that passes at T=10s but misses at T=1s is a
`MutationObserver` bug, not a selector bug — and the user experiences it as "the ad
flashed before it vanished."

| Point | What it catches |
|---|---|
| `document_start` | Nothing yet — establishes the floor |
| DOMContentLoaded | Static/server-rendered slots |
| +3s idle | Auction-filled slots |
| After full scroll to bottom, +3s | Lazy/viewport-triggered slots (**most of these**) |

### Stage G — Regression lock

Keep `testdata/*.json`. Before each release, re-run and diff. Rising
`topLevelUncovered` = the network changed its markup; that's expected and is the
maintenance loop, not a defect.

---

## Part 2 — Proposed fixes

### 2a. Selector additions (Class N + H)

```js
// PubFuture — mangaread's primary network
'[id^="pf-"][class*="PUBFUTURE"]',
'.PUBFUTURE',
'[class^="pf-config-"]',
'.pf-wrapper',
'iframe[id^="iframe_pf-"]',

// BidGear SSP — hex suffixes randomize per pageview, anchor the prefix
'[id^="bg-ssp-"]',
'[class^="bg-container-"]',

// Bare ad-token class names (Gap 2)
'div.c-ads',
'[class~="ad"]',        // ~= matches the whole-word token "ad" only
'[class*="body-top-ads"]',
'[class*="body-bottom-ads"]',
```

Note `[class~="ad"]` (whitespace-token match) rather than `[class*="ad"]` — the latter
would match `header`, `download`, `read-container`, `loading`, and roughly half the web.
This distinction is the whole ballgame; getting it wrong nukes the page.

Also add to `AD_IMAGE_HOST_FRAGMENTS`: `bidgear.com`, `bg-ssp`, `rubiconproject.com`,
`onetag-sys.com` (all observed making requests from this page).

### 2b. New detection primitive — srcless / opaque iframes (Class S)

This is the real fix for Gap 1 and generalizes far beyond this site. An iframe is
high-confidence ad if it satisfies **two or more** of:

- No `src` attribute, or `src` is `about:blank` / `javascript:` / a `data:` URI
- Has a `sandbox` attribute
- Rendered dimensions match a standard IAB unit (300x250, 728x90, 320x50, 300x600,
  160x600, 970x250, 336x280)
- `id` or `name` matches `/^(iframe_)?[a-z]{2,4}[-_]\d{3,}/i` (vendor slot-id pattern)
- Cross-origin `contentWindow` on an element with no accessible document

Require ≥2 signals before blocking so a legitimate srcless iframe (some embeds, some
payment widgets) is not caught by the sandbox check alone.

### 2c. Wrapper reconciliation (Gap 3)

When a matched ad element is hidden, walk **up** while the parent satisfies all of:

- parent's rendered area ≤ 1.6× the child's area
- parent contains no `<video>`, `<audio>`, or non-ad-network `<img>` (your existing
  `containsRealContent`)
- parent contains no text node longer than ~40 chars
- parent is not the content root

…then hide the topmost such parent instead. That converts "blank 330x250 hole" into
"ad removed." Your `blockElement` already climbs; this tightens the stop condition with
an area ratio so it cannot run away up the WordPress wrapper chain.

### 2d. Observer hardening (Gap 5)

Extend the `MutationObserver` config to `{childList:true, subtree:true, attributes:true,
attributeFilter:['style','class','src','id','height','width']}`, and add a
`ResizeObserver` on any element that matched a *medium*-confidence heuristic but was
0-height at scan time — re-evaluate when it inflates. Debounce re-scans to ~250ms.

### 2e. "Block on demand" — the reporting loop

Right now a user who clicks Block on a novel ad fixes it only for themselves. Make that
click generate a **candidate selector fingerprint** (tag + stable class prefixes + id
prefix + dimensions, with hashes stripped) and write it to a Firestore
`ad_signatures` collection with a hit counter. Once N distinct users independently
block the same fingerprint, promote it into the shipped selector list via the existing
feature-flag mechanism.

This turns your existing manual-block UI into a crowdsourced filter list — which is
strategically the interesting part, since it's the same aggregation pattern you already
use for keywords, and it means the extension gets better at blocking without you
personally hunting every network.

---

## Part 3 — `probe.js`

Save as `tools/probe.js`; paste into the console on any page under test.

```js
(() => {
  const AD_SELECTORS = window.__EUDA_SELECTORS || []; // paste live list here
  const m = new Set(document.querySelectorAll(AD_SELECTORS.join(',')));
  const cov = el => { let n = el; while (n) { if (m.has(n)) return true; n = n.parentElement; } return false; };
  const cn = el => ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '').toString();
  const vis = el => { const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 50 && getComputedStyle(el).display !== 'none'; };
  const sig = el => ((el.id || '') + ' ' + cn(el)).toLowerCase();
  const RX = /\bad\b|ads|advert|spon|promo|banner|popup|pubfuture|pf-|bg-container|bg-ssp|code-block|zone|slot|aswift/;
  const chain = el => { const o = []; let n = el;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      o.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
        (cn(n) ? '.' + cn(n).trim().split(/\s+/).join('.') : '')); n = n.parentElement; }
    return o; };
  const sus = [...document.querySelectorAll('div,ins,section,aside,iframe')]
    .filter(el => vis(el) && (RX.test(sig(el)) || el.tagName === 'IFRAME'));
  const un = sus.filter(el => !cov(el));
  const tops = un.filter(el => !un.some(o => o !== el && o.contains(el)));
  const out = {
    url: location.href.split('?')[0],
    ts: new Date().toISOString(),
    harnessLive: document.querySelectorAll('[data-eudaimonia-blocked]').length,
    suspects: sus.length,
    uncovered: un.length,
    topLevelUncovered: tops.map(el => ({
      chain: chain(el),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
      pos: getComputedStyle(el).position,
      innerFrames: el.querySelectorAll('iframe').length,
      srclessFrames: [...el.querySelectorAll('iframe')].filter(f => !f.getAttribute('src')).length
    }))
  };
  console.log(JSON.stringify(out, null, 2));
  copy(JSON.stringify(out));   // lands on clipboard
  return out;
})();
```

**Caution when sharing output:** ad iframe URLs carry long query strings with
identifiers. Strip query strings (the script above does, for `location`) before pasting
probe output anywhere.

---

## Suggested order of work

1. Stage A harness check — confirm the extension actually injects on this page.
   Everything below is meaningless until this passes.
2. Baseline probe ×3 loads, saved.
3. Ship 2a (selectors) + 2d (observer) together — lowest risk, likely resolves most of
   the visible evasion.
4. Re-probe. Measure.
5. Ship 2b (srcless iframe primitive) behind a feature flag. This one has real
   false-positive risk; the flag lets you back it out.
6. Ship 2c (wrapper reconciliation) — cosmetic, fixes the "blank hole" complaint.
7. 2e (crowdsourced signatures) as its own project.
