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
    // Populate form fields with existing data
    if (data.moveToward) document.getElementById('moveToward').value = data.moveToward;
    if (data.moveAway) document.getElementById('moveAway').value = data.moveAway;
    if (data.dailyHabits) document.getElementById('dailyHabits').value = data.dailyHabits;
    if (data.productCategories) document.getElementById('productCategories').value = data.productCategories;
    if (data.checkinDay) document.getElementById('checkinDay').value = data.checkinDay;
    if (data.checkinTime) document.getElementById('checkinTime').value = data.checkinTime;
  });
}

function handleNext() {
  if (currentStep === totalSteps) {
    // On last step, save everything and complete setup
    completeSetup();
  } else {
    // Move to next step
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
  // Hide all steps
  document.querySelectorAll('.step').forEach(step => {
    step.classList.remove('active');
  });
  
  // Show welcome screen (step 0)
  if (stepNum === 0) {
    document.getElementById('stepWelcome').classList.add('active');
    document.getElementById('backBtn').style.display = 'none';
    document.getElementById('nextBtn').textContent = 'Get Started →';
    return;
  }
  
  // Show current step
  if (stepNum <= totalSteps) {
    document.getElementById('step' + stepNum).classList.add('active');
  } else {
    document.getElementById('stepComplete').classList.add('active');
  }
  
  // Update buttons
  const backBtn = document.getElementById('backBtn');
  const nextBtn = document.getElementById('nextBtn');
  
  if (stepNum === 1) {
    backBtn.style.display = 'block'; // Can go back to welcome
  } else if (stepNum > 1) {
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
  
  // Hide progress on welcome screen
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
  // Gather all the data
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
    // If editing, just save the updates and go back to popup
    chrome.storage.sync.set(setupData, function() {
      // Update keyword aggregation
      if (typeof aggregateUserKeywords === 'function') {
        aggregateUserKeywords(setupData);
      }
      window.location.href = 'popup.html';
    });
  } else {
    // If new setup, award base tokens and invites
    setupData.tokens = 10;
    setupData.invites = 3;
    setupData.setupDate = new Date().toISOString();

    // Try to redeem invite code if provided
    const inviteCodeInput = document.getElementById('inviteCode');
    const inviteCode = inviteCodeInput ? inviteCodeInput.value.trim() : '';
    const statusEl = document.getElementById('inviteCodeStatus');

    async function finishSetup(bonusTokens) {
      setupData.tokens += bonusTokens;

      chrome.storage.sync.set(setupData, function() {
        if (typeof aggregateUserKeywords === 'function') {
          aggregateUserKeywords(setupData);
        }

        // Update completion screen token count
        const finalCount = document.getElementById('finalTokenCount');
        if (finalCount) {
          finalCount.textContent = setupData.tokens;
          if (bonusTokens > 0) {
            finalCount.insertAdjacentHTML('afterend',
              `<div style="font-size:12px;color:#51cf66;margin-top:4px;">includes ${bonusTokens} invite bonus 🎉</div>`
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

    if (inviteCode) {
      // Show checking state
      if (statusEl) {
        statusEl.textContent = 'Checking invite code...';
        statusEl.style.color = '#666';
        statusEl.style.display = 'block';
      }

      // Disable Next button while checking
      document.getElementById('nextBtn').disabled = true;

      const result = await storage.redeemInviteCode(inviteCode);

      document.getElementById('nextBtn').disabled = false;

      if (result.success) {
        // 2 bonus tokens for invitee (already awarded in redeemInviteCode locally,
        // but we apply them here through setupData instead to keep it atomic)
        finishSetup(2);
      } else {
        if (statusEl) {
          statusEl.textContent = `❌ ${result.error}`;
          statusEl.style.color = '#c92a2a';
          statusEl.style.display = 'block';
        }
        // Still complete setup, just without bonus
        finishSetup(0);
      }
    } else {
      finishSetup(0);
    }
  }
}
