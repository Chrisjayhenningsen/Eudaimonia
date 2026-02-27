// Wrap everything in an IIFE to avoid variable collisions when script runs in multiple frames
(function() {
  'use strict';
  
  // Firebase REST API wrapper
  const FIREBASE_PROJECT_ID = 'eudaimonia-350ce';
  const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  
  // Feature flags cache
  let featureFlags = null;
  let flagsLastFetched = 0;
  const FLAGS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  
  const storage = {
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
          showKeywordsInPromo: fields.showKeywordsInPromo?.booleanValue !== false
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
        showKeywordsInPromo: true
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
  
  // Store the element that was right-clicked
  let targetElement = null;

// Listen for right-click to capture the target element
document.addEventListener('contextmenu', (e) => {
  targetElement = e.target;
}, true);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showBlockModal') {
    showBlockingModal();
  }
});

function findNearestFixedAd(element) {
  // If the clicked element IS one of our overlays, find the matching iframe's parent
  if (element && element.getAttribute('data-eudaimonia-iframe-overlay')) {
    const adId = element.getAttribute('data-for-iframe');
    const iframe = document.querySelector(`[data-eudaimonia-flagged="${adId}"]`);
    if (iframe) return iframe.parentElement || iframe;
    // Fallback: just use the overlay's position to find a nearby iframe
    const overlayRect = element.getBoundingClientRect();
    const iframes = document.querySelectorAll('iframe[data-eudaimonia-flagged]');
    for (const iframe of iframes) {
      return iframe.parentElement || iframe;
    }
  }

  // Walk up the DOM to find a fixed/absolute floating container
  let el = element;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute') {
      return el;
    }
    el = el.parentElement;
  }
  
  // Also check: is the element itself or its parent an iframe flagged by us?
  el = element;
  while (el && el !== document.body) {
    if (el.tagName === 'IFRAME' || el.getAttribute('data-eudaimonia-flagged')) {
      return el.parentElement || el;
    }
    el = el.parentElement;
  }
  
  // Check for iframes with ad-like titles (e.g. title="offer", title="advertisement")
  const adTitles = ['offer', 'advertisement', 'ad', 'sponsor', 'promo'];
  const iframes = document.querySelectorAll('iframe[title]');
  for (const iframe of iframes) {
    const title = (iframe.title || '').toLowerCase();
    if (adTitles.some(t => title.includes(t))) {
      return iframe.parentElement || iframe;
    }
  }
  
  // Last resort: look for fixed or bottom-anchored iframes
  const allIframes = document.querySelectorAll('iframe');
  for (const iframe of allIframes) {
    const rect = iframe.getBoundingClientRect();
    const style = window.getComputedStyle(iframe);
    if (style.position === 'fixed' || style.position === 'absolute' || rect.bottom > window.innerHeight - 300) {
      return iframe.parentElement || iframe;
    }
  }
  
  return null;
}

function showBlockingModal() {
  if (!targetElement) return;
  
  // Detect if user right-clicked near/on a fixed floating ad
  const fixedAdElement = findNearestFixedAd(targetElement);
  const isFloatingAd = !!fixedAdElement;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.id = 'eudaimonia-block-modal';
  overlay.innerHTML = `
    <div class="eudaimonia-modal-backdrop"></div>
    <div class="eudaimonia-modal-content">
      <h2>🎯 Block with Eudaimonia</h2>
      <p>What would you like to block?</p>
      
      <div class="eudaimonia-option-group">
        ${isFloatingAd ? `
        <button class="eudaimonia-option-btn" id="eud-block-floating" style="border-color: #ff8800;">
          <div class="eudaimonia-option-title">💨 Remove This Floating Ad</div>
          <div class="eudaimonia-option-desc">Instantly dismiss this popup/overlay ad</div>
        </button>
        ` : ''}
        <button class="eudaimonia-option-btn" id="eud-block-source">
          <div class="eudaimonia-option-title">🚫 Block Source</div>
          <div class="eudaimonia-option-desc">Don't show content from this domain</div>
        </button>
        
        <button class="eudaimonia-option-btn" id="eud-block-category">
          <div class="eudaimonia-option-title">📂 Block Category</div>
          <div class="eudaimonia-option-desc">Block similar content by category</div>
        </button>
      </div>
      
      <div id="eud-domain-input" style="display: none;">
        <label for="eud-domain-text">What domain should be blocked?</label>
        <input type="text" id="eud-domain-text" placeholder="e.g., example.com" />
        <button id="eud-save-domain" class="eudaimonia-primary-btn">Block Domain</button>
      </div>
      
      <div id="eud-category-input" style="display: none;">
        <label for="eud-category-text">What category is this?</label>
        <input type="text" id="eud-category-text" placeholder="e.g., crypto, weight loss, dating apps..." />
        <button id="eud-save-category" class="eudaimonia-primary-btn">Save</button>
      </div>
      
      <button class="eudaimonia-cancel-btn" id="eud-cancel">Cancel</button>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Add event listeners
  if (isFloatingAd) {
    document.getElementById('eud-block-floating').addEventListener('click', () => {
      blockFloatingAd(fixedAdElement);
      closeModal();
    });
  }
  document.getElementById('eud-block-source').addEventListener('click', handleBlockSource);
  document.getElementById('eud-block-category').addEventListener('click', showCategoryInput);
  document.getElementById('eud-save-domain').addEventListener('click', handleManualDomain);
  document.getElementById('eud-save-category').addEventListener('click', handleBlockCategory);
  document.getElementById('eud-cancel').addEventListener('click', closeModal);
  
  // Close on backdrop click
  overlay.querySelector('.eudaimonia-modal-backdrop').addEventListener('click', closeModal);
}

function blockFloatingAd(element) {
  // Strategy 1: if element has data-eudaimonia-flagged, its parent div is the ad container
  let toRemove = element;

  // If we were passed the iframe directly, the parent div is the real ad shell
  if (element.tagName === 'IFRAME') {
    toRemove = element.parentElement || element;
  }

  // Strategy 2: walk up looking for the outermost positioned container
  // that is NOT the full page
  let candidate = toRemove.parentElement;
  while (candidate && candidate !== document.body && candidate !== document.documentElement) {
    const style = window.getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    const isFullPage = rect.width >= window.innerWidth * 0.95;
    if (isFullPage) break;
    if (style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute') {
      toRemove = candidate;
    }
    candidate = candidate.parentElement;
  }

  // Strategy 3: if nothing found via walk-up, find any element with our flagged attribute
  if (toRemove === element) {
    const flagged = document.querySelector('[data-eudaimonia-flagged]');
    if (flagged) {
      toRemove = flagged.parentElement || flagged;
    }
  }

  // Safety check: never remove anything that's a critical page structure element
  const SAFE_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'MAIN', 'HEADER', 'FOOTER', 'NAV']);
  if (!toRemove 
    || toRemove === document.body 
    || toRemove === document.documentElement
    || SAFE_TAGS.has(toRemove.tagName)
    || toRemove.id === 'app' 
    || toRemove.id === 'root'
    || toRemove.id === 'main') {
    console.warn('Eudaimonia: blocked attempt to remove critical page element, aborting');
    return;
  }

  console.log('Eudaimonia: removing floating ad element:', toRemove.tagName, toRemove.className);
  
  // Clean up any overlays/badges we placed for this ad
  const flaggedIframe = toRemove.querySelector('iframe[data-eudaimonia-flagged]') 
    || (toRemove.getAttribute('data-eudaimonia-flagged') ? toRemove : null);
  if (flaggedIframe) {
    const adId = flaggedIframe.getAttribute('data-eudaimonia-flagged');
    document.querySelectorAll(`[data-for-iframe="${adId}"]`).forEach(el => el.remove());
  }

  toRemove.remove();
  
  // Show a clickable success toast
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 12px 20px;
    border-radius: 20px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    z-index: 9999999;
    opacity: 1;
    transition: opacity 0.5s ease;
    pointer-events: all;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    user-select: none;
  `;
  toast.innerHTML = `
    <span>✅ Floating ad removed</span>
    <span style="
      background: #4a9eff;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    ">See aligned alternatives →</span>
  `;

  // Clicking the toast opens the sidebar
  toast.addEventListener('click', () => {
    toast.remove();
    showPromotionSidebar();
  });

  // Hovering pauses the fade-out timer
  let fadeTimer;
  const startFade = () => {
    fadeTimer = setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  };

  toast.addEventListener('mouseenter', () => clearTimeout(fadeTimer));
  toast.addEventListener('mouseleave', startFade);

  document.body.appendChild(toast);
  startFade();
}

function showCategoryInput() {
  document.getElementById('eud-category-input').style.display = 'block';
  document.getElementById('eud-category-text').focus();
}

function handleBlockSource() {
  // Get the domain from the clicked element's links
  const domain = extractDomain(targetElement);
  
  if (!domain) {
    // Couldn't auto-detect - show manual input
    showDomainInput();
    return;
  }
  
  // Save to storage and block
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'source',
    domain: domain
  }, (response) => {
    if (response.success) {
      blockElement(targetElement, 'source', domain);
      closeModal();
    }
  });
}

function showDomainInput() {
  document.getElementById('eud-domain-input').style.display = 'block';
  document.getElementById('eud-domain-text').focus();
}

function handleManualDomain() {
  const domain = document.getElementById('eud-domain-text').value.trim();
  
  if (!domain) {
    alert('Please enter a domain');
    return;
  }
  
  // Clean up the domain (remove protocol, paths, etc.)
  let cleanDomain = domain;
  try {
    // Try to parse as URL first
    if (domain.includes('://')) {
      cleanDomain = new URL(domain).hostname;
    } else {
      // Remove any path parts
      cleanDomain = domain.split('/')[0];
    }
  } catch (e) {
    // If parsing fails, just use what they typed
    cleanDomain = domain.split('/')[0];
  }
  
  // Save to storage and block
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'source',
    domain: cleanDomain
  }, (response) => {
    if (response.success) {
      blockElement(targetElement, 'source', cleanDomain);
      closeModal();
    }
  });
}

function handleBlockCategory() {
  const category = document.getElementById('eud-category-text').value.trim();
  
  if (!category) {
    alert('Please enter a category');
    return;
  }
  
  // Save to storage and block
  chrome.runtime.sendMessage({
    action: 'saveBlock',
    blockType: 'category',
    category: category
  }, (response) => {
    if (response.success) {
      blockElement(targetElement, 'category', category);
      closeModal();
    }
  });
}

function extractDomain(element) {
  // Try to find a link in or near the element
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
  
  // Fallback: Try to extract domain from image src
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
      // Only use image domain if it's not a common CDN
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

function blockElement(element, blockType, blockValue) {
  // Find a suitable container to block (go up the DOM tree)
  let container = element;
  
  // Try to find a reasonable container (something bigger than just text)
  // Skip over <a> tags as we don't want to insert our badge inside them
  while (container && container.parentElement) {
    const rect = container.getBoundingClientRect();
    const isLargeEnough = rect.width > 200 && rect.height > 100;
    const isNotLink = container.tagName !== 'A';
    
    if (isLargeEnough && isNotLink) {
      break; // Found a good container
    }
    
    // Keep going up if it's a link or too small
    container = container.parentElement;
  }
  
  // Make sure we have a valid parent to insert the badge into
  if (!container.parentElement) {
    // Fallback: if this is a fixed/floating element, just remove it directly
    const fixedAd = findNearestFixedAd(element);
    if (fixedAd) {
      blockFloatingAd(fixedAd);
    } else {
      console.warn('Eudaimonia: Could not find suitable parent for badge');
    }
    return;
  }
  
  // Create replacement badge first
  const badge = document.createElement('div');
  badge.className = 'eudaimonia-blocked-badge';
  badge.innerHTML = `
    <img src="${chrome.runtime.getURL('Eudaimonia_logo.png')}" alt="Eudaimonia" class="eudaimonia-badge-logo">
    <div class="eudaimonia-badge-text">
      Content blocked (${blockType}: ${blockValue})<br>
      <span class="eudaimonia-badge-link">Click for aligned alternative</span>
    </div>
  `;
  
  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showPromotionSidebar();
    return false;
  }, true); // Use capture phase
  
  // Insert badge before the container
  container.parentNode.insertBefore(badge, container);
  
  // Now hide the element
  container.style.display = 'none';
  container.style.pointerEvents = 'none';
  container.setAttribute('data-eudaimonia-blocked', blockType);
  container.setAttribute('data-eudaimonia-value', blockValue);
  
  // Check if this is user's first block - show helpful tip
  chrome.storage.sync.get(['firstBlockComplete'], (data) => {
    if (!data.firstBlockComplete) {
      chrome.storage.sync.set({ firstBlockComplete: true });
      
      // Show a brief celebration tooltip
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
  
  // Disable pointer events on nearby iframes that might be overlaying
  const parent = container.parentNode;
  if (parent) {
    const nearbyIframes = parent.querySelectorAll('iframe');
    nearbyIframes.forEach(iframe => {
      // Check if iframe is for tracking/ads
      const src = iframe.src || '';
      if (src.includes('criteo') || src.includes('doubleclick') || src.includes('googlesyndication') || 
          iframe.getAttribute('sandbox') || iframe.title?.toLowerCase().includes('ad')) {
        iframe.style.pointerEvents = 'none';
        iframe.style.display = 'none';
      }
    });
  }
}

function closeModal() {
  const modal = document.getElementById('eudaimonia-block-modal');
  if (modal) {
    modal.remove();
  }
  targetElement = null;
}

// Ad-like iframe titles and known ad domains
// Note: keep titles specific - 'ad' alone is too broad and causes false positives
const AD_IFRAME_TITLES = ['offer', 'advertisement', 'sponsor', 'promo', 'popup'];
const AD_DOMAINS = ['hostave3', 'doubleclick', 'googlesyndication', 'criteo', 'adnxs', 'drsmexa', 'preroll'];

function isAdIframe(iframe) {
  const title = (iframe.title || '').toLowerCase();
  const src = (iframe.src || '').toLowerCase();

  // Title must be specific - not just containing 'ad' which matches too much
  if (AD_IFRAME_TITLES.some(t => title === t || title.includes(t))) return true;

  // Domain matching on src
  if (src && AD_DOMAINS.some(d => src.includes(d))) return true;

  // Blank iframes injected by ad scripts - only flag if floating AND not full-width
  if (!src || src === 'about:blank') {
    const style = window.getComputedStyle(iframe);
    const parent = iframe.parentElement;
    const parentStyle = parent ? window.getComputedStyle(parent) : null;
    const isFloating = style.position === 'fixed' || style.position === 'absolute'
      || (parentStyle && (parentStyle.position === 'fixed' || parentStyle.position === 'absolute'));
    const rect = iframe.getBoundingClientRect();
    const isSmallish = rect.width < window.innerWidth * 0.8;
    if (isFloating && isSmallish) return true;
  }

  return false;
}

function flagAdIframe(iframe) {
  // Don't double-flag
  if (iframe.getAttribute('data-eudaimonia-flagged')) return;

  const adId = 'ad-' + Math.random().toString(36).slice(2, 8);
  iframe.setAttribute('data-eudaimonia-flagged', adId);

  // Disable pointer events on the iframe so clicks pass through to our overlay
  iframe.style.pointerEvents = 'none';

  // Find the highest z-index in the ad's container tree so we can beat it
  let highestZ = 999990;
  let el = iframe.parentElement;
  while (el && el !== document.body) {
    const z = parseInt(window.getComputedStyle(el).zIndex) || 0;
    if (z > highestZ) highestZ = z;
    el = el.parentElement;
  }
  const overlayZ = highestZ + 10;

  const rect = iframe.getBoundingClientRect();

  // Transparent overlay — intercepts clicks in the outer DOM
  const overlay = document.createElement('div');
  overlay.setAttribute('data-eudaimonia-iframe-overlay', 'true');
  overlay.setAttribute('data-for-iframe', adId);
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: ${overlayZ};
    cursor: pointer;
    background: transparent;
  `;

  // Both left and right click on overlay should show our modal
  const openModal = (e) => {
    e.preventDefault();
    e.stopPropagation();
    targetElement = overlay;
    showBlockingModal();
  };
  overlay.addEventListener('click', openModal);
  overlay.addEventListener('contextmenu', openModal);

  // Small "🛡 Click to block ad" badge in the corner
  const badge = document.createElement('div');
  badge.setAttribute('data-eudaimonia-flag-badge', 'true');
  badge.setAttribute('data-for-iframe', adId);
  badge.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    background: rgba(74, 158, 255, 0.9);
    border-radius: 0px 0px 4px 0px;
    padding: 3px 8px;
    font-size: 11px;
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    pointer-events: all;
    cursor: pointer;
    z-index: ${overlayZ + 1};
  `;
  badge.textContent = '🛡 Click to block ad';
  badge.addEventListener('click', openModal);

  document.body.appendChild(overlay);
  document.body.appendChild(badge);

  // Update positions after layout settles
  setTimeout(() => {
    const newRect = iframe.getBoundingClientRect();
    overlay.style.top = `${newRect.top}px`;
    overlay.style.left = `${newRect.left}px`;
    overlay.style.width = `${newRect.width}px`;
    overlay.style.height = `${newRect.height}px`;
    badge.style.top = `${newRect.top}px`;
    badge.style.left = `${newRect.left}px`;
  }, 1500);
}

// Domains where Eudaimonia should not scan for ads (productivity/trusted tools)
const EXCLUDED_SCAN_DOMAINS = [
  'claude.ai', 'anthropic.com', 'google.com', 'google.co.uk',
  'docs.google.com', 'drive.google.com', 'mail.google.com',
  'github.com', 'notion.so', 'figma.com', 'linear.app',
  'slack.com', 'discord.com', 'youtube.com'
];

function scanForAdIframes() {
  const hostname = window.location.hostname.replace(/^www\./, '');
  if (EXCLUDED_SCAN_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
    return; // Don't scan on trusted/productivity sites
  }

  document.querySelectorAll('iframe').forEach(iframe => {
    if (isAdIframe(iframe)) {
      flagAdIframe(iframe);
    }
  });
}

// On page load, block previously blocked items and scan for ad iframes
window.addEventListener('load', () => {
  // Scan for ad iframes
  scanForAdIframes();

  // Also watch for dynamically injected iframes (ads often load late)
  const observer = new MutationObserver(() => {
    scanForAdIframes();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.sync.get(['blockedSources', 'blockedCategories'], (data) => {
    const blockedSources = data.blockedSources || [];
    
    // Find and block elements from blocked sources
    if (blockedSources.length > 0) {
      const links = document.querySelectorAll('a[href]');
      links.forEach(link => {
        try {
          const url = new URL(link.href);
          if (blockedSources.includes(url.hostname)) {
            // Find parent container and block it
            let container = link;
            while (container && container.parentElement) {
              const rect = container.getBoundingClientRect();
              if (rect.width > 200 && rect.height > 100) {
                break;
              }
              container = container.parentElement;
            }
            
            // Only block if we found a valid container with a parent
            if (container && container.parentElement && container.parentElement.parentElement) {
              blockElement(container, 'source', url.hostname);
            }
          }
        } catch (e) {
          // Invalid URL, skip
        }
      });
    }
  });
});

function showPromotionSidebar() {
  // Check if sidebar already exists
  if (document.getElementById('eudaimonia-promo-sidebar')) {
    return;
  }
  
  // Get user's goals and fetch promotions from Firebase
  chrome.storage.sync.get(['moveToward', 'moveAway', 'dailyHabits', 'productCategories'], async (data) => {
    // Combine positive goal fields (what user wants)
    const positiveGoals = [
      data.moveToward || '',
      data.dailyHabits || '',
      data.productCategories || ''
    ].join(' ').toLowerCase();
    
    // Negative keywords (what user wants to avoid)
    const negativeKeywords = (data.moveAway || '').toLowerCase();
    
    // Fetch all promotions from Firebase
    const allPromotions = await storage.getPromotions();
    
    // Match promotions to user's goals using keyword matching
    const matchedPromos = matchPromotions(allPromotions, positiveGoals, negativeKeywords);
    
    // Create sidebar
    createSidebar(matchedPromos);
  });
}

function matchPromotions(promotions, positiveGoalsText, negativeKeywordsText) {
  if (promotions.length === 0) {
    return [];
  }
  
  // Extract individual words from negative keywords (obstacles)
  const negativeWords = negativeKeywordsText
    .split(/[\s,]+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase().trim());
  
  // Score each promotion based on keyword matches
  // Only include promotions with remaining budget
  const scored = promotions
    .filter(promo => (promo.budget || 0) > 0)
    .map(promo => {
    let score = 0;
    
    // Check promotion keywords against user's positive goals
    promo.keywords.forEach(keyword => {
      if (positiveGoalsText.includes(keyword)) {
        score += 1;
      }
    });
    
    // Also check if any words from title/description match positive goals
    const promoText = `${promo.title} ${promo.description}`.toLowerCase();
    const promoWords = promoText.split(/[\s,]+/).filter(w => w.length > 4);
    
    promoWords.forEach(word => {
      if (positiveGoalsText.includes(word)) {
        score += 0.5; // Half point for text matches
      }
    });
    
    // PENALIZE if promotion matches negative keywords (obstacles)
    negativeWords.forEach(negWord => {
      if (promoText.includes(negWord)) {
        score -= 10; // Heavy penalty for matching obstacles
      }
    });
    
    // Also check promotion keywords against obstacles
    promo.keywords.forEach(keyword => {
      if (negativeKeywordsText.includes(keyword)) {
        score -= 10;
      }
    });
    
    return { ...promo, score };
  });
  
  // Sort by score (highest first) and return top matches
  // Only return promotions with positive scores (matched goals, didn't match obstacles)
  return scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // Show top 5 matches
}

async function createSidebar(promotions) {
  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'eudaimonia-sidebar-backdrop';
  backdrop.id = 'eudaimonia-sidebar-backdrop';
  
  // Create sidebar
  const sidebar = document.createElement('div');
  sidebar.className = 'eudaimonia-promo-sidebar';
  sidebar.id = 'eudaimonia-promo-sidebar';
  
  // Header
  const header = document.createElement('div');
  header.className = 'eudaimonia-sidebar-header';
  header.innerHTML = `
    <h2>🎯 Aligned Recommendations</h2>
    <p>Community picks matched to your goals</p>
    <button class="eudaimonia-close-sidebar" id="eud-close-sidebar">×</button>
  `;
  
  // Promo list
  const promoList = document.createElement('div');
  promoList.className = 'eudaimonia-promo-list';
  
  if (promotions.length === 0) {
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
    // Get feature flags to determine display mode - AWAIT this
    const flags = await storage.getFeatureFlags();
    const displayMode = flags.promotionDisplay;
    const showKeywords = flags.showKeywordsInPromo;
    
    promotions.forEach(promo => {
      const card = document.createElement('div');
      card.className = 'eudaimonia-promo-card';
      
      // Build card HTML based on feature flags
      let cardHTML = '';
      
      if (displayMode === 'url') {
        // URL first, then title and description
        cardHTML = `
          <div class="eudaimonia-promo-url">${escapeHtml(extractDomainFromUrl(promo.url))}</div>
          <h3 class="eudaimonia-promo-title">${escapeHtml(promo.title)}</h3>
          <p class="eudaimonia-promo-description">${escapeHtml(promo.description)}</p>
        `;
      } else {
        // Title first (default)
        cardHTML = `
          <h3 class="eudaimonia-promo-title">${escapeHtml(promo.title)}</h3>
          <p class="eudaimonia-promo-description">${escapeHtml(promo.description)}</p>
        `;
      }
      
      // Add keywords if enabled
      if (showKeywords) {
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
        // Deduct 1 token from viewer and record click on promotion
        await recordPromoClick(promo.id);
        window.open(promo.url, '_blank');
      });
      
      promoList.appendChild(card);
    });
  }
  
  sidebar.appendChild(header);
  sidebar.appendChild(promoList);
  
  document.body.appendChild(backdrop);
  document.body.appendChild(sidebar);
  
  // Show with animation
  setTimeout(() => {
    backdrop.classList.add('show');
    sidebar.classList.add('show');
  }, 10);
  
  // Close handlers
  document.getElementById('eud-close-sidebar').addEventListener('click', closeSidebar);
  backdrop.addEventListener('click', closeSidebar);
}

async function recordPromoClick(promoId) {
  try {
    // Fetch current promotion data
    const promoRef = `${FIRESTORE_URL}/promotions/${promoId}`;
    const response = await fetch(promoRef);
    if (!response.ok) return;
    
    const data = await response.json();
    const currentClicks = parseInt(data.fields?.clicks?.integerValue || '0');
    const budget = parseInt(data.fields?.budget?.integerValue || '0');
    
    // Decrement budget and increment clicks
    const newBudget = Math.max(0, budget - 1);
    const newClicks = currentClicks + 1;
    
    await fetch(`${promoRef}?updateMask.fieldPaths=clicks&updateMask.fieldPaths=budget`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          clicks: { integerValue: newClicks.toString() },
          budget: { integerValue: newBudget.toString() }
        }
      })
    });
    
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
