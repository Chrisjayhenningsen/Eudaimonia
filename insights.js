document.addEventListener('DOMContentLoaded', function() {
  loadMyPromotionStats();
  loadKeywordInsights();
  setupAccordions();
  
  document.getElementById('backBtn').addEventListener('click', function() {
    window.location.href = 'promote.html';
  });
});

function setupAccordions() {
  // My Promotions accordion (default open)
  document.getElementById('myPromosHeader').addEventListener('click', function() {
    this.classList.toggle('collapsed');
    document.getElementById('myPromosContent').classList.toggle('collapsed');
  });
  
  // Keywords accordion (default closed)
  document.getElementById('keywordsHeader').addEventListener('click', function() {
    this.classList.toggle('collapsed');
    document.getElementById('keywordsContent').classList.toggle('collapsed');
  });
  
  // Set keywords to collapsed by default
  document.getElementById('keywordsHeader').classList.add('collapsed');
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    // Remove protocol, www, and trailing slashes for comparison
    return urlObj.hostname.replace(/^www\./, '') + urlObj.pathname.replace(/\/$/, '');
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

async function loadMyPromotionStats() {
  const statsContainer = document.getElementById('myPromoStats');
  
  chrome.storage.sync.get(['myPromotions'], async function(data) {
    const myPromotions = data.myPromotions || [];
    
    if (myPromotions.length === 0) {
      statsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>You haven't promoted any links yet.</p>
          <p>Submit your first promotion to see stats here!</p>
        </div>
      `;
      return;
    }
    
    // Fetch all promotions from Firebase to get click counts and budgets
    statsContainer.innerHTML = '<p style="color: #999; font-size: 13px;">Loading stats...</p>';
    
    try {
      const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
      const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
      
      const response = await fetch(`${FIRESTORE_URL}/promotions`);
      const firebaseData = await response.json();
      const allPromotions = firebaseData.documents || [];
      
      // Match my submitted URLs to Firebase promotions
      const myUrls = myPromotions.map(p => normalizeUrl(p.url));
      const myFirebasePromos = allPromotions
        .map(doc => {
          const fields = doc.fields;
          return {
            url: fields.url?.stringValue || '',
            title: fields.title?.stringValue || '',
            clicks: parseInt(fields.clicks?.integerValue || '0'),
            budget: parseInt(fields.budget?.integerValue || '0'),
            cost: parseInt(fields.cost?.integerValue || '0'),
            timestamp: fields.timestamp?.stringValue || ''
          };
        })
        .filter(promo => myUrls.includes(normalizeUrl(promo.url)));
      
      if (myFirebasePromos.length === 0) {
        statsContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⏳</div>
            <p>Your promotions are processing...</p>
            <p>Stats will appear shortly.</p>
          </div>
        `;
        return;
      }
      
      // Sort by clicks (most popular first)
      myFirebasePromos.sort((a, b) => b.clicks - a.clicks);
      
      // Build stats display
      statsContainer.innerHTML = myFirebasePromos.map(promo => {
        const budgetEmpty = promo.budget === 0;
        return `
          <div class="promo-stat-item" style="${budgetEmpty ? 'opacity: 0.6;' : ''}">
            <div class="promo-stat-title">${escapeHtml(promo.title) || promo.url}</div>
            <div class="promo-stat-url">${normalizeUrl(promo.url)}</div>
            <div class="promo-stat-clicks">
              <span class="clicks-count">${promo.clicks}</span>
              <span class="clicks-label"> click${promo.clicks !== 1 ? 's' : ''}</span>
              <span style="color: #ccc; margin: 0 5px;">·</span>
              ${budgetEmpty 
                ? `<span style="color: #ff6b6b; font-size: 12px; font-weight: 600;">⏸ Budget exhausted</span>`
                : `<span style="color: #51cf66; font-size: 12px;">✅ ${promo.budget} token${promo.budget !== 1 ? 's' : ''} remaining</span>`
              }
            </div>
            <button class="add-tokens-btn" data-promo-url="${escapeHtml(promo.url)}" style="margin-top: 10px; padding: 8px 12px; background: #4a9eff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              + Add More Tokens
            </button>
          </div>
        `;
      }).join('');
      
      // Add click handlers for token top-up buttons
      document.querySelectorAll('.add-tokens-btn').forEach(btn => {
        btn.addEventListener('click', () => handleAddTokens(btn.dataset.promoUrl));
      });
      
    } catch (error) {
      console.error('Error loading stats:', error);
      statsContainer.innerHTML = `
        <div class="empty-state">
          <p style="color: #ff6b6b;">Could not load stats.</p>
          <p style="font-size: 12px;">${error.message}</p>
        </div>
      `;
    }
  });
}

async function handleAddTokens(promoUrl) {
  // Get current token balance
  chrome.storage.sync.get(['tokens'], async (data) => {
    const currentTokens = data.tokens || 0;
    
    if (currentTokens < 1) {
      alert('You don\'t have any tokens to add. Complete check-ins to earn more!');
      return;
    }
    
    // Prompt for number of tokens
    const tokensToAdd = prompt(
      `How many tokens would you like to add to this promotion?\n\nYou have ${currentTokens} tokens available.`,
      '2'
    );
    
    if (!tokensToAdd) return; // User cancelled
    
    const amount = parseInt(tokensToAdd);
    
    if (isNaN(amount) || amount < 1) {
      alert('Please enter a valid number of tokens (minimum 1).');
      return;
    }
    
    if (amount > currentTokens) {
      alert(`You only have ${currentTokens} tokens available. Please enter a smaller amount.`);
      return;
    }
    
    try {
      // Find the promotion in Firebase
      const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
      const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
      
      const response = await fetch(`${FIRESTORE_URL}/promotions`);
      const firebaseData = await response.json();
      const allPromotions = firebaseData.documents || [];
      
      // Find matching promotion
      const targetPromo = allPromotions.find(doc => {
        const url = doc.fields.url?.stringValue || '';
        return normalizeUrl(url) === normalizeUrl(promoUrl);
      });
      
      if (!targetPromo) {
        alert('Could not find this promotion in the database.');
        return;
      }
      
      // Get current budget and update it
      const promoId = targetPromo.name.split('/').pop();
      const currentBudget = parseInt(targetPromo.fields.budget?.integerValue || '0');
      const newBudget = currentBudget + amount;
      
      // Update promotion budget
      await fetch(`${FIRESTORE_URL}/promotions/${promoId}?updateMask.fieldPaths=budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            budget: { integerValue: newBudget.toString() }
          }
        })
      });
      
      // Deduct tokens from user
      chrome.storage.sync.set({ tokens: currentTokens - amount }, () => {
        alert(`✅ Successfully added ${amount} token${amount !== 1 ? 's' : ''} to this promotion!\n\nNew budget: ${newBudget} tokens\nYour remaining tokens: ${currentTokens - amount}`);
        
        // Reload stats
        loadMyPromotionStats();
      });
      
    } catch (error) {
      console.error('Error adding tokens:', error);
      alert('Failed to add tokens. Please try again.');
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadKeywordInsights() {
  const keywordContainer = document.getElementById('keywordStats');
  
  try {
    const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
    const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    
    // Fetch aggregated keyword data
    const response = await fetch(`${FIRESTORE_URL}/aggregations/keywords`);
    
    if (!response.ok) {
      keywordContainer.innerHTML = `
        <div class="empty-state">
          <p style="color: #999; font-size: 13px;">No user data yet. As people complete setup, keyword insights will appear here!</p>
        </div>
      `;
      return;
    }
    
    const data = await response.json();
    const fields = data.fields || {};
    
    if (!fields.keywords?.mapValue?.fields) {
      keywordContainer.innerHTML = `
        <div class="empty-state">
          <p style="color: #999; font-size: 13px;">No keyword data available yet. Encourage users to complete their setup!</p>
        </div>
      `;
      return;
    }
    
    // Parse keyword data
    const keywordsMap = fields.keywords.mapValue.fields;
    const keywordArray = [];
    
    for (const [word, value] of Object.entries(keywordsMap)) {
      const wordFields = value.mapValue.fields;
      const goals = parseInt(wordFields.goals?.integerValue || '0');
      const obstacles = parseInt(wordFields.obstacles?.integerValue || '0');
      const total = goals + obstacles;
      
      keywordArray.push({
        word,
        goals,
        obstacles,
        total
      });
    }
    
    // Sort by total frequency
    keywordArray.sort((a, b) => b.total - a.total);
    
    if (keywordArray.length === 0) {
      keywordContainer.innerHTML = `
        <div class="empty-state">
          <p style="color: #999; font-size: 13px;">No keywords found yet!</p>
        </div>
      `;
      return;
    }
    
    // Display keywords
    keywordContainer.innerHTML = `
      <div class="keyword-list">
        ${keywordArray.map(item => {
          const isObstacle = item.obstacles > 0;
          const sourceText = item.obstacles > 0 && item.goals > 0 
            ? `${item.goals} goals, ${item.obstacles} obstacles`
            : item.obstacles > 0
            ? 'obstacles'
            : 'goals';
          
          return `
            <div class="keyword-item">
              <div>
                <span class="keyword-text">${escapeHtml(item.word)}</span>
                <span class="keyword-source ${isObstacle ? 'obstacle' : ''}">${sourceText}</span>
              </div>
              <span class="keyword-count">${item.total} ${item.total === 1 ? 'user' : 'users'}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
    
  } catch (error) {
    console.error('Error loading keyword insights:', error);
    keywordContainer.innerHTML = `
      <div class="empty-state">
        <p style="color: #ff6b6b;">Could not load keyword data.</p>
        <p style="font-size: 12px; color: #999;">${error.message}</p>
      </div>
    `;
  }
}
