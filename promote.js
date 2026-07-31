// Flat cost for every promotion submission - no more first-time/repeat tiering.
const PROMOTION_COST = 1;

// Load data when page opens
document.addEventListener('DOMContentLoaded', function() {
  loadTokenCount();
  initEmailAndInviteUI();

  // On URL blur: check cost + run Safe Browsing + decide whether to show the
  // owner-invite prompt for this specific URL.
  document.getElementById('promoUrl').addEventListener('blur', async function() {
    checkPromotionCost();
    await checkUrlSafety();
    await checkOwnerInvitePrompt();
  });

  document.getElementById('submitBtn').addEventListener('click', submitPromotion);
  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.location.href = 'popup.html';
  });
  document.getElementById('insightsBtn').addEventListener('click', function() {
    window.location.href = 'insights.html';
  });
});

async function loadTokenCount() {
  const el = document.getElementById('tokenCount');
  if (el) el.textContent = '…'; // loading state while we fetch from Firestore
  const tokens = await storage.getBalance();
  if (el) el.textContent = tokens;
}

// Shows the "verify your email" field once, permanently, if this account has
// never submitted a promotion before - independent of which URL is typed in,
// since this gate is about the PERSON, not the link.
function initEmailAndInviteUI() {
  chrome.storage.sync.get(['myPromotions'], function(data) {
    const myPromotions = data.myPromotions || [];
    if (myPromotions.length === 0) {
      document.getElementById('verifyEmailGroup').style.display = 'block';
    }
  });
}

// --- Review display helper ---
function showReview(type, message) {
  const div = document.getElementById('reviewDisplay');
  div.style.display = type ? 'block' : 'none';
  div.className = type || '';
  div.innerHTML = message || '';
}

// --- Layer 1: Safe Browsing check on URL blur ---
// Known-bad domains as a last-resort fallback when Safe Browsing API is unavailable.
// These are Google's own test URLs plus obvious malware patterns.
const BLOCKED_DOMAINS = [
  'malware.testing.google.test',
  'phishing.testing.google.test',
  'testsafebrowsing.appspot.com',
  'eicar.org' // standard antivirus test domain
];

async function checkUrlSafety() {
  const url = document.getElementById('promoUrl').value.trim();
  if (!url) return;

  // Layer 0: hardcoded domain blocklist (always runs, no API needed)
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      showReview('review-blocked',
        `<strong>⛔ URL not permitted</strong>` +
        `This domain cannot be submitted.`
      );
      document.getElementById('submitBtn').disabled = true;
      return;
    }
  } catch (e) {
    // Invalid URL — let the later validation catch it
  }

  let safeBrowsingKey = null;
  try {
    const flags = await storage.getFeatureFlags();
    safeBrowsingKey = flags.safeBrowsingKey || null;
  } catch (e) { /* non-blocking */ }

  if (!safeBrowsingKey) {
    // Key not configured — show a neutral notice but don't block submission
    showReview(null, '');
    document.getElementById('submitBtn').disabled = false;
    console.warn('Safe Browsing key not configured in Firebase feature flags.');
    return;
  }

  showReview('review-checking', '🔍 Checking URL safety...');
  document.getElementById('submitBtn').disabled = true;

  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${safeBrowsingKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'eudaimonia', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: [
              'MALWARE',
              'SOCIAL_ENGINEERING',
              'UNWANTED_SOFTWARE',
              'POTENTIALLY_HARMFUL_APPLICATION'
            ],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    if (!response.ok) {
      // The check did not actually run. Without this branch, a 403/401 error
      // body falls through as "no matches" and gets treated as a clean URL —
      // a silent false negative that disables URL safety with no signal at all.
      let detail = '';
      try {
        const errBody = await response.json();
        detail = errBody?.error?.message || '';
      } catch (e) { /* error body may not be JSON */ }

      if (response.status === 401 || response.status === 403) {
        console.error(
          `Safe Browsing check DID NOT RUN (HTTP ${response.status}) — URL safety is ` +
          `NOT being enforced. Usually means the Safe Browsing API is not enabled on ` +
          `the Cloud project, or the API key is restricted/revoked. ${detail}`
        );
      } else {
        console.error(`Safe Browsing check failed (HTTP ${response.status}). ${detail}`);
      }

      // Fail open, per the existing policy: don't block legitimate submitters
      // when the service is unavailable.
      showReview(null, '');
      document.getElementById('submitBtn').disabled = false;
      return;
    }

    const data = await response.json();

    if (data.matches && data.matches.length > 0) {
      const threatType = data.matches[0].threatType.replace(/_/g, ' ').toLowerCase();
      showReview('review-blocked',
        `<strong>⛔ URL blocked by Google Safe Browsing</strong>` +
        `This URL has been flagged as <em>${threatType}</em> and cannot be submitted.`
      );
      document.getElementById('submitBtn').disabled = true;
    } else {
      showReview(null, '');
      document.getElementById('submitBtn').disabled = false;
    }
  } catch (error) {
    // Fail open — don't block legitimate submitters if Safe Browsing is unavailable
    console.error('Safe Browsing check failed:', error);
    showReview(null, '');
    document.getElementById('submitBtn').disabled = false;
  }
}

// --- Owner-invite prompt: shown per-URL, only for links this user hasn't
// promoted before. No toggle, no "don't ask again" - just an optional field
// that's either filled in or isn't. It reappears every time a genuinely new
// URL is entered by design: a persistent opt-out would mean someone who
// dismisses it once by default never sees it again even on the rare link
// where they'd actually want it. ---
async function checkOwnerInvitePrompt() {
  const url = document.getElementById('promoUrl').value.trim();
  const group = document.getElementById('ownerInviteGroup');
  if (!url) {
    group.style.display = 'none';
    return;
  }

  const normalizedUrl = normalizeUrl(url);

  chrome.storage.sync.get(['myPromotions'], function(data) {
    const myPromotions = data.myPromotions || [];
    const alreadyPromoted = myPromotions.some(promo =>
      normalizeUrl(promo.url) === normalizedUrl
    );

    if (alreadyPromoted) {
      group.style.display = 'none';
      return;
    }

    group.style.display = 'block';
  });
}

async function checkPromotionCost() {
  const url = document.getElementById('promoUrl').value.trim();
  if (!url) return;

  const tokens = await storage.getBalance();

  const costDisplay = document.getElementById('costDisplay');
  costDisplay.style.display = 'block';
  costDisplay.className = 'cost-display';
  costDisplay.innerHTML = `
    Cost: <span class="cost-amount">${PROMOTION_COST} token</span>
  `;

  const warningDisplay = document.getElementById('warningDisplay');
  if (tokens < PROMOTION_COST) {
    warningDisplay.style.display = 'block';
    warningDisplay.className = 'warning';
    warningDisplay.textContent = `You need ${PROMOTION_COST - tokens} more token${(PROMOTION_COST - tokens) > 1 ? 's' : ''} to submit this promotion.`;
    document.getElementById('submitBtn').disabled = true;
  } else {
    warningDisplay.style.display = 'none';
    // Note: don't re-enable here — Safe Browsing may have disabled it
  }
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '') + urlObj.pathname.replace(/\/$/, '');
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || '').trim());
}

// Generates an EUDA-XXXX invite code purely client-side - no network call
// needed to produce it. Matches the format of firebase-config.js's
// generateInviteCode so codes from either path look identical. The code
// isn't actually redeemable until storage.registerGeneratedInviteCode(code)
// writes it to Firestore, which we fire off in the background (not awaited)
// as soon as the code is generated.
function generateLocalInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `EUDA-${suffix}`;
}

// Single source of truth for the invite email's subject and body.
function buildInviteContent(code) {
  const subject = 'Join me on Eudaimonia - block distracting ads & stay focused';
  const bodyLines = [
    'Hey,',
    '',
    'I\'ve been using a Chrome extension called Eudaimonia that helps me block distracting ads ' +
      'and replace them with recommendations actually aligned with my goals.',
    '',
    'I\'ve promoted your product on this platform because I believe in your mission - if you join, ' +
      'you can get free ad credits in the future!',
    '',
    'You can install it here:',
    'https://chrome.google.com/webstore/detail/eudaimonia',
    '',
    `Use invite code ${code} when you sign up to unlock bonus tokens.`,
    '',
    'Hope you find it useful!'
  ];
  return { subject, body: bodyLines.join('\n') };
}

// Builds a mailto: with the invitation pre-filled but NO recipient — the user
// types the owner's address into their own mail client. This mirrors the stable
// v0.5 invite, which is known to work in the extension context.
function buildInviteMailto(code) {
  const { subject, body } = buildInviteContent(code);
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Opens the pre-filled invitation email via chrome.tabs.create — exactly the
// mechanism the v0.5 popup used successfully. Chrome hands the mailto: off to
// the user's configured mail handler; the recipient is left blank for the user
// to fill in and send.
function openInviteEmail(code) {
  chrome.tabs.create({ url: buildInviteMailto(code) });
}

async function submitPromotion() {
  const url = document.getElementById('promoUrl').value.trim();
  const title = document.getElementById('promoTitle').value.trim();
  const description = document.getElementById('promoDescription').value.trim();
  const keywords = document.getElementById('promoKeywords').value.trim();

  if (!url || !title || !description || !keywords) {
    alert('Please fill in all required fields');
    return;
  }

  try {
    new URL(url);
  } catch (e) {
    alert('Please enter a valid URL (including https://)');
    return;
  }

  // --- Layer 2: Blocklist check on title/description/keywords ---
  showReview('review-checking', '🔍 Reviewing submission...');
  document.getElementById('submitBtn').disabled = true;

  const blocklistResult = await storage.checkBlocklist(title, description, keywords);
  if (blocklistResult.blocked) {
    showReview('review-blocked',
      `<strong>⛔ Submission blocked</strong>${blocklistResult.reason}`
    );
    return; // Leave button disabled — user must edit content to proceed
  }

  showReview(null, '');

  const normalizedUrl = normalizeUrl(url);

  chrome.storage.sync.get(['myPromotions'], async function(data) {
    const myPromotions = data.myPromotions || [];

    const isFirstPromotion = myPromotions.length === 0;
    const alreadyPromoted = myPromotions.some(promo =>
      normalizeUrl(promo.url) === normalizedUrl
    );

    // First-ever submission requires a verified email (anti-spam gate).
    let promoterEmail = '';
    if (isFirstPromotion) {
      promoterEmail = (document.getElementById('promoterEmail').value || '').trim();
      if (!promoterEmail || !isValidEmail(promoterEmail)) {
        alert('Please enter a valid email address to verify your first submission.');
        document.getElementById('submitBtn').disabled = false;
        return;
      }
    }

    // Pre-check the balance for a friendly message; the backend enforces it too.
    const balance = await storage.getBalance();
    if (balance < PROMOTION_COST) {
      alert(`You need ${PROMOTION_COST} token${PROMOTION_COST > 1 ? 's' : ''} to submit this promotion. You have ${balance}.`);
      document.getElementById('submitBtn').disabled = false;
      return;
    }

    const promotion = {
      url,
      title,
      description,
      keywords: keywords.split(',').map(k => k.trim().toLowerCase()),
      timestamp: new Date().toISOString(),
      cost: PROMOTION_COST,
      budget: PROMOTION_COST,
      clicks: 0
    };

    // The spend (create promotion + debit balance) happens server-side.
    const res = await storage.savePromotion(promotion, isFirstPromotion, promoterEmail);

    if (!res.success) {
      const msg = res.error === 'INSUFFICIENT_TOKENS'
          ? "You don't have enough tokens to submit this promotion."
        : res.error === 'BLOCKED_CONTENT'
          ? 'This submission was blocked by our content filter.'
        : res.error === 'AUTH_REQUIRED'
          ? "Couldn't sign you in. Please check your connection and try again."
        : 'Failed to submit promotion. Please try again.';
      alert(msg);
      document.getElementById('submitBtn').disabled = false;
      return;
    }

    myPromotions.push({ url, timestamp: new Date().toISOString() });

    // Owner invite: if this is a genuinely new URL and the user left the
    // "Invite the owner" toggle on (its default), open a pre-filled invitation
    // email. No recipient is set — the user adds the owner's address and sends
    // it from their own mail client. The generated code is registered so the
    // invite stays trackable/redeemable in the backend.
    const wantsInvite = document.getElementById('ownerInviteToggle').checked;
    const offerInvite = !alreadyPromoted && wantsInvite;

    if (offerInvite) {
      const code = generateLocalInviteCode();
      storage.registerGeneratedInviteCode(code); // fire-and-forget
      openInviteEmail(code);
    }

    chrome.storage.sync.set({ myPromotions }, function() {
      alert(
        `✅ Promotion submitted successfully!\n\n` +
        `Cost: ${PROMOTION_COST} token${PROMOTION_COST > 1 ? 's' : ''}\n` +
        `Remaining tokens: ${res.balance}\n` +
        `Budget: ${PROMOTION_COST} click${PROMOTION_COST > 1 ? 's' : ''}\n\n` +
        `Your link will appear in the sidebar when users block ads. Check Advertiser Insights to track clicks!`
      );
      window.location.href = 'popup.html';
    });
  });
}
