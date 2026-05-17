const API_BASE = "http://localhost:3000";

const MAX_ELEMENTS = 60;
const TEXT_LIMIT = 120;

function trimText(value) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (parseFloat(style.opacity || "1") === 0) return false;
  return true;
}

function collectInteractiveElements() {
  const selector =
    'a[href], button, input:not([type="hidden"]), textarea, select, ' +
    '[role="button"], [role="link"], [role="textbox"], [role="combobox"], [onclick]';
  const seen = [];
  const nodes = Array.from(document.querySelectorAll(selector));

  for (const el of nodes) {
    if (seen.length >= MAX_ELEMENTS) break;
    if (el.disabled || el.getAttribute("aria-hidden") === "true") continue;
    if (!isVisible(el)) continue;

    const text =
      trimText(el.innerText || el.textContent) ||
      trimText(el.getAttribute("aria-label")) ||
      trimText(el.getAttribute("title")) ||
      trimText(el.getAttribute("placeholder")) ||
      trimText(el.getAttribute("value"));
    if (!text && !el.getAttribute("href")) continue;

    seen.push({
      i: seen.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text,
      href: trimText(el.getAttribute("href") || ""),
      type: el.getAttribute("type") || "",
      placeholder: trimText(el.getAttribute("placeholder") || ""),
      _el: el,
    });
  }
  return seen;
}

function ensureUi() {
  if (document.getElementById("cguide-root")) return;

  const root = document.createElement("div");
  root.id = "cguide-root";
  root.innerHTML = `
    <button id="cguide-fab" type="button" title="Ask C_GUIDE (Ctrl+Shift+L)">✦</button>
    <div id="cguide-panel" role="dialog" aria-label="Ask C_GUIDE">
      <div id="cguide-header">
        <h3>Ask C_GUIDE</h3>
        <button id="cguide-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="cguide-meta">Gemini or Cursor (API key) · Esc to close</div>
      <textarea id="cguide-input" placeholder="Type or use the mic… (Enter to send)"></textarea>
      <div class="cguide-input-actions">
        <button id="cguide-mic" type="button" title="Voice input">🎤</button>
        <button id="cguide-send" type="button">Ask</button>
      </div>
      <div id="cguide-answer" aria-live="polite"></div>
      <ol id="cguide-steps"></ol>
      <div id="cguide-stepnav" class="cguide-stepnav" hidden>
        <button id="cguide-prev" type="button">← Previous</button>
        <span id="cguide-stepcount">1 / 1</span>
        <button id="cguide-next" type="button">Next →</button>
      </div>
    </div>
    <div id="cguide-highlight"></div>
    <div id="cguide-phantom">
      <div id="cguide-phantom-reticle"></div>
      <div id="cguide-phantom-dot"></div>
      <div id="cguide-phantom-label">Target</div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const fab = document.getElementById("cguide-fab");
  const panel = document.getElementById("cguide-panel");
  const input = document.getElementById("cguide-input");
  const sendBtn = document.getElementById("cguide-send");
  const answer = document.getElementById("cguide-answer");
  const stepsEl = document.getElementById("cguide-steps");
  const closeBtn = document.getElementById("cguide-close");
  const phantom = document.getElementById("cguide-phantom");
  const phantomLabel = document.getElementById("cguide-phantom-label");
  const highlight = document.getElementById("cguide-highlight");
  const stepNav = document.getElementById("cguide-stepnav");
  const stepCount = document.getElementById("cguide-stepcount");
  const prevBtn = document.getElementById("cguide-prev");
  const nextBtn = document.getElementById("cguide-next");
  const micBtn = document.getElementById("cguide-mic");

  let currentTargetEl = null;
  let guidance = {
    steps: [],
    elements: [],
    stepIndex: 0,
    originalPrompt: "",
    refining: false,
    refineToken: 0,
  };
  let recognition = null;

  function findElementByIndex(elements, index) {
    if (typeof index !== "number" || index < 0) return null;
    const byI = elements.find((el) => el.i === index);
    if (byI?._el) return byI;
    return elements[index] || null;
  }

  function findElementByKeyword(stepText, elements) {
    const words = (stepText || "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    if (!words.length) return null;
    let best = null;
    let bestScore = 0;
    for (const el of elements) {
      const hay = `${el.text} ${el.placeholder} ${el.href}`.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function findElementForStep(step, elements) {
    if (!elements.length) return null;
    const byIndex = findElementByIndex(elements, step.elementIndex);
    if (byIndex?._el) return byIndex;
    const byKeyword = findElementByKeyword(step.text, elements);
    if (byKeyword?._el) return byKeyword;
    return null;
  }

  async function refineStepFromBackend(stepIndex) {
    const step = guidance.steps[stepIndex];
    if (!step) return null;

    const elements = collectInteractiveElements();
    guidance.elements = elements;

    try {
      const res = await fetch(`${API_BASE}/api/ask/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalPrompt: guidance.originalPrompt,
          stepText: step.text,
          stepIndex: stepIndex + 1,
          totalSteps: guidance.steps.length,
          previousSteps: guidance.steps
            .slice(0, stepIndex)
            .map((s) => s.text),
          url: location.href,
          title: document.title,
          elements: elements.map(({ _el, ...rest }) => rest),
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.elementIndex === "number" && data.elementIndex >= 0) {
        step.elementIndex = data.elementIndex;
        if (data.label) step.label = data.label;
      }
      return data;
    } catch {
      return null;
    }
  }

  function startVoiceInput() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showAnswer("Voice is not supported in this browser. Type your question.", true);
      return;
    }
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.onstart = () => {
      micBtn.textContent = "■";
      micBtn.classList.add("listening");
    };
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      sendPrompt();
    };
    recognition.onend = () => {
      micBtn.textContent = "🎤";
      micBtn.classList.remove("listening");
      recognition = null;
    };
    recognition.onerror = () => {
      micBtn.textContent = "🎤";
      micBtn.classList.remove("listening");
      recognition = null;
    };
    recognition.start();
  }

  function normalizeStepsFromApi(data) {
    if (Array.isArray(data.stepItems) && data.stepItems.length > 0) {
      return data.stepItems.map((s) => ({
        text: s.text || "",
        elementIndex:
          typeof s.elementIndex === "number" ? s.elementIndex : -1,
        label: s.target?.label || s.label || "",
      }));
    }
    if (
      Array.isArray(data.steps) &&
      data.steps.length > 0 &&
      typeof data.steps[0] === "object"
    ) {
      return data.steps;
    }
    const strings = Array.isArray(data.steps)
      ? data.steps.filter((s) => typeof s === "string")
      : [];
    const idx = data.elementIndex;
    return strings.map((text, i) => ({
      text,
      elementIndex: i === 0 && typeof idx === "number" ? idx : -1,
      label: i === 0 ? data.label || "" : "",
    }));
  }

  function updateStepNav() {
    const total = guidance.steps.length;
    if (total <= 1) {
      stepNav.hidden = true;
      return;
    }
    stepNav.hidden = false;
    stepCount.textContent = `${guidance.stepIndex + 1} / ${total}`;
    prevBtn.disabled = guidance.stepIndex === 0;
    nextBtn.disabled = guidance.stepIndex >= total - 1;
  }

  async function showStep(index) {
    if (!guidance.steps.length) {
      hideTarget();
      return;
    }
    guidance.stepIndex = Math.max(0, Math.min(index, guidance.steps.length - 1));
    const step = guidance.steps[guidance.stepIndex];
    const token = ++guidance.refineToken;

    stepsEl.querySelectorAll("li").forEach((li, i) => {
      li.classList.toggle("active", i === guidance.stepIndex);
    });

    updateStepNav();
    setStepNavBusy(true);

    let elements = collectInteractiveElements();
    guidance.elements = elements;
    let target = findElementForStep(step, elements);
    if (target?._el) {
      placeTarget(target._el, step.label || target.text);
    } else {
      hideTarget();
    }

    await refineStepFromBackend(guidance.stepIndex);
    if (token !== guidance.refineToken) return;

    elements = guidance.elements;
    target = findElementForStep(step, elements);
    if (target?._el) {
      placeTarget(target._el, step.label || target.text);
    } else {
      hideTarget();
    }
    setStepNavBusy(false);
  }

  function setStepNavBusy(busy) {
    if (stepNav.hidden) return;
    prevBtn.disabled = busy || guidance.stepIndex === 0;
    nextBtn.disabled = busy || guidance.stepIndex >= guidance.steps.length - 1;
    stepCount.textContent = busy
      ? "Locating…"
      : `${guidance.stepIndex + 1} / ${guidance.steps.length}`;
  }

  function showGuidance(data, elements, originalPrompt) {
    guidance = {
      steps: normalizeStepsFromApi(data),
      elements,
      stepIndex: 0,
      originalPrompt,
      refining: false,
      refineToken: 0,
    };
    showSteps(guidance.steps.map((s) => s.text));
    void showStep(0);
  }

  function openPanel() {
    panel.classList.add("open");
    setTimeout(() => input.focus(), 30);
  }
  function closePanel() {
    panel.classList.remove("open");
  }
  function hideTarget() {
    phantom.classList.remove("visible");
    highlight.classList.remove("visible");
    currentTargetEl = null;
  }

  function showAnswer(text, isError = false) {
    answer.textContent = text;
    answer.classList.add("visible");
    answer.classList.toggle("error", isError);
  }

  function showSteps(stepTexts) {
    stepsEl.innerHTML = "";
    if (!stepTexts?.length) {
      stepsEl.classList.remove("visible");
      return;
    }
    stepTexts.forEach((text, i) => {
      const li = document.createElement("li");
      li.textContent = text;
      li.addEventListener("click", () => {
        void showStep(i);
      });
      stepsEl.appendChild(li);
    });
    stepsEl.classList.add("visible");
  }

  function placeTarget(el, label) {
    if (!el) {
      hideTarget();
      return;
    }
    currentTargetEl = el;
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    const update = () => {
      if (!currentTargetEl || !document.body.contains(currentTargetEl)) {
        hideTarget();
        return;
      }
      const rect = currentTargetEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      phantom.style.left = `${cx}px`;
      phantom.style.top = `${cy}px`;
      phantom.classList.add("visible");

      highlight.style.left = `${rect.left - 4}px`;
      highlight.style.top = `${rect.top - 4}px`;
      highlight.style.width = `${rect.width + 8}px`;
      highlight.style.height = `${rect.height + 8}px`;
      highlight.classList.add("visible");
    };

    phantomLabel.textContent = label || "Click here";
    setTimeout(update, 350);
    update();
  }

  // Re-position phantom on scroll/resize so it stays glued to the target
  const repositionTarget = () => {
    if (!currentTargetEl) return;
    const rect = currentTargetEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    phantom.style.left = `${cx}px`;
    phantom.style.top = `${cy}px`;
    highlight.style.left = `${rect.left - 4}px`;
    highlight.style.top = `${rect.top - 4}px`;
    highlight.style.width = `${rect.width + 8}px`;
    highlight.style.height = `${rect.height + 8}px`;
  };
  window.addEventListener("scroll", repositionTarget, true);
  window.addEventListener("resize", repositionTarget);

  fab.addEventListener("click", () => {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", () => {
    closePanel();
    hideTarget();
    guidance = {
      steps: [],
      elements: [],
      stepIndex: 0,
      originalPrompt: "",
      refining: false,
      refineToken: 0,
    };
    stepNav.hidden = true;
  });

  prevBtn.addEventListener("click", () => {
    void showStep(guidance.stepIndex - 1);
  });
  nextBtn.addEventListener("click", () => {
    void showStep(guidance.stepIndex + 1);
  });

  micBtn.addEventListener("click", startVoiceInput);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      closePanel();
      hideTarget();
      return;
    }
    if (!panel.classList.contains("open") || guidance.steps.length === 0) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      void showStep(guidance.stepIndex - 1);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      void showStep(guidance.stepIndex + 1);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  sendBtn.addEventListener("click", sendPrompt);

  async function sendPrompt() {
    const prompt = input.value.trim();
    if (!prompt) return;

    sendBtn.disabled = true;
    sendBtn.textContent = "Thinking…";
    showAnswer("Thinking…", false);
    stepsEl.classList.remove("visible");
    hideTarget();

    const elements = collectInteractiveElements();
    const payload = {
      prompt,
      url: location.href,
      title: document.title,
      elements: elements.map(({ _el, ...rest }) => rest),
    };

    try {
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          // Omit to use server AI_PROVIDER; or set "gemini" | "cursor"
          provider: undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAnswer(data.error || "Request failed", true);
        return;
      }

      showAnswer(data.answer || data.thought || "(no answer)", false);
      showGuidance(data, elements, prompt);
    } catch {
      showAnswer(
        `Could not reach the C_GUIDE backend at ${API_BASE}. Is \`npm run dev\` running?`,
        true,
      );
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Ask";
    }
  }

  window.__cguideOpen = openPanel;
}

ensureUi();

chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CGUIDE_OPEN") {
    ensureUi();
    window.__cguideOpen?.();
    sendResponse?.({ ok: true });
  }
  return true;
});
