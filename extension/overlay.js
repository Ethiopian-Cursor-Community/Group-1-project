const API_BASE = "http://localhost:3000";

function ensureUi() {
  if (document.getElementById("cguide-root")) return;

  const root = document.createElement("div");
  root.id = "cguide-root";
  root.innerHTML = `
    <button id="cguide-fab" type="button" title="Ask Cursor (Ctrl+Shift+L)">✦</button>
    <div id="cguide-panel" role="dialog" aria-label="Ask Cursor">
      <div id="cguide-header">
        <h3>Ask Cursor</h3>
        <button id="cguide-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="cguide-meta">Powered by @cursor/sdk</div>
      <textarea id="cguide-input" placeholder="Ask anything…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="cguide-send" type="button">Ask Cursor</button>
      <div id="cguide-answer" aria-live="polite"></div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const fab = document.getElementById("cguide-fab");
  const panel = document.getElementById("cguide-panel");
  const input = document.getElementById("cguide-input");
  const sendBtn = document.getElementById("cguide-send");
  const answer = document.getElementById("cguide-answer");
  const closeBtn = document.getElementById("cguide-close");

  function openPanel() {
    panel.classList.add("open");
    input.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
  }

  fab.addEventListener("click", () => {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  sendBtn.addEventListener("click", sendPrompt);

  function showAnswer(text, isError = false) {
    answer.textContent = text;
    answer.classList.add("visible");
    answer.classList.toggle("error", isError);
  }

  async function sendPrompt() {
    const prompt = input.value.trim();
    if (!prompt) return;

    sendBtn.disabled = true;
    sendBtn.textContent = "Thinking…";
    showAnswer("Asking Cursor…", false);

    try {
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAnswer(data.error || "Request failed", true);
        return;
      }
      showAnswer(data.answer || "(no answer)", false);
    } catch {
      showAnswer(
        "Could not reach the C_GUIDE backend at " +
          API_BASE +
          ". Is `npm run dev` running?",
        true,
      );
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Ask Cursor";
    }
  }

  window.__cguideOpen = openPanel;
}

ensureUi();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CGUIDE_OPEN") {
    ensureUi();
    window.__cguideOpen?.();
    sendResponse?.({ ok: true });
  }
  return true;
});
