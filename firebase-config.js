// Firebase REST API wrapper - no SDK needed
const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
var FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/eudaimonia-350ce/databases/(default)/documents';
const FIREBASE_API_KEY = 'AIzaSyBBK2zeQBWA7Gxfb-d4XUvhk3QDdAfdpQU';
const FUNCTIONS_BASE = 'https://eudaimonia-project.netlify.app/.netlify/functions';

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

// ─── Email hashing ────────────────────────────────────────────────────────────
// One-way, unsalted SHA-256 of a normalized (trimmed, lowercased) email address.
// Unsalted is deliberate: it's what lets us later hash a DIFFERENT email (e.g.
// during the owner-invite flow) and get the same value if it's the same address,
// which is the whole point - we need to answer "does this address already belong
// to a registered user?" without ever storing or transmitting the address itself.
// The tradeoff is that a common/guessable address could theoretically be reversed
// via a precomputed rainbow table - this is a "does this exist" anti-spam/dedup
// check, not a secret, so that's an accepted limitation rather than a bug.
async function hashEmail(email) {
  const normalized = (email || '').trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const storage = {
  // Get current user ID
  async getCurrentUserId() {
    if (!currentUser) {
      currentUser = await ensureAuthenticated();
    }
    return currentUser?.uid || null;
  },
  
  // Ensure user is authenticated (anonymous). Always routes through
  // ensureAuthenticated so an expired in-memory token gets refreshed rather than
  // reused — ensureAuthenticated is cheap when the stored token is still valid.
  async ensureAuth() {
    currentUser = await ensureAuthenticated();
    return currentUser;
  },

  // ─── Backend helpers ───────────────────────────────────────────────────────
  // Calls an authenticated Netlify Function with the user's Firebase ID token.
  // Throws an Error on failure; err.code carries the machine-readable error
  // string from the function (e.g. 'INSUFFICIENT_TOKENS') when present.
  async callFn(name, body) {
    const user = await this.ensureAuth();
    if (!user || !user.token) {
      const e = new Error('AUTH_REQUIRED'); e.code = 'AUTH_REQUIRED'; throw e;
    }
    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + user.token },
      body: JSON.stringify(body || {})
    });
    let data; const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status; err.code = data.error;
      throw err;
    }
    return data;
  },

  // Reads the canonical token balance from Firestore (users/{uid}). Falls back
  // to the last cached value for display if auth/network is unavailable.
  async getBalance() {
    try {
      const user = await this.ensureAuth();
      if (!user || !user.uid || !user.token) return await this._cachedBalance();
      const res = await fetch(`${FIRESTORE_URL}/users/${user.uid}`, {
        headers: { 'Authorization': 'Bearer ' + user.token }
      });
      if (!res.ok) return await this._cachedBalance();
      const data = await res.json();
      const tokens = parseInt(data.fields?.tokens?.integerValue || '0');
      chrome.storage.local.set({ cachedBalance: tokens });
      return tokens;
    } catch (e) {
      return await this._cachedBalance();
    }
  },

  _cachedBalance() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['cachedBalance'], (d) => resolve(d.cachedBalance || 0));
    });
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

  // Records that a hashed email address belongs to a registered user. Called
  // once, on a user's first-ever promotion. The document ID IS the hash, and
  // the only other field is a timestamp - there is nothing here to link back
  // to a person's goals, promotions, or any other profile data, and no way to
  // recover the original address from the hash.
  async registerEmailHash(email) {
    try {
      const hash = await hashEmail(email);
      await fetch(`${FIRESTORE_URL}/emailHashes/${hash}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            registered: { booleanValue: true },
            createdAt: { stringValue: new Date().toISOString() }
          }
        })
      });
    } catch (error) {
      // Non-critical - worst case, a returning user gets asked to verify again,
      // or an already-registered address gets invited once more. Never block
      // the promotion submission over this.
      console.log('Could not register email hash (non-critical):', error.message);
    }
  },

  // Checks whether a (plaintext, never transmitted) email address already
  // belongs to a registered user, by hashing it the same way and looking up
  // the resulting document. Used by the owner-invite flow to silently skip
  // sending an invite to someone who's already using the product - the
  // inviter never learns the result either way, they just don't see a
  // compose-email tab open for an address that's already registered.
  async isEmailRegistered(email) {
    try {
      const hash = await hashEmail(email);
      const response = await fetch(`${FIRESTORE_URL}/emailHashes/${hash}`);
      return response.ok;
    } catch (error) {
      console.log('Could not check email hash, failing open (will send invite):', error.message);
      return false; // fail open - a missed dedup is far less bad than a blocked flow
    }
  },

  // Registers a client-generated invite code in Firestore. Deliberately
  // split from generateInviteCode(): the CODE ITSELF is produced
  // synchronously, client-side, with no network call at all (see
  // generateLocalInviteCode in promote.js) - that's what lets a mailto:
  // invite open immediately in the same click as Submit, the way a plain
  // synchronous assignment would. This function only registers that
  // already-generated code so it's actually redeemable later; callers are
  // expected to call it fire-and-forget (not awaited) after the mail draft
  // has already been opened, since nothing about showing the invite depends
  // on this write having finished yet.
  async registerGeneratedInviteCode(code) {
    try {
      await this.callFn('invites', { action: 'register', code });
    } catch (error) {
      console.log('Eudaimonia: could not register invite code (non-critical):', error.message);
    }
  },

  // Save promotion to Firestore using REST API
  // isFirstPromotion: whether this is the user's first-ever submission (determined
  // by the caller from local myPromotions) - if true and an email was provided,
  // we register a one-way hash of it as the anti-spam check.
  // email: only ever used here to derive a hash - the plaintext never leaves the
  // browser and is never written to Firestore in any form.
  // Submits a promotion by spending 1 token, server-side. The backend
  // (spend function) verifies the user, recomputes the cost, checks the
  // balance, and creates the promotion + debits the balance in one
  // transaction. Returns { success, balance, promoId } or { success:false, error }.
  // NOTE: the first-promotion email-hash anti-spam record is deferred to the
  // fast-follow backend pass; the client still enforces a valid email in the UI.
  async savePromotion(promotion, isFirstPromotion, email) {
    try {
      const result = await this.callFn('spend', {
        action: 'promote',
        url: promotion.url,
        title: promotion.title,
        description: promotion.description,
        keywords: promotion.keywords,
        email: email || '',
        isFirstPromotion: !!isFirstPromotion
      });
      return { success: true, balance: result.balance, promoId: result.promoId };
    } catch (error) {
      console.error('Error saving promotion:', error);
      return { success: false, error: error.code || error.message };
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
  // Redeems an invite code server-side. The invites function validates the code,
  // marks it used once, and credits both the invitee (+2) and inviter (+6) to
  // their Firestore balances in a single transaction. Rewards are defined by the
  // backend, not here.
  async redeemInviteCode(code) {
    try {
      await this.callFn('invites', { action: 'redeem', code });
      return { success: true };
    } catch (error) {
      const map = {
        CODE_NOT_FOUND: 'Invite code not found. Please check and try again.',
        CODE_USED: 'This invite code has already been used.',
        SELF_REDEEM: "You can't redeem your own invite code.",
        AUTH_REQUIRED: "Couldn't sign you in. Please check your connection and try again."
      };
      return { success: false, error: map[error.code] || 'Something went wrong. Please try again.' };
    }
  }
};

// Authentication helper functions
async function ensureAuthenticated() {
  // Check if we have a stored auth token
  return new Promise((resolve) => {
    chrome.storage.local.get(['authToken', 'userId', 'tokenExpiry', 'refreshToken'], async (data) => {
      const now = Date.now();

      // 1. Valid, unexpired token → reuse it.
      if (data.authToken && data.userId && data.tokenExpiry && data.tokenExpiry > now) {
        resolve({ uid: data.userId, token: data.authToken });
        return;
      }

      // 2. Expired but we have a refresh token → refresh WITHOUT changing uid.
      //    Firebase ID tokens last only ~1 hour; the anonymous ACCOUNT persists.
      //    We must exchange the refresh token for a fresh ID token (same uid),
      //    NOT sign up again (which would mint a brand-new user and orphan the
      //    existing token balance).
      if (data.refreshToken && data.userId) {
        try {
          const r = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(data.refreshToken)}`
            }
          );
          const rd = await r.json();
          if (rd.id_token) {
            const expiry = now + (parseInt(rd.expires_in || '3600', 10) * 1000);
            chrome.storage.local.set({
              authToken: rd.id_token,
              userId: rd.user_id,
              refreshToken: rd.refresh_token,
              tokenExpiry: expiry
            });
            resolve({ uid: rd.user_id, token: rd.id_token });
            return;
          }
          console.warn('Token refresh returned no id_token; falling back to sign-in:', rd);
        } catch (e) {
          console.log('Token refresh failed, will try a fresh sign-in:', e.message);
        }
      }

      // 3. No stored account (or refresh failed) → sign up a new anonymous user.
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
          const expiry = now + (parseInt(authData.expiresIn || '3600', 10) * 1000);

          // Store auth data, INCLUDING the refresh token so future expiries
          // refresh in place rather than creating a new user.
          chrome.storage.local.set({
            authToken: token,
            userId: userId,
            refreshToken: authData.refreshToken,
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
