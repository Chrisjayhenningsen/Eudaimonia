// Wrap everything in an IIFE to avoid variable collisions when script runs in multiple frames
(function() {
  'use strict';

  // Debug logging. Off for releases: content.js is injected into every frame
  // on <all_urls>, so ungated logging spams the console of every page the
  // user visits - dozens of lines per ad-heavy page. Flip to true when
  // debugging. console.error / console.warn are deliberately NOT gated.
  const EUD_DEBUG = false;
  function eudLog(...args) {
    if (EUD_DEBUG) console.log('[Eudaimonia]', ...args);
  }

  // Injection heartbeat. Content scripts run in an isolated world, so a page's
  // DevTools console can't see our JS globals - but the DOM is shared. Stamp the
  // version on <html> so "is the extension actually running here?" is a one-line
  // check from the page console: document.documentElement.dataset.eudaimoniaVersion
  try { document.documentElement.setAttribute('data-eudaimonia-version', '0.7.2'); } catch (e) {}

  // Firebase REST API wrapper
  const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
  const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  eudLog("content.js loaded on", window.location.href);
  
  // Feature flags cache
  let featureFlags = null;
  let flagsLastFetched = 0;
  const FLAGS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  // ─── Sidebar ad-cycling tuning ────────────────────────────────────────────
  // The sidebar only ever renders as many cards as fit on screen without
  // scrolling. Everything else that matched stays queued in memory. A card
  // sitting in the TOP HALF of the visible list without being clicked for
  // SIDEBAR_DWELL_MS gets sent to the back of the queue (never dropped -
  // matching keywords is enough to stay eligible forever) and the next
  // queued match slides into its slot.
  const SIDEBAR_DWELL_MS = 6000;   // unclicked-but-seen time before a card cycles out
  const SIDEBAR_POOL_SIZE = 25;    // matched candidates kept in the rotation pool

  let sidebarQueue = [];
  let sidebarCapacity = 0;
  let sidebarObserver = null;
  let sidebarDwellTimers = new Map();
  let sidebarDisplayFlags = null;
  
  const storage = {
    async getFeatureFlags() {
      const now = Date.now();
      
      if (featureFlags && (now - flagsLastFetched) < FLAGS_CACHE_DURATION) {
        return featureFlags;
      }
      
      try {
        const response = await fetch(`${FIRESTORE_URL}/config/featureFlags`);
        
        if (!response.ok) {
          eudLog('No feature flags found, using defaults');
          return this.getDefaultFlags();
        }
        
        const data = await response.json();
        const fields = data.fields;
        
        featureFlags = {
          promotionDisplay: fields.promotionDisplay?.stringValue || 'title',
          tokenEarningRate: parseInt(fields.tokenEarningRate?.integerValue || '2'),
          setupTokenReward: parseInt(fields.setupTokenReward?.integerValue || '10'),
          checkInFrequency: fields.checkInFrequency?.stringValue || 'weekly',
          showKeywordsInPromo: fields.showKeywordsInPromo?.booleanValue !== false,
          // Higher-risk heuristic: block iframes that LOOK like ads (srcless,
          // sandboxed, IAB-sized, vendor slot-id) without matching a known
          // network selector. Defaults OFF - opt-in via the flag so it can be
          // rolled back instantly if it catches a legit embed in the wild.
          heuristicIframeBlocking: fields.heuristicIframeBlocking?.booleanValue === true,
          // Crowdsourced block-signature collection: when a user manually
          // blocks an ad our selectors MISSED, send an anonymized fingerprint
          // (normalized selector + bare domain, no full URL) to Firestore so
          // the maintainer can see what's evading and add coverage. Default ON;
          // flip off to stop all collection.
          adSignatureReporting: fields.adSignatureReporting?.booleanValue !== false
        };
        
        flagsLastFetched = now;
        return featureFlags;
        
      } catch (error) {
        console.error('Error fetching feature flags:', error);
        return this.getDefaultFlags();
      }
    },
    
    getDefaultFlags() {
      return {
        promotionDisplay: 'title',
        tokenEarningRate: 2,
        setupTokenReward: 10,
        checkInFrequency: 'weekly',
        showKeywordsInPromo: true,
        heuristicIframeBlocking: false,
        adSignatureReporting: true
      };
    },
    
    async getPromotions() {
      try {
        const response = await fetch(`${FIRESTORE_URL}/promotions`);
        if (!response.ok) return [];
        
        const data = await response.json();
        if (!data.documents) return [];
        
        return data.documents.map(doc => {
          const fields = doc.fields;
          return {
            id: doc.name.split('/').pop(),
            url: fields.url?.stringValue || '',
            title: fields.title?.stringValue || '',
            description: fields.description?.stringValue || '',
            keywords: fields.keywords?.arrayValue?.values?.map(v => v.stringValue) || [],
            timestamp: fields.timestamp?.stringValue || '',
            cost: parseInt(fields.cost?.integerValue || '0'),
            budget: parseInt(fields.budget?.integerValue || '0'),
            clicks: parseInt(fields.clicks?.integerValue || '0')
          };
        });
      } catch (error) {
        console.error('Error fetching promotions:', error);
        return [];
      }
    }
  };

  // ─── Stripe purchase bridge ─────────────────────────────────────────────────
  // When the Netlify success page posts a message with the Stripe session ID,
  // we store it here so popup.js can pick it up and claim the token award.
  window.addEventListener('message', (e) => {
	  eudLog("received message:", e.data);
    // Stripe purchase bridge removed: purchased tokens are now credited
    // server-side by the Stripe webhook directly to the user's Firestore
    // balance, so there is nothing for the page to hand off here.
    return;
  });

  // ─── iframe → top-frame sidebar trigger ─────────────────────────────────────
  // When a badge inside an ad iframe is clicked, that iframe's content.js
  // instance can't render a full-page sidebar (it's scoped to the iframe's
  // own tiny document). Instead it sends a zero-payload postMessage to
  // window.top, and only the TOP-FRAME instance responds here.
  //
  // SECURITY NOTE: We deliberately ignore everything in the message payload
  // and call showPromotionSidebar() with no arguments - it independently
  // re-fetches the user's goals from chrome.storage and promotions from
  // Firebase, just as a normal badge click would. This means a malicious
  // page that forges an EUDAIMONIA_SHOW_SIDEBAR message can only make the
  // sidebar open (mildly annoying, and blocked by the existing "already
  // open" guard) - it cannot inject content into it. The message is a
  // pure trigger, never a data channel.
  if (window.self === window.top) {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.action === 'EUDAIMONIA_SHOW_SIDEBAR') {
        showPromotionSidebar();
      }
      if (e.data && e.data.action === 'EUDAIMONIA_RESCAN') {
        chrome.storage.sync.get(['autoBlockAds', 'blockedCategories'], (data) => {
          scanAndBlockAds(document, {
            autoBlockAds: data.autoBlockAds !== false,
            blockedCategories: data.blockedCategories || []
          });
        });
      }
      // Triggered by iframe content scripts when the user clicks Save on
      // the category input - the iframe can't read input.value cross-frame,
      // so we complete the save here in the top frame where the modal lives.
      // The adSignals payload is our own data (computed from the ad element
      // before it was hidden), not untrusted page content.
      if (e.data && e.data.action === 'EUDAIMONIA_SAVE_CATEGORY') {
        const modal = document.getElementById('eudaimonia-block-modal');
        if (!modal) return;
        const input = modal.querySelector('#eud-category-text');
        if (!input) return;
        const category = input.value.trim();
        if (!category) {
          alert('Please enter a category name.');
          return;
        }
        doSaveCategory(category, e.data.adSignals || '');
      }
    });
  }

  // Store the element that was right-clicked
  let targetElement = null;

// Listen for right-click to capture the target element
document.addEventListener('contextmenu', (e) => {
  targetElement = e.target;
}, true);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showBlockModal') {
    showBlockingModal(request.x, request.y);
  }
});

// Detects whether an element sits inside an ancestor that's both
// position:fixed AND uses an extremely high z-index (above 1 billion) -
// well beyond anything a normal page would legitimately need, but a known
// pattern for floating widgets (e.g. Taboola's "Next Up" unit, which uses
// z-index:9999999999) that are deliberately trying to stay above
// everything else on the page, including our own modal at the real CSS
// ceiling of 2147483647.
//
// When this is true, raising our own z-index further cannot help - we're
// already at the legal maximum, and so is the widget (browsers clamp
// values above it to the same ceiling). The actual fix is to stop
// competing in the global stacking order altogether: render inside that
// same ancestor's stacking context instead, so we only need to beat
// siblings within it, not the whole page.
function findHighZIndexFixedAncestor(element) {
  let node = element;
  let steps = 0;
  const HIGH_ZINDEX_THRESHOLD = 1000000000;

  while (node && node !== document.body && steps < 10) {
    const style = window.getComputedStyle(node);
    if (style.position === 'fixed') {
      const z = parseInt(style.zIndex, 10);
      if (!isNaN(z) && z > HIGH_ZINDEX_THRESHOLD) {
        return node;
      }
    }
    node = node.parentElement;
    steps++;
  }

  return null;
}

function showBlockingModal(clickX, clickY) {
	eudLog("showBlockingModal");
eudLog("location:", location.href);
eudLog("top?", window === window.top);
eudLog("target:", targetElement);
eudLog("trap:", findHighZIndexFixedAncestor(targetElement));
  if (!targetElement) return;

  const trapAncestor = findHighZIndexFixedAncestor(targetElement);

  if (trapAncestor) {
    showBlockingPopover(trapAncestor, clickX, clickY);
  } else {
    showBlockingModalFullscreen();
  }
}

// Compact variant used when the clicked element is inside a fixed,
// extremely-high-z-index ancestor (see findHighZIndexFixedAncestor above).
// Instead of a full-viewport overlay, this renders a small card anchored
// near the click point, inserted as a CHILD of that same ancestor so it
// inherits its stacking context rather than competing with it globally.
function showBlockingPopover(trapAncestor, clickX, clickY) {
  const popover = document.createElement('div');
  popover.id = 'eudaimonia-block-modal';
  popover.className = 'eudaimonia-popover-mode';

  // Position near the click point, but clamped so the card can't render
  // partially off-screen if the click happened near an edge.
  const POPOVER_WIDTH = 280;
  const ancestorRect = trapAncestor.getBoundingClientRect();
  // clickX/clickY are viewport-relative (from the browser's contextmenu
  // event coordinates); convert to be relative to the ancestor's own box,
  // since the popover will be positioned with that ancestor as its
  // containing block.
  let left = (clickX ?? ancestorRect.left + 20) - ancestorRect.left;
  let top = (clickY ?? ancestorRect.top + 20) - ancestorRect.top;

  // Clamp within the ancestor's own bounds so the popover doesn't spill
  // outside a small floating widget.
  const maxLeft = Math.max(0, ancestorRect.width - POPOVER_WIDTH - 10);
  left = Math.min(Math.max(0, left), maxLeft);
  top = Math.max(0, top);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${POPOVER_WIDTH}px`;

  popover.innerHTML = `
    <div class="eudaimonia-modal-content eudaimonia-popover-content">
      <h2>🎯 Block with Eudaimonia</h2>
      <p>What would you like to block?</p>
      
      <div class="eudaimonia-option-group">
        <button class="eudaimonia-option-btn" id="eud-block-source">
          <div class="eudaimonia-option-title">🚫 Block Source</div>
          <div class="eudaimonia-option-desc">Don't show content from this domain</div>
        </button>
        
        <button class="eudaimonia-option-btn" id="eud-block-category">
          <div class="eudaimonia-option-title">📂 Block Category</div>
          <div class="eudaimonia-option-desc">Block similar content by category</div>
        </button>

        <button class="eudaimonia-option-btn" id="eud-block-all">
          <div class="eudaimonia-option-title">🛡️ Block All Ads</div>
          <div class="eudaimonia-option-desc">Automatically replace ads with the Eudaimonia badge from now on</div>
        </button>
      </div>
      
      <div id="eud-domain-input" style="display: none;">
        <label for="eud-domain-text">What domain should be blocked?</label>
        <input type="text" id="eud-domain-text" placeholder="e.g., example.com" />
        <button id="eud-save-domain" class="eudaimonia-primary-btn">Block Domain</button>
      </div>
      
      <div id="eud-category-input" style="display: none;">
        <label for="eud-category-text">What category is this?</label>
        <input type="text" id="eud-category-text" list="eud-category-suggestions" placeholder="e.g., crypto, weight loss, dating apps..." />
        <datalist id="eud-category-suggestions"></datalist>
        <button id="eud-save-category" class="eudaimonia-primary-btn">Save</button>
      </div>
      
      <button class="eudaimonia-cancel-btn" id="eud-cancel">Cancel</button>
    </div>
  `;

  // Insert as a child of the trapping ancestor itself - this is the whole
  // point: we inherit its stacking context instead of fighting it.
  trapAncestor.appendChild(popover);

  wireUpModalButtons();
eudLog("wireUpModalButtons");
eudLog(modal);

[
  "eud-block-source",
  "eud-block-category",
  "eud-block-all",
  "eud-category-input",
  "eud-category-text"
].forEach(id => {
    eudLog(id, q(id));
});
  // Popover mode has no backdrop, so clicking anywhere outside the card
  // should close it - otherwise there'd be no way to dismiss without
  // hitting Cancel exactly.
  setTimeout(() => {
    document.addEventListener('click', handleOutsidePopoverClick, true);
  }, 0);
}

function handleOutsidePopoverClick(e) {
  const popover = document.getElementById('eudaimonia-block-modal');
  if (popover && !popover.contains(e.target)) {
    closeModal();
  }
}

function showBlockingModalFullscreen() {
  const overlay = document.createElement('div');
  overlay.id = 'eudaimonia-block-modal';
  overlay.innerHTML = `
    <div class="eudaimonia-modal-backdrop"></div>
    <div class="eudaimonia-modal-content">
      <h2>🎯 Block with Eudaimonia</h2>
      <p>What would you like to block?</p>
      
      <div class="eudaimonia-option-group">
        <button class="eudaimonia-option-btn" id="eud-block-source">
          <div class="eudaimonia-option-title">🚫 Block Source</div>
          <div class="eudaimonia-option-desc">Don't show content from this domain</div>
        </button>
        
        <button class="eudaimonia-option-btn" id="eud-block-category">
          <div class="eudaimonia-option-title">📂 Block Category</div>
          <div class="eudaimonia-option-desc">Block similar content by category</div>
        </button>

        <button class="eudaimonia-option-btn" id="eud-block-all">
          <div class="eudaimonia-option-title">🛡️ Block All Ads</div>
          <div class="eudaimonia-option-desc">Automatically replace ads with the Eudaimonia badge from now on</div>
        </button>
      </div>
      
      <div id="eud-domain-input" style="display: none;">
        <label for="eud-domain-text">What domain should be blocked?</label>
        <input type="text" id="eud-domain-text" placeholder="e.g., example.com" />
        <button id="eud-save-domain" class="eudaimonia-primary-btn">Block Domain</button>
      </div>
      
      <div id="eud-category-input" style="display: none;">
        <label for="eud-category-text">What category is this?</label>
        <input type="text" id="eud-category-text" list="eud-category-suggestions" placeholder="e.g., crypto, weight loss, dating apps..." />
        <datalist id="eud-category-suggestions"></datalist>
        <button id="eud-save-category" class="eudaimonia-primary-btn">Save</button>
      </div>
      
      <button class="eudaimonia-cancel-btn" id="eud-cancel">Cancel</button>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  wireUpModalButtons();
  
  overlay.querySelector('.eudaimonia-modal-backdrop').addEventListener('click', closeModal);
}

// Shared button wiring between the fullscreen and popover modal variants -
// both render the same set of buttons/inputs by id, just with different
// surrounding markup and insertion point, so the handlers don't need to
// know or care which mode is active.
//
// IMPORTANT: uses modal.querySelector rather than document.getElementById
// throughout. In the popover case, the modal is inserted into the TOP
// frame's document as a child of a high-z-index ancestor, but this code
// runs inside an AD IFRAME's content script where `document` refers to
// the iframe's own tiny document. document.getElementById would search
// the wrong document, return null on the very first call, throw a
// TypeError, and silently prevent all subsequent listeners from wiring.
// modal.querySelector searches within the modal element itself, which is
// always the right scope regardless of which document it lives in.
function wireUpModalButtons() {
  const modal = document.getElementById('eudaimonia-block-modal')
    || document.querySelector('#eudaimonia-block-modal')
    || (() => {
      try {
        return window.top.document.getElementById('eudaimonia-block-modal');
      } catch (e) {
        return null;
      }
    })();

  if (!modal) {
    console.error('Eudaimonia: wireUpModalButtons could not find modal');
    return;
  }

  const q = (id) => modal.querySelector(`#${id}`);

  // Debug logging
  eudLog("wireUpModalButtons");
  eudLog("location:", location.href);
  eudLog("modal:", modal);

  [
    "eud-block-source",
    "eud-block-category",
    "eud-block-all",
    "eud-category-input",
    "eud-category-text"
  ].forEach(id => {
    eudLog(id, q(id));
  });

  q('eud-block-source').addEventListener('click', handleBlockSource);
  q('eud-block-category').addEventListener('click', showCategoryInput);
  q('eud-block-all').addEventListener('click', handleBlockAll);
  q('eud-save-domain').addEventListener('click', handleManualDomain);
  q('eud-save-category').addEventListener('click', handleBlockCategory);
  q('eud-cancel').addEventListener('click', closeModal);

  chrome.storage.sync.get(['blockedCategories'], (data) => {
    const categories = data.blockedCategories || [];
    const datalist = modal.querySelector('#eud-category-suggestions');
    if (!datalist) return;
    datalist.innerHTML = categories
      .map(c => `<option value="${escapeHtml(c.name)}"></option>`)
      .join('');
  });
}

// Modal-scoped element lookup. Always searches within #eudaimonia-block-modal
// rather than the full document, making it safe when the modal lives in a
// different document than the content script (e.g. popover inserted into the
// top frame's document while this script runs inside an ad iframe).
// Returns null if the modal or element isn't found.
function modalEl(id) {
  let modal = document.getElementById('eudaimonia-block-modal');
  if (!modal && window.self !== window.top) {
    try { modal = window.top.document.getElementById('eudaimonia-block-modal'); }
    catch (e) {}
  }
  return modal ? modal.querySelector(`#${id}`) : null;
}

function showCategoryInput() {
    eudLog("showCategoryInput");
    eudLog("modal", document.getElementById("eudaimonia-block-modal"));

    const input = modalEl("eud-category-input");
    const text = modalEl("eud-category-text");

    eudLog("input", input);
    eudLog("text", text);

    if (!input || !text) {
        eudLog("FAILED");
        return;
    }

    eudLog("SUCCESS");

    input.style.display = "block";
    text.focus();
}

// Defensive check used by every handler that relies on targetElement being
// set from the contextmenu listener. If this ever fails, something raced
// or cleared targetElement between right-click and button-click - this
// surfaces that clearly in the console instead of silently doing nothing,
// which is what made an earlier occurrence of this hard to diagnose.
function requireTargetElement() {
  if (!targetElement) {
    console.error('Eudaimonia: targetElement was missing when a block action was attempted. The right-click target may not have been captured correctly - try right-clicking the ad again.');
    closeModal();
    return false;
  }
  return true;
}

function handleBlockSource() {
  if (!requireTargetElement()) return;
  
  const domain = extractDomain(targetElement);
  
  if (!domain) {
    showDomainInput();
    return;
  }
  
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'source',
    domain: domain
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Eudaimonia: saveBlock message failed:', chrome.runtime.lastError.message);
      alert('Eudaimonia: could not save this block (extension messaging failed). Try right-clicking the ad again.');
      return;
    }
    if (response && response.success) {
      reportAdSignatureIfNovel(targetElement); // before hide - needs dimensions
      blockElement(targetElement, 'source', domain);
      closeModal();
    } else {
      console.error('Eudaimonia: saveBlock returned no success response');
    }
  });
}

function showDomainInput() {
  const input = modalEl('eud-domain-input');
  const text = modalEl('eud-domain-text');
  if (!input || !text) return;
  input.style.display = 'block';
  text.focus();
}

function handleManualDomain() {
  if (!requireTargetElement()) return;
  
  const domain = (modalEl('eud-domain-text') || {}).value?.trim();
  
  if (!domain) {
    alert('Please enter a domain');
    return;
  }
  
  let cleanDomain = domain;
  try {
    if (domain.includes('://')) {
      cleanDomain = new URL(domain).hostname;
    } else {
      cleanDomain = domain.split('/')[0];
    }
  } catch (e) {
    cleanDomain = domain.split('/')[0];
  }
  
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'source',
    domain: cleanDomain
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Eudaimonia: saveBlock message failed:', chrome.runtime.lastError.message);
      alert('Eudaimonia: could not save this block (extension messaging failed). Try right-clicking the ad again.');
      return;
    }
    if (response && response.success) {
      reportAdSignatureIfNovel(targetElement); // before hide - needs dimensions
      blockElement(targetElement, 'source', cleanDomain);
      closeModal();
    } else {
      console.error('Eudaimonia: saveBlock returned no success response');
    }
  });
}

function handleBlockCategory() {
  if (!requireTargetElement()) return;

  // When this handler runs inside an ad iframe, the modal lives in the top
  // frame's document. Reading input.value cross-frame is blocked by the
  // same-origin policy (returns undefined even if the user typed something),
  // so we cannot read the category name from here. Instead, post a message
  // to the top frame carrying the ad signals we already have, and let the
  // top frame's content script instance read the input and complete the save
  // — it runs in the same document as the modal, so cross-frame access
  // isn't an issue there.
  if (window.self !== window.top) {
    const isBadge = targetElement.classList.contains('eudaimonia-blocked-badge');
    const adSignals = isBadge
      ? (targetElement.dataset.adSignals || '')
      : extractTextSignals(targetElement);
    window.top.postMessage({
      action: 'EUDAIMONIA_SAVE_CATEGORY',
      adSignals: adSignals
    }, '*');
    return;
  }

  const category = (modalEl('eud-category-text') || {}).value?.trim();
  
  if (!category) {
    alert('Please enter a category');
    return;
  }
  
  // Seed keywords with the category name plus any of the target element's
  // own text signals - this means the category can immediately catch
  // similarly-worded ads, not just exact future re-typing of this name.
  //
  // If targetElement is an already-blocked badge (the user right-clicked
  // our own badge rather than the original ad), extractTextSignals would
  // only harvest our own UI text ("Content blocked", etc). Instead, read
  // the original ad's signals that blockElement stored on the badge at
  // creation time via data-ad-signals.
  const isBadge = targetElement && targetElement.classList.contains('eudaimonia-blocked-badge');
  const ownSignals = isBadge
    ? (targetElement.dataset.adSignals || '')
    : (targetElement ? extractTextSignals(targetElement) : '');
  doSaveCategory(category, ownSignals);
}

// Shared save logic, called either directly (top-frame) or after receiving
// EUDAIMONIA_SAVE_CATEGORY from an iframe. Separated so the postMessage
// handler can call it without duplicating the sendMessage/rescan logic.
function doSaveCategory(category, ownSignals) {
  const seedKeywords = new Set([category.toLowerCase()]);
  ownSignals
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .slice(0, 5)
    .forEach(w => seedKeywords.add(w));
  
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'category',
    category: category,
    keywords: Array.from(seedKeywords)
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Eudaimonia: saveBlock message failed:', chrome.runtime.lastError.message);
      return;
    }
    if (response && response.success) {
      if (targetElement) {
        reportAdSignatureIfNovel(targetElement); // before hide - needs dimensions
        blockElement(targetElement, 'category', category);
      }
      closeModal();
      chrome.storage.sync.get(['autoBlockAds', 'blockedCategories'], (data) => {
        scanAndBlockAds(document, {
          autoBlockAds: data.autoBlockAds !== false,
          blockedCategories: data.blockedCategories || []
        });
      });
    } else {
      console.error('Eudaimonia: saveBlock returned no success response');
    }
  });
}

function handleBlockAll() {
  chrome.storage.sync.set({ autoBlockAds: true }, () => {
    // Scan the current page now so the effect is immediate.
    // Existing badges are untouched - scanAndBlockAds skips anything
    // already marked data-eudaimonia-blocked.
    chrome.storage.sync.get(['blockedCategories'], (data) => {
      scanAndBlockAds(document, {
        autoBlockAds: true,
        blockedCategories: data.blockedCategories || []
      });
    });
    closeModal();
  });
}

function extractDomain(element) {
  let link = element.closest('a');
  if (!link) {
    link = element.querySelector('a');
  }
  
  if (link && link.href) {
    try {
      const url = new URL(link.href);
      return url.hostname;
    } catch (e) {
      // Invalid URL, continue to fallback
    }
  }
  
  let img = element;
  if (element.tagName !== 'IMG') {
    img = element.closest('img');
    if (!img) {
      img = element.querySelector('img');
    }
  }
  
  if (img && img.src) {
    try {
      const url = new URL(img.src);
      const hostname = url.hostname;
      const commonCDNs = ['cloudfront.net', 'cloudflare.com', 'akamaihd.net', 'imgur.com'];
      const isCommonCDN = commonCDNs.some(cdn => hostname.includes(cdn));
      
      if (!isCommonCDN) {
        return hostname;
      }
    } catch (e) {
      // Invalid URL
    }
  }
  
  return null;
}

// Detects whether an element sits inside a "page-obscuring" interstitial -
// a fixed-position wrapper that covers most of the viewport (full-page ad
// takeovers, "click to continue" overlays, etc). These are structurally
// different from normal in-content ads: the actual ad creative (image, close
// button) is usually a small piece nested inside a much larger fixed
// container that also includes a separate dimming backdrop as a sibling.
// Blocking just the small piece leaves the backdrop active and the page
// still effectively unusable, even though the ad image itself is gone.
//
// Returns the interstitial wrapper element if found, otherwise null. Walks
// up a bounded number of steps so a deeply nested ad doesn't cause runaway
// climbing on pages where no interstitial actually exists.
function findInterstitialWrapper(element) {
  let node = element;
  let steps = 0;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  while (node && node !== document.body && steps < 8) {
    const style = window.getComputedStyle(node);
    if (style.position === 'fixed') {
      const rect = node.getBoundingClientRect();
      const coversWidth = rect.width >= viewportW * 0.5;
      const coversHeight = rect.height >= viewportH * 0.5;
      // Also accept large explicit pixel dimensions even if not 100% of
      // viewport - many interstitials use a fixed px size (e.g. 640x480)
      // positioned centrally rather than stretching edge to edge.
      const isLargeFixedBlock = rect.width >= 300 && rect.height >= 300;

      if ((coversWidth && coversHeight) || isLargeFixedBlock) {
        return node;
      }
    }
    node = node.parentElement;
    steps++;
  }

  return null;
}

// ─── Video ad handling ──────────────────────────────────────────────────────
// Video pre-rolls are structurally unlike banner ads. On VAST-based players
// (YouTube, xhamster, most tube sites) the ad and the content play through the
// SAME <video> element - the player just swaps the source when the ad ends.
// That makes display:none actively wrong twice over:
//   1. Hiding a <video> does not pause it. The ad keeps playing, audio and
//      all, and its countdown still has to run to completion before the
//      player will load the real video. The user sees a badge and thinks
//      they've blocked something while the ad plays on invisibly.
//   2. Because the element is shared, hiding it hides the content video too.
//      Worse, a hidden element has a zero-size rect, so player scripts that
//      use IntersectionObserver to drive a sticky/floating mini-player read
//      it as permanently out of view and detach the player from the page.
// So for video we END the ad rather than conceal it: click the player's own
// skip control if there is one, otherwise seek to the end so the player's
// VAST logic fires its own "complete" handler and loads the content.

// Skip controls across common players. Ordered roughly most- to least-specific.
const SKIP_BUTTON_SELECTORS = [
  '.ytp-ad-skip-button',
  '.videoAdUiSkipButton',
  '[class*="xplayer-ads"] [class*="skip"]',
  '[class*="ad-skip"]',
  '[class*="adSkip"]',
  '[class*="skip-button"]',
  '[class*="skipButton"]',
  '[id*="skip-button"]',
  'button[class*="skip"]'
];

function findSkipButton(root) {
  for (const sel of SKIP_BUTTON_SELECTORS) {
    let btn;
    try { btn = root.querySelector(sel); } catch (e) { continue; }
    if (!btn) continue;
    const rect = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    // Only click something the user could actually have clicked themselves -
    // players keep a disabled/hidden skip button in the DOM during the
    // pre-skip countdown, and clicking that does nothing.
    const visible = rect.width > 0 && rect.height > 0 &&
                    style.visibility !== 'hidden' && style.display !== 'none' &&
                    parseFloat(style.opacity || '1') > 0.1;
    if (visible && !btn.disabled) return btn;
  }
  return null;
}

// Locates the <video> that a block target belongs to. The user may right-click
// the video itself, or - more often on tube sites - the transparent
// clickthrough <a> that the ad overlays on top of the player. We climb a
// bounded distance and then require the candidate video to actually overlap
// the clicked element, so we can't wander up to <body> and grab an unrelated
// video elsewhere on the page.
function findAdVideo(element) {
  if (element.tagName === 'VIDEO') return element;

  const targetRect = element.getBoundingClientRect();
  let node = element;
  let steps = 0;

  while (node && node !== document.body && steps < 8) {
    let video = null;
    if (node.tagName === 'VIDEO') {
      video = node;
    } else if (node.querySelector) {
      video = node.querySelector('video');
    }

    if (video) {
      const vr = video.getBoundingClientRect();
      const overlaps = targetRect.left < vr.right && targetRect.right > vr.left &&
                       targetRect.top < vr.bottom && targetRect.bottom > vr.top;
      // A zero-size target (some clickthrough links are 0x0 until hover) can't
      // overlap anything, so fall back to accepting it if it's a descendant.
      const degenerate = targetRect.width === 0 || targetRect.height === 0;
      if (overlaps || degenerate) return video;
    }

    node = node.parentElement;
    steps++;
  }

  return null;
}

// Walks up from the video to the outermost element that is still essentially
// "the player" - i.e. hasn't grown much beyond the video's own box. We anchor
// the badge just outside this, so it sits above the player rather than on top
// of the picture.
function findPlayerShell(video) {
  const vr = video.getBoundingClientRect();
  let node = video;
  let steps = 0;

  while (node.parentElement && node.parentElement !== document.body && steps < 5) {
    const pr = node.parentElement.getBoundingClientRect();
    if (pr.width > vr.width * 1.3 || pr.height > vr.height * 1.6) break;
    node = node.parentElement;
    steps++;
  }

  return node;
}

// Fast-forwards a pre-roll to its end. We mute while doing this because
// seeking can produce a burst of ad audio, then restore the user's original
// mute state as soon as the player swaps in different media - otherwise we'd
// silently leave the content video muted.
//
// Retried on an interval because some players re-seek the ad back if you move
// the playhead once; a handful of nudges usually wins, and if it doesn't we
// give up rather than fight the page forever.
function endVideoAd(video) {
  const originalMuted = video.muted;
  const originalSrc = video.currentSrc || video.src || '';
  let attempts = 0;
  let timer = null;

  const finish = () => {
    if (timer) clearInterval(timer);
    timer = null;
    video.removeEventListener('loadedmetadata', onSourceChange);
    video.removeEventListener('emptied', onSourceChange);
    try { video.muted = originalMuted; } catch (e) {}
  };

  function onSourceChange() {
    const current = video.currentSrc || video.src || '';
    if (current && current !== originalSrc) finish();
  }

  video.addEventListener('loadedmetadata', onSourceChange);
  video.addEventListener('emptied', onSourceChange);

  const nudge = () => {
    attempts++;
    const current = video.currentSrc || video.src || '';
    if (current !== originalSrc) { finish(); return; }

    // Prefer the player's own skip control - it drives the player through its
    // normal ad-complete path, which is always cleaner than moving the
    // playhead underneath it. Re-checked each tick because most skip buttons
    // only become clickable after a countdown ("Skip in 5...").
    const skip = findSkipButton(document);
    if (skip) {
      skip.click();
      return;
    }

    const duration = video.duration;
    if (isFinite(duration) && duration > 0) {
      try {
        video.muted = true;
        video.currentTime = Math.max(0, duration - 0.05);
        // Some players only advance their VAST state machine while playing,
        // so a paused ad parked at the end never fires 'complete'.
        if (video.paused) { const p = video.play(); if (p) p.catch(() => {}); }
      } catch (e) {
        // currentTime can throw on a not-yet-seekable stream; the next tick
        // will try again.
      }
    }

    if (attempts >= 8) finish();
  };

  nudge();
  timer = setInterval(nudge, 250);
}

// The video path: end the ad, hide only the ad's own overlay chrome (the
// clickthrough link and banner, which are genuinely separate elements and
// safe to remove), and anchor a badge outside the player.
function blockVideoAd(video, element, blockType, blockValue) {
  endVideoAd(video);

  // Hide the ad's overlay furniture, but never the video itself. We scope
  // this to the player shell so we can't reach unrelated page elements.
  const shell = findPlayerShell(video);
  const overlays = shell.parentElement
    ? shell.parentElement.querySelectorAll('[class*="ads"], [class*="advert"], [id*="ads-"]')
    : [];
  overlays.forEach(node => {
    if (node.contains(video)) return;      // never hide an ancestor of the video
    if (node.querySelector('video')) return;
    node.style.display = 'none';
    node.style.pointerEvents = 'none';
    node.setAttribute('data-eudaimonia-blocked', blockType);
  });

  const badge = createBlockedBadge(element, blockType, blockValue, 'video');
  const anchor = shell.parentNode ? shell : video;
  if (anchor.parentNode) {
    anchor.parentNode.insertBefore(badge, anchor);
  }

  video.setAttribute('data-eudaimonia-video-blocked', blockValue);

  // Badges anchored outside the player would be orphaned on screen if the
  // page later removes the player; and in fullscreen only the fullscreened
  // subtree renders, so the badge correctly disappears on its own.
  return badge;
}

function createBlockedBadge(element, blockType, blockValue, variant) {
  const badge = document.createElement('div');
  badge.className = 'eudaimonia-blocked-badge' +
    (variant === 'video' ? ' eudaimonia-blocked-badge--video' : '');

  // Store the original element's text signals on the badge itself so that
  // if the user later right-clicks the badge (rather than the original ad)
  // to block by category, handleBlockCategory has real ad keywords to seed
  // with — not our own UI text ("Content blocked", "Click for aligned
  // alternative") which is what extractTextSignals would harvest from the
  // badge div without this.
  const originalSignals = extractTextSignals(element);
  if (originalSignals.trim()) {
    badge.dataset.adSignals = originalSignals;
  }

  const headline = variant === 'video'
    ? `Ad skipped (${blockType}: ${blockValue})`
    : `Content blocked (${blockType}: ${blockValue})`;

  badge.innerHTML = `
    <img src="${chrome.runtime.getURL('Eudaimonia_logo.png')}" alt="Eudaimonia" class="eudaimonia-badge-logo">
    <div class="eudaimonia-badge-text">
      ${headline}<br>
      <span class="eudaimonia-badge-link">Click for aligned alternative</span>
    </div>
  `;

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // If this badge is inside an iframe (e.g. an ad served in its own
    // frame), document.body here refers to that iframe's tiny document,
    // not the real page - so rendering a sidebar here would be clipped
    // to the iframe's own viewport dimensions. Instead, send a trigger
    // message to the top-level frame's content script instance, which
    // has access to the real document.body and can render the sidebar
    // at full-page size. We intentionally send ONLY a trigger action,
    // never any data payload - see note in the top-frame listener.
    if (window.self !== window.top) {
      window.top.postMessage({ action: 'EUDAIMONIA_SHOW_SIDEBAR' }, '*');
    } else {
      togglePromotionSidebar();
    }

    return false;
  }, true);

  return badge;
}

function blockElement(element, blockType, blockValue, alreadyClimbed = false) {
  let container = element;
  let blockedInterstitial = false;

  // Video ads get an entirely different treatment - see blockVideoAd. This
  // check runs before the interstitial check and the climb, because both of
  // those end in display:none, which is the one thing we must not do to a
  // shared player element.
  const adVideo = findAdVideo(element);
  if (adVideo) {
    blockVideoAd(adVideo, element, blockType, blockValue);
    showFirstBlockTooltip();
    return;
  }
  
  if (!alreadyClimbed) {
    // First check whether this element is part of a page-obscuring
    // interstitial. If so, prefer blocking the whole interstitial wrapper
    // over the normal small-container climb below - otherwise we'd hide
    // just the ad creative and leave its dimming backdrop active.
    const interstitial = findInterstitialWrapper(element);
    
    if (interstitial) {
      container = interstitial;
      blockedInterstitial = true;
    } else {
      // Only climb here for manual-click paths (source/category via right-click
      // on a raw DOM node). Callers that already did their own climb - i.e.
      // scanAndBlockAds, which also runs containsRealContent() safety checks
      // along the way - pass alreadyClimbed=true so we don't undo that work
      // by climbing past the boundary it deliberately stopped at.
      while (container && container.parentElement) {
        const rect = container.getBoundingClientRect();
        const isLargeEnough = rect.width > 200 && rect.height > 100;
        const isNotLink = container.tagName !== 'A';
        
        if (isLargeEnough && isNotLink) {
          break;
        }
        
        container = container.parentElement;
      }
    }
  }
  
  if (!container.parentElement) {
    console.warn('Eudaimonia: Could not find suitable parent for badge');
    return;
  }
  
  // Backstop. If the climb or the interstitial check somehow landed on a
  // container that holds a <video>, hiding it would take the content player
  // down with the ad. Reroute to the video path rather than proceed.
  const containerVideo = container.tagName === 'VIDEO'
    ? container
    : (container.querySelector ? container.querySelector('video') : null);
  if (containerVideo) {
    blockVideoAd(containerVideo, element, blockType, blockValue);
    showFirstBlockTooltip();
    return;
  }

  const badge = createBlockedBadge(element, blockType, blockValue, 'default');

  container.parentNode.insertBefore(badge, container);

  container.style.display = 'none';
  container.style.pointerEvents = 'none';
  container.setAttribute('data-eudaimonia-blocked', blockType);
  container.setAttribute('data-eudaimonia-value', blockValue);
  
  // Interstitial ad scripts commonly lock page scroll (e.g. setting
  // overflow:hidden on <html>/<body>) when they open, expecting their own
  // close button to undo it later. Since we hide the overlay directly
  // rather than triggering that close handler, the lock is never released
  // on its own - so we force scroll back on ourselves whenever we block
  // one of these. This is intentionally blunt (always reset, regardless of
  // what the page's own CSS wants) because a page legitimately needing
  // overflow:hidden outside of a modal context is rare, and the alternative
  // is leaving the user stuck after they explicitly asked us to remove
  // what was almost certainly the cause.
  if (blockedInterstitial) {
    document.documentElement.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow');
    
    // Fallback for scroll locks applied via a CSS class (e.g.
    // body.modal-open { overflow: hidden }) rather than inline style -
    // removing the inline property above won't undo a stylesheet rule, so
    // force it back on directly as a last resort.
    requestAnimationFrame(() => {
      const htmlStillLocked = window.getComputedStyle(document.documentElement).overflow === 'hidden';
      const bodyStillLocked = window.getComputedStyle(document.body).overflow === 'hidden';
      if (htmlStillLocked) document.documentElement.style.overflow = 'auto';
      if (bodyStillLocked) document.body.style.overflow = 'auto';
    });
  }
  
  showFirstBlockTooltip();

  const parent = container.parentNode;
  if (parent) {
    const nearbyIframes = parent.querySelectorAll('iframe');
    nearbyIframes.forEach(iframe => {
      const src = iframe.src || '';
      if (src.includes('criteo') || src.includes('doubleclick') || src.includes('googlesyndication') ||
          iframe.getAttribute('sandbox') || iframe.title?.toLowerCase().includes('ad')) {
        iframe.style.pointerEvents = 'none';
        iframe.style.display = 'none';
      }
    });
  }
}

function showFirstBlockTooltip() {
  chrome.storage.sync.get(['firstBlockComplete'], (data) => {
    if (!data.firstBlockComplete) {
      chrome.storage.sync.set({ firstBlockComplete: true });

      setTimeout(() => {
        const tooltip = document.createElement('div');
        tooltip.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          background: #4a9eff;
          color: white;
          padding: 15px 20px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 14px;
          max-width: 300px;
          animation: slideIn 0.3s ease;
        `;
        tooltip.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 5px;">🎉 Nice! First ad blocked!</div>
          <div style="font-size: 13px; opacity: 0.9;">Click the badge to see aligned recommendations. Block more ads to discover better alternatives.</div>
        `;
        document.body.appendChild(tooltip);
        
        setTimeout(() => {
          tooltip.style.transition = 'opacity 0.3s';
          tooltip.style.opacity = '0';
          setTimeout(() => tooltip.remove(), 300);
        }, 5000);
      }, 500);
    }
  });
}

function closeModal() {
  // The modal may live in the top frame's document (popover case, where it
  // was inserted as a child of a high-z-index ancestor in the top frame)
  // while this code runs inside an ad iframe. Try the local document first,
  // then fall back to window.top.document.
  let modal = document.getElementById('eudaimonia-block-modal');
  if (!modal && window.self !== window.top) {
    try { modal = window.top.document.getElementById('eudaimonia-block-modal'); }
    catch (e) {} // cross-origin guard
  }
  if (modal) {
    modal.remove();
  }
  // Only relevant if popover mode added this listener, but always safe to
  // call - removeEventListener on a listener that was never added is a no-op.
  document.removeEventListener('click', handleOutsidePopoverClick, true);
  targetElement = null;
}

// ─── Ad selector list ────────────────────────────────────────────────────────
// Three layers: standard attributes, known ad network patterns, common class/id patterns.
// Reusable as-is for a Safari Web Extension; the selector strings also map directly
// to Safari Content Blocker JSON rules (css-display-none action).
const AD_SELECTORS = [
  // Standard semantic attributes
  '[data-ad]',
  '[data-adunit]',
  '[data-ad-unit]',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[data-adtype]',
  '[aria-label*="advertisement"]',
  '[aria-label*="Advertisement"]',
  '[aria-label*="Sponsored"]',
  '[aria-label*="sponsored"]',

  // Google ad network iframes and containers
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="googleadservices.com"]',
  'iframe[id*="google_ads_iframe"]',
  'ins.adsbygoogle',

  // Other common ad networks
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="ads.yahoo.com"]',
  'iframe[src*="bing.com/maps/sdkrelease/mapcontrol"]',
  'iframe[src*="criteo.com"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="outbrain.com"]',
  'iframe[src*="moatads.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="a-ads.com"]',
  'img[src*="a-ads.com"]',
  'img[src*="static.a-ads.com"]',

  // Common class name patterns
  '[class*="advertisement"]',
  '[class*="Advertisement"]',
  '[class*="adsbygoogle"]',
  '[class*="ad-container"]',
  '[class*="ad-wrapper"]',
  '[class*="ad-banner"]',
  '[class*="ad-unit"]',
  '[class*="ad-slot"]',
  '[class*="sponsor-"]',
  '[class*="sponsored-"]',
  '[class*="Sponsored"]',
  '[class*="native-ad"]',
  '[class*="promo-ad"]',
  '[class*="dfp-ad"]',
  '[class*="taboola"]',
  '[class*="outbrain"]',

  // Common id patterns
  '[id*="google_ads"]',
  '[id*="div-gpt-ad"]',
  '[id*="ad-container"]',
  '[id*="ad-banner"]',
  '[id*="ad-slot"]',
  '[id*="adunit"]',
  '[id*="taboola"]',
  '[id*="outbrain"]',

  // Taboola uses deliberately generic-looking class/id names (thumbBlock,
  // video-label, etc.) to blend in, but the "tbl-" prefix is a consistent
  // fingerprint across their widgets regardless of surrounding naming.
  '[class*="tbl-"]',
  '[id*="tbl-"]',

  // PubFuture — the primary network on mangaread.org and similar WP manga sites.
  // Its iframes carry NO src attribute (written via srcdoc/JS), so the
  // iframe[src*="..."] rules above can never see them. We anchor on the
  // container fingerprints instead. The pf-config-<hash> suffix randomizes per
  // pageview, so we prefix-match it rather than using the full string.
  '.PUBFUTURE',
  '[id^="pf-"][class*="PUBFUTURE"]',
  '[class^="pf-config-"]',
  '.pf-wrapper',
  'iframe[id^="iframe_pf-"]',

  // BidGear SSP — the outer wrapper survives when only the inner a-ads iframe is
  // hidden, leaving a blank rectangle. Both id and class carry randomized hex
  // suffixes, so prefix-anchor is the only stable handle.
  '[id^="bg-ssp-"]',
  '[class^="bg-container-"]',

  // Bare ad-token class names. IMPORTANT: use ~= (whitespace-separated whole
  // token) not *= here. [class*="ad"] would match header, download, loading,
  // read-container, etc. and destroy half the web. [class~="ad"] matches only
  // an element whose class list contains the exact token "ad".
  '[class~="ad"]',
  '[class~="c-ads"]',
  '[class*="body-top-ads"]',
  '[class*="body-bottom-ads"]',

  // Clickjacking overlay observed on mangaread: a transparent, contentless
  // full-viewport <a> that intercepts clicks and redirects off-site. The
  // general overlay heuristic (isClickjackOverlay) catches this class of thing
  // structurally, but the literal id is a cheap, zero-false-positive fast path.
  'a#clickLayer',
];

// Elements we should never block, even if they match a selector above
const AD_ALLOWLIST = [
  '#eudaimonia-block-modal',
  '#eudaimonia-promo-sidebar',
  '.eudaimonia-blocked-badge',
  '[data-eudaimonia-blocked]',
];

function isAllowlisted(el) {
  return AD_ALLOWLIST.some(sel => el.closest(sel));
}

// ─── Ad signature collection (2e, collection half) ───────────────────────────
// When a user MANUALLY blocks an ad our selectors didn't catch, we send an
// anonymized fingerprint upstream so the maintainer can see what's evading and
// ship coverage. We deliberately do NOT auto-promote these to the live selector
// list - that's a curated, human-reviewed step in the admin panel. This half is
// pure telemetry: cheap, reversible, privacy-preserving.

// Collapse per-pageview randomness so the same ad slot fingerprints the same way
// across loads/sites. Ad networks hide behind hashed tokens
// (pf-config-6a14105f4ef244020330c759, bg-container-102396d51d7); we replace any
// long hex run or 4+ digit run with '*' so the STABLE part survives.
function normalizeAdToken(tok) {
  return tok
    // Any 6+ alphanumeric run CONTAINING A DIGIT is treated as a hash/id and
    // collapsed. The digit requirement is what protects real words: "PUBFUTURE",
    // "advertisement", "adsbygoogle" have no digit and survive, while
    // "6a14105f4ef244020330c759" / base36 slot ids do not.
    .replace(/[a-z0-9]{6,}/gi, m => (/\d/.test(m) ? '*' : m))
    // Shorter pure-digit runs (slot indexes, zone ids) too.
    .replace(/\d{4,}/g, '*')
    .replace(/\*{2,}/g, '*');
}

// Small deterministic string hash -> short base36 key. Used as the Firestore
// map key so we never put user-derived or special characters in a field name.
function adSignatureHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return 'sig' + (h >>> 0).toString(36);
}

function bucketSize(px) {
  return Math.round(px / 10) * 10; // coarse bucket to absorb sub-pixel noise
}

function fingerprintAdElement(el) {
  const tag = el.tagName.toLowerCase();

  const rawClass = (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '';
  const classTokens = rawClass.toString().trim().split(/\s+/)
    .filter(Boolean)
    .map(normalizeAdToken)
    // drop our own UI classes and tokens that became just '*' after stripping
    .filter(t => t && t !== '*' && !t.startsWith('eudaimonia'))
    .slice(0, 4);

  const id = el.id ? normalizeAdToken(el.id) : '';

  // For iframes the serving host is the single most useful stable signal.
  let host = '';
  if (tag === 'iframe') {
    const src = el.getAttribute('src') || '';
    if (src) { try { host = new URL(src, location.href).hostname; } catch (e) {} }
  }

  const r = el.getBoundingClientRect();
  const size = `${bucketSize(r.width)}x${bucketSize(r.height)}`;

  const selector = tag
    + (id ? '#' + id : '')
    + (classTokens.length ? '.' + classTokens.join('.') : '')
    + (host ? '|' + host : '');

  return { selector, size, key: adSignatureHash(selector) };
}

// Is this element (or an ancestor) already matched by our shipped selector
// list? If so, blocking it is NOT a selector gap - it's the user refining by
// category/source on an already-recognized ad - so there's nothing new to
// report. Only genuine misses are worth collecting.
function isCoveredByAdSelectors(el) {
  let combined;
  try { combined = AD_SELECTORS.join(','); } catch (e) { return false; }
  let n = el;
  let steps = 0;
  while (n && n !== document.documentElement && steps < 12) {
    try { if (n.matches && n.matches(combined)) return true; } catch (e) {}
    n = n.parentElement;
    steps++;
  }
  return false;
}

// Session-scoped dedup so re-blocking / multi-frame instances don't inflate
// counts within a single pageview.
const reportedSignatureKeys = new Set();

function reportAdSignatureIfNovel(el) {
  try {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (isAllowlisted(el)) return;
    // Don't fingerprint our own already-placed badge.
    if (el.classList && el.classList.contains('eudaimonia-blocked-badge')) return;
    // Only report genuine selector misses.
    if (isCoveredByAdSelectors(el)) return;

    const fp = fingerprintAdElement(el);
    if (!fp.selector || reportedSignatureKeys.has(fp.key)) return;
    reportedSignatureKeys.add(fp.key);

    // Privacy: send the page's bare hostname, never the full URL (ad URLs carry
    // identifiers). No user id is attached.
    const domain = location.hostname;

    storage.getFeatureFlags().then(flags => {
      if (flags.adSignatureReporting === false) return;
      chrome.runtime.sendMessage({
        action: 'reportAdSignature',
        signature: { key: fp.key, selector: fp.selector, size: fp.size, domain }
      }, () => { void chrome.runtime.lastError; }); // swallow - best effort
    }).catch(() => {});
  } catch (e) {
    // Telemetry must never interfere with the actual block.
  }
}

// Hostname fragments that mean "this image is from an ad/tracking network,
// not real page content." Used to decide whether a climbed-up container is
// safe to hide, since real content (article images, manga pages, etc.) will
// never be served from these.
const AD_IMAGE_HOST_FRAGMENTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'ads.yahoo.com', 'criteo.com', 'taboola.com',
  'outbrain.com', 'moatads.com', 'adnxs.com', 'pubadx.one', 'pubfuture.com',
  'onclckbn.net', 'onclicka.js', 'a-ads.com', 'adflycode.com',
  'bidgear.com', 'bg-ssp', 'rubiconproject.com', 'onetag-sys.com',
  '7ad.org', 'adform.net',
];

function isAdImageSrc(src) {
  if (!src) return true; // no src (lazy-loaded ad placeholder) - not disqualifying
  return AD_IMAGE_HOST_FRAGMENTS.some(frag => src.includes(frag));
}

// Pure ad-network HOSTNAMES (not the class/file fragments in the list above).
// If content.js finds itself running in a frame served from one of these, the
// ENTIRE frame is an ad - nothing legitimate is ever served from these origins.
// This is what lets us remove video ad creatives (e.g. a bare <video class="main">
// served by a-ads) that the normal video-protection guard would otherwise spare.
const AD_FRAME_HOSTS = [
  'a-ads.com', 'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'moatads.com',
  'adnxs.com', 'pubadx.one', 'pubfuture.com', '7ad.org', 'adform.net',
  'bidgear.com', 'rubiconproject.com', 'onetag-sys.com', 'onclckbn.net',
];

// Cached: a frame's origin never changes over its lifetime. Uses exact-or-subdomain
// matching (host === h or host ends with ".h") - NOT substring - so a lookalike
// like "somea-ads.com.evil.test" can't match "a-ads.com".
let _adFrameChecked = false;
let _isAdFrame = false;
function isAdNetworkFrame() {
  if (_adFrameChecked) return _isAdFrame;
  _adFrameChecked = true;
  try {
    const host = location.hostname || '';
    _isAdFrame = !!host && AD_FRAME_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) {
    _isAdFrame = false;
  }
  return _isAdFrame;
}

// Safety net for the climb below: if a candidate container holds an <img>
// whose src is NOT from a known ad network, treat that as real page content
// (article art, manga pages, product photos, etc.) and refuse to block it.
// This protects against the climb walking too far up a deeply-nested wrapper
// chain (common in WordPress block markup) and catching unrelated content
// that merely happens to share an ancestor with an empty/not-yet-loaded ad slot.
function containsRealContent(container) {
  // Media elements are treated as real content unconditionally. On VAST-based
  // players the pre-roll and the content video share one <video>, so a
  // container holding media can never be safely hidden - even when an ad is
  // playing in it right now. Manual blocks on video go through blockVideoAd,
  // which ends the ad instead of hiding it; the auto-scanner simply declines.
  if (container.querySelector('video, audio')) return true;

  const imgs = container.querySelectorAll('img');
  for (const img of imgs) {
    if (!isAdImageSrc(img.src)) return true;
  }
  return false;
}

// Gathers visible/readable text from a container for category-keyword
// matching: alt text, aria-labels, title attributes, and plain text content.
// Used both when seeding a new category's keywords (from the element the
// user right-clicked) and when scanning other ad-matched elements for the
// same keywords later.
function extractTextSignals(container) {
  if (!container) return '';
  const parts = [];
  container.querySelectorAll('img[alt]').forEach(img => parts.push(img.alt));
  container.querySelectorAll('[aria-label]').forEach(el => parts.push(el.getAttribute('aria-label')));
  container.querySelectorAll('[title]').forEach(el => parts.push(el.getAttribute('title')));
  parts.push(container.textContent || '');
  return parts.join(' ').toLowerCase();
}

// Checks a container's text signals against the user's blocked-category
// keyword lists. Returns the matching category name, or null.
// Note: this is only ever called on elements that ALREADY matched an
// AD_SELECTOR - category keywords are a refinement within that gate, not
// an independent way to flag arbitrary page content as blockable. This is
// intentional: it keeps false positives bounded by the same logic that
// already protects regular auto-blocking, at the cost of missing
// category matches on ads our selectors don't yet recognize as ads at all
// (those still need to be caught manually, same as before).
function matchesBlockedCategory(container, blockedCategories) {
  if (!blockedCategories || blockedCategories.length === 0) return null;
  const text = extractTextSignals(container);
  for (const cat of blockedCategories) {
    const keywords = cat.keywords || [cat.name];
    if (keywords.some(kw => kw && text.includes(kw.toLowerCase()))) {
      return cat.name;
    }
  }
  return null;
}

// ─── Clickjacking overlay detection ─────────────────────────────────────────
// A whole class of ad evades the selector list by having no ad-ish class, id,
// or network src at all: a transparent, empty, absolutely/fixed-positioned <a>
// (or link-wrapping div) stretched over most of the viewport at a high z-index.
// Its only purpose is to intercept the user's next click and navigate off-site.
// These are more dangerous than banners (any click is hijacked), so we detect
// them structurally rather than waiting to fingerprint each new instance.
//
// The discriminator that keeps false positives near zero is the OFF-SITE HREF:
// legitimate full-viewport overlays (modal backdrops, cookie banners, lightbox
// dimmers, sticky nav) either carry real content/text or don't exist to send
// you to another domain. We require ALL of: positioned + covers most of the
// viewport + high z-index + effectively empty + a link to a different host.
const CLICKJACK_MIN_Z = 1000;

function isClickjackOverlay(el) {
  // Find the outbound link: the element itself if it's an anchor, else a lone
  // anchor child that fills it (the common "div wrapper + inner <a>" shape).
  let anchor = null;
  if (el.tagName === 'A') {
    anchor = el;
  } else {
    const innerAnchors = el.querySelectorAll('a[href]');
    if (innerAnchors.length === 1) anchor = innerAnchors[0];
  }
  if (!anchor || !anchor.getAttribute('href')) return false;

  // Must point to a different host than the page we're on.
  let destHost;
  try {
    destHost = new URL(anchor.href, location.href).hostname;
  } catch (e) {
    return false;
  }
  if (!destHost || destHost === location.hostname) return false;

  // getComputedStyle can return null for elements that aren't rendered in a
  // view (detached, inside a display:none subtree in some engines). Guard it -
  // a null deref here would otherwise abort the whole overlay pass.
  const style = getComputedStyle(el);
  if (!style) return false;
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  const z = parseInt(style.zIndex, 10);
  if (!Number.isFinite(z) || z < CLICKJACK_MIN_Z) return false;

  // Covers most of the viewport (the whole point of a click-catcher).
  const r = el.getBoundingClientRect();
  const coversWidth = r.width >= window.innerWidth * 0.6;
  const coversHeight = r.height >= window.innerHeight * 0.6;
  if (!coversWidth || !coversHeight) return false;

  // Effectively empty: no meaningful text, no real media. A legit interactive
  // overlay (consent dialog, lightbox) fails at least one of these.
  const text = (el.textContent || '').trim();
  if (text.length > 10) return false;
  if (el.querySelector('img, video, audio, form, input, button')) return false;

  return true;
}

// Scan a subtree for clickjacking overlays.
//
// PERFORMANCE: a clickjack overlay is always built around an off-site anchor -
// either the anchor IS the overlay, or a div wraps a single anchor. So we
// iterate the ANCHORS (few) and test each anchor plus its immediate parent,
// rather than iterating every <div> and running a nested querySelectorAll on
// each. On a large DOM (a full manga chapter is tens of thousands of nodes) the
// old div-scan was O(divs x descendants) and could freeze the page - it ran on
// the initial scan, every observer re-fire, and every delayed sweep.
function scanAndBlockOverlays(root = document, options = {}) {
  const { autoBlockAds = true } = options;
  if (!autoBlockAds) return; // respect the same master toggle as ad blocking

  let anchors;
  try {
    anchors = root.querySelectorAll('a[href]');
  } catch (e) {
    return;
  }

  const seen = new Set();
  const consider = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || seen.has(el)) return;
    seen.add(el);
    if (el.dataset && el.dataset.eudaimoniaBlocked) return;
    if (isAllowlisted(el)) return;
    if (!isClickjackOverlay(el)) return;
    blockElement(el, 'overlay', 'clickjacking', true);
  };

  anchors.forEach(a => {
    consider(a);              // the anchor itself as the overlay
    consider(a.parentElement); // or a div wrapping just this anchor
  });
}

// Video ads served INSIDE a pure ad-network frame evade the normal scan twice
// over: the creative (e.g. <video class="main">) matches no AD_SELECTOR, and the
// video-protection guard (containsRealContent) deliberately refuses to hide
// anything holding a <video> so it never kills a real player. But when the frame
// itself is served from an ad-network origin, there is no real player to protect
// - the whole frame is an ad. So we remove its content wholesale.
//
// Safety: gated on isAdNetworkFrame() (exact/subdomain origin match against a
// pure-ad-network host list) AND restricted to sub-frames - it will never blank
// the top document, even in the implausible case its hostname matched.
function scanAdNetworkFrame(options = {}) {
  const { autoBlockAds = true } = options;
  if (!autoBlockAds) return;
  if (window.self === window.top) return;   // never touch the top document
  if (!isAdNetworkFrame()) return;

  const body = document.body;
  if (!body || (body.dataset && body.dataset.eudaimoniaBlocked)) return;

  // Stop any playing/queued creative before hiding, so audio doesn't keep going.
  try {
    document.querySelectorAll('video, audio').forEach(m => { try { m.pause(); } catch (e) {} });
  } catch (e) {}

  body.style.setProperty('display', 'none', 'important');
  body.setAttribute('data-eudaimonia-blocked', 'ad-frame');
  body.setAttribute('data-eudaimonia-value', location.hostname);
}

// ─── Wrapper reconciliation (the "blank rectangle" fix) ──────────────────────
// Hiding an ad element with display:none collapses it - UNLESS an ancestor
// wrapper reserved the space with an explicit height (very common: the ad slot
// sits in a fixed 300x250 / 728x90 box so the layout doesn't jump while the
// creative loads). Hide the child, the sized wrapper stays, and the user sees a
// blank rectangle instead of a removed ad.
//
// This walks UP from the element we're about to hide and absorbs those
// space-reserving wrappers, so the whole slot collapses. It is deliberately
// conservative - every step must clear four guards, because over-climbing on a
// single-column reader page means hiding real content:
//
//   1. Area ratio: the parent may be at most ~1.6x the child's area. A wrapper
//      that merely pads an ad slot is about the same size as the ad; a real
//      content container (article body, manga reader) is vastly larger and is
//      rejected on the first step.
//   2. No real media: parent must not contain <video>/<audio> or a non-ad
//      <img> (reuses containsRealContent).
//   3. No substantial text: parent's trimmed text must be short (<= 40 chars).
//      Ad wrappers hold a creative, not prose; a content container fails this.
//   4. Not a page-level root: never climb into <body>, <html>, <main>, or a
//      known content container.
function climbToAdWrapper(startContainer) {
  const CONTENT_ROOT_SELECTOR =
    'body, html, main, [role="main"], .read-container, .reading-content, ' +
    '.entry-content, article, #content, .site-content';
  const area = el => {
    const r = el.getBoundingClientRect();
    return Math.max(r.width, 0) * Math.max(r.height, 0);
  };

  let container = startContainer;
  let steps = 0;
  while (steps < 4) {
    const parent = container.parentElement;
    if (!parent) break;
    if (parent === document.body || parent === document.documentElement) break;
    if (parent.matches && parent.matches(CONTENT_ROOT_SELECTOR)) break;

    const childArea = area(container);
    const parentArea = area(parent);
    // If the child has no measurable area yet, fall back to a bare-wrapper test
    // rather than an unreliable ratio.
    const ratioOk = childArea > 0
      ? parentArea <= childArea * 1.6
      : parent.children.length === 1;
    if (!ratioOk) break;

    if (containsRealContent(parent)) break;
    if ((parent.textContent || '').trim().length > 40) break;

    container = parent;
    steps++;
  }
  return container;
}

// ─── Heuristic ad-iframe detection (2b, feature-flagged) ─────────────────────
// The hardest ad to fingerprint is an iframe with NO ad-network src at all -
// the creative is written into it via srcdoc/JS after the auction resolves
// (exactly the PubFuture case on mangaread). The selector list can't see those.
// This scores an iframe on ad-shaped traits and blocks it only when confident.
//
// To keep legitimate embeds safe (YouTube, Stripe/payment frames, Disqus, maps),
// signals are split into STRONG (ad-specific) and WEAK (also common on real
// widgets). We block only when there are >=2 total signals AND at least one is
// strong. That combination is what excludes the dangerous false positives: a
// sandboxed cross-origin payment iframe scores two WEAK signals and zero strong,
// so it is never touched.
const IAB_SIZES = [
  [300,250],[728,90],[320,50],[300,600],[160,600],[970,250],
  [336,280],[970,90],[468,60],[250,250],[320,100],[300,50],
];
const SLOT_ID_RX = /^(iframe[_-])?[a-z]{2,6}[-_]\d{3,}/i;

function iframeSignals(iframe) {
  const strong = [];
  const weak = [];

  const srcAttr = (iframe.getAttribute('src') || '').trim();
  const srclessOrOpaque = !srcAttr ||
    /^(about:blank|javascript:|data:)/i.test(srcAttr);
  if (srclessOrOpaque) strong.push('srcless');

  const r = iframe.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (IAB_SIZES.some(([iw, ih]) => Math.abs(w - iw) <= 2 && Math.abs(h - ih) <= 2)) {
    strong.push('iab-size');
  }

  const idName = (iframe.id || '') + ' ' + (iframe.getAttribute('name') || '');
  if (SLOT_ID_RX.test((iframe.id || '')) || SLOT_ID_RX.test(iframe.getAttribute('name') || '')) {
    strong.push('slot-id');
  }

  if (iframe.hasAttribute('sandbox')) weak.push('sandbox');

  // Cross-origin content we can't read. Cheap and exception-safe: reading
  // contentDocument on a cross-origin frame returns null (or throws), which is
  // itself the signal. Only meaningful when there IS a src (a srcless frame is
  // same-origin about:blank and already counted above).
  if (srcAttr && !srclessOrOpaque) {
    let crossOrigin = false;
    try { crossOrigin = iframe.contentDocument === null; } catch (e) { crossOrigin = true; }
    if (crossOrigin) weak.push('cross-origin');
  }

  return { strong, weak };
}

function isHeuristicAdIframe(iframe) {
  const { strong, weak } = iframeSignals(iframe);
  return strong.length >= 1 && (strong.length + weak.length) >= 2;
}

function scanHeuristicIframes(root = document, options = {}) {
  const { autoBlockAds = true, heuristicIframes = false } = options;
  if (!autoBlockAds || !heuristicIframes) return;

  let iframes;
  try {
    iframes = root.querySelectorAll('iframe');
  } catch (e) {
    return;
  }
  iframes.forEach(iframe => {
    if (iframe.dataset && iframe.dataset.eudaimoniaBlocked) return;
    if (isAllowlisted(iframe)) return;
    if (!isHeuristicAdIframe(iframe)) return;
    // Reconcile the surrounding blank-space wrapper, same as the selector path.
    let container = climbToAdWrapper(iframe);
    if (containsRealContent(container)) return;
    blockElement(container, 'ad', 'heuristic-iframe', true);
  });
}

function scanAndBlockAds(root = document, options = {}) {
  const { autoBlockAds = true, blockedCategories = [] } = options;
  // The overlay and heuristic-iframe passes are newer and more experimental than
  // the core selector list. They must NEVER be able to take down the core
  // ad-blocking: if either throws on some hostile page, swallow it here so the
  // selector loop below still runs. (Silent by default; flip EUD_DEBUG to see.)
  try { scanAdNetworkFrame(options); } catch (e) { if (EUD_DEBUG) console.warn('[Eudaimonia] ad-frame pass failed:', e); }
  try { scanAndBlockOverlays(root, options); } catch (e) { if (EUD_DEBUG) console.warn('[Eudaimonia] overlay pass failed:', e); }
  try { scanHeuristicIframes(root, options); } catch (e) { if (EUD_DEBUG) console.warn('[Eudaimonia] heuristic-iframe pass failed:', e); }
  const combined = AD_SELECTORS.join(',');
  let candidates;
  try {
    candidates = root.querySelectorAll(combined);
  } catch (e) {
    return; // malformed selector shouldn't crash the page
  }

  candidates.forEach(el => {
    // Skip if already handled or allowlisted
    if (el.dataset.eudaimoniaBlocked || isAllowlisted(el)) return;

    // Skip tiny/invisible elements (tracking pixels, etc.)
    const rect = el.getBoundingClientRect();
    const hasSize = rect.width > 50 && rect.height > 30;

    // For iframes and ins tags we trust the selector alone (they may not have
    // dimensions until fully loaded). For class/id matches we require size.
    const isTrustedSelector = el.tagName === 'IFRAME' || el.tagName === 'INS';
    if (!isTrustedSelector && !hasSize) return;

    // Decide what to actually hide. For cosmetic ad selectors, the matched
    // element itself is almost always the right thing to block - it's the
    // widget/iframe/ad-unit, not some unrelated ancestor. We only climb past
    // it when the matched element is a near-invisible wrapper (zero-size, or
    // a single-child positioning div) where hiding it alone wouldn't actually
    // remove anything visible.
    //
    // Critically, we do NOT climb just because a parent happens to be wide -
    // on a single-column page (e.g. an article or manga reader) almost every
    // ancestor is wide, so that check used to walk all the way up to a
    // container that wrapped unrelated page content.
    let container = el;
    let steps = 0;
    while (steps < 3) {
      const r = container.getBoundingClientRect();
      const isNearInvisible = r.width < 2 || r.height < 2;
      const isBareWrapper = container.children.length === 1 &&
        container.textContent.trim().length === 0;

      if (!isNearInvisible && !isBareWrapper) break;
      if (!container.parentElement) break;

      // Don't climb into a parent that holds real, non-ad images (article
      // art, manga pages, etc.) - stop here even if this step would
      // otherwise look like a bare wrapper worth climbing past.
      if (containsRealContent(container.parentElement)) break;

      container = container.parentElement;
      steps++;
    }

    // Wrapper reconciliation: absorb any space-reserving ancestor so the slot
    // collapses instead of leaving a blank rectangle. Guarded to stop before
    // real content - see climbToAdWrapper.
    container = climbToAdWrapper(container);

    // Final safety check: even after climbing (or not), never hide a
    // container that contains real, non-ad images. If the matched element
    // itself turned out to be (or climbed into) something holding real
    // content, skip it entirely rather than risk hiding a manga page,
    // article photo, etc.
    if (containsRealContent(container)) return;

    if (!container.parentElement) return;

    // Two independent reasons an ad-selector match can result in a block:
    //   1. autoBlockAds is on - block everything that looks like an ad.
    //   2. The element's text matches a blocked category - block it even
    //      if autoBlockAds is off, but ONLY because it already passed the
    //      ad-selector gate above. Category keywords never block something
    //      that didn't look like an ad in the first place.
    const categoryMatch = matchesBlockedCategory(container, blockedCategories);

    if (categoryMatch) {
      blockElement(container, 'category', categoryMatch, true);
    } else if (autoBlockAds) {
      blockElement(container, 'ad', 'auto-detected', true);
    }
  });
}

// On page load, block previously blocked items AND auto-detected ads
window.addEventListener('load', () => {
  chrome.storage.sync.get(['blockedSources', 'blockedCategories', 'autoBlockAds'], (data) => {
    const blockedSources = data.blockedSources || [];
    const blockedCategories = data.blockedCategories || [];
    const autoBlockAds = data.autoBlockAds !== false; // default ON

    // ── Perf: top-frame gating ───────────────────────────────────────────────
    // Only the TOP frame runs the full document-scanning machinery below (the
    // blocked-source link scan, the selector/overlay/heuristic passes, the
    // MutationObserver, and the delayed full-document sweeps). A subframe runs
    // ONLY scanAdNetworkFrame — the single pass that must execute from *inside* a
    // frame, because it blanks a frame whose own origin is a pure ad network and
    // the top document can't reach into a cross-origin child.
    //
    // This is safe for the flagship cases: top-level ad iframes (including the
    // heuristic PubFuture/mangaread case) are caught by the top frame's own
    // heuristic/selector passes, which inspect the <iframe> element from the
    // parent — they never needed the in-frame instance. What we give up is
    // scanning ads/links nested *inside* non-ad-network subframes; in exchange,
    // an ad-heavy page with dozens of iframes stops installing a persistent
    // subtree+attribute MutationObserver and four delayed full sweeps in every
    // one of them.
    if (window.self !== window.top) {
      const runFrameScan = () => { try { scanAdNetworkFrame({ autoBlockAds }); } catch (e) {} };
      runFrameScan();
      // A few cheap re-runs in case the frame's body/creative inflates shortly
      // after load — replaces the per-frame observer we deliberately skip.
      [800, 2500, 6000].forEach(delay => setTimeout(runFrameScan, delay));
      return;
    }

    // Block previously-blocked sources
    if (blockedSources.length > 0) {
      const links = document.querySelectorAll('a[href]');
      links.forEach(link => {
        try {
          const url = new URL(link.href);
          if (blockedSources.includes(url.hostname)) {
            let container = link;
            while (container && container.parentElement) {
              const rect = container.getBoundingClientRect();
              if (rect.width > 200 && rect.height > 100) {
                break;
              }
              container = container.parentElement;
            }
            if (container && container.parentElement && container.parentElement.parentElement) {
              blockElement(container, 'source', url.hostname);
            }
          }
        } catch (e) {
          // Invalid URL, skip
        }
      });
    }

    // Scan for ads if either auto-block-all is on, or there's at least one
    // blocked category to match against - these are independent triggers.
    // A user can have category blocking set up without wanting blanket
    // "hide everything ad-shaped" behavior, and vice versa.
    const shouldScan = autoBlockAds || blockedCategories.length > 0;

    if (shouldScan) {
      // CRITICAL: core ad-blocking must start IMMEDIATELY and must never depend
      // on a network call. Earlier this was gated behind getFeatureFlags() (a
      // Firestore fetch) - on a slow or CSP-restricted page that fetch can hang,
      // and blocking never ran at all. So we scan right now with the heuristic
      // pass OFF (its safe default), then resolve the flag in the background and,
      // only if enabled, upgrade the shared scanOptions so LATER rescans (the
      // observer + delayed sweeps) pick up the heuristic pass. scanOptions is
      // passed by reference into those closures, so mutating it here is enough.
      const scanOptions = {
        autoBlockAds,
        blockedCategories,
        heuristicIframes: false
      };
      startScanning(scanOptions);

      storage.getFeatureFlags().then(flags => {
        if (flags && flags.heuristicIframeBlocking === true) {
          scanOptions.heuristicIframes = true;
          // Run one extra pass now that the flag is known to be on.
          try { scanAndBlockAds(document, scanOptions); } catch (e) {}
        }
      }).catch(() => { /* flag unknown -> heuristic stays off; core unaffected */ });
    }

    function startScanning(scanOptions) {
      scanAndBlockAds(document, scanOptions);

      // Watch for ads injected after page load (infinite scroll, lazy slots, etc.)
      //
      // Ad slots on auction-driven sites are frequently written as empty 0-height
      // containers at first paint, then inflate later when a creative wins the
      // auction and loads. A childList-only observer sees the empty shell, scans
      // it (finds nothing measurable), and never looks again. So we also watch
      // attribute mutations (style/class/src/height/width flips are exactly how a
      // slot goes from 0px to a rendered ad) and re-scan the changed subtree.
      //
      // Both paths funnel through a single debounced queue so a burst of DOM
      // churn (common during ad load) collapses into one re-scan pass instead of
      // hundreds.
      const rescanQueue = new Set();
      let rescanTimer = null;
      const flushRescan = () => {
        rescanTimer = null;
        const roots = [...rescanQueue];
        rescanQueue.clear();
        roots.forEach(node => {
          // Node may have been detached between queueing and flush.
          if (node && node.isConnected) scanAndBlockAds(node, scanOptions);
        });
      };
      const queueRescan = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        // Never re-scan our own UI; avoids feedback loops from badges/sidebar.
        if (node.closest && isAllowlisted(node)) return;
        rescanQueue.add(node);
        if (rescanTimer === null) rescanTimer = setTimeout(flushRescan, 250);
      };

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            // A slot inflating / swapping its creative. Re-evaluate it and its
            // parent (the ad often lives one wrapper up from the attr change).
            queueRescan(mutation.target);
            queueRescan(mutation.target.parentElement);
            continue;
          }
          mutation.addedNodes.forEach(node => queueRescan(node));
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'src', 'id', 'height', 'width'],
      });

      // Safety net for the timing gap the observer can't cover: some slots inflate
      // via layout changes that don't mutate a watched attribute on a node we've
      // seen (e.g. an iframe's own content resizing its host). A few delayed
      // full-document sweeps catch those late arrivals cheaply. Debounced queue
      // dedupes these against the observer's own re-scans.
      [800, 2000, 4000, 8000].forEach(delay => {
        setTimeout(() => scanAndBlockAds(document, scanOptions), delay);
      });
    }
  });
});

function togglePromotionSidebar() {
  if (document.getElementById('eudaimonia-promo-sidebar')) {
    closeSidebar();
    return;
  }
  showPromotionSidebar();
}

function showPromotionSidebar() {
  if (document.getElementById('eudaimonia-promo-sidebar')) {
    return;
  }
  
  chrome.storage.sync.get(['moveToward', 'moveAway', 'dailyHabits', 'productCategories'], async (data) => {
    const positiveGoals = [
      data.moveToward || '',
      data.dailyHabits || '',
      data.productCategories || ''
    ].join(' ').toLowerCase();
    
    const negativeKeywords = (data.moveAway || '').toLowerCase();
    
    const allPromotions = await storage.getPromotions();
    const matchedPromos = matchPromotions(allPromotions, positiveGoals, negativeKeywords);
    
    createSidebar(matchedPromos);
  });
}

function matchPromotions(promotions, positiveGoalsText, negativeKeywordsText) {
  if (promotions.length === 0) {
    return [];
  }
  
  const negativeWords = negativeKeywordsText
    .split(/[\s,]+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase().trim());
  
  const scored = promotions
    .filter(promo => (promo.budget || 0) > 0)
    .map(promo => {
    let score = 0;
    
    promo.keywords.forEach(keyword => {
      if (positiveGoalsText.includes(keyword)) {
        score += 1;
      }
    });
    
    const promoText = `${promo.title} ${promo.description}`.toLowerCase();
    const promoWords = promoText.split(/[\s,]+/).filter(w => w.length > 4);
    
    promoWords.forEach(word => {
      if (positiveGoalsText.includes(word)) {
        score += 0.5;
      }
    });
    
    negativeWords.forEach(negWord => {
      if (promoText.includes(negWord)) {
        score -= 10;
      }
    });
    
    promo.keywords.forEach(keyword => {
      if (negativeKeywordsText.includes(keyword)) {
        score -= 10;
      }
    });
    
    return { ...promo, score };
  });
  
  return scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SIDEBAR_POOL_SIZE); // keep a rotation pool, not just the top few
}

// ─── Sidebar rendering + ad cycling ─────────────────────────────────────────
//
// The sidebar only renders as many cards as fit on screen without scrolling
// (sidebarCapacity). Everything else that matched sits in sidebarQueue,
// waiting its turn.
//
// While a rendered card sits in the TOP HALF of the visible list without
// being clicked for SIDEBAR_DWELL_MS, it's considered "seen but ignored":
// it gets moved to the back of sidebarQueue (never dropped - it's still a
// keyword match and stays eligible forever) and the next queued match
// slides into the freed slot. Clicking a card clears its dwell timer, so an
// engaged card is never cycled out from under the user.

async function createSidebar(promotions) {
  const backdrop = document.createElement('div');
  backdrop.className = 'eudaimonia-sidebar-backdrop';
  backdrop.id = 'eudaimonia-sidebar-backdrop';

  const sidebar = document.createElement('div');
  sidebar.className = 'eudaimonia-promo-sidebar';
  sidebar.id = 'eudaimonia-promo-sidebar';

  const header = document.createElement('div');
  header.className = 'eudaimonia-sidebar-header';
  header.innerHTML = `
    <h2>🎯 Aligned Recommendations</h2>
    <p>Community picks matched to your goals</p>
    <button class="eudaimonia-close-sidebar" id="eud-close-sidebar">×</button>
  `;

  const promoList = document.createElement('div');
  promoList.className = 'eudaimonia-promo-list';
  promoList.id = 'eudaimonia-promo-list';

  sidebar.appendChild(header);
  sidebar.appendChild(promoList);
  document.body.appendChild(backdrop);
  document.body.appendChild(sidebar);

  if (promotions.length === 0) {
    sidebarQueue = [];
    promoList.innerHTML = `
      <div class="eudaimonia-no-promos">
        <div class="eudaimonia-no-promos-icon">🌱</div>
        <h3 style="font-size: 18px; margin: 15px 0 10px 0; color: #333;">No aligned recommendations yet</h3>
        <p style="margin: 0 0 15px 0; color: #666; line-height: 1.5;">
          This is where you'll see products and services matched to your goals. 
        </p>
        <p style="margin: 0; color: #999; font-size: 14px;">
          Be the first to share something helpful! Visit the extension popup and click "Promote Link" to submit a recommendation.
        </p>
      </div>
    `;
  } else {
    const flags = await storage.getFeatureFlags();
    sidebarDisplayFlags = { displayMode: flags.promotionDisplay, showKeywords: flags.showKeywordsInPromo };

    sidebarQueue = promotions.slice();
    sidebarCapacity = measureSidebarCapacity(sidebar, header, promoList, sidebarQueue[0]);
    renderVisibleSidebarCards(promoList);
  }

  setTimeout(() => {
    backdrop.classList.add('show');
    sidebar.classList.add('show');
  }, 10);

  document.getElementById('eud-close-sidebar').addEventListener('click', closeSidebar);
  backdrop.addEventListener('click', closeSidebar);
}

// Renders one card off-screen to measure its real height (including margin),
// then divides the sidebar's available vertical space by that to find how
// many cards fit without scrolling. Falls back to 1 if measurement is ever
// degenerate (e.g. a promo with unusually little content).
function measureSidebarCapacity(sidebar, header, promoList, samplePromo) {
  if (!samplePromo) return 1;

  const sample = buildPromoCard(samplePromo);
  sample.style.visibility = 'hidden';
  promoList.appendChild(sample);
  const cardRect = sample.getBoundingClientRect();
  const cardStyles = window.getComputedStyle(sample);
  const cardHeight = cardRect.height + parseFloat(cardStyles.marginBottom || '15');
  promoList.removeChild(sample);

  const listStyles = window.getComputedStyle(promoList);
  const listPadding = parseFloat(listStyles.paddingTop || '0') + parseFloat(listStyles.paddingBottom || '0');
  const availableHeight = sidebar.clientHeight - header.offsetHeight - listPadding;

  if (!cardHeight || cardHeight <= 0) return Math.max(1, Math.min(5, sidebarQueue.length));

  const capacity = Math.floor(availableHeight / cardHeight);
  return Math.max(1, Math.min(capacity, sidebarQueue.length));
}

// Builds a single promo card element. Pulled out of createSidebar so it can
// be reused both for the one-off measurement pass and for real rendering.
function buildPromoCard(promo) {
  const card = document.createElement('div');
  card.className = 'eudaimonia-promo-card';
  card.dataset.promoId = promo.id;

  const flags = sidebarDisplayFlags || { displayMode: 'title', showKeywords: true };
  let cardHTML = '';

  if (flags.displayMode === 'url') {
    cardHTML = `
      <div class="eudaimonia-promo-url">${escapeHtml(extractDomainFromUrl(promo.url))}</div>
      <h3 class="eudaimonia-promo-title">${escapeHtml(promo.title)}</h3>
      <p class="eudaimonia-promo-description">${escapeHtml(promo.description)}</p>
    `;
  } else {
    cardHTML = `
      <h3 class="eudaimonia-promo-title">${escapeHtml(promo.title)}</h3>
      <p class="eudaimonia-promo-description">${escapeHtml(promo.description)}</p>
    `;
  }

  if (flags.showKeywords) {
    cardHTML += `
      <div class="eudaimonia-promo-meta">
        <div class="eudaimonia-promo-keywords">
          ${promo.keywords.map(k => `<span class="eudaimonia-keyword-tag">${escapeHtml(k)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  card.innerHTML = cardHTML;

  card.addEventListener('click', async () => {
    clearSidebarDwellTimer(promo.id);
    await recordPromoClick(promo.id);
    window.open(promo.url, '_blank');
  });

  return card;
}

// (Re)renders whatever is currently at the front of sidebarQueue, up to
// sidebarCapacity cards, and re-attaches the IntersectionObserver that
// drives dwell tracking. Called both on first open and every time a card
// cycles out.
function renderVisibleSidebarCards(promoList) {
  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }
  sidebarDwellTimers.forEach(timerId => clearTimeout(timerId));
  sidebarDwellTimers.clear();

  promoList.innerHTML = '';
  const visible = sidebarQueue.slice(0, sidebarCapacity);

  if (visible.length === 0) return;

  sidebarObserver = new IntersectionObserver(handleSidebarIntersections, {
    root: promoList,
    // Only count a card as "seen" while it's in the TOP HALF of the
    // scrollable list - a card merely visible near the bottom edge
    // shouldn't start its dwell countdown yet.
    rootMargin: '0px 0px -50% 0px',
    threshold: 0
  });

  visible.forEach(promo => {
    const card = buildPromoCard(promo);
    promoList.appendChild(card);
    sidebarObserver.observe(card);
  });
}

function handleSidebarIntersections(entries) {
  entries.forEach(entry => {
    const promoId = entry.target.dataset.promoId;
    if (entry.isIntersecting) {
      if (!sidebarDwellTimers.has(promoId)) {
        const timerId = setTimeout(() => downrankAndCycle(promoId), SIDEBAR_DWELL_MS);
        sidebarDwellTimers.set(promoId, timerId);
      }
    } else {
      // Scrolled out of the top half (or off-screen entirely) before the
      // dwell window elapsed - don't penalize a card the user never
      // really had a chance to look at.
      clearSidebarDwellTimer(promoId);
    }
  });
}

function clearSidebarDwellTimer(promoId) {
  const timerId = sidebarDwellTimers.get(promoId);
  if (timerId) {
    clearTimeout(timerId);
    sidebarDwellTimers.delete(promoId);
  }
}

// Moves a "seen but ignored" promo to the back of the queue - it stays
// eligible (still matches the user's goals, still has budget) and can
// resurface later if fresher matches run out. Then re-renders so the next
// queued promo fills the vacated slot.
function downrankAndCycle(promoId) {
  sidebarDwellTimers.delete(promoId);

  const idx = sidebarQueue.findIndex(p => p.id === promoId);
  if (idx === -1) return;

  const [promo] = sidebarQueue.splice(idx, 1);
  sidebarQueue.push(promo);

  const promoList = document.getElementById('eudaimonia-promo-list');
  if (promoList) renderVisibleSidebarCards(promoList);
}

async function recordPromoClick(promoId) {
  // Budget/click accounting now happens server-side. We hand the click off to
  // the background service worker, which calls the record-click function from
  // the extension's own context (a visited page's CSP can't block it there).
  try {
    chrome.runtime.sendMessage({ action: 'recordClick', promoId });
  } catch (error) {
    console.error('Error recording promo click:', error);
  }
}

function extractDomainFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return url;
  }
}

function closeSidebar() {
  const sidebar = document.getElementById('eudaimonia-promo-sidebar');
  const backdrop = document.getElementById('eudaimonia-sidebar-backdrop');

  if (sidebarObserver) {
    sidebarObserver.disconnect();
    sidebarObserver = null;
  }
  sidebarDwellTimers.forEach(timerId => clearTimeout(timerId));
  sidebarDwellTimers.clear();
  sidebarQueue = [];

  if (sidebar) {
    sidebar.classList.remove('show');
    backdrop.classList.remove('show');
    
    setTimeout(() => {
      sidebar.remove();
      backdrop.remove();
    }, 300);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

})(); // End of IIFE
