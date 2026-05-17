async function openOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("http")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CGUIDE_OPEN" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["overlay.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["overlay.css"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "CGUIDE_OPEN" });
    } catch (err) {
      console.warn("Could not open C_GUIDE overlay on this tab:", err);
    }
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") openOnActiveTab();
});

chrome.action?.onClicked.addListener(() => openOnActiveTab());
