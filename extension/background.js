const SKIP_SCHEMES = ["chrome://", "edge://", "about:", "chrome-extension://"];

function isAppTab(url) {
  return (
    url?.startsWith("http://localhost:3000") ||
    url?.startsWith("http://127.0.0.1:3000")
  );
}

function canInject(url) {
  if (!url) return false;
  return !SKIP_SCHEMES.some((s) => url.startsWith(s));
}

async function openExtensionPanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CGUIDE_OPEN" });
  } catch {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["overlay.css"],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["overlay.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "CGUIDE_OPEN" });
    } catch (err) {
      console.warn("C_GUIDE: could not open overlay:", err);
    }
  }
}

async function openAppHotkey(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CGUIDE_APP_HOTKEY" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["app-bridge.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "CGUIDE_APP_HOTKEY" });
    } catch (err) {
      console.warn("C_GUIDE: could not reach app tab:", err);
    }
  }
}

async function openOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !canInject(tab.url)) return;

  if (isAppTab(tab.url)) {
    await openAppHotkey(tab.id);
  } else {
    await openExtensionPanel(tab.id);
  }
}

async function injectCompanion(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["companion.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["companion.js"],
    });
  } catch {
    /* restricted pages (chrome://, etc.) */
  }
}

async function ensureCompanionOnAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && canInject(tab.url)) {
      await injectCompanion(tab.id);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureCompanionOnAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureCompanionOnAllTabs();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") openOnActiveTab();
});

chrome.action?.onClicked.addListener((tab) => {
  if (tab?.id && canInject(tab.url)) openOnActiveTab();
});
