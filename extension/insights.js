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
      
      const user = await storage.ensureAuth();
      const myUid = user?.uid || null;

      // Match my promotions by owner userId (robust), falling back to a URL
      // match for older promotions created before userId was recorded.
      const myUrls = myPromotions.map(p => normalizeUrl(p.url));
      const myFirebasePromos = allPromotions
        .map(doc => {
          const fields = doc.fields;
          return {
            id: doc.name.split('/').pop(),
            userId: fields.userId?.stringValue || '',
            url: fields.url?.stringValue || '',
            title: fields.title?.stringValue || '',
            clicks: parseInt(fields.clicks?.integerValue || '0'),
            budget: parseInt(fields.budget?.integerValue || '0'),
            cost: parseInt(fields.cost?.integerValue || '0'),
            timestamp: fields.timestamp?.stringValue || ''
          };
        })
        .filter(promo => (myUid && promo.userId === myUid) || myUrls.includes(normalizeUrl(promo.url)));
      
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
            <button class="add-tokens-btn" data-promo-id="${promo.id}" style="margin-top: 10px; padding: 8px 12px; background: #4a9eff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
              + Add More Tokens
            </button>
          </div>
        `;
      }).join('');
      
      // Add click handlers for token top-up buttons
      document.querySelectorAll('.add-tokens-btn').forEach(btn => {
        btn.addEventListener('click', () => handleAddTokens(btn.dataset.promoId));
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

async function handleAddTokens(promoId) {
  const currentTokens = await storage.getBalance();

  if (currentTokens < 1) {
    alert('You don\'t have any tokens to add. Complete check-ins to earn more!');
    return;
  }

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
    // Server-side, transactional: verifies ownership, debits the balance, and
    // increments the promotion's budget in one atomic step.
    const res = await storage.callFn('spend', { action: 'addBudget', promoId, amount });
    alert(`✅ Successfully added ${amount} token${amount !== 1 ? 's' : ''} to this promotion!\n\nYour remaining tokens: ${res.balance}`);
    loadMyPromotionStats();
  } catch (err) {
    const msg = err.code === 'INSUFFICIENT_TOKENS'
        ? "You don't have enough tokens."
      : err.code === 'NOT_OWNER'
        ? 'You can only add tokens to your own promotions.'
      : err.code === 'PROMO_NOT_FOUND'
        ? 'Could not find this promotion.'
      : err.code === 'AUTH_REQUIRED'
        ? "Couldn't sign you in. Please check your connection and try again."
      : 'Failed to add tokens. Please try again.';
    alert(msg);
  }
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
