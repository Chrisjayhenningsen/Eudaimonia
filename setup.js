// Setup state
let currentStep = 0; // Start at welcome screen
const totalSteps = 5;
let isEditing = false;

// Run when page loads
document.addEventListener('DOMContentLoaded', function() {
  // Check if user is editing (already completed setup)
  chrome.storage.sync.get(['setupComplete'], function(data) {
    if (data.setupComplete) {
      isEditing = true;
      loadExistingData();
      // The invite-code redemption field only ever does anything for a
      // brand-new setup (see completeSetup's isEditing branch below) - hide
      // it for returning users editing their profile so it doesn't look
      // like a live control that silently does nothing.
      const inviteSection = document.getElementById('inviteCodeSection');
      if (inviteSection) inviteSection.style.display = 'none';
    }
  });
  
  showStep(0);
  updateProgress();
  
  document.getElementById('nextBtn').addEventListener('click', handleNext);
  document.getElementById('backBtn').addEventListener('click', handleBack);
});

function loadExistingData() {
  chrome.storage.sync.get([
    'moveToward',
    'moveAway', 
    'dailyHabits',
    'productCategories',
    'checkinDay',
    'checkinTime'
  ], function(data) {
    if (data.moveToward) document.getElementById('moveToward').value = data.moveToward;
    if (data.moveAway) document.getElementById('moveAway').value = data.moveAway;
    if (data.dailyHabits) document.getElementById('dailyHabits').value = data.dailyHabits;
    if (data.productCategories) document.getElementById('productCategories').value = data.productCategories;
    if (data.checkinDay !== undefined) document.getElementById('checkinDay').value = data.checkinDay;
    if (data.checkinTime) document.getElementById('checkinTime').value = data.checkinTime;
  });
}

function handleNext() {
  if (currentStep === totalSteps) {
    completeSetup();
  } else {
    currentStep++;
    showStep(currentStep);
    updateProgress();
  }
}

function handleBack() {
  if (currentStep > 0) {
    currentStep--;
    showStep(currentStep);
    updateProgress();
  }
}

function showStep(stepNum) {
  document.querySelectorAll('.step').forEach(step => {
    step.classList.remove('active');
  });
  
  if (stepNum === 0) {
    document.getElementById('stepWelcome').classList.add('active');
    document.getElementById('backBtn').style.display = 'none';
    document.getElementById('nextBtn').textContent = 'Get Started →';
    return;
  }
  
  if (stepNum <= totalSteps) {
    document.getElementById('step' + stepNum).classList.add('active');
  } else {
    document.getElementById('stepComplete').classList.add('active');
  }
  
  const backBtn = document.getElementById('backBtn');
  const nextBtn = document.getElementById('nextBtn');
  
  if (stepNum >= 1) {
    backBtn.style.display = 'block';
  }
  
  if (stepNum === totalSteps) {
    nextBtn.textContent = 'Complete Setup';
  } else if (stepNum > totalSteps) {
    nextBtn.textContent = 'Start Using Eudaimonia';
  } else {
    nextBtn.textContent = 'Next';
  }
}

function updateProgress() {
  const dots = document.querySelectorAll('.progress-dot');
  const progressContainer = document.getElementById('progress');
  
  if (currentStep === 0) {
    progressContainer.style.display = 'none';
    return;
  }
  
  progressContainer.style.display = 'flex';
  
  dots.forEach((dot, index) => {
    dot.classList.remove('active', 'complete');
    if (index < currentStep - 1) {
      dot.classList.add('complete');
    } else if (index === currentStep - 1) {
      dot.classList.add('active');
    }
  });
}

async function completeSetup() {
  const setupData = {
    moveToward: document.getElementById('moveToward').value.trim(),
    moveAway: document.getElementById('moveAway').value.trim(),
    dailyHabits: document.getElementById('dailyHabits').value.trim(),
    productCategories: document.getElementById('productCategories').value.trim(),
    checkinDay: document.getElementById('checkinDay').value,
    checkinTime: document.getElementById('checkinTime').value,
    setupComplete: true
  };
  
  if (isEditing) {
    chrome.storage.sync.set(setupData, async function() {
      // MUST be awaited: this does two sequential Firestore calls. Without
      // awaiting, the window.location.href navigation below fires almost
      // immediately after, destroying this page's JS context and silently
      // killing the aggregation before it completes - it was never
      // reaching Firestore at all on profile edits before this fix.
      if (typeof aggregateUserKeywords === 'function') {
        await aggregateUserKeywords(setupData);
      }
      window.location.href = 'popup.html';
    });
  } else {
    setupData.setupDate = new Date().toISOString();

    const inviteCodeInput = document.getElementById('inviteCode');
    const inviteCode = inviteCodeInput ? inviteCodeInput.value.trim() : '';
    const statusEl = document.getElementById('inviteCodeStatus');

    // Save the profile locally. Tokens are NOT stored locally anymore — the
    // balance is canonical in Firestore and granted server-side.
    chrome.storage.sync.set(setupData, async function() {
      if (typeof aggregateUserKeywords === 'function') {
        await aggregateUserKeywords(setupData);
      }

      // Grant the one-time onboarding tokens server-side (idempotent per user).
      try {
        await storage.callFn('claim-onboarding', {});
      } catch (e) {
        console.warn('Eudaimonia: onboarding grant failed (non-fatal):', e?.message);
      }

      // Redeem an invite code if one was entered (server credits both parties).
      let inviteOk = false;
      if (inviteCode) {
        if (statusEl) {
          statusEl.textContent = 'Checking invite code...';
          statusEl.style.color = '#666';
          statusEl.style.display = 'block';
        }
        document.getElementById('nextBtn').disabled = true;
        const result = await storage.redeemInviteCode(inviteCode);
        document.getElementById('nextBtn').disabled = false;
        inviteOk = result.success;
        if (!inviteOk && statusEl) {
          statusEl.textContent = `❌ ${result.error}`;
          statusEl.style.color = '#c92a2a';
          statusEl.style.display = 'block';
        }
      }

      // Show the resulting balance, read back from the server.
      const balance = await storage.getBalance();
      const finalCount = document.getElementById('finalTokenCount');
      if (finalCount) {
        finalCount.textContent = balance;
        if (inviteOk) {
          finalCount.insertAdjacentHTML('afterend',
            `<div style="font-size:12px;color:#51cf66;margin-top:4px;">includes 2 bonus tokens from your invite code 🎉</div>`
          );
        }
      }

      currentStep = totalSteps + 1;
      showStep(currentStep);
      updateProgress();

      const nextBtn = document.getElementById('nextBtn');
      nextBtn.onclick = function() {
        window.location.href = 'popup.html';
      };
    });
  }
}
