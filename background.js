// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'blockWithEudaimonia',
      title: 'Block with Eudaimonia',
      contexts: ['all']
    });
  });
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

});

// --- Ad signature aggregation (crowdsourced block collection) ---

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

// Reports a crowdsourced ad-block signature — now handled server-side. POSTs the
// signature to the report-ad-signature Netlify Function, which does the
// read-modify-write of aggregations/adSignatures in a transaction (fixing the
// old concurrent-writer race). Runs here in the service worker, not the content
// script, so a visited page's CSP can't block the request. Best-effort and
// non-blocking — a failure must never affect the user's block. No auth header:
// the endpoint is intentionally open, matching record-click.
async function reportAdSignature(sig) {
  if (!sig || !sig.key || !sig.selector) return;

  await fetch(`${FUNCTIONS_BASE}/report-ad-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: sig.key,
      selector: sig.selector,
      size: sig.size || '',
      domain: sig.domain || ''
    })
  });
}

// Check-in reminders are no longer scheduled here. The nagging notification was
// replaced by a passive state on the popup's Check In button (see popup.js),
// which let us drop the `notifications` and `alarms` permissions entirely —
// fewer install-time permission prompts. Eligibility ("can earn tokens") is
// computed on popup open from the stored lastCheckin timestamp.
