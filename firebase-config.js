// Firebase REST API wrapper - no SDK needed
const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Current user
let currentUser = null;

// Initialize auth on load
(async function initAuth() {
  try {
    currentUser = await ensureAuthenticated();
  } catch (error) {
    console.log('Auth not available, some features limited');
    currentUser = null;
  }
})();

// Feature flags cache
let featureFlags = null;
let flagsLastFetched = 0;
const FLAGS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const storage = {
  // Get current user ID
  async getCurrentUserId() {
    if (!currentUser) {
      currentUser = await ensureAuthenticated();
    }
    return currentUser?.uid || null;
  },
  
  // Ensure user is authenticated (anonymous)
  async ensureAuth() {
    if (!currentUser) {
      currentUser = await ensureAuthenticated();
    }
    return currentUser;
  },
  
  // Get feature flags from Firebase (cached)
  async getFeatureFlags() {
    const now = Date.now();
    
    // Return cached flags if still fresh
    if (featureFlags && (now - flagsLastFetched) < FLAGS_CACHE_DURATION) {
      return featureFlags;
    }
    
    try {
      const response = await fetch(`${FIRESTORE_URL}/config/featureFlags`);
      
      if (!response.ok) {
        console.log('No feature flags found, using defaults');
        return this.getDefaultFlags();
      }
      
      const data = await response.json();
      const fields = data.fields;
      
      // Parse feature flags from Firestore format
      featureFlags = {
        promotionDisplay: fields.promotionDisplay?.stringValue || 'title',
        tokenEarningRate: parseInt(fields.tokenEarningRate?.integerValue || '2'),
        setupTokenReward: parseInt(fields.setupTokenReward?.integerValue || '10'),
        checkInFrequency: fields.checkInFrequency?.stringValue || 'weekly',
        showKeywordsInPromo: fields.showKeywordsInPromo?.booleanValue !== false,
        authSystem: fields.authSystem?.stringValue || 'anonymous',
        requireInvites: fields.requireInvites?.booleanValue !== false,
        safeBrowsingKey: fields.safeBrowsingKey?.stringValue || null
      };
      
      flagsLastFetched = now;
      console.log('Feature flags loaded:', featureFlags);
      return featureFlags;
      
    } catch (error) {
      console.error('Error fetching feature flags:', error);
      return this.getDefaultFlags();
    }
  },
  
  // Default feature flags (fallback)
  getDefaultFlags() {
    return {
      promotionDisplay: 'title',  // 'title' or 'url'
      tokenEarningRate: 2,         // tokens per system check-in
      setupTokenReward: 10,        // tokens for completing setup
      checkInFrequency: 'weekly',  // 'weekly', 'daily', 'biweekly'
      showKeywordsInPromo: true,   // show keyword tags on promotions
      authSystem: 'anonymous',     // 'anonymous', 'email', 'none'
      requireInvites: true,        // enforce invite requirement for submissions
      safeBrowsingKey: null        // Google Safe Browsing API key
    };
  },
  
  // Fetch the policy blocklist from Firebase (terms banned from title/description/keywords)
  async getBlocklist() {
    try {
      const response = await fetch(`${FIRESTORE_URL}/config/blocklist`);
      if (!response.ok) return [];
      const data = await response.json();
      const values = data.fields?.terms?.arrayValue?.values || [];
      return values.map(v => v.stringValue.toLowerCase()).filter(Boolean);
    } catch (error) {
      console.error('Error fetching blocklist:', error);
      return [];
    }
  },

  // Check submission text against the blocklist
  // Returns { blocked: false } or { blocked: true, reason: string }
  async checkBlocklist(title, description, keywords) {
    const blocklist = await this.getBlocklist();
    if (blocklist.length === 0) return { blocked: false };

    const combined = `${title} ${description} ${keywords}`.toLowerCase();
    const hit = blocklist.find(term => combined.includes(term));

    if (hit) {
      return {
        blocked: true,
        reason: `In accordance with Chrome Store policies, there are certain links we're not able to display. Your submission tripped our automatic filter. If you believe this is an error, please reach out to <a href='mailto:chrisjayhenningsen@gmail.com' style='color:#c92a2a;'>chrisjayhenningsen@gmail.com</a> and we'll take a look.`
      };
    }
    return { blocked: false };
  },

  // Save promotion to Firestore using REST API
  async savePromotion(promotion) {
    try {
      // Get current user (optional - will work without if auth disabled)
      let userId = null;
      try {
        const user = await this.ensureAuth();
        userId = user?.uid;
      } catch (authError) {
        console.log('Auth not available, submitting without userId');
      }
      
      // Check if this is user's FIRST promotion ever (anti-spam gate)
      const isFirstPromotion = await new Promise((resolve) => {
        chrome.storage.sync.get(['myPromotions', 'invites'], (data) => {
          const myPromotions = data.myPromotions || [];
          const invites = data.invites || 0;
          
          const isFirst = myPromotions.length === 0;
          const hasInvite = invites > 0;
          
          if (isFirst && !hasInvite) {
            alert('You need an invite to submit your first promotion. Earn more by completing check-ins!');
            resolve('NO_INVITE');
          } else {
            resolve(isFirst);
          }
        });
      });
      
      if (isFirstPromotion === 'NO_INVITE') {
        return false;
      }
      
      // Add userId to promotion if available
      if (userId) {
        promotion.userId = userId;
      }
      
      // Build fields object
      const fields = {
        url: { stringValue: promotion.url },
        title: { stringValue: promotion.title },
        description: { stringValue: promotion.description },
        keywords: { 
          arrayValue: { 
            values: promotion.keywords.map(k => ({ stringValue: k }))
          }
        },
        timestamp: { stringValue: promotion.timestamp },
        cost: { integerValue: promotion.cost.toString() },
        budget: { integerValue: (promotion.budget || promotion.cost).toString() },
        clicks: { integerValue: '0' }
      };
      
      // Add userId if we have it
      if (userId) {
        fields.userId = { stringValue: userId };
      }
      
      const response = await fetch(`${FIRESTORE_URL}/promotions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Firebase error:', errorText);
        alert('Failed to submit promotion. Please try again or check console for details.');
        return false;
      }
      
      // Only deduct invite if this was the FIRST promotion
      if (isFirstPromotion === true) {
        chrome.storage.sync.get(['invites'], (data) => {
          const invites = data.invites || 0;
          chrome.storage.sync.set({ invites: Math.max(0, invites - 1) });
        });
      }
      
      return true;
    } catch (error) {
      console.error('Error saving promotion:', error);
      alert('Error: ' + error.message);
      return false;
    }
  },
  
  // Get all promotions from Firestore
  async getPromotions() {
    try {
      const response = await fetch(`${FIRESTORE_URL}/promotions`);
      
      if (!response.ok) {
        console.error('Firebase error:', await response.text());
        return [];
      }
      
      const data = await response.json();
      
      if (!data.documents) {
        return [];
      }
      
      // Convert Firestore format to simple objects
      return data.documents.map(doc => {
        const fields = doc.fields;
        return {
          id: doc.name.split('/').pop(),
          url: fields.url?.stringValue || '',
          title: fields.title?.stringValue || '',
          description: fields.description?.stringValue || '',
          keywords: fields.keywords?.arrayValue?.values?.map(v => v.stringValue) || [],
          timestamp: fields.timestamp?.stringValue || '',
          cost: parseInt(fields.cost?.integerValue || '0')
        };
      });
    } catch (error) {
      console.error('Error fetching promotions:', error);
      return [];
    }
  },

  // Generate a human-readable invite code and store it in Firebase
  // Returns the code string or null on failure
  async generateInviteCode() {
    try {
      const userId = await this.getCurrentUserId();

      // Generate EUDA-XXXX format code
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
      let suffix = '';
      for (let i = 0; i < 4; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
      }
      const code = `EUDA-${suffix}`;

      // Store in Firebase invites collection
      const response = await fetch(`${FIRESTORE_URL}/invites/${code}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            createdBy: { stringValue: userId || 'anonymous' },
            used: { booleanValue: false },
            createdAt: { stringValue: new Date().toISOString() }
          }
        })
      });

      if (!response.ok) {
        console.error('Failed to store invite code:', await response.text());
        return null;
      }

      return code;
    } catch (error) {
      console.error('Error generating invite code:', error);
      return null;
    }
  },

  // Redeem an invite code during setup
  // Returns { success, error } 
  // On success: awards 2 tokens to invitee, 6 to inviter
  async redeemInviteCode(code) {
    try {
      const cleanCode = code.trim().toUpperCase();

      // Fetch the invite document
      const response = await fetch(`${FIRESTORE_URL}/invites/${cleanCode}`);
      if (!response.ok) {
        return { success: false, error: 'Invite code not found. Please check and try again.' };
      }

      const data = await response.json();
      const fields = data.fields || {};

      if (fields.used?.booleanValue === true) {
        return { success: false, error: 'This invite code has already been used.' };
      }

      const inviterUserId = fields.createdBy?.stringValue;

      // Mark code as used
      await fetch(`${FIRESTORE_URL}/invites/${cleanCode}?updateMask.fieldPaths=used&updateMask.fieldPaths=usedAt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            used: { booleanValue: true },
            usedAt: { stringValue: new Date().toISOString() }
          }
        })
      });

      // Award 2 bonus tokens to the invitee (locally)
      await new Promise(resolve => {
        chrome.storage.sync.get(['tokens'], (d) => {
          chrome.storage.sync.set({ tokens: (d.tokens || 0) + 2 }, resolve);
        });
      });

      // Award 6 bonus tokens to the inviter (in Firebase user doc)
      if (inviterUserId && inviterUserId !== 'anonymous') {
        const inviterUrl = `${FIRESTORE_URL}/users/${inviterUserId}`;
        const inviterRes = await fetch(inviterUrl);
        if (inviterRes.ok) {
          const inviterData = await inviterRes.json();
          const currentTokens = parseInt(inviterData.fields?.tokens?.integerValue || '0');
          await fetch(`${inviterUrl}?updateMask.fieldPaths=tokens`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: { tokens: { integerValue: (currentTokens + 6).toString() } }
            })
          });
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error redeeming invite code:', error);
      return { success: false, error: 'Something went wrong. Please try again.' };
    }
  }
};

// Authentication helper functions
async function ensureAuthenticated() {
  // Check if we have a stored auth token
  return new Promise((resolve) => {
    chrome.storage.local.get(['authToken', 'userId', 'tokenExpiry'], async (data) => {
      const now = Date.now();
      
      // If we have a valid token, use it
      if (data.authToken && data.userId && data.tokenExpiry && data.tokenExpiry > now) {
        resolve({ uid: data.userId, token: data.authToken });
        return;
      }
      
      // Otherwise, sign in anonymously
      try {
        const response = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true })
          }
        );
        
        const authData = await response.json();
        
        if (authData.idToken) {
          const userId = authData.localId;
          const token = authData.idToken;
          const expiry = now + (3600 * 1000); // 1 hour
          
          // Store auth data
          chrome.storage.local.set({
            authToken: token,
            userId: userId,
            tokenExpiry: expiry
          });
          
          // Initialize user document in Firestore
          await initializeUserDocument(userId);
          
          resolve({ uid: userId, token: token });
        } else {
          console.error('Auth failed:', authData);
          resolve(null);
        }
      } catch (error) {
        console.log('Anonymous auth unavailable (VPN/network may be blocking). Extension will work without auth.');
        resolve(null);
      }
    });
  });
}

async function initializeUserDocument(userId) {
  try {
    // Check if user document exists
    const userDocUrl = `${FIRESTORE_URL}/users/${userId}`;
    const checkResponse = await fetch(userDocUrl);
    
    if (checkResponse.ok) {
      // User already exists
      return;
    }
    
    // Create user document with invites from Chrome storage
    return new Promise((resolve) => {
      chrome.storage.sync.get(['invites', 'tokens'], async (data) => {
        const invites = data.invites || 0;
        const tokens = data.tokens || 0;
        
        try {
          await fetch(userDocUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                invites: { integerValue: invites.toString() },
                tokens: { integerValue: tokens.toString() },
                createdAt: { stringValue: new Date().toISOString() }
              }
            })
          });
        } catch (err) {
          console.log('Could not create user document (non-critical):', err.message);
        }
        
        resolve();
      });
    });
  } catch (error) {
    // Non-critical - just log it
    console.log('User document initialization skipped:', error.message);
  }
}

// Aggregate user keywords to Firebase
async function aggregateUserKeywords(userData) {
  try {
    // Extract keywords from user data
    const goalKeywords = extractKeywords(
      (userData.moveToward || '') + ' ' + 
      (userData.dailyHabits || '') + ' ' + 
      (userData.productCategories || '')
    );
    
    const obstacleKeywords = extractKeywords(userData.moveAway || '');
    
    // Get current aggregation from Firebase
    const aggUrl = `${FIRESTORE_URL}/aggregations/keywords`;
    const response = await fetch(aggUrl);
    
    let currentData = {};
    if (response.ok) {
      const data = await response.json();
      // Parse existing data
      const fields = data.fields || {};
      if (fields.keywords?.mapValue?.fields) {
        const keywordsMap = fields.keywords.mapValue.fields;
        for (const [word, value] of Object.entries(keywordsMap)) {
          const wordFields = value.mapValue.fields;
          currentData[word] = {
            goals: parseInt(wordFields.goals?.integerValue || '0'),
            obstacles: parseInt(wordFields.obstacles?.integerValue || '0')
          };
        }
      }
    }
    
    // Update counts
    goalKeywords.forEach(word => {
      if (!currentData[word]) {
        currentData[word] = { goals: 0, obstacles: 0 };
      }
      currentData[word].goals++;
    });
    
    obstacleKeywords.forEach(word => {
      if (!currentData[word]) {
        currentData[word] = { goals: 0, obstacles: 0 };
      }
      currentData[word].obstacles++;
    });
    
    // Convert to Firestore format
    const keywordsMapFields = {};
    for (const [word, counts] of Object.entries(currentData)) {
      keywordsMapFields[word] = {
        mapValue: {
          fields: {
            goals: { integerValue: counts.goals.toString() },
            obstacles: { integerValue: counts.obstacles.toString() }
          }
        }
      };
    }
    
    // Save back to Firebase
    await fetch(aggUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          keywords: {
            mapValue: {
              fields: keywordsMapFields
            }
          },
          lastUpdated: { stringValue: new Date().toISOString() }
        }
      })
    });
    
    console.log('Keyword aggregation updated');
  } catch (error) {
    console.error('Error aggregating keywords:', error);
  }
}

function extractKeywords(text) {
  if (!text) return [];
  
  // Split by common delimiters and clean
  const words = text
    .toLowerCase()
    .split(/[\n,;]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2) // Only words with 3+ characters
    .filter(w => !isCommonWord(w)); // Filter out common words
  
  return [...new Set(words)]; // Remove duplicates
}

function isCommonWord(word) {
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have',
    'but', 'not', 'are', 'was', 'been', 'more', 'will', 'can',
    'all', 'would', 'there', 'their', 'what', 'about', 'which',
    'when', 'make', 'than', 'then', 'them', 'these', 'could',
    'into', 'time', 'has', 'look', 'two', 'way', 'how', 'who'
  ]);
  return commonWords.has(word);
}

