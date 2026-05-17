export type AiProvider = "gemini" | "cursor";

export interface GuideTarget {
  x: number;
  y: number;
  label: string;
}

export interface GuidanceStep {
  text: string;
  target?: GuideTarget;
  elementIndex?: number;
}

export interface GuidanceResult {
  thought: string;
  steps: GuidanceStep[];
}

export function normalizeKey(key: string | undefined): string {
  return key?.replace(/^["']|["']$/g, "").trim() ?? "";
}

export function parseProvider(
  value: unknown,
  fallback: AiProvider,
): AiProvider | null {
  if (value === "gemini" || value === "cursor") return value;
  return fallback;
}

const STEP_JSON_SHAPE = `{
  "thought": "...",
  "steps": [
    {
      "text": "imperative step 1",
      "target": { "x": 100, "y": 200, "label": "short label" },
      "elementIndex": 2
    }
  ]
}`;

export function buildPageGuidancePrompt(
  prompt: string,
  pageUrl: string,
  pageTitle: string,
  elements: unknown[] | null,
): string {
  if (!elements?.length) {
    return [
      "You are a helpful assistant. Answer clearly and concisely.",
      `User question: ${prompt}`,
    ].join("\n");
  }

  return [
    "You are an in-browser assistant guiding a user on a real webpage.",
    `Page URL: ${pageUrl}`,
    `Page title: ${pageTitle}`,
    `User question: "${prompt}"`,
    "",
    "Interactive elements (each has numeric `i`):",
    JSON.stringify(elements.slice(0, 60), null, 2),
    "",
    "Respond with ONLY valid JSON (no markdown fences):",
    STEP_JSON_SHAPE,
    "",
    "Rules:",
    "- 2-8 steps, each under 80 chars.",
    "- Each step MUST include elementIndex (use -1 only if no element applies).",
    "- Every step needs a DIFFERENT elementIndex when the action moves to a new control.",
    "- elementIndex must match an element `i` from the list.",
    "- label: short name for that element.",
    "- Omit target x/y for DOM mode (extension uses elementIndex).",
  ].join("\n");
}

export function buildAskStepPrompt(
  originalPrompt: string,
  stepText: string,
  stepIndex: number,
  totalSteps: number,
  previousSteps: string[],
  pageUrl: string,
  pageTitle: string,
  elements: unknown[],
): string {
  return [
    "You are an in-browser assistant pinpointing ONE element for the CURRENT step.",
    `Original user goal: "${originalPrompt}"`,
    `Page URL: ${pageUrl}`,
    `Page title: ${pageTitle}`,
    "",
    `Total steps: ${totalSteps}.`,
    `Already completed: ${
      previousSteps.length
        ? previousSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
        : "(none)"
    }`,
    "",
    `>>> CURRENT step ${stepIndex} of ${totalSteps}: "${stepText}"`,
    "",
    "Live interactive elements on the page right now (each has numeric `i`):",
    JSON.stringify(elements.slice(0, 60), null, 2),
    "",
    "Pick the SINGLE element the user must interact with for THIS step.",
    "Respond with ONLY valid JSON (no markdown fences):",
    `{ "elementIndex": <i>, "label": "short name" }`,
    "- elementIndex MUST be one of the `i` values above.",
    "- If truly no element matches, use -1.",
    "- Do NOT pick an element for a different step.",
  ].join("\n");
}

export function buildStepVisionPrompt(
  stepText: string,
  stepIndex: number,
  totalSteps: number,
  dimensions: { width?: number; height?: number },
): string {
  return `You are analyzing a screenshot of the user's screen.
The user is following a multi-step guide.

Current step ${stepIndex} of ${totalSteps}:
"${stepText}"

Find the EXACT pixel location to click for THIS step only (not other steps).

Respond with ONLY valid JSON:
{
  "target": { "x": 500, "y": 300, "label": "short label" }
}
- x,y normalized 0-1000 (top-left = 0,0).
- Screen: ${dimensions?.width ?? "?"} x ${dimensions?.height ?? "?"} px.`;
}

export function buildVisionGuidePrompt(
  prompt: string,
  dimensions: { width?: number; height?: number },
): string {
  return `You are a browser guidance assistant analyzing a screenshot.
The image IS attached. You can see the UI.

User question: "${prompt}"
Screen size (pixels): ${dimensions?.width ?? "?"} x ${dimensions?.height ?? "?"}.

Guide the user step-by-step. For EACH step, give where to click on the image.

Respond with ONLY valid JSON:
{
  "thought": "one sentence",
  "steps": [
    {
      "text": "imperative action",
      "target": { "x": 500, "y": 300, "label": "button name" }
    }
  ]
}
- x,y normalized 0-1000 (top-left = 0,0).
- 2-6 steps, each with its own target coordinates.
- Do NOT ask the user to describe their screen.`;
}

export function buildCursorScreenFallbackPrompt(prompt: string): string {
  return [
    "You are C_GUIDE, a UI navigation coach.",
    `The user asked: "${prompt}"`,
    "",
    "You do NOT have the screenshot. Still give concrete steps.",
    "NEVER say you cannot see the screen.",
    "",
    "Respond with ONLY valid JSON:",
    `{
  "thought": "...",
  "steps": [
    { "text": "...", "target": { "x": 500, "y": 500, "label": "..." } }
  ]
}`,
    "- 3-6 steps, each with a plausible target (center-ish x,y 300-700).",
  ].join("\n");
}

function parseTarget(raw: unknown): GuideTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as { x?: number; y?: number; label?: string };
  if (typeof t.x !== "number" || typeof t.y !== "number") return undefined;
  return {
    x: t.x,
    y: t.y,
    label: typeof t.label === "string" ? t.label : "Target",
  };
}

export function normalizeGuidanceSteps(
  parsed: Record<string, unknown> | null,
  fallbackLines?: string[],
): GuidanceStep[] {
  if (!parsed) {
    return (fallbackLines ?? []).map((text) => ({ text }));
  }

  const rawSteps = parsed.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return [];
  }

  const legacyTarget = parseTarget(parsed.target);

  if (typeof rawSteps[0] === "object" && rawSteps[0] !== null) {
    return rawSteps
      .map((item) => {
        const s = item as {
          text?: string;
          target?: unknown;
          elementIndex?: number;
          label?: string;
        };
        const text = typeof s.text === "string" ? s.text : "";
        if (!text) return null;
        let target = parseTarget(s.target);
        if (!target && typeof s.elementIndex === "number" && s.label) {
          target = { x: 500, y: 500, label: s.label };
        }
        return {
          text,
          target,
          elementIndex:
            typeof s.elementIndex === "number" ? s.elementIndex : undefined,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .slice(0, 8);
  }

  const elementIndexes = Array.isArray(parsed.elementIndexes)
    ? parsed.elementIndexes
    : [];
  const targets = Array.isArray(parsed.targets) ? parsed.targets : [];

  return (rawSteps as unknown[])
    .filter((s): s is string => typeof s === "string")
    .map((text, i) => ({
      text,
      target:
        parseTarget(targets[i]) ??
        (i === 0 ? legacyTarget : undefined) ??
        undefined,
      elementIndex:
        typeof elementIndexes[i] === "number"
          ? (elementIndexes[i] as number)
          : i === 0 && typeof parsed.elementIndex === "number"
            ? (parsed.elementIndex as number)
            : undefined,
    }))
    .slice(0, 8);
}

export function parseGuideJson(text: string): GuidanceResult {
  const parsed = extractJson(text);
  const steps = normalizeGuidanceSteps(parsed);
  if (steps.length > 0) {
    return {
      thought:
        parsed && typeof parsed.thought === "string"
          ? parsed.thought
          : parsed && typeof parsed.answer === "string"
            ? parsed.answer
            : text.slice(0, 200),
      steps,
    };
  }

  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return {
    thought: lines[0] || text,
    steps: lines.slice(1, 7).map((line) => ({
      text: line,
      target: { x: 500, y: 500, label: "Follow steps" },
    })),
  };
}

export function matchSingleStepElement(
  stepText: string,
  elements: Array<{ i?: number; text?: string; placeholder?: string; href?: string }>,
): { elementIndex: number; label: string } {
  const index = matchElementByText(stepText, elements);
  if (index >= 0) {
    const el = elements.find((e) => e.i === index);
    return { elementIndex: index, label: el?.text || "" };
  }
  return { elementIndex: -1, label: "" };
}

function matchElementByText(
  stepText: string,
  elements: Array<{ i?: number; text?: string; placeholder?: string; href?: string }>,
): number {
  const words = stepText
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (!words.length) return -1;

  let bestIndex = -1;
  let bestScore = 0;
  for (const el of elements) {
    const hay = `${el.text ?? ""} ${el.placeholder ?? ""} ${el.href ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (hay.includes(w)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = typeof el.i === "number" ? el.i : -1;
    }
  }
  return bestScore > 0 ? bestIndex : -1;
}

export function enrichStepsWithElements(
  steps: GuidanceStep[],
  elements: Array<{ i?: number; text?: string; placeholder?: string; href?: string }>,
): GuidanceStep[] {
  return steps.map((step, idx) => {
    if (typeof step.elementIndex === "number" && step.elementIndex >= 0) {
      return step;
    }
    const matched = matchElementByText(step.text, elements);
    if (matched >= 0) {
      return { ...step, elementIndex: matched };
    }
    const fallback = elements[idx];
    if (fallback && typeof fallback.i === "number") {
      return { ...step, elementIndex: fallback.i };
    }
    return step;
  });
}

export function formatAskResponse(
  text: string,
  hasElements: boolean,
  elements?: Array<{ i?: number; text?: string; placeholder?: string; href?: string }>,
) {
  const parsed = extractJson(text);
  let stepItems = normalizeGuidanceSteps(parsed);
  if (hasElements && elements?.length) {
    stepItems = enrichStepsWithElements(stepItems, elements);
  }

  if (!hasElements) {
    return {
      answer: text,
      steps: stepItems.map((s) => s.text),
      stepItems,
      elementIndex: -1,
    };
  }

  if (!parsed) {
    return {
      elementIndex: -1,
      label: "",
      steps: [] as string[],
      stepItems: [] as GuidanceStep[],
      answer: text,
    };
  }

  const first = stepItems[0];
  return {
    elementIndex: first?.elementIndex ?? -1,
    label: first?.target?.label ?? "",
    steps: stepItems.map((s) => s.text),
    stepItems,
    answer:
      typeof parsed.answer === "string"
        ? parsed.answer
        : typeof parsed.thought === "string"
          ? parsed.thought
          : text,
  };
}

export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0], text].filter(
    (s): s is string => Boolean(s),
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}
