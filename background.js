// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'blockWithEudaimonia',
    title: 'Block with Eudaimonia',
    contexts: ['all']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'blockWithEudaimonia') {
    // Send message to content script to show the blocking modal
    chrome.tabs.sendMessage(tab.id, {
      action: 'showBlockModal',
      x: info.x || 0,
      y: info.y || 0
    }).catch((error) => {
      // If content script isn't loaded, inject it first
      console.log('Content script not ready, injecting...');
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).then(() => {
        // Try again after injection
        chrome.tabs.sendMessage(tab.id, {
          action: 'showBlockModal',
          x: info.x || 0,
          y: info.y || 0
        });
      }).catch(err => {
        console.error('Failed to inject content script:', err);
      });
    });
  }
});

// Listen for messages from content script
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
        if (!blockedCategories.includes(request.category)) {
          blockedCategories.push(request.category);
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
});
