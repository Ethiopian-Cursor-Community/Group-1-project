import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { Agent, CursorAgentError } from "@cursor/sdk";
import dotenv from "dotenv";
import {
  getSessionStatus,
  pullCommands,
  queuePrompt,
  requestTrigger,
  setCaptureActive,
} from "./server/session.ts";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

  const apiKey = process.env.GEMINI_API_KEY?.replace(/^["']|["']$/g, "");
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is missing. Add it to .env and restart the server.");
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  const cursorApiKey = process.env.CURSOR_API_KEY?.replace(/^["']|["']$/g, "");
  const cursorModel = process.env.CURSOR_MODEL || "composer-2";

  if (!cursorApiKey) {
    console.warn("CURSOR_API_KEY is missing. Add it to .env to enable the Cursor assistant.");
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      gemini: { hasApiKey: Boolean(apiKey), model: GEMINI_MODEL },
      cursor: { hasApiKey: Boolean(cursorApiKey), model: cursorModel },
    });
  });

  app.post("/api/ask", async (req, res) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    if (!cursorApiKey) {
      return res.status(500).json({
        error: "CURSOR_API_KEY is not configured. Add it to .env and restart the server.",
      });
    }

    try {
      const result = await Agent.prompt(prompt, {
        apiKey: cursorApiKey,
        model: { id: cursorModel },
        local: { cwd: process.cwd() },
      });

      if (result.status === "error") {
        console.error("Cursor agent error:", result);
        return res.status(502).json({
          error: "Cursor agent run failed",
          id: result.id,
        });
      }

      const answer =
        typeof result.result === "string" && result.result.trim().length > 0
          ? result.result
          : "(Cursor returned no answer)";

      res.json({ answer, runId: result.id, status: result.status });
    } catch (err) {
      if (err instanceof CursorAgentError) {
        console.error("Cursor startup error:", err);
        return res.status(500).json({
          error: err.message,
          retryable: err.isRetryable,
        });
      }
      console.error("Ask endpoint error:", err);
      const message = err instanceof Error ? err.message : "Ask failed";
      res.status(500).json({ error: message });
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

  app.post("/api/guide", async (req, res) => {
    try {
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
      }

      const { prompt, image, dimensions } = req.body;

      if (!prompt?.trim()) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      if (!image) {
        return res.status(400).json({ error: "Image is required" });
      }

      const imagePart = {
        inlineData: {
          mimeType: "image/jpeg",
          data: image,
        },
      };

      const systemPrompt = `You are a browser guidance assistant. 
      The user will provide a screenshot of their current browser tab and a task or question.
      Your goal is to identify the EXACT element they are looking for or the next step to take.
      
      Respond PRIVATELY in JSON format with:
      1. "thought": Your reasoning.
      2. "steps": An array of strings describing the process.
      3. "target": { "x": number, "y": number, "label": string } where x and y are NORMALIZED coordinates (0-1000) for where the cursor should point.
      
      If the task is "I couldn't find search", find the search bar.
      Current screen dimensions: ${dimensions.width}x${dimensions.height}.
      Provide the most helpful step.`;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: {
          parts: [
            imagePart,
            { text: `${systemPrompt}\n\nUser Request: ${prompt}` }
          ]
        },
        config: {
          responseMimeType: "application/json"
        }
      });

      const text = response.text;
      if (!text) {
        return res.status(502).json({ error: "Empty response from Gemini" });
      }
      res.json(JSON.parse(text));
    } catch (error: any) {
      console.error("Gemini Error:", error);
      res.status(500).json({ error: error.message || "Guide request failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
