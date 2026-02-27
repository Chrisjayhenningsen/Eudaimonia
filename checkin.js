// Load systems and set up the check-in page
document.addEventListener('DOMContentLoaded', function() {
  loadSystems();
  
  document.getElementById('saveBtn').addEventListener('click', saveCheckin);
  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.location.href = 'popup.html';
  });
});

function loadSystems() {
  chrome.storage.sync.get(['dailyHabits', 'lastCheckin'], function(data) {
    const systems = data.dailyHabits || '';
    const lastCheckin = data.lastCheckin || null;
    
    // Check if user can earn tokens this week
    const canEarnTokens = checkIfCanEarnTokens(lastCheckin);
    updateTokenMessage(canEarnTokens);
    
    if (!systems.trim()) {
      document.getElementById('systemsList').innerHTML = 
        '<p style="color: #999; font-style: italic;">No systems defined yet. Add some in your profile!</p>';
      return;
    }
    
    // Split systems by newlines and create a checklist
    const systemsList = document.getElementById('systemsList');
    systemsList.innerHTML = '';
    
    const systemArray = systems.split('\n').filter(s => s.trim());
    systemArray.forEach((system, index) => {
      const systemDiv = createSystemItem(system, index);
      systemsList.appendChild(systemDiv);
    });
  });
}

function createSystemItem(systemText, index) {
  const div = document.createElement('div');
  div.className = 'system-item';
  
  div.innerHTML = `
    <div class="system-text">${systemText}</div>
    <div class="completion-group">
      <div class="completion-radio" id="completed-${index}">
        <input type="radio" name="system-${index}" id="radio-completed-${index}" value="completed">
        <label for="radio-completed-${index}">⭐ Completed!</label>
      </div>
      <div class="completion-radio" id="trouble-${index}">
        <input type="radio" name="system-${index}" id="radio-trouble-${index}" value="trouble">
        <label for="radio-trouble-${index}">🤔 Ran into trouble</label>
      </div>
    </div>
    <div class="reflection-area" id="reflection-${index}">
      <label class="reflection-label">What happened? How can you adjust?</label>
      <textarea id="reflection-text-${index}" placeholder="Reflect on what got in the way and what you might change..."></textarea>
    </div>
  `;
  
  // Add event listeners to show/hide reflection area
  const completedRadio = div.querySelector(`#radio-completed-${index}`);
  const troubleRadio = div.querySelector(`#radio-trouble-${index}`);
  const reflectionArea = div.querySelector(`#reflection-${index}`);
  const completedDiv = div.querySelector(`#completed-${index}`);
  const troubleDiv = div.querySelector(`#trouble-${index}`);
  
  completedRadio.addEventListener('change', function() {
    if (this.checked) {
      reflectionArea.classList.remove('show');
      completedDiv.classList.add('selected');
      troubleDiv.classList.remove('selected');
    }
  });
  
  troubleRadio.addEventListener('change', function() {
    if (this.checked) {
      reflectionArea.classList.add('show');
      troubleDiv.classList.add('selected');
      completedDiv.classList.remove('selected');
    }
  });
  
  return div;
}

function checkIfCanEarnTokens(lastCheckin) {
  if (!lastCheckin) return true; // Never checked in before
  
  const lastDate = new Date(lastCheckin);
  const now = new Date();
  
  // Check if it's been at least 7 days
  const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

function updateTokenMessage(canEarn) {
  const messageEl = document.getElementById('tokenMessage');
  if (canEarn) {
    messageEl.textContent = '🎁 You can earn tokens with this check-in!';
  } else {
    messageEl.textContent = 'Check in anytime! Token earnings reset weekly.';
  }
}

async function saveCheckin() {
  // Get feature flags first
  const flags = await storage.getFeatureFlags();
  const tokenRate = flags.tokenEarningRate;
  
  chrome.storage.sync.get(['dailyHabits', 'tokens', 'invites', 'lastCheckin', 'lastInviteEarned'], function(data) {
    const systemArray = (data.dailyHabits || '').split('\n').filter(s => s.trim());
    const canEarnTokens = checkIfCanEarnTokens(data.lastCheckin);

    // Invite accrues once per week, tracked separately from token check-in
    const now = new Date();
    const lastInviteDate = data.lastInviteEarned ? new Date(data.lastInviteEarned) : null;
    const daysSinceInvite = lastInviteDate
      ? (now - lastInviteDate) / (1000 * 60 * 60 * 24)
      : 999;
    const earnedInvite = daysSinceInvite >= 7;
    
    let completedCount = 0;
    let reflectionCount = 0;
    const checkinData = [];
    
    // Collect check-in data
    systemArray.forEach((system, index) => {
      const completedRadio = document.getElementById(`radio-completed-${index}`);
      const troubleRadio = document.getElementById(`radio-trouble-${index}`);
      const reflectionText = document.getElementById(`reflection-text-${index}`);
      
      if (completedRadio && completedRadio.checked) {
        completedCount++;
        checkinData.push({ system: system, completed: true });
      } else if (troubleRadio && troubleRadio.checked) {
        reflectionCount++;
        checkinData.push({
          system: system,
          completed: false,
          reflection: reflectionText ? reflectionText.value.trim() : ''
        });
      }
    });
    
    // Calculate tokens earned using feature flag rate
    let tokensEarned = 0;
    if (canEarnTokens) {
      tokensEarned = (completedCount + reflectionCount) * tokenRate;
    }
    
    // Save the check-in
    const updateData = {
      lastCheckin: now.toISOString(),
      tokens: (data.tokens || 0) + tokensEarned,
      invites: (data.invites || 0) + (earnedInvite ? 1 : 0)
    };
    if (earnedInvite) {
      updateData.lastInviteEarned = now.toISOString();
    }
    
    // Store the check-in history
    chrome.storage.sync.get(['checkinHistory'], function(historyData) {
      const history = historyData.checkinHistory || [];
      history.push({
        date: now.toISOString(),
        data: checkinData,
        tokensEarned,
        inviteEarned: earnedInvite
      });
      
      if (history.length > 10) history.shift();
      updateData.checkinHistory = history;
      
      chrome.storage.sync.set(updateData, function() {
        const tokenMsg = tokensEarned > 0 ? `You earned ${tokensEarned} tokens!` : 'Come back next week to earn tokens.';
        const inviteMsg = earnedInvite ? ' You also earned an invite — share it with a friend! 💌' : '';
        alert(`Check-in saved! ${tokenMsg}${inviteMsg}`);
        window.location.href = 'popup.html';
      });
    });
  });
}
