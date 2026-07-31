// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'blockWithEudaimonia',
      title: 'Block with Eudaimonia',
      contexts: ['all']
    });
  });

  // Schedule reminder alarm if user already has a schedule saved
  // (handles reinstalls / browser restarts)
  rescheduleAlarmFromStorage();
});

// Reschedule alarm on service worker startup (alarms don't survive SW restarts)
chrome.runtime.onStartup.addListener(() => {
  rescheduleAlarmFromStorage();
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'blockWithEudaimonia') {
    // Send message to content script to show the blocking modal.
    // Target the specific frame the click happened in - right-clicking an
    // ad inside a cross-origin iframe (e.g. a GPT ad slot) means the click
    // event, and therefore info.frameId, refers to that iframe's own
    // document, not the top-level page. Without frame targeting the message
    // goes to the top frame's content script instance, which has no
    // knowledge of the element the user actually clicked.
    const sendOptions = info.frameId !== undefined ? { frameId: info.frameId } : {};

    chrome.tabs.sendMessage(tab.id, {
      action: 'showBlockModal',
      x: info.x || 0,
      y: info.y || 0
    }, sendOptions).catch((error) => {
      // If content script isn't loaded, inject it first
      console.log('Content script not ready, injecting...');
      chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: info.frameId !== undefined ? [info.frameId] : undefined },
        files: ['content.js']
      }).then(() => {
        // Try again after injection
        chrome.tabs.sendMessage(tab.id, {
          action: 'showBlockModal',
          x: info.x || 0,
          y: info.y || 0
        }, sendOptions).catch(err => {
          // Fall back to top-frame messaging if frame-targeted delivery fails
          console.log('Frame-targeted delivery failed, falling back to top frame:', err);
          chrome.tabs.sendMessage(tab.id, {
            action: 'showBlockModal',
            x: info.x || 0,
            y: info.y || 0
          });
        });
      }).catch(err => {
        console.error('Failed to inject content script:', err);
      });
    });
  }
});

// Listen for messages from content script and popup pages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveBlock') {
    // Save the blocked item to storage
    chrome.storage.sync.get(['blockedSources', 'blockedCategories'], (data) => {
      const blockedSources = data.blockedSources || [];
      const blockedCategories = data.blockedCategories || [];

      if (request.blockType === 'source' && request.domain) {
        if (!blockedSources.includes(request.domain)) {
          blockedSources.push(request.domain);
        }
      } else if (request.blockType === 'category' && request.category) {
        const existing = blockedCategories.find(c => c.name === request.category);
        if (existing) {
          // Merge keywords if category already exists
          const newKeywords = request.keywords || [];
          existing.keywords = Array.from(new Set([...(existing.keywords || []), ...newKeywords]));
        } else {
          blockedCategories.push({
            name: request.category,
            keywords: request.keywords || [request.category]
          });
        }
      }

      chrome.storage.sync.set({
        blockedSources,
        blockedCategories
      }, () => {
        sendResponse({ success: true });
      });
    });

    return true; // Keep channel open for async response
  }

  if (request.action === 'reportAdSignature') {
    // Crowdsourced block-signature collection (2e, collection half only).
    // Runs in the background service worker rather than the content script on
    // purpose: a page's CSP connect-src can block a content-script fetch to
    // Firestore, but the background context is governed by the extension's own
    // CSP (which allows firestore.googleapis.com). Best-effort and fully
    // non-blocking - a failure here must never affect the user's block.
    reportAdSignature(request.signature)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.warn('Eudaimonia: ad signature report failed (non-fatal):', err?.message);
        sendResponse({ success: false });
      });
    return true; // async response
  }

  if (request.action === 'recordClick') {
    recordPromoClick(request.promoId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.warn('Eudaimonia: recordClick failed (non-fatal):', err?.message);
        sendResponse({ success: false });
      });
    return true; // async response
  }

  if (request.action === 'scheduleCheckinReminder') {
    scheduleCheckinAlarm(request.day, request.time);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'cancelCheckinReminder') {
    chrome.alarms.clear('checkinReminder');
    sendResponse({ success: true });
    return false;
  }
});

// Fire notification when alarm triggers
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkinReminder') {
    chrome.storage.sync.get(['lastCheckin'], (data) => {
      const lastCheckin = data.lastCheckin || null;
      const canEarn = canEarnTokens(lastCheckin);

      chrome.notifications.create('checkinReminder', {
        type: 'basic',
        iconUrl: 'icon48.png',
        title: canEarn ? '🎯 Time to check in and earn tokens!' : '🎯 Time for your weekly check-in!',
        message: canEarn
          ? 'Complete your check-in to earn tokens this week.'
          : 'Reflect on your systems and track your progress.',
        priority: 1
      });
    });
  }
});

// Open the extension popup when notification is clicked
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'checkinReminder') {
    chrome.notifications.clear(notificationId);
    // Open the popup by opening checkin.html in a new tab as a fallback
    // (Chrome doesn't allow programmatically opening the popup)
    chrome.tabs.create({ url: chrome.runtime.getURL('checkin.html') });
  }
});

// --- Ad signature aggregation (crowdsourced block collection) ---

const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const AD_SIGNATURES_URL = `${FIRESTORE_URL}/aggregations/adSignatures`;
const FUNCTIONS_BASE = 'https://eudaimonia-project.netlify.app/.netlify/functions';

// Records a promotion click by calling the record-click function. Runs here in
// the service worker (not the content script) so a visited page's CSP can't
// block the request. Best-effort and non-blocking.
async function recordPromoClick(promoId) {
  if (!promoId) return;
  await fetch(`${FUNCTIONS_BASE}/record-click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promoId })
  });
}

// Read-modify-write of a single Firestore doc holding a map of
// { <key>: { count, selector, size, domain, updated } }. Mirrors the existing
// keyword aggregation pattern. Same known caveat: concurrent writers can race
// and lose an increment - acceptable for approximate telemetry at this scale.
async function reportAdSignature(sig) {
  if (!sig || !sig.key || !sig.selector) return;

  const resp = await fetch(AD_SIGNATURES_URL);
  let current = {};
  if (resp.ok) {
    const data = await resp.json();
    const map = data.fields?.signatures?.mapValue?.fields || {};
    for (const [k, v] of Object.entries(map)) {
      const f = v.mapValue?.fields || {};
      current[k] = {
        count: parseInt(f.count?.integerValue || '0'),
        selector: f.selector?.stringValue || '',
        size: f.size?.stringValue || '',
        domain: f.domain?.stringValue || '',
        updated: f.updated?.stringValue || ''
      };
    }
  }

  const existing = current[sig.key];
  current[sig.key] = {
    count: (existing ? existing.count : 0) + 1,
    selector: sig.selector,
    size: sig.size || (existing ? existing.size : ''),
    domain: sig.domain || (existing ? existing.domain : ''),
    updated: new Date().toISOString()
  };

  const mapFields = {};
  for (const [k, val] of Object.entries(current)) {
    mapFields[k] = {
      mapValue: {
        fields: {
          count: { integerValue: val.count.toString() },
          selector: { stringValue: val.selector },
          size: { stringValue: val.size },
          domain: { stringValue: val.domain },
          updated: { stringValue: val.updated }
        }
      }
    };
  }

  await fetch(AD_SIGNATURES_URL, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        signatures: { mapValue: { fields: mapFields } },
        lastUpdated: { stringValue: new Date().toISOString() }
      }
    })
  });
}

// --- Alarm scheduling helpers ---

function rescheduleAlarmFromStorage() {
  chrome.storage.sync.get(['checkinDay', 'checkinTime'], (data) => {
    if (data.checkinDay !== undefined && data.checkinDay !== '' && data.checkinTime) {
      scheduleCheckinAlarm(data.checkinDay, data.checkinTime);
    }
  });
}

function scheduleCheckinAlarm(day, time) {
  // Clear any existing alarm first
  chrome.alarms.clear('checkinReminder', () => {
    if (day === '' || day === undefined || day === null) {
      // User opted out of reminders
      return;
    }

    const targetDay = parseInt(day); // 0 = Sunday, 6 = Saturday
    const [hours, minutes] = time.split(':').map(Number);

    const nextFire = getNextOccurrence(targetDay, hours, minutes);
    const weekInMinutes = 7 * 24 * 60;

    chrome.alarms.create('checkinReminder', {
      when: nextFire,
      periodInMinutes: weekInMinutes
    });

    console.log(`Eudaimonia: check-in reminder scheduled for ${new Date(nextFire).toLocaleString()}, repeating weekly`);
  });
}

function getNextOccurrence(targetDay, hours, minutes) {
  const now = new Date();
  const result = new Date(now);

  result.setHours(hours, minutes, 0, 0);

  // How many days ahead is the target day?
  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;

  if (daysUntil < 0) {
    daysUntil += 7; // Wrap to next week
  } else if (daysUntil === 0 && result <= now) {
    daysUntil = 7; // Same day but time has passed — next week
  }

  result.setDate(result.getDate() + daysUntil);
  return result.getTime();
}

function canEarnTokens(lastCheckin) {
  if (!lastCheckin) return true;
  const daysSince = (Date.now() - new Date(lastCheckin).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}
