import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Mic, 
  MousePointer2, 
  Monitor, 
  X, 
  Command,
  ArrowRight,
  MessageSquare,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface GuideTarget {
  x: number;
  y: number;
  label: string;
}

interface GuidanceStep {
  text: string;
  target?: GuideTarget;
  elementIndex?: number;
}

interface Guidance {
  thought: string;
  steps: GuidanceStep[];
  vision?: boolean;
  visionFallback?: boolean;
}

export default function App() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState<Guidance | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [phantomPos, setPhantomPos] = useState({ x: -100, y: -100 });
  const [isPhantomActive, setIsPhantomActive] = useState(false);
  const [isTriggerOpen, setIsTriggerOpen] = useState(false);
  const [inputMode, setInputMode] = useState<'selection' | 'text' | 'voice'>('selection');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [stepRefining, setStepRefining] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCapturingRef = useRef(isCapturing);
  const handleSubmitRef = useRef<(text?: string) => Promise<void>>(async () => {});
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    isCapturingRef.current = isCapturing;
  }, [isCapturing]);

  const openAskModal = (mode: "selection" | "text" | "voice" = "selection") => {
    setIsTriggerOpen(true);
    setInputMode(mode);
  };

  const toggleGuideTrigger = () => {
    setIsTriggerOpen((prev) => !prev);
    setInputMode("selection");
  };

  // Hotkey: Ctrl+Shift+L (in-app). Cross-tab: install extension/ folder in Chrome.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        toggleGuideTrigger();
      }
      if (e.key === 'Escape') {
        setIsTriggerOpen(false);
      }
    };
    const handleExternalHotkey = () => toggleGuideTrigger();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('cguide:toggle-trigger', handleExternalHotkey);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('cguide:toggle-trigger', handleExternalHotkey);
    };
  }, []);

  // Mouse tracking
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const syncSessionStatus = async (captureActive: boolean) => {
    try {
      await fetch("/api/session/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captureActive }),
      });
    } catch (err) {
      console.error("Session sync failed:", err);
    }
  };

  // Attach stream after <video> mounts (fixes blank preview)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream || !isCapturing) return;

    video.srcObject = stream;
    setVideoReady(false);

    const onReady = () => {
      setVideoReady(true);
      video.play().catch(() => {});
    };

    video.addEventListener("loadedmetadata", onReady);
    if (video.readyState >= 1) onReady();

    return () => {
      video.removeEventListener("loadedmetadata", onReady);
    };
  }, [stream, isCapturing]);

  // Poll backend for cross-tab hotkey / overlay prompts
  useEffect(() => {
    if (!isCapturing) return;

    const poll = async () => {
      try {
        const res = await fetch("/api/session/pull");
        if (!res.ok) return;
        const data = await res.json();
        if (data.openTrigger) {
          setIsTriggerOpen(true);
          setInputMode("selection");
        }
        if (data.pendingPrompt) {
          await handleSubmitRef.current(data.pendingPrompt);
        }
      } catch (err) {
        console.error("Session poll failed:", err);
      }
    };

    const id = window.setInterval(poll, 400);
    return () => window.clearInterval(id);
  }, [isCapturing]);

  const startCapture = async () => {
    try {
      setErrorMessage(null);
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = displayStream;
      setStream(displayStream);
      setIsCapturing(true);
      await syncSessionStatus(true);

      displayStream.getVideoTracks()[0].onended = () => {
        stopCapture();
      };
    } catch (err) {
      console.error("Error sharing screen:", err);
      setErrorMessage("Screen share was cancelled or blocked by the browser.");
    }
  };

  const stopCapture = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setIsCapturing(false);
    setVideoReady(false);
    setIsPhantomActive(false);
    setResponse(null);
    syncSessionStatus(false);
  };

  const waitForVideoFrame = (video: HTMLVideoElement, timeoutMs = 3000) =>
    new Promise<boolean>((resolve) => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(true);
        return;
      }
      const done = (ok: boolean) => {
        video.removeEventListener("loadeddata", onData);
        clearTimeout(timer);
        resolve(ok);
      };
      const onData = () => done(video.videoWidth > 0);
      const timer = setTimeout(() => done(false), timeoutMs);
      video.addEventListener("loadeddata", onData);
    });

  const captureFrame = async (): Promise<string | null> => {
    if (!videoRef.current || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const video = videoRef.current;

    const ready = await waitForVideoFrame(video);
    if (!ready || !video.videoWidth) return null;

    const maxWidth = 960;
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > maxWidth) {
      const scale = maxWidth / w;
      w = maxWidth;
      h = Math.round(video.videoHeight * scale);
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
  };

  const toggleListening = () => {
    if (isListening) {
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.onstart = () => {
      setIsListening(true);
      setInputMode('voice');
    };
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setPrompt(transcript);
      handleSubmit(transcript);
      setIsListening(false);
      setIsTriggerOpen(false);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.start();
  };

  const handleSubmit = async (text?: string) => {
    const finalPrompt = (text ?? prompt).trim();
    if (!finalPrompt || !isCapturingRef.current) {
      if (!isCapturingRef.current) {
        setErrorMessage("Start screen sync before sending a question.");
      }
      return;
    }

    setIsLoading(true);
    setIsTriggerOpen(false);
    setErrorMessage(null);

    const frame = await captureFrame();
    if (!frame) {
      setIsLoading(false);
      setErrorMessage("Live preview is not ready yet. Wait a moment and try again.");
      return;
    }

    try {
      const res = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: finalPrompt,
          provider: "gemini",
          image: frame,
          dimensions: {
            width: videoRef.current?.videoWidth ?? 0,
            height: videoRef.current?.videoHeight ?? 0,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        // Give a friendly message for quota/rate-limit errors.
        const raw: string = typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error ?? "Guide request failed");
        const isQuota =
          raw.includes("429") ||
          raw.includes("RESOURCE_EXHAUSTED") ||
          raw.includes("quota") ||
          raw.includes("rate limit");
        throw new Error(isQuota ? "Gemini free-tier quota exhausted. " + raw : raw);
      }

      if (data.error) {
        throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
      }

      const guidance = normalizeGuidance(data);
      setResponse(guidance);
      setPrompt("");
      setStepIndex(0);

      if (guidance.visionFallback || guidance.vision === false) {
        setIsPhantomActive(false);
        setErrorMessage(
          "Gemini could not analyze the screenshot (quota or model limit). " +
            "Use Previous/Next for text steps, or the ✦ extension on the live tab for a moving cursor on real buttons.",
        );
      } else {
        setErrorMessage(null);
        await refineStepTarget(0, guidance);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Guidance request failed";
      console.error("Guidance error:", err);
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  };

  handleSubmitRef.current = handleSubmit;

  const normalizeGuidance = (data: Record<string, unknown>): Guidance => {
    if (Array.isArray(data.stepItems) && data.stepItems.length > 0) {
      return {
        thought: String(data.thought ?? ""),
        steps: data.stepItems as GuidanceStep[],
        vision: Boolean(data.vision),
        visionFallback: Boolean(data.visionFallback),
      };
    }
    const rawSteps = data.steps;
    if (Array.isArray(rawSteps) && rawSteps.length > 0 && typeof rawSteps[0] === "object") {
      return {
        thought: String(data.thought ?? ""),
        steps: rawSteps as GuidanceStep[],
        vision: Boolean(data.vision),
        visionFallback: Boolean(data.visionFallback),
      };
    }
    const legacyTarget = data.target as GuideTarget | undefined;
    const strings = Array.isArray(rawSteps)
      ? rawSteps.filter((s): s is string => typeof s === "string")
      : [];
    return {
      thought: String(data.thought ?? ""),
      steps: strings.map((text, i) => ({
        text,
        target: i === 0 ? legacyTarget : undefined,
      })),
      vision: Boolean(data.vision),
      visionFallback: Boolean(data.visionFallback),
    };
  };

  const showStepOnPreview = (guidance: Guidance, index: number) => {
    const step = guidance.steps[index];
    if (!step?.target || guidance.visionFallback || !videoRef.current) {
      setIsPhantomActive(false);
      return;
    }
    const rect = videoRef.current.getBoundingClientRect();
    setPhantomPos({
      x: rect.left + (step.target.x / 1000) * rect.width,
      y: rect.top + (step.target.y / 1000) * rect.height,
    });
    setIsPhantomActive(true);
  };

  const refineStepTarget = async (index: number, guidance?: Guidance) => {
    const g = guidance ?? response;
    if (!g || index < 0 || index >= g.steps.length) return;

    setStepIndex(index);

    if (!isCapturingRef.current) {
      showStepOnPreview(g, index);
      return;
    }

    setStepRefining(true);
    try {
      const frame = await captureFrame();
      if (!frame) return;

      const step = g.steps[index];
      const res = await fetch("/api/guide/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepText: step.text,
          stepIndex: index + 1,
          totalSteps: g.steps.length,
          image: frame,
          dimensions: {
            width: videoRef.current?.videoWidth ?? 0,
            height: videoRef.current?.videoHeight ?? 0,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Step vision failed",
        );
      }

      setResponse((prev) => {
        if (!prev) return prev;
        const steps = [...prev.steps];
        steps[index] = { ...steps[index], target: data.target };
        return { ...prev, steps, vision: true, visionFallback: false };
      });
      setErrorMessage(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Step vision failed";
      setErrorMessage(message);
      showStepOnPreview(g, index);
    } finally {
      setStepRefining(false);
    }
  };

  const goToStep = (index: number) => {
    void refineStepTarget(index);
  };

  useEffect(() => {
    if (response && !response.visionFallback && !stepRefining) {
      showStepOnPreview(response, stepIndex);
    }
  }, [stepIndex, response, stepRefining]);

  return (
    <div className="min-h-screen bg-[#020203] text-gray-100 font-sans selection:bg-brand-500/30 overflow-hidden relative">
      {/* Immersive Background System */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 cyber-grid opacity-20" />
        <div 
          className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-brand-600/10 blur-[160px] rounded-full animate-float"
          style={{ animationDelay: '0s' }}
        />
        <div 
          className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-blue-600/10 blur-[140px] rounded-full animate-float"
          style={{ animationDelay: '2s' }}
        />
        <div className="absolute inset-0 bg-noise opacity-[0.04] mix-blend-overlay" />
        
        {/* Animated Particles */}
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: Math.random() * 100 + "%" }}
            animate={{ 
              y: [null, Math.random() * -100 + "%"],
              opacity: [0, 0.3, 0]
            }}
            transition={{ 
              duration: Math.random() * 10 + 10,
              repeat: Infinity,
              ease: "linear"
            }}
            className="absolute w-px h-20 bg-gradient-to-b from-brand-500/0 via-brand-500/50 to-brand-500/0"
            style={{ left: Math.random() * 100 + "%" }}
          />
        ))}
      </div>
      
      <header className="fixed top-0 left-0 right-0 h-20 border-b border-white/[0.05] bg-black/40 backdrop-blur-3xl z-50 flex items-center justify-between px-10">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-brand-600 to-blue-600 rounded-xl blur opacity-30 group-hover:opacity-70 transition duration-500"></div>
            <div className="relative w-10 h-10 rounded-xl bg-black flex items-center justify-center border border-white/10">
              <Sparkles className="w-5 h-5 text-brand-400" />
            </div>
          </div>
          <div className="flex flex-col">
            <span className="font-bold tracking-tight text-xl bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              C_GUIDE <span className="text-brand-500 italic">v1.0</span>
            </span>
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-[0.2em]">Neural Assistant</span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => openAskModal("voice")}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600/20 border border-brand-500/30 text-brand-300 text-xs font-bold uppercase tracking-wider hover:bg-brand-600/30 transition-all cursor-pointer"
            title="Ask with voice (Ctrl+Shift+L)"
          >
            <Mic className="w-4 h-4" />
            Ask
          </button>
          <button
            type="button"
            onClick={() => openAskModal("text")}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 text-xs font-bold uppercase tracking-wider hover:bg-white/10 transition-all cursor-pointer"
            title="Ask with text"
          >
            <MessageSquare className="w-4 h-4" />
            Text
          </button>
          {!isCapturing ? (
            <button 
              onClick={startCapture}
              className="group relative flex items-center gap-2 px-6 py-2.5 bg-white text-black rounded-xl font-bold text-sm transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer overflow-hidden shadow-[0_0_20px_rgba(255,255,255,0.1)]"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] pointer-events-none" />
              <Monitor className="w-4 h-4" />
              SYNC ENVIRONMENT
            </button>
          ) : (
            <button 
              onClick={stopCapture}
              className="flex items-center gap-2 px-6 py-2.5 bg-red-500/5 text-red-500 border border-red-500/20 rounded-xl font-bold text-sm hover:bg-red-500/10 transition-all cursor-pointer"
            >
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              DISCONNECT
            </button>
          )}
        </div>
      </header>

      {errorMessage && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed top-24 left-1/2 -translate-x-1/2 z-[60] max-w-lg w-full mx-4 px-5 py-3 rounded-2xl bg-red-500/10 border border-red-500/30 text-sm text-red-200 flex items-start justify-between gap-4"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="shrink-0 text-red-400 hover:text-white cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </motion.div>
      )}

      <main className="pt-28 pb-40 px-10 h-screen flex gap-10">
        {/* Main Interface */}
        <div className="flex-1 relative glass-card rounded-[40px] p-6 flex flex-col group overflow-hidden">
          <div className="flex items-center justify-between mb-4 px-2">
            <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
              <div className="w-1.5 h-1.5 rounded-full bg-brand-500 shadow-[0_0_8px_rgba(139,92,246,0.5)]" />
              LIVE_FEED.SYS
            </div>
            {isCapturing && (
              <div className="text-[10px] font-mono text-gray-600">
                RESOLUTION: {videoRef.current?.videoWidth}x{videoRef.current?.videoHeight}
              </div>
            )}
          </div>
          
          <div className="flex-1 min-h-0 bg-black/40 rounded-[24px] border border-white/5 relative overflow-hidden group-hover:border-white/10 transition-colors">
            {!isCapturing ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-12 gap-6">
                <div className="w-24 h-24 rounded-full bg-brand-500/5 border border-brand-500/10 flex items-center justify-center animate-pulse">
                  <Monitor className="w-10 h-10 text-brand-400 opacity-40" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-bold">Waiting for input stream</h2>
                  <p className="max-w-xs text-sm text-gray-500 leading-relaxed font-medium">
                    The assistant needs access to your browser tab to see what you see and provide guidance.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {!videoReady && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-20 bg-black/60"
                  >
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      className="w-10 h-10 border-2 border-brand-500/30 border-t-brand-500 rounded-full"
                    />
                    <p className="text-xs font-mono text-gray-400 uppercase tracking-widest">
                      Connecting live feed…
                    </p>
                  </motion.div>
                )}
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-contain filter grayscale-[0.2] contrast-[1.1] scale-[1.01]"
                />
                
                {/* AI Integrated Overlays */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  <div className="absolute inset-0 bg-brand-500/5 mix-blend-overlay" />
                  <div className="absolute inset-0 scanline opacity-20" />
                  <motion.div 
                    initial={{ top: "-10%" }}
                    animate={{ top: "110%" }}
                    transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                    className="absolute left-0 right-0 h-px bg-brand-500/50 shadow-[0_0_15px_rgba(139,92,246,0.8)] z-10"
                  />
                </div>

                <canvas ref={canvasRef} className="hidden" />
                
                <AnimatePresence>
                  {isPhantomActive && (
                    <motion.div
                      key={`${phantomPos.x}-${phantomPos.y}`}
                      initial={{ opacity: 0, scale: 0.5, x: phantomPos.x, y: phantomPos.y }}
                      animate={{ opacity: 1, scale: 1, x: phantomPos.x, y: phantomPos.y }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ type: "spring", damping: 25, stiffness: 120 }}
                      style={{ position: "fixed", left: 0, top: 0, zIndex: 200 }}
                      className="pointer-events-none"
                    >
                      <div className="relative">
                        {/* Target HUD Reticle */}
                        <div className="absolute -inset-12 flex items-center justify-center">
                          <svg className="w-24 h-24 text-brand-500/40 animate-[spin_10s_linear_infinite]" viewBox="0 0 100 100">
                            <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="10 20" />
                          </svg>
                          <div className="absolute w-16 h-16 border border-brand-400/20 rounded-full" />
                        </div>

                        <div className="absolute -inset-10 bg-brand-500/30 blur-[40px] rounded-full animate-pulse" />
                        
                        <div className="relative flex items-center justify-center w-8 h-8">
                          <div className="absolute w-0.5 h-8 bg-brand-500" />
                          <div className="absolute w-8 h-0.5 bg-brand-500" />
                          <MousePointer2 className="relative w-10 h-10 text-white drop-shadow-[0_0_15px_rgba(255,255,255,1)]" />
                        </div>
                        
                        <motion.div 
                          initial={{ opacity: 0, x: 30 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="absolute left-16 top-0 glass-card px-5 py-3 rounded-[20px] border-brand-500/40"
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping" />
                              <span className="text-[10px] font-mono text-brand-400 font-bold uppercase tracking-[0.2em]">DATA_LOCKED</span>
                            </div>
                            <span className="text-sm font-bold text-white tracking-tight whitespace-nowrap">
                              {response?.steps[stepIndex]?.target?.label || "NEURAL_TARGET"}
                            </span>
                            <div className="flex items-center gap-4 mt-2">
                              <div className="text-[8px] font-mono text-gray-500">Step {stepIndex + 1}/{response?.steps.length ?? 0}</div>
                            </div>
                          </div>
                          {/* HUD Corner Brackets */}
                          <div className="absolute top-2 left-2 w-2 h-2 border-t border-l border-brand-500/40" />
                          <div className="absolute top-2 right-2 w-2 h-2 border-t border-r border-brand-500/40" />
                          <div className="absolute bottom-2 left-2 w-2 h-2 border-b border-l border-brand-500/40" />
                          <div className="absolute bottom-2 right-2 w-2 h-2 border-b border-r border-brand-500/40" />
                        </motion.div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </div>
        </div>

        {/* Side Panel */}
        <aside className="w-[400px] flex flex-col gap-8 h-full pr-2">
          {isLoading ? (
            <div className="flex-1 glass-card rounded-[40px] flex flex-col items-center justify-center p-12 gap-8 relative overflow-hidden">
              <div className="absolute inset-0 bg-brand-500/5 animate-[pulse_2s_infinite]" />
              <div className="relative">
                <div className="w-24 h-24 rounded-full border-4 border-brand-500/10 border-t-brand-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-brand-400 animate-pulse" />
                </div>
              </div>
              <div className="text-center space-y-2 relative z-10">
                <h3 className="text-lg font-bold tracking-tight text-glow">Processing Neural Stream</h3>
                <p className="text-xs font-mono text-gray-500 tracking-[0.3em] uppercase">Analyzing visual context...</p>
              </div>
              
              <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden mt-4">
                <motion.div 
                  initial={{ x: "-100%" }}
                  animate={{ x: "100%" }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  className="w-1/2 h-full bg-gradient-to-r from-transparent via-brand-500 to-transparent"
                />
              </div>
            </div>
          ) : response ? (
            <motion.div 
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex-1 flex flex-col glass-card rounded-[40px] p-8 border-brand-500/20"
            >
              <div className="shrink-0 flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-brand-400" />
                  </div>
                  <span className="text-sm font-bold uppercase tracking-widest text-brand-400 font-mono">Neural Guidance</span>
                </div>
                <div className="px-3 py-1 bg-brand-500/10 border border-brand-500/20 rounded-full text-[10px] font-bold text-brand-400">
                  CONFIDENCE: 98%
                </div>
              </div>

              <div className="flex-1 flex flex-col gap-10 overflow-y-auto custom-scrollbar pr-2">
                <div className="space-y-3">
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Analysis</span>
                  <p className="text-lg text-gray-200 leading-relaxed font-medium">
                    {response.thought}
                  </p>
                </div>

                <div className="space-y-6">
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Execution Steps</span>
                  <div className="space-y-4">
                    {response.steps.map((step, i) => (
                      <motion.button
                        type="button"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.1 }}
                        key={i}
                        onClick={() => goToStep(i)}
                        disabled={stepRefining}
                        className={`flex gap-4 p-4 rounded-3xl text-left w-full transition-all cursor-pointer ${
                          i === stepIndex
                            ? "bg-brand-500/15 border border-brand-500/40"
                            : "bg-white/[0.02] border border-white/5 hover:border-white/10 hover:bg-white/[0.04]"
                        }`}
                      >
                        <motion.div className="w-8 h-8 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-xs font-bold text-brand-400 shrink-0">
                          {i + 1}
                        </motion.div>
                        <p className="text-[14px] text-gray-300 leading-relaxed font-medium pt-1">{step.text}</p>
                      </motion.button>
                    ))}
                  </div>
                </div>
              </div>

              {response.steps.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 flex items-center justify-between gap-3"
                >
                  <button
                    type="button"
                    disabled={stepIndex === 0 || stepRefining}
                    onClick={() => goToStep(stepIndex - 1)}
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold uppercase tracking-widest text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </button>
                  <span className="text-[10px] font-mono text-gray-500 shrink-0 text-center min-w-[72px]">
                    {stepRefining ? "Locating…" : `${stepIndex + 1} / ${response.steps.length}`}
                  </span>
                  <button
                    type="button"
                    disabled={stepIndex >= response.steps.length - 1 || stepRefining}
                    onClick={() => goToStep(stepIndex + 1)}
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-brand-600 hover:bg-brand-500 border border-brand-500/30 text-xs font-bold uppercase tracking-widest text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </motion.div>
              )}

              <button 
                onClick={() => {
                  setResponse(null);
                  setIsPhantomActive(false);
                  setStepIndex(0);
                }}
                className="mt-4 w-full py-4 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold uppercase tracking-widest text-gray-400 hover:text-white transition-all cursor-pointer"
              >
                Clear Guidance
              </button>
            </motion.div>
          ) : (
            <div className="flex-1 glass-card rounded-[40px] p-10 flex flex-col items-center justify-center text-center relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-b from-brand-600/5 to-transparent pointer-events-none" />
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-white/5 blur-3xl rounded-full scale-150 animate-pulse" />
                <div className="w-20 h-20 rounded-[30px] border border-white/10 bg-white/[0.02] flex items-center justify-center rotate-12 group-hover:rotate-0 transition-transform duration-500">
                  <MessageSquare className="w-8 h-8 text-white/20" />
                </div>
              </div>
              <h3 className="text-xl font-bold mb-4">Neural Hub Ready</h3>
              <p className="text-sm text-gray-500 max-w-[240px] leading-relaxed font-medium">
                Use <span className="text-brand-400">Ask</span> / <span className="text-brand-400">Text</span> above or{" "}
                <span className="text-brand-400">Ctrl+Shift+L</span>. Sync screen first for the guide cursor.
              </p>
            </div>
          )}
        </aside>
      </main>

      <AnimatePresence>
        {isTriggerOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsTriggerOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-md"
            />
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="relative w-full max-w-xl glass-card rounded-[48px] p-4 shadow-[0_40px_100px_rgba(0,0,0,0.6)]"
            >
              <div className="relative">
                {inputMode === 'selection' ? (
                  <div className="flex p-2 gap-4">
                    <button
                      onClick={toggleListening}
                      className="flex-1 p-10 rounded-[40px] bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-brand-500/20 transition-all flex flex-col items-center gap-6 group cursor-pointer"
                    >
                      <div className="w-20 h-20 rounded-full bg-brand-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Mic className="w-8 h-8 text-brand-400" />
                      </div>
                      <div className="text-center">
                        <span className="block text-sm font-bold uppercase tracking-widest text-white mb-1">Voice Agent</span>
                        <span className="block text-[10px] text-gray-500 font-mono">STT.NEURAL_LINK</span>
                      </div>
                    </button>
                    <button
                      onClick={() => setInputMode('text')}
                      className="flex-1 p-10 rounded-[40px] bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-blue-500/20 transition-all flex flex-col items-center gap-6 group cursor-pointer"
                    >
                      <div className="w-20 h-20 rounded-full bg-blue-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <MessageSquare className="w-8 h-8 text-blue-400" />
                      </div>
                      <div className="text-center">
                        <span className="block text-sm font-bold uppercase tracking-widest text-white mb-1">Text Query</span>
                        <span className="block text-[10px] text-gray-500 font-mono">CMD.PROCESSOR</span>
                      </div>
                    </button>
                  </div>
                ) : inputMode === 'text' ? (
                  <motion.div 
                    initial={{ opacity: 0 }} 
                    animate={{ opacity: 1 }} 
                    className="p-6 flex flex-col gap-4"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center">
                        <MessageSquare className="w-5 h-5 text-blue-400" />
                      </div>
                      <span className="text-sm font-bold uppercase tracking-widest text-blue-400 font-mono">Ready to process command</span>
                    </div>
                    <div className="flex items-center gap-4 bg-white/5 p-4 rounded-3xl border border-white/10">
                      <input
                        autoFocus
                        type="text"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                        placeholder="Describe what you're looking for..."
                        className="flex-1 bg-transparent border-none outline-none text-xl px-2 text-white placeholder:text-gray-700"
                      />
                      <button
                        onClick={() => handleSubmit()}
                        className="w-14 h-14 bg-brand-600 hover:bg-brand-500 rounded-2xl flex items-center justify-center shadow-xl shadow-brand-600/20 active:scale-95 transition-all cursor-pointer"
                      >
                        <ArrowRight className="w-6 h-6" />
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0 }} 
                    animate={{ opacity: 1 }} 
                    className="flex flex-col items-center justify-center p-14 gap-8"
                  >
                    <div className="relative">
                      <motion.div
                        animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.6, 0.3] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="absolute inset-0 bg-brand-500 blur-3xl rounded-full"
                      />
                      <div className="relative w-24 h-24 rounded-full bg-brand-600 flex items-center justify-center shadow-2xl shadow-brand-600/50">
                        <Mic className="w-10 h-10 text-white" />
                      </div>
                    </div>
                    <div className="text-center space-y-2">
                      <p className="text-2xl font-bold text-white uppercase tracking-tight">Listening</p>
                      <p className="text-sm text-gray-500 font-mono tracking-widest">STT_STREAMING_ACTIVE</p>
                    </div>
                    <button 
                      onClick={() => {
                        setIsListening(false);
                        setInputMode('selection');
                      }}
                      className="px-8 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 hover:text-white transition-all cursor-pointer"
                    >
                      Abort Sync
                    </button>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Status Bar */}
      <div className="fixed bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-8 pl-8 pr-12 py-4 glass-card rounded-[32px] z-50">
        <div className="flex items-center gap-3">
          <Command className="w-4 h-4 text-gray-500" />
          <div className="flex items-center gap-1.5">
            <kbd className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold text-gray-400 font-mono">CTRL</kbd>
            <span className="text-[10px] text-gray-600">+</span>
            <kbd className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold text-gray-400 font-mono">SHIFT</kbd>
            <span className="text-[10px] text-gray-600">+</span>
            <kbd className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold text-gray-400 font-mono">L</kbd>
          </div>
        </div>
        <div className="w-px h-6 bg-white/10" />
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${isCapturing ? 'bg-green-500' : 'bg-gray-700'}`} />
          <span className="text-[10px] uppercase font-bold tracking-widest text-gray-500">
            {isCapturing ? 'System Linked' : 'Offline'}
          </span>
        </div>
      </div>

      <motion.div
        className="fixed top-0 left-0 w-6 h-6 border border-white/30 rounded-full pointer-events-none z-[9999]"
        animate={{ x: mousePos.x - 12, y: mousePos.y - 12 }}
        transition={{ type: "spring", damping: 40, stiffness: 600, mass: 0.4 }}
      >
        <div className="absolute inset-0 bg-brand-500/10 rounded-full blur-md" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-white rounded-full" />
      </motion.div>
    </div>
  );
}
