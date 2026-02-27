// Check if setup is complete, redirect to setup if not
chrome.storage.sync.get(['setupComplete', 'moveToward', 'dailyHabits'], function(data) {
  // Redirect to setup if either:
  // 1. setupComplete flag is not set, OR
  // 2. Key fields are empty (meaning user never actually filled out setup)
  if (!data.setupComplete || (!data.moveToward && !data.dailyHabits)) {
    window.location.href = 'setup.html';
    return; // Stop execution
  }
});

// This runs when the popup opens
document.addEventListener('DOMContentLoaded', function() {
  // Load and display current data
  loadData();
  
  // Set up the Profile button
  document.getElementById('profileBtn').addEventListener('click', function() {
    window.location.href = 'profile.html';
  });
  
  // Set up the Check In button
  document.getElementById('checkinBtn').addEventListener('click', function() {
    window.location.href = 'checkin.html';
  });
  
  // Set up the Promote Link button
  document.getElementById('promoteBtn').addEventListener('click', function() {
    window.location.href = 'promote.html';
  });

  // Invite card — toggle panel on click (only when user has invites)
  document.getElementById('inviteCard').addEventListener('click', function() {
    const invites = parseInt(document.getElementById('inviteCount').textContent) || 0;
    if (invites === 0) return;
    const panel = document.getElementById('invitePanel');
    const card = document.getElementById('inviteCard');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    // Round bottom corners on card only when panel is closed
    card.style.borderRadius = isOpen ? '8px' : '8px 8px 0 0';
  });

  // Send invite — generate code and open mailto
  document.getElementById('sendInviteBtn').addEventListener('click', async function() {
    const email = document.getElementById('inviteEmail').value.trim();
    const statusEl = document.getElementById('inviteStatus');
    const codeDisplay = document.getElementById('inviteCodeDisplay');
    const codeText = document.getElementById('inviteCodeText');

    if (!email || !email.includes('@')) {
      statusEl.textContent = 'Please enter a valid email address.';
      statusEl.style.color = '#c92a2a';
      statusEl.style.display = 'block';
      return;
    }

    this.disabled = true;
    this.textContent = 'Generating code...';
    statusEl.style.display = 'none';

    const code = await storage.generateInviteCode();

    if (!code) {
      statusEl.textContent = 'Could not generate invite code. Please try again.';
      statusEl.style.color = '#c92a2a';
      statusEl.style.display = 'block';
      this.disabled = false;
      this.textContent = 'Generate Code & Open Email';
      return;
    }

    // Show the code
    codeText.textContent = code;
    codeDisplay.style.display = 'block';

    // Build the mailto
    const subject = encodeURIComponent('This Chrome Extension wants to make advertising a net positive');
    const storeUrl = 'https://chromewebstore.google.com/detail/eudaimonia/pjmfochokhnbcapfmgapipmdnamehgii';
    const body = encodeURIComponent(
      `I just installed an extension that replaced my ads with things I actually want. ` +
      `Now instead of advertising distracting from my goals it's a serendipity booster. ` +
      `Check it out here: ${storeUrl}\n\n` +
      `When you complete setup, enter this invite code and we'll both get bonus tokens — ` +
      `those can be used to submit our own ads to people whose long term goals are supported by seeing them!\n\n` +
      `${code}`
    );

    window.open(`mailto:${email}?subject=${subject}&body=${body}`);

    statusEl.textContent = '✅ Email client opened! Your code is saved.';
    statusEl.style.color = '#2e7d32';
    statusEl.style.display = 'block';
    this.disabled = false;
    this.textContent = 'Send Another Invite';
  });
});

// Load all user data from storage
function loadData() {
  chrome.storage.sync.get([
    'tokens', 
    'invites', 
    'moveToward', 
    'moveAway', 
    'dailyHabits'
  ], function(data) {
    // Display token and invite counts
    const tokens = data.tokens || 0;
    const invites = data.invites || 0;
    
    document.getElementById('tokenCount').textContent = tokens;
    document.getElementById('inviteCount').textContent = invites;

    // Hide "click to use" hint and pointer cursor when no invites left
    const inviteCard = document.getElementById('inviteCard');
    const inviteHint = document.getElementById('inviteClickHint');
    if (invites === 0) {
      inviteHint.style.display = 'none';
      inviteCard.style.cursor = 'default';
    } else {
      inviteHint.style.display = 'block';
      inviteCard.style.cursor = 'pointer';
    }
    
    // Add helpful tip if tokens are low
    const tokenElement = document.getElementById('tokenCount');
    if (tokens < 2) {
      tokenElement.style.color = '#ff6b6b';
      // Add a small tip below the popup
      const tipDiv = document.createElement('div');
      tipDiv.style.cssText = 'background: #fff3cd; padding: 10px; margin-top: 15px; border-radius: 6px; font-size: 12px; color: #856404;';
      tipDiv.innerHTML = '💡 <strong>Low on tokens?</strong> Complete your weekly check-in to earn more!';
      document.querySelector('body').appendChild(tipDiv);
    }
    
    // Display goals and systems
    displayText('moveTowardText', data.moveToward);
    displayText('moveAwayText', data.moveAway);
    displayText('dailyHabitsText', data.dailyHabits);
  });
}

// Helper function to display text or show "Not set"
function displayText(elementId, text) {
  const element = document.getElementById(elementId);
  if (text && text.trim()) {
    element.textContent = text;
  } else {
    element.textContent = 'Not set yet';
    element.style.fontStyle = 'italic';
    element.style.color = '#999';
  }
}
