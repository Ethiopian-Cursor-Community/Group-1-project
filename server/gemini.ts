import { GoogleGenAI } from "@google/genai";

/** Gemini API (AI Studio) — API key only. No Vertex / ADC / GCP. */
export function createGeminiClient(apiKey: string | undefined) {
  const key = apiKey?.replace(/^["']|["']$/g, "").trim();
  if (!key) {
    return null;
  }
  return new GoogleGenAI({ apiKey: key });
}

export async function geminiText(
  ai: GoogleGenAI,
  model: string,
  prompt: string,
  jsonMode = false,
): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: { parts: [{ text: prompt }] },
    config: jsonMode ? { responseMimeType: "application/json" } : undefined,
  });
  const text = response.text;
  if (!text?.trim()) {
    throw new Error("Empty response from Gemini");
  }
  return text;
}

export async function geminiVisionJson(
  ai: GoogleGenAI,
  model: string,
  imageBase64: string,
  prompt: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        { text: prompt },
      ],
    },
    config: { responseMimeType: "application/json" },
  });
  const text = response.text;
  if (!text?.trim()) {
    throw new Error("Empty response from Gemini");
  }
  return text;
}

export function geminiModelFallbackChain(primary: string): string[] {
  const candidates = [
    primary,
    "gemini-2.5-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-8b",
    "gemini-1.5-flash",
    "gemini-2.0-flash",
  ];
  return [...new Set(candidates)];
}

export async function geminiVisionWithFallback(
  ai: GoogleGenAI,
  models: string[],
  imageBase64: string,
  prompt: string,
): Promise<{ text: string; model: string }> {
  let lastError: unknown;
  for (const model of models) {
    try {
      const text = await geminiVisionJson(ai, model, imageBase64, prompt);
      return { text, model };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        msg.includes("429") ||
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("quota") ||
        msg.includes("RESOURCE_EXHAUSTED");
      if (!retryable) throw err;
      console.warn(
        `Gemini vision failed on ${model}: ${msg.slice(0, 120)} — trying next model…`,
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Gemini models failed");
}
