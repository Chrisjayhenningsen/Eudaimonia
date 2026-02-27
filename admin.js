const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

document.addEventListener('DOMContentLoaded', function() {
  loadCurrentFlags();
  document.getElementById('loadBtn').addEventListener('click', loadCurrentFlags);
  document.getElementById('saveBtn').addEventListener('click', saveFlags);
});

async function loadCurrentFlags() {
  try {
    // Load feature flags
    const flagsRes = await fetch(`${FIRESTORE_URL}/config/featureFlags`);
    if (flagsRes.ok) {
      const data = await flagsRes.json();
      const f = data.fields || {};
      document.getElementById('promotionDisplay').value = f.promotionDisplay?.stringValue || 'title';
      document.getElementById('tokenEarningRate').value = f.tokenEarningRate?.integerValue || '2';
      document.getElementById('setupTokenReward').value = f.setupTokenReward?.integerValue || '10';
      document.getElementById('checkInFrequency').value = f.checkInFrequency?.stringValue || 'weekly';
      document.getElementById('showKeywordsInPromo').value = (f.showKeywordsInPromo?.booleanValue !== false).toString();
      document.getElementById('authSystem').value = f.authSystem?.stringValue || 'anonymous';
      document.getElementById('requireInvites').value = (f.requireInvites?.booleanValue !== false).toString();
      document.getElementById('safeBrowsingKey').value = f.safeBrowsingKey?.stringValue || '';
    }

    // Load blocklist
    const blRes = await fetch(`${FIRESTORE_URL}/config/blocklist`);
    if (blRes.ok) {
      const blData = await blRes.json();
      const terms = blData.fields?.terms?.arrayValue?.values?.map(v => v.stringValue) || [];
      document.getElementById('blocklist').value = terms.join(', ');
    }

    showMessage('Flags loaded successfully!', 'success');
  } catch (error) {
    console.error('Error loading flags:', error);
    showMessage('Error loading flags: ' + error.message, 'error');
  }
}

async function saveFlags() {
  const safeBrowsingKey = document.getElementById('safeBrowsingKey').value.trim();
  const blocklistRaw = document.getElementById('blocklist').value;
  const blocklistTerms = blocklistRaw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);

  try {
    // Save feature flags
    const flagsRes = await fetch(`${FIRESTORE_URL}/config/featureFlags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          promotionDisplay: { stringValue: document.getElementById('promotionDisplay').value },
          tokenEarningRate: { integerValue: document.getElementById('tokenEarningRate').value },
          setupTokenReward: { integerValue: document.getElementById('setupTokenReward').value },
          checkInFrequency: { stringValue: document.getElementById('checkInFrequency').value },
          showKeywordsInPromo: { booleanValue: document.getElementById('showKeywordsInPromo').value === 'true' },
          authSystem: { stringValue: document.getElementById('authSystem').value },
          requireInvites: { booleanValue: document.getElementById('requireInvites').value === 'true' },
          safeBrowsingKey: { stringValue: safeBrowsingKey }
        }
      })
    });

    if (!flagsRes.ok) {
      const err = await flagsRes.text();
      throw new Error('Failed to save flags: ' + err);
    }

    // Save blocklist
    const blRes = await fetch(`${FIRESTORE_URL}/config/blocklist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          terms: {
            arrayValue: {
              values: blocklistTerms.map(t => ({ stringValue: t }))
            }
          }
        }
      })
    });

    if (!blRes.ok) {
      const err = await blRes.text();
      throw new Error('Failed to save blocklist: ' + err);
    }

    showMessage('✅ Flags and blocklist saved! Changes will take effect within 5 minutes.', 'success');
  } catch (error) {
    console.error('Error saving:', error);
    showMessage('❌ Error: ' + error.message, 'error');
  }
}

function showMessage(message, type) {
  const div = document.getElementById('statusMessage');
  div.textContent = message;
  div.className = 'status-message ' + type;
  div.style.display = 'block';
  setTimeout(() => { div.style.display = 'none'; }, 5000);
}
