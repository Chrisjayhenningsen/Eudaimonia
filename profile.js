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
    'blockedCategories'
  ], function(data) {
    // Populate all fields
    if (data.moveToward) document.getElementById('moveToward').value = data.moveToward;
    if (data.moveAway) document.getElementById('moveAway').value = data.moveAway;
    if (data.dailyHabits) document.getElementById('dailyHabits').value = data.dailyHabits;
    if (data.productCategories) document.getElementById('productCategories').value = data.productCategories;
    if (data.checkinDay) document.getElementById('checkinDay').value = data.checkinDay;
    if (data.checkinTime) document.getElementById('checkinTime').value = data.checkinTime;
    
    // Load blocked items
    loadBlockedItems(data.blockedSources || [], data.blockedCategories || []);
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
        <span class="blocked-item-text">${source}</span>
        <button class="unblock-btn" data-type="source" data-value="${source}">Unblock</button>
      `;
      sourcesList.appendChild(item);
    });
  }
  
  if (categories.length === 0) {
    categoriesList.innerHTML = '<em style="color: #999;">No blocked categories</em>';
  } else {
    categoriesList.innerHTML = '';
    categories.forEach(category => {
      const item = document.createElement('div');
      item.className = 'blocked-item';
      item.innerHTML = `
        <span class="blocked-item-text">${category}</span>
        <button class="unblock-btn" data-type="category" data-value="${category}">Unblock</button>
      `;
      categoriesList.appendChild(item);
    });
  }
  
  // Add event listeners to unblock buttons
  document.querySelectorAll('.unblock-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const type = this.getAttribute('data-type');
      const value = this.getAttribute('data-value');
      unblockItem(type, value);
    });
  });
}

function unblockItem(type, value) {
  chrome.storage.sync.get(['blockedSources', 'blockedCategories'], function(data) {
    let blockedSources = data.blockedSources || [];
    let blockedCategories = data.blockedCategories || [];
    
    if (type === 'source') {
      blockedSources = blockedSources.filter(s => s !== value);
    } else if (type === 'category') {
      blockedCategories = blockedCategories.filter(c => c !== value);
    }
    
    chrome.storage.sync.set({
      blockedSources,
      blockedCategories
    }, function() {
      // Reload the blocked items display
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
    // Return to main popup
    window.location.href = 'popup.html';
  });
}
