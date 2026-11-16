// Server-side Google Safe Browsing proxy.
//
// WHY: the extension used to call safebrowsing.googleapis.com directly from
// promote.js, using a key read from the world-readable config/featureFlags doc.
// A key used from the browser can never be secret, so we move the call here and
// keep the key in a Netlify env var (SAFE_BROWSING_KEY) that no client can read.
//
// No auth — same as record-click / aggregate-keywords / report-ad-signature.
// It only reports whether one URL is flagged, so abuse value is low; a Firestore
// rate limit can be layered on in the rate-limiting pass (Task 3).
//
// Contract:  POST { url }  →  200 { checked, unsafe, threatType? }
//   checked=false  → the lookup could NOT run (missing key / upstream error);
//                    the client treats this as "fail open" exactly as today.
//   unsafe=true    → Safe Browsing flagged the URL; client blocks submission.
//
// Follows the create-checkout.js precedent of importing json/preflight from
// _admin without needing Firestore itself.

const { json, preflight } = require('./_admin');

const THREAT_INFO = {
  threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
  platformTypes: ['ANY_PLATFORM'],
  threatEntryTypes: ['URL'],
};

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let url;
  try { ({ url } = JSON.parse(event.body)); } catch (e) { return json(400, { error: 'Invalid body' }); }
  if (!url || typeof url !== 'string') return json(400, { error: 'Missing url' });

  // Only http(s) URLs are forwarded upstream.
  try {
    const scheme = new URL(url).protocol;
    if (scheme !== 'http:' && scheme !== 'https:') return json(400, { error: 'Unsupported URL scheme' });
  } catch (e) {
    return json(400, { error: 'Invalid url' });
  }

  const key = process.env.SAFE_BROWSING_KEY;
  if (!key) {
    console.error('SAFE_BROWSING_KEY not set — Safe Browsing check cannot run (failing open).');
    return json(200, { checked: false, unsafe: false });
  }

  try {
    const resp = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'eudaimonia', clientVersion: '1.0' },
          threatInfo: { ...THREAT_INFO, threatEntries: [{ url }] },
        }),
      }
    );

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json())?.error?.message || ''; } catch (e) { /* body may not be JSON */ }
      if (resp.status === 401 || resp.status === 403) {
        console.error(
          `Safe Browsing DID NOT RUN (HTTP ${resp.status}) — key restricted/revoked or ` +
          `Safe Browsing API not enabled on the Cloud project. ${detail}`
        );
      } else {
        console.error(`Safe Browsing upstream HTTP ${resp.status}. ${detail}`);
      }
      return json(200, { checked: false, unsafe: false }); // fail open
    }

    const data = await resp.json();
    if (data.matches && data.matches.length > 0) {
      return json(200, { checked: true, unsafe: true, threatType: data.matches[0].threatType || 'THREAT' });
    }
    return json(200, { checked: true, unsafe: false });
  } catch (err) {
    console.error('Safe Browsing proxy error:', err);
    return json(200, { checked: false, unsafe: false }); // fail open
  }
};
