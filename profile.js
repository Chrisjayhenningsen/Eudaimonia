// Load existing data when page opens
document.addEventListener('DOMContentLoaded', function() {
  loadProfileData();
  
  document.getElementById('saveBtn').addEventListener('click', saveProfile);
  document.getElementById('cancelBtn').addEventListener('click', function() {
    window.location.href = 'popup.html';
  });
});

function loadProfileData() {
  chrome.storage.sync.get([
    'moveToward',
    'moveAway',
    'dailyHabits',
    'productCategories',
    'checkinDay',
    'checkinTime',
    'blockedSources',
    'blockedCategories',
    'autoBlockAds'
  ], function(data) {
    // Populate all fields
    if (data.moveToward) document.getElementById('moveToward').value = data.moveToward;
    if (data.moveAway) document.getElementById('moveAway').value = data.moveAway;
    if (data.dailyHabits) document.getElementById('dailyHabits').value = data.dailyHabits;
    if (data.productCategories) document.getElementById('productCategories').value = data.productCategories;
    if (data.checkinDay !== undefined) document.getElementById('checkinDay').value = data.checkinDay;
    if (data.checkinTime) document.getElementById('checkinTime').value = data.checkinTime;
    
    // Load blocked items
    loadAutoBlockAdsStatus(data.autoBlockAds === true);
    loadBlockedItems(data.blockedSources || [], data.blockedCategories || []);
  });
}

function loadAutoBlockAdsStatus(isEnabled) {
  const statusDiv = document.getElementById('autoBlockAdsStatus');
  
  if (isEnabled) {
    statusDiv.innerHTML = `
      <div class="blocked-item">
        <span class="blocked-item-text">✅ Enabled — new ads are auto-replaced with the Eudaimonia badge</span>
        <button class="unblock-btn" id="disableAutoBlockBtn">Disable</button>
      </div>
    `;
    document.getElementById('disableAutoBlockBtn').addEventListener('click', () => {
      setAutoBlockAds(false);
    });
  } else {
    statusDiv.innerHTML = `<em style="color: #999;">Not enabled. Right-click any ad and choose "Block All Ads" to turn this on.</em>`;
  }
}

function setAutoBlockAds(value) {
  chrome.storage.sync.set({ autoBlockAds: value }, () => {
    loadAutoBlockAdsStatus(value);
  });
}

function loadBlockedItems(sources, categories) {
  const sourcesList = document.getElementById('blockedSourcesList');
  const categoriesList = document.getElementById('blockedCategoriesList');
  
  if (sources.length === 0) {
    sourcesList.innerHTML = '<em style="color: #999;">No blocked sources</em>';
  } else {
    sourcesList.innerHTML = '';
    sources.forEach(source => {
      const item = document.createElement('div');
      item.className = 'blocked-item';
      item.innerHTML = `
        <span class="blocked-item-text">${escapeHtml(source)}</span>
        <button class="unblock-btn" data-type="source" data-value="${escapeHtml(source)}">Unblock</button>
      `;
      sourcesList.appendChild(item);
    });
    
    sourcesList.querySelectorAll('.unblock-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        unblockSource(this.getAttribute('data-value'));
      });
    });
  }
  
  if (categories.length === 0) {
    categoriesList.innerHTML = '<em style="color: #999;">No blocked categories</em>';
  } else {
    categoriesList.innerHTML = '';
    categories.forEach(category => {
      categoriesList.appendChild(buildCategoryCard(category));
    });
  }
}

// Builds a single category's card: name + unblock + an expandable keyword
// editor, since keywords are the main lever for fixing a category that's
// over- or under-matching once it's already in use.
function buildCategoryCard(category) {
  const card = document.createElement('div');
  card.className = 'category-card';
  
  const keywordsText = (category.keywords || []).join(', ');
  
  card.innerHTML = `
    <div class="category-card-header">
      <span class="category-name">${escapeHtml(category.name)}</span>
      <div class="category-header-buttons">
        <button class="edit-keywords-btn" data-name="${escapeHtml(category.name)}">Edit keywords</button>
        <button class="unblock-btn" data-type="category" data-value="${escapeHtml(category.name)}">Unblock</button>
      </div>
    </div>
    <div class="category-keywords-editor">
      <label>Keywords (comma-separated) — any of these appearing in an ad's text will match this category:</label>
      <textarea>${escapeHtml(keywordsText)}</textarea>
      <button class="save-keywords-btn" data-name="${escapeHtml(category.name)}">Save Keywords</button>
    </div>
  `;
  
  card.querySelector('.edit-keywords-btn').addEventListener('click', function() {
    const editor = card.querySelector('.category-keywords-editor');
    editor.classList.toggle('show');
  });
  
  card.querySelector('.unblock-btn').addEventListener('click', function() {
    unblockCategory(this.getAttribute('data-value'));
  });
  
  card.querySelector('.save-keywords-btn').addEventListener('click', function() {
    const name = this.getAttribute('data-name');
    const textarea = card.querySelector('.category-keywords-editor textarea');
    saveKeywordsForCategory(name, textarea.value);
  });
  
  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function unblockSource(value) {
  chrome.storage.sync.get(['blockedSources', 'blockedCategories'], function(data) {
    const blockedSources = (data.blockedSources || []).filter(s => s !== value);
    const blockedCategories = data.blockedCategories || [];
    
    chrome.storage.sync.set({ blockedSources }, function() {
      loadBlockedItems(blockedSources, blockedCategories);
    });
  });
}

function unblockCategory(name) {
  chrome.storage.sync.get(['blockedSources', 'blockedCategories'], function(data) {
    const blockedSources = data.blockedSources || [];
    const blockedCategories = (data.blockedCategories || [])
      .filter(c => c.name.toLowerCase() !== name.toLowerCase());
    
    chrome.storage.sync.set({ blockedCategories }, function() {
      loadBlockedItems(blockedSources, blockedCategories);
    });
  });
}

function saveKeywordsForCategory(name, rawKeywordsText) {
  const newKeywords = rawKeywordsText
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0);
  
  if (newKeywords.length === 0) {
    alert('A category needs at least one keyword to match against. Use "Unblock" instead if you want to remove this category entirely.');
    return;
  }
  
  chrome.storage.sync.get(['blockedSources', 'blockedCategories'], function(data) {
    const blockedSources = data.blockedSources || [];
    const blockedCategories = data.blockedCategories || [];
    const target = blockedCategories.find(c => c.name.toLowerCase() === name.toLowerCase());
    
    if (target) {
      target.keywords = newKeywords;
    }
    
    chrome.storage.sync.set({ blockedCategories }, function() {
      loadBlockedItems(blockedSources, blockedCategories);
    });
  });
}

function saveProfile() {
  const profileData = {
    moveToward: document.getElementById('moveToward').value.trim(),
    moveAway: document.getElementById('moveAway').value.trim(),
    dailyHabits: document.getElementById('dailyHabits').value.trim(),
    productCategories: document.getElementById('productCategories').value.trim(),
    checkinDay: document.getElementById('checkinDay').value,
    checkinTime: document.getElementById('checkinTime').value
  };
  
  chrome.storage.sync.set(profileData, function() {
    // Tell background to reschedule (or cancel) the alarm with the new schedule
    chrome.runtime.sendMessage({
      action: 'scheduleCheckinReminder',
      day: profileData.checkinDay,
      time: profileData.checkinTime
    });
    
    window.location.href = 'popup.html';
  });
}
