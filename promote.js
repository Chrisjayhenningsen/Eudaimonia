// Load data when page opens
document.addEventListener('DOMContentLoaded', function() {
  loadTokenCount();
  
  // On URL blur: check cost + run Safe Browsing
  document.getElementById('promoUrl').addEventListener('blur', async function() {
    checkPromotionCost();
    await checkUrlSafety();
  });
  
  document.getElementById('submitBtn').addEventListener('click', submitPromotion);
  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.location.href = 'popup.html';
  });
  document.getElementById('insightsBtn').addEventListener('click', function() {
    window.location.href = 'insights.html';
  });
});

function loadTokenCount() {
  chrome.storage.sync.get(['tokens', 'invites'], function(data) {
    document.getElementById('tokenCount').textContent = data.tokens || 0;
    document.getElementById('inviteCount').textContent = data.invites || 0;
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

function checkPromotionCost() {
  const url = document.getElementById('promoUrl').value.trim();
  if (!url) return;
  
  const normalizedUrl = normalizeUrl(url);
  
  chrome.storage.sync.get(['myPromotions', 'tokens'], function(data) {
    const myPromotions = data.myPromotions || [];
    const tokens = data.tokens || 0;
    
    const alreadyPromoted = myPromotions.some(promo => 
      normalizeUrl(promo.url) === normalizedUrl
    );
    const cost = alreadyPromoted ? 2 : 1;
    
    const costDisplay = document.getElementById('costDisplay');
    costDisplay.style.display = 'block';
    costDisplay.className = 'cost-display';
    costDisplay.innerHTML = `
      Cost: <span class="cost-amount">${cost} token${cost > 1 ? 's' : ''}</span>
      ${alreadyPromoted
        ? '<br><small>(Re-promoting your own link)</small>'
        : '<br><small>(First time or promoting for someone else)</small>'}
    `;
    
    const warningDisplay = document.getElementById('warningDisplay');
    if (tokens < cost) {
      warningDisplay.style.display = 'block';
      warningDisplay.className = 'warning';
      warningDisplay.textContent = `You need ${cost - tokens} more token${cost - tokens > 1 ? 's' : ''} to submit this promotion.`;
      document.getElementById('submitBtn').disabled = true;
    } else {
      warningDisplay.style.display = 'none';
      // Note: don't re-enable here — Safe Browsing may have disabled it
    }
  });
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '') + urlObj.pathname.replace(/\/$/, '');
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

async function submitPromotion() {
  const url = document.getElementById('promoUrl').value.trim();
  const title = document.getElementById('promoTitle').value.trim();
  const description = document.getElementById('promoDescription').value.trim();
  const keywords = document.getElementById('promoKeywords').value.trim();
  
  if (!url || !title || !description || !keywords) {
    alert('Please fill in all fields');
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
  
  chrome.storage.sync.get(['myPromotions', 'tokens'], async function(data) {
    const myPromotions = data.myPromotions || [];
    const tokens = data.tokens || 0;
    
    const alreadyPromoted = myPromotions.some(promo => 
      normalizeUrl(promo.url) === normalizedUrl
    );
    const cost = alreadyPromoted ? 2 : 1;
    
    if (tokens < cost) {
      alert(`You need ${cost} tokens to submit this promotion. You have ${tokens}.`);
      document.getElementById('submitBtn').disabled = false;
      return;
    }

    // Invite gate: first-ever promotion requires an invite
    const isFirstPromotion = myPromotions.length === 0;
    if (isFirstPromotion) {
      const invites = await new Promise(resolve =>
        chrome.storage.sync.get(['invites'], d => resolve(d.invites || 0))
      );
      if (invites < 1) {
        alert('You need an invite to submit your first promotion. Earn more by completing check-ins!');
        document.getElementById('submitBtn').disabled = false;
        return;
      }
    }
    
    const promotion = {
      url,
      title,
      description,
      keywords: keywords.split(',').map(k => k.trim().toLowerCase()),
      timestamp: new Date().toISOString(),
      cost,
      budget: cost,
      clicks: 0
    };
    
    const success = await storage.savePromotion(promotion, isFirstPromotion);
    
    if (!success) {
      alert('Failed to submit promotion. Please try again.');
      document.getElementById('submitBtn').disabled = false;
      return;
    }
    
    myPromotions.push({ url, timestamp: new Date().toISOString() });
    const newTokenCount = tokens - cost;
    
    chrome.storage.sync.set({ myPromotions, tokens: newTokenCount }, function() {
      alert(
        `✅ Promotion submitted successfully!\n\n` +
        `Cost: ${cost} token${cost > 1 ? 's' : ''}\n` +
        `Remaining tokens: ${newTokenCount}\n` +
        `Budget: ${cost} click${cost > 1 ? 's' : ''}\n\n` +
        `💡 Your link will appear in the sidebar when users block ads. Check Advertiser Insights to track clicks!`
      );
      window.location.href = 'popup.html';
    });
  });
}
