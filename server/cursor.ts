import { Agent, CursorAgentError } from "@cursor/sdk";

/** Cursor Cloud Agents API — API key only. No GCP / ADC. */
export function normalizeKey(key: string | undefined): string {
  return key?.replace(/^["']|["']$/g, "").trim() ?? "";
}

export async function cursorPrompt(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: model },
      local: { cwd: process.cwd() },
    });

    if (result.status === "error") {
      throw new Error("Cursor agent run failed");
    }

    return typeof result.result === "string" ? result.result : "";
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(err.message);
    }
    throw err;
  }
}
