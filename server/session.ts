export interface SessionPull {
  openTrigger: boolean;
  pendingPrompt: string | null;
}

const state = {
  captureActive: false,
  openTrigger: false,
  pendingPrompt: null as string | null,
};

export function setCaptureActive(active: boolean) {
  state.captureActive = active;
  if (!active) {
    state.openTrigger = false;
    state.pendingPrompt = null;
  }
}

export function getSessionStatus() {
  return { captureActive: state.captureActive };
}

export function requestTrigger(): { ok: true } | { error: string } {
  if (!state.captureActive) {
    return { error: "Screen sync is not active. Open C_GUIDE and click SYNC ENVIRONMENT." };
  }
  state.openTrigger = true;
  return { ok: true };
}

export function queuePrompt(prompt: string): { ok: true } | { error: string } {
  if (!state.captureActive) {
    return { error: "Screen sync is not active. Open C_GUIDE and click SYNC ENVIRONMENT." };
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { error: "Prompt is required" };
  }
  state.pendingPrompt = trimmed;
  state.openTrigger = false;
  return { ok: true };
}

export function pullCommands(): SessionPull {
  const result: SessionPull = {
    openTrigger: state.openTrigger,
    pendingPrompt: state.pendingPrompt,
  };
  state.openTrigger = false;
  state.pendingPrompt = null;
  return result;
}
