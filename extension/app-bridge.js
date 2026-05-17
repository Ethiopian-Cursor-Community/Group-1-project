// Localhost app tab: Ctrl+Shift+L opens the in-app modal (not the extension panel).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CGUIDE_APP_HOTKEY") {
    window.dispatchEvent(new CustomEvent("cguide:toggle-trigger"));
    sendResponse?.({ ok: true });
  }
  return true;
});
