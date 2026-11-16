// This runs when the popup opens
document.addEventListener('DOMContentLoaded', function() {
  loadData();

  document.getElementById('luckyBtn').addEventListener('click', handleSurpriseMe);

  document.getElementById('profileBtn').addEventListener('click', function() {
    window.location.href = 'profile.html';
  });

  document.getElementById('checkinBtn').addEventListener('click', function() {
    window.location.href = 'checkin.html';
  });

  document.getElementById('promoteBtn').addEventListener('click', function() {
    window.location.href = 'promote.html';
  });

  // Open the token purchase page, passing our uid so the Stripe webhook can
  // credit the right balance after payment. (Safe to pass an unverified uid:
  // tokens are only ever minted on a real, Stripe-verified payment.)
  document.getElementById('tokenBox').addEventListener('click', async function() {
    let url = 'https://eudaimonia-project.netlify.app/#purchase';
    try {
      const user = await storage.ensureAuth();
      if (user && user.uid) {
        url = 'https://eudaimonia-project.netlify.app/?uid=' + encodeURIComponent(user.uid) + '#purchase';
      }
    } catch (e) { /* fall back to the plain purchase URL */ }
    chrome.tabs.create({ url });
  });
});

// ─── "Surprise me" (Feature C) ───────────────────────────────────────────────
// Opens the recommendations sidebar on the active tab in serendipity mode, so
// there is always a way in even on a page where nothing was blocked - and a
// safety net if badgeDismissMode makes in-page badges scarce.
//
// Goes over chrome.tabs.sendMessage -> chrome.runtime.onMessage, the TRUSTED
// extension-internal channel. Deliberately NOT the window.postMessage sidebar
// trigger, which is reachable by any page and therefore carries no payload.

// Schemes where Chrome will not run content scripts at all. Injecting is
// pointless here, so we say something useful instead of failing obscurely.
function isRestrictedUrl(url) {
  if (!url) return true;
  const blocked = [
    'chrome://', 'chrome-extension://', 'chrome-search://', 'chrome-untrusted://',
    'devtools://', 'edge://', 'about:', 'view-source:', 'data:',
    'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
  ];
  return blocked.some(prefix => url.startsWith(prefix));
}

// Chrome's built-in PDF viewer is a plugin document - content scripts don't run
// in it even though the URL looks like an ordinary http(s) page.
function isPdfUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch (e) {
    return false;
  }
}

function setLuckyStatus(message) {
  const box = document.getElementById('luckyStatus');
  if (!box) return;
  if (!message) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.textContent = message;
  box.style.display = 'block';
}

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      void chrome.runtime.lastError;
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

// Resolves to the content script's response, or null if it couldn't be reached.
// frameId 0 targets the top frame only - content.js runs in every frame, and
// only the top frame can render a full-page sidebar.
function askForLuckyRecommendation(tabId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        { action: 'showLuckyRecommendation' },
        { frameId: 0 },
        response => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        }
      );
    } catch (e) {
      resolve(null);
    }
  });
}

// The content script is declared in the manifest, but a tab loaded BEFORE the
// extension was installed or reloaded won't have it. Inject on demand, the same
// fallback background.js already uses for the context-menu path.
function injectContentScript(tabId) {
  return new Promise(resolve => {
    try {
      // CSS first: if the script renders before its styles land, the sidebar
      // appears unstyled for a frame.
      chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] })
        .catch(() => {})   // a missing stylesheet shouldn't block the script
        .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }))
        .then(() => resolve(true))
        .catch(() => resolve(false));
    } catch (e) {
      resolve(false);
    }
  });
}

async function handleSurpriseMe() {
  const btn = document.getElementById('luckyBtn');
  const originalHTML = btn.innerHTML;

  setLuckyStatus('');
  btn.disabled = true;
  btn.style.opacity = '0.75';
  btn.innerHTML = '&#10024; Finding something&hellip;';

  const restore = () => {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.innerHTML = originalHTML;
  };

  try {
    const tab = await getActiveTab();

    if (!tab || !tab.id) {
      setLuckyStatus('Could not find the active tab. Try again in a moment.');
      restore();
      return;
    }

    if (isRestrictedUrl(tab.url)) {
      setLuckyStatus('Chrome does not let extensions run on this page. Open any website and try again.');
      restore();
      return;
    }

    if (isPdfUrl(tab.url)) {
      setLuckyStatus('Chrome’s PDF viewer does not allow extensions. Try this on a normal web page.');
      restore();
      return;
    }

    let result = await askForLuckyRecommendation(tab.id);

    // No response means no content script in that tab (installed/reloaded after
    // the page loaded). Inject, then ask once more.
    if (!result) {
      const injected = await injectContentScript(tab.id);
      if (injected) result = await askForLuckyRecommendation(tab.id);
    }

    if (!result) {
      setLuckyStatus('Could not reach this page. Reloading the tab usually fixes it.');
      restore();
      return;
    }

    if (result.ok) {
      window.close();   // get out of the way so the sidebar is visible
      return;
    }

    if (result.reason === 'no-goals') {
      setLuckyStatus('Add at least one goal in Edit Profile so recommendations can be matched to you.');
    } else if (result.reason === 'no-promos') {
      setLuckyStatus('No recommendations available yet. Be the first — try Promote Link.');
    } else {
      setLuckyStatus('Something went wrong finding a recommendation. Try again.');
    }
    restore();

  } catch (e) {
    setLuckyStatus('Something went wrong finding a recommendation. Try again.');
    restore();
  }
}

// ─── Load data ───────────────────────────────────────────────────────────────

function loadData() {
  chrome.storage.sync.get([
    'setupComplete', 'moveToward', 'dailyHabits', 'moveAway', 'lastCheckin'
  ], function(data) {
    if (!data.setupComplete || (!data.moveToward && !data.dailyHabits)) {
      window.location.href = 'setup.html';
      return;
    }

    displayText('moveTowardText', data.moveToward);
    displayText('moveAwayText', data.moveAway);
    displayText('dailyHabitsText', data.dailyHabits);

    updateCheckinButton(data.lastCheckin || null);
    refreshBalance();
  });
}

// Passive replacement for the old check-in notification: when the weekly window
// has elapsed and a check-in would earn tokens, restyle the Check In button
// (amber + "Tokens ready!") so the cue lives in the popup instead of a system
// notification. Same 7-day rule the rest of the client uses.
function canEarnTokens(lastCheckin) {
  if (!lastCheckin) return true; // never checked in
  const daysSince = (Date.now() - new Date(lastCheckin).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

function updateCheckinButton(lastCheckin) {
  const btn = document.getElementById('checkinBtn');
  if (!btn) return;
  if (canEarnTokens(lastCheckin)) {
    // Swap tonal -> filled. Nothing in this popup is lit at rest, so this is
    // the ONLY thing that ever lights itself without the pointer — which is
    // what makes it read as "there is something here for you" rather than as
    // decoration. A class swap rather than an inline colour, so the palette
    // stays defined in one place (ui.css).
    btn.classList.remove('btn-tonal-green');
    btn.classList.add('btn-ready');
    btn.innerHTML = '&#127873; Check In &mdash; Tokens ready!';
    btn.title = 'You can earn tokens with this check-in';
  }
  // Otherwise leave the default tonal "Check In" state from popup.html.
}

// Balance is now canonical in Firestore (users/{uid}); read it from there
// rather than from local storage, so purchased/earned/spent tokens are always
// the server's source of truth.
async function refreshBalance() {
  const el = document.getElementById('tokenCount');
  if (el) el.textContent = '…'; // loading state while we fetch from Firestore
  const tokens = await storage.getBalance();
  if (el) el.textContent = tokens;

  if (tokens < 2 && el) {
    el.style.color = '#b3261e';   // #ff6b6b was 2.1:1 on the token tint
    if (!document.getElementById('lowTokenTip')) {
      var tipDiv = document.createElement('div');
      tipDiv.id = 'lowTokenTip';
      tipDiv.className = 'note-amber';   // shares the palette's advisory style
      tipDiv.style.marginTop = '15px';
      tipDiv.innerHTML = '&#128161; <strong>Low on tokens?</strong> Complete your weekly check-in to earn more!';
      document.body.appendChild(tipDiv);
    }
  }
}

function displayText(elementId, text) {
  var element = document.getElementById(elementId);
  if (text && text.trim()) {
    element.textContent = text;
  } else {
    element.textContent = 'Not set yet';
    element.style.fontStyle = 'italic';
    element.style.color = '#999';
  }
}
