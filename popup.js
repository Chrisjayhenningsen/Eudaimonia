// This runs when the popup opens
document.addEventListener('DOMContentLoaded', function() {
  loadData();

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

// ─── Load data ───────────────────────────────────────────────────────────────

function loadData() {
  chrome.storage.sync.get([
    'setupComplete', 'moveToward', 'dailyHabits', 'moveAway'
  ], function(data) {
    if (!data.setupComplete || (!data.moveToward && !data.dailyHabits)) {
      window.location.href = 'setup.html';
      return;
    }

    displayText('moveTowardText', data.moveToward);
    displayText('moveAwayText', data.moveAway);
    displayText('dailyHabitsText', data.dailyHabits);

    refreshBalance();
  });
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
    el.style.color = '#ff6b6b';
    if (!document.getElementById('lowTokenTip')) {
      var tipDiv = document.createElement('div');
      tipDiv.id = 'lowTokenTip';
      tipDiv.style.cssText = 'background:#fff3cd;padding:10px;margin-top:15px;border-radius:6px;font-size:12px;color:#856404;';
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
