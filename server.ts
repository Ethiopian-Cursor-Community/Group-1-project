import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { cursorPrompt, normalizeKey as normalizeCursorKey } from "./server/cursor.ts";
import {
  createGeminiClient,
  geminiModelFallbackChain,
  geminiText,
  geminiVisionWithFallback,
} from "./server/gemini.ts";
import {
  buildAskStepPrompt,
  buildCursorScreenFallbackPrompt,
  buildPageGuidancePrompt,
  buildStepVisionPrompt,
  buildVisionGuidePrompt,
  extractJson,
  formatAskResponse,
  matchSingleStepElement,
  parseGuideJson,
  parseProvider,
  type AiProvider,
} from "./server/providers.ts";
import {
  getSessionStatus,
  pullCommands,
  queuePrompt,
  requestTrigger,
  setCaptureActive,
} from "./server/session.ts";

// Force-load .env, overriding any stale env vars already in the process.
dotenv.config({ path: path.join(process.cwd(), ".env"), override: true });

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite";
const CURSOR_MODEL = process.env.CURSOR_MODEL || "composer-2";
const DEFAULT_PROVIDER =
  parseProvider(process.env.AI_PROVIDER, "gemini") ?? "gemini";

const geminiKey = normalizeCursorKey(process.env.GEMINI_API_KEY);
const cursorKey = normalizeCursorKey(process.env.CURSOR_API_KEY);

// Debug — printed once at startup so you can see what was loaded.
console.log(
  `[env] GEMINI_API_KEY: ${geminiKey ? `set (${geminiKey.slice(0, 8)}…)` : "MISSING"}`,
);
console.log(
  `[env] CURSOR_API_KEY: ${cursorKey ? `set (${cursorKey.slice(0, 8)}…)` : "MISSING"}`,
);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "10mb" }));

  const gemini = createGeminiClient(geminiKey);

  if (gemini) {
    console.log(`Gemini ready (${GEMINI_MODEL}, API key)`);
  } else {
    console.warn("GEMINI_API_KEY missing — set in .env for Gemini routes");
  }

  if (cursorKey) {
    console.log(`Cursor ready (${CURSOR_MODEL}, API key)`);
  } else {
    console.warn("CURSOR_API_KEY missing — set in .env for Cursor routes");
  }

  const resolveProvider = (body: { provider?: unknown }): AiProvider => {
    return parseProvider(body?.provider, DEFAULT_PROVIDER) ?? DEFAULT_PROVIDER;
  };

  const isRateLimit = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes("429") ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("quota") ||
      msg.includes("rate limit")
    );
  };

  const isConfigured = (provider: AiProvider): boolean =>
    provider === "gemini" ? Boolean(gemini) : Boolean(cursorKey);

  const selectProvider = (
    requested: AiProvider,
    options?: { needsVision?: boolean },
  ): AiProvider | null => {
    if (options?.needsVision) {
      // Only Gemini can process screenshot/image input.
      if (isConfigured("gemini")) return "gemini";
      // Fallback to Cursor text guidance if Gemini is unavailable.
      if (isConfigured("cursor")) return "cursor";
      return null;
    }
    if (isConfigured(requested)) return requested;
    const alternate: AiProvider = requested === "gemini" ? "cursor" : "gemini";
    if (isConfigured(alternate)) return alternate;
    return null;
  };

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      auth: "api-key-only",
      defaultProvider: DEFAULT_PROVIDER,
      gemini: { configured: Boolean(gemini), model: GEMINI_MODEL },
      cursor: { configured: Boolean(cursorKey), model: CURSOR_MODEL },
    });
  });

  app.post("/api/ask", async (req, res) => {
    const requestedProvider = resolveProvider(req.body);
    const provider = selectProvider(requestedProvider);
    if (!provider) {
      return res.status(500).json({
        error:
          "No AI provider is configured. Set GEMINI_API_KEY and/or CURSOR_API_KEY in .env, then restart npm run dev.",
      });
    }

    const prompt = String(req.body?.prompt ?? "").trim();
    const elements = Array.isArray(req.body?.elements) ? req.body.elements : null;
    const pageUrl = String(req.body?.url ?? "");
    const pageTitle = String(req.body?.title ?? "");

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const fullPrompt = buildPageGuidancePrompt(
      prompt,
      pageUrl,
      pageTitle,
      elements,
    );
    const jsonMode = Boolean(elements?.length);

    // Re-read keys at request time — no restart needed after editing .env.
    const liveAskGeminiKey = normalizeCursorKey(process.env.GEMINI_API_KEY);
    const liveAskCursorKey = normalizeCursorKey(process.env.CURSOR_API_KEY);
    const liveAskGemini = liveAskGeminiKey ? createGeminiClient(liveAskGeminiKey) : gemini;

    try {
      let text: string;
      let usedProvider = provider;

      if (provider === "cursor") {
        if (!liveAskCursorKey) {
          return res.status(500).json({
            error: "CURSOR_API_KEY is not set. Add it to .env — no restart needed.",
          });
        }
        text = await cursorPrompt(liveAskCursorKey, CURSOR_MODEL, fullPrompt);
      } else {
        if (!liveAskGemini) {
          return res.status(500).json({
            error: "GEMINI_API_KEY is not set. Add it to .env — no restart needed.",
          });
        }
        try {
          text = await geminiText(liveAskGemini, GEMINI_MODEL, fullPrompt, jsonMode);
        } catch (geminiErr) {
          if (isRateLimit(geminiErr) && liveAskCursorKey) {
            console.warn("Gemini quota hit on /api/ask — falling back to Cursor.");
            usedProvider = "cursor";
            text = await cursorPrompt(liveAskCursorKey, CURSOR_MODEL, fullPrompt);
          } else if (isRateLimit(geminiErr)) {
            return res.status(429).json({
              error:
                "Gemini free-tier quota is exhausted. Set CURSOR_API_KEY in .env as fallback, or wait for quota reset.",
            });
          } else {
            throw geminiErr;
          }
        }
      }

      res.json({
        provider: usedProvider,
        ...formatAskResponse(text, jsonMode, elements ?? undefined),
      });
    } catch (error: unknown) {
      console.error(`${provider} /api/ask error:`, error);
      const message = error instanceof Error ? error.message : "Ask failed";
      res.status(500).json({ error: message, provider });
    }
  });

  app.post("/api/ask/step", async (req, res) => {
    const stepText = String(req.body?.stepText ?? "").trim();
    const originalPrompt = String(req.body?.originalPrompt ?? "").trim();
    const stepIndex = Number(req.body?.stepIndex) || 1;
    const totalSteps = Number(req.body?.totalSteps) || 1;
    const previousSteps = Array.isArray(req.body?.previousSteps)
      ? req.body.previousSteps.map((s: unknown) => String(s))
      : [];
    const elements = Array.isArray(req.body?.elements) ? req.body.elements : [];
    const pageUrl = String(req.body?.url ?? "");
    const pageTitle = String(req.body?.title ?? "");

    if (!stepText) {
      return res.status(400).json({ error: "stepText is required" });
    }
    if (elements.length === 0) {
      return res.status(400).json({ error: "elements are required" });
    }

    const prompt = buildAskStepPrompt(
      originalPrompt,
      stepText,
      stepIndex,
      totalSteps,
      previousSteps,
      pageUrl,
      pageTitle,
      elements,
    );

    const liveGeminiKey = normalizeCursorKey(process.env.GEMINI_API_KEY);
    const liveCursorKey = normalizeCursorKey(process.env.CURSOR_API_KEY);
    const liveGemini = liveGeminiKey ? createGeminiClient(liveGeminiKey) : gemini;

    const matchedElements = elements as Array<{
      i?: number;
      text?: string;
      placeholder?: string;
      href?: string;
    }>;

    const localFallback = () => {
      const enriched = matchSingleStepElement(stepText, matchedElements);
      return {
        elementIndex: enriched.elementIndex,
        label: enriched.label,
        provider: "local" as const,
      };
    };

    try {
      let text: string | null = null;
      let usedProvider: AiProvider | "local" = "gemini";

      if (liveGemini) {
        try {
          text = await geminiText(liveGemini, GEMINI_MODEL, prompt, true);
          usedProvider = "gemini";
        } catch (err) {
          if (isRateLimit(err) && liveCursorKey) {
            console.warn("Gemini quota hit on /api/ask/step — using Cursor.");
            text = await cursorPrompt(liveCursorKey, CURSOR_MODEL, prompt);
            usedProvider = "cursor";
          } else if (!liveCursorKey) {
            console.warn("Gemini failed on /api/ask/step — using local fallback.");
            return res.json(localFallback());
          } else {
            throw err;
          }
        }
      } else if (liveCursorKey) {
        text = await cursorPrompt(liveCursorKey, CURSOR_MODEL, prompt);
        usedProvider = "cursor";
      } else {
        return res.json(localFallback());
      }

      const parsed = text ? extractJson(text) : null;
      const rawIndex = parsed?.elementIndex;
      const elementIndex =
        typeof rawIndex === "number" && Number.isFinite(rawIndex) ? rawIndex : -1;
      const label =
        parsed && typeof parsed.label === "string" ? parsed.label : "";

      const valid = matchedElements.some((e) => e.i === elementIndex);
      if (!valid) {
        const fallback = localFallback();
        return res.json({
          ...fallback,
          provider: usedProvider,
          note: "AI returned invalid index — used local match",
        });
      }

      res.json({ elementIndex, label, provider: usedProvider });
    } catch (error: unknown) {
      console.error("/api/ask/step error:", error);
      res.json(localFallback());
    }
  });

  app.post("/api/session/status", (req, res) => {
    setCaptureActive(Boolean(req.body?.captureActive));
    res.json(getSessionStatus());
  });

  app.get("/api/session/status", (_req, res) => {
    res.json(getSessionStatus());
  });

  app.post("/api/session/trigger", (_req, res) => {
    const result = requestTrigger();
    if ("error" in result) return res.status(400).json(result);
    res.json(result);
  });

  app.post("/api/session/prompt", (req, res) => {
    const result = queuePrompt(String(req.body?.prompt ?? ""));
    if ("error" in result) return res.status(400).json(result);
    res.json(result);
  });

  app.get("/api/session/pull", (_req, res) => {
    res.json(pullCommands());
  });

  app.post("/api/guide/step", async (req, res) => {
    const { stepText, stepIndex, totalSteps, image, dimensions } = req.body;

    if (!stepText?.trim()) {
      return res.status(400).json({ error: "Step text is required" });
    }
    if (!image) {
      return res.status(400).json({ error: "Screenshot image is required" });
    }

    const liveGeminiKey = normalizeCursorKey(process.env.GEMINI_API_KEY);
    const liveGemini = liveGeminiKey ? createGeminiClient(liveGeminiKey) : gemini;

    if (!liveGemini) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is required for per-step vision targeting.",
      });
    }

    try {
      const prompt = buildStepVisionPrompt(
        String(stepText),
        Number(stepIndex) || 1,
        Number(totalSteps) || 1,
        dimensions ?? {},
      );
      const { text, model } = await geminiVisionWithFallback(
        liveGemini,
        geminiModelFallbackChain(GEMINI_MODEL),
        image,
        prompt,
      );
      const parsed = extractJson(text);
      const target = parsed?.target
        ? {
            x:
              typeof (parsed.target as { x?: number }).x === "number"
                ? (parsed.target as { x: number }).x
                : 500,
            y:
              typeof (parsed.target as { y?: number }).y === "number"
                ? (parsed.target as { y: number }).y
                : 500,
            label:
              typeof (parsed.target as { label?: string }).label === "string"
                ? (parsed.target as { label: string }).label
                : "Target",
          }
        : { x: 500, y: 500, label: "Target" };

      res.json({ provider: "gemini", model, vision: true, target });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Step vision failed";
      console.error("/api/guide/step error:", error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/guide", async (req, res) => {
    const requestedProvider = resolveProvider(req.body);
    const { prompt, image, dimensions } = req.body;

    if (!prompt?.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    // For screenshots we prefer Gemini vision, but we can fallback to Cursor text guidance.
    const guideProvider = selectProvider(requestedProvider, {
      needsVision: Boolean(image),
    });
    if (!guideProvider) {
      return res.status(500).json({
        error:
          "No AI provider is configured. Set GEMINI_API_KEY and/or CURSOR_API_KEY in .env, then restart npm run dev.",
      });
    }

    // Re-read keys at request time so a server restart isn't needed after .env edits.
    const liveGeminiKey = normalizeCursorKey(process.env.GEMINI_API_KEY);
    const liveCursorKey = normalizeCursorKey(process.env.CURSOR_API_KEY);
    const liveGemini = liveGeminiKey ? createGeminiClient(liveGeminiKey) : gemini;

    try {
      if (image) {
        // Try Gemini vision first; fall back to Cursor text on quota errors.
        if (liveGemini) {
          try {
            const systemPrompt = buildVisionGuidePrompt(prompt, dimensions ?? {});
            const { text, model } = await geminiVisionWithFallback(
              liveGemini,
              geminiModelFallbackChain(GEMINI_MODEL),
              image,
              systemPrompt,
            );
            console.log(`Vision guidance via Gemini model: ${model}`);
            return res.json({
              provider: "gemini",
              model,
              vision: true,
              ...parseGuideJson(text),
            });
          } catch (geminiErr) {
            if (!isRateLimit(geminiErr) && !liveCursorKey) {
              throw geminiErr;
            }
            if (liveCursorKey) {
              console.warn(
                "Gemini vision unavailable — using Cursor text fallback (no screenshot).",
              );
            } else {
              return res.status(429).json({
                error:
                  "Gemini quota exhausted. Add CURSOR_API_KEY as fallback or wait for quota reset.",
                retryAfterSeconds: 60,
              });
            }
          }
        }

        // Cursor cannot see screenshots — structured best-effort steps only.
        if (!liveCursorKey) {
          return res.status(500).json({
            error: "No AI provider is available. Set GEMINI_API_KEY and/or CURSOR_API_KEY in .env.",
          });
        }
        const fallbackText = await cursorPrompt(
          liveCursorKey,
          CURSOR_MODEL,
          buildCursorScreenFallbackPrompt(prompt),
        );
        return res.json({
          provider: "cursor",
          vision: false,
          visionFallback: true,
          ...parseGuideJson(fallbackText),
        });
      }

      const textPrompt = buildPageGuidancePrompt(prompt, "", "screen", null);

      // Text-only path: prefer Cursor, fall back to Gemini, or vice versa.
      let text: string;
      let usedProvider: AiProvider;
      if (liveCursorKey) {
        try {
          text = await cursorPrompt(liveCursorKey, CURSOR_MODEL, textPrompt);
          usedProvider = "cursor";
        } catch (cursorErr) {
          if (liveGemini) {
            console.warn("Cursor failed on /api/guide text path — trying Gemini.");
            text = await geminiText(liveGemini, GEMINI_MODEL, textPrompt, true);
            usedProvider = "gemini";
          } else {
            throw cursorErr;
          }
        }
      } else if (liveGemini) {
        text = await geminiText(liveGemini, GEMINI_MODEL, textPrompt, true);
        usedProvider = "gemini";
      } else {
        return res.status(500).json({
          error: "No AI provider is available. Set GEMINI_API_KEY and/or CURSOR_API_KEY in .env.",
        });
      }

      res.json({
        provider: usedProvider!,
        vision: false,
        ...parseGuideJson(text),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Guide failed";
      console.error(`/api/guide error:`, error);
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Default AI provider: ${DEFAULT_PROVIDER} (api-key auth only)`);
  });
}

startServer();
