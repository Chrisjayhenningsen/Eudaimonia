// Load systems and set up the check-in page
document.addEventListener('DOMContentLoaded', function() {
  loadSystems();
  
  document.getElementById('saveBtn').addEventListener('click', saveCheckin);
  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.location.href = 'popup.html';
  });
});

function loadSystems() {
  chrome.storage.sync.get(['dailyHabits', 'moveToward', 'lastCheckin'], function(data) {
    const systems = data.dailyHabits || '';
    const moveToward = data.moveToward || '';
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
      const systemDiv = createSystemItem(system, index, systemArray, moveToward);
      systemsList.appendChild(systemDiv);
    });
  });
}

function createSystemItem(systemText, index, systemArray, moveToward) {
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
      <span class="adjust-label">Should you adjust your goal or the way you move towards it?</span>
      <div class="adjust-group">
        <div class="adjust-radio" id="adjust-system-div-${index}">
          <input type="radio" name="adjust-${index}" id="adjust-system-${index}" value="system">
          <label for="adjust-system-${index}">🔧 Adjust my system <span style="color:#999;font-weight:400">(change how I pursue this goal)</span></label>
        </div>
        <div class="adjust-radio" id="adjust-goal-div-${index}">
          <input type="radio" name="adjust-${index}" id="adjust-goal-${index}" value="goal">
          <label for="adjust-goal-${index}">🎯 Adjust my goal <span style="color:#999;font-weight:400">(the goal itself needs rethinking)</span></label>
        </div>
      </div>
      <label class="reflection-label" id="reflection-label-${index}">What would work better?</label>
      <textarea id="reflection-text-${index}" placeholder="Describe what you'd like to change..."></textarea>
    </div>
  `;

  const completedRadio = div.querySelector(`#radio-completed-${index}`);
  const troubleRadio   = div.querySelector(`#radio-trouble-${index}`);
  const reflectionArea = div.querySelector(`#reflection-${index}`);
  const completedDiv   = div.querySelector(`#completed-${index}`);
  const troubleDiv     = div.querySelector(`#trouble-${index}`);
  const adjustSystemDiv = div.querySelector(`#adjust-system-div-${index}`);
  const adjustGoalDiv   = div.querySelector(`#adjust-goal-div-${index}`);
  const adjustSystemRadio = div.querySelector(`#adjust-system-${index}`);
  const adjustGoalRadio   = div.querySelector(`#adjust-goal-${index}`);
  const reflectionLabel   = div.querySelector(`#reflection-label-${index}`);
  const reflectionText    = div.querySelector(`#reflection-text-${index}`);

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

  // Pre-fill textarea with current field value so user can edit in place
  adjustSystemRadio.addEventListener('change', function() {
    if (this.checked) {
      adjustSystemDiv.classList.add('selected');
      adjustGoalDiv.classList.remove('selected');
      reflectionLabel.textContent = 'Edit this system (changes will replace the current version):';
      reflectionText.value = systemText;
      reflectionText.focus();
    }
  });

  adjustGoalRadio.addEventListener('change', function() {
    if (this.checked) {
      adjustGoalDiv.classList.add('selected');
      adjustSystemDiv.classList.remove('selected');
      reflectionLabel.textContent = 'Edit your goals (changes will replace the current version):';
      reflectionText.value = moveToward || '';
      reflectionText.focus();
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
  chrome.storage.sync.get(['dailyHabits', 'moveToward', 'lastCheckin'], async function(data) {
    const systemArray = (data.dailyHabits || '').split('\n').filter(s => s.trim());

    let completedCount = 0;
    let reflectionCount = 0;
    const checkinData = [];

    // Track profile updates from reflections
    let updatedSystems = [...systemArray]; // copy so we can splice
    const goalAdditions = [];             // text to append to moveToward

    systemArray.forEach((system, index) => {
      const completedRadio  = document.getElementById(`radio-completed-${index}`);
      const troubleRadio    = document.getElementById(`radio-trouble-${index}`);
      const reflectionText  = document.getElementById(`reflection-text-${index}`);
      const adjustSystemRadio = document.getElementById(`adjust-system-${index}`);
      const adjustGoalRadio   = document.getElementById(`adjust-goal-${index}`);

      if (completedRadio && completedRadio.checked) {
        completedCount++;
        checkinData.push({ system, completed: true });

      } else if (troubleRadio && troubleRadio.checked) {
        reflectionCount++;
        const text = reflectionText ? reflectionText.value.trim() : '';

        checkinData.push({
          system,
          completed: false,
          adjustType: adjustSystemRadio && adjustSystemRadio.checked ? 'system'
                    : adjustGoalRadio   && adjustGoalRadio.checked   ? 'goal'
                    : 'none',
          reflection: text
        });

        // Apply profile updates if they wrote something
        if (text) {
          if (adjustSystemRadio && adjustSystemRadio.checked) {
            // Replace just this system line with the edited version
            updatedSystems[index] = text;
          } else if (adjustGoalRadio && adjustGoalRadio.checked) {
            // Queue full replacement of moveToward
            goalAdditions.push(text);
          }
        }
      }
    });

    // Award tokens server-side. The backend enforces the earning cadence and
    // caps the amount, then returns how many were actually granted.
    const responses = completedCount + reflectionCount;
    let earned = 0;
    try {
      const res = await storage.callFn('earn-checkin', { responses });
      earned = res.earned || 0;
    } catch (e) {
      // Non-fatal: the check-in itself still saves; tokens just aren't granted
      // if the backend was unreachable (offline / sign-in blocked).
      console.warn('Eudaimonia: check-in token award failed (non-fatal):', e?.message);
    }

    // Build the storage update (profile data stays local; tokens are server-side)
    const updateData = {
      lastCheckin: new Date().toISOString(),
      dailyHabits: updatedSystems.join('\n')
    };

    // Replace moveToward with the edited version (pre-filled so existing text is preserved unless changed)
    if (goalAdditions.length > 0) {
      updateData.moveToward = goalAdditions[goalAdditions.length - 1]; // use last edit if multiple
    }

    chrome.storage.sync.get(['checkinHistory'], function(historyData) {
      const history = historyData.checkinHistory || [];
      history.push({
        date: new Date().toISOString(),
        data: checkinData,
        tokensEarned: earned
      });
      if (history.length > 10) history.shift();
      updateData.checkinHistory = history;

      chrome.storage.sync.set(updateData, function() {
        // Build a meaningful success message
        let msg = `Check-in saved!`;
        if (earned > 0) msg += ` You earned ${earned} tokens!`;
        const systemsChanged = updatedSystems.some((s, i) => s !== systemArray[i]);
        if (systemsChanged) msg += `\n\n✏️ Your systems have been updated.`;
        if (goalAdditions.length > 0) msg += `\n\n🎯 Your goals have been updated.`;
        alert(msg);
        window.location.href = 'popup.html';
      });
    });
  });
}
