import { useEffect, useMemo, useRef, useState } from "react";
import { getUserId } from "./auth";

type WsStatus = "idle" | "connecting" | "open" | "closed" | "error";

type ScenePosition =
  | "door"
  | "bar"
  | "fire"
  | "table"
  | "window"
  | "stairs";

const POSITIONS: ScenePosition[] = ["door", "bar", "fire", "table", "window", "stairs"];
const POSITION_X: Record<ScenePosition, number> = {
  door: 6,
  bar: 22,
  fire: 40,
  table: 60,
  window: 78,
  stairs: 94,
};

const BUBBLE_MS_SAY = 9000;
const BUBBLE_MS_DO = 6000;
const BUBBLE_MS_MOVE = 4000;
const NARRATION_MAX = 40;
const THINKING_TAIL_CHARS = 180;

interface CharacterLive {
  npcId: string;
  name: string;
  palette: string;
  objective: string;
  position: ScenePosition;
  thinking: boolean;
  thinkingTail: string;
  thinkingTokens: number;
  bubble: { kind: "say" | "do" | "move"; text: string; expiresAt: number } | null;
  lastReason: string | null;
  lastActedAt: number | null;
  nextWakeAt: number | null;
}

interface NarrationEvent {
  id: number;
  npcId: string;
  name: string;
  palette: string;
  kind: "say" | "do" | "move" | "noop";
  text: string;
  reason: string;
  at: number;
}

interface ServerHelloLite {
  type: "hello";
  userId: string;
  scene?: { location?: string; timeOfDay?: string };
  dailyPlan?: {
    date?: string;
    npcs?: Array<{
      name: string;
      palette?: string;
      objective?: string;
      backstory?: string;
    }>;
  };
  clock?: { gameHour?: number; gameMinute?: number };
}

const WS_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "ws://localhost:8788"
    : "wss://augur.carl-lewis.workers.dev";

export function HearthScene() {
  const [status, setStatus] = useState<WsStatus>("idle");
  const [hello, setHello] = useState<ServerHelloLite | null>(null);
  const [chars, setChars] = useState<Record<string, CharacterLive>>({});
  const [narration, setNarration] = useState<NarrationEvent[]>([]);
  const [tick, setTick] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const narrationIdRef = useRef(1);
  // Mirror chars into a ref so the WS handler (created once) can look up
  // current name/palette without re-binding on every state change.
  const charsRef = useRef<Record<string, CharacterLive>>({});
  useEffect(() => { charsRef.current = chars; }, [chars]);

  // 1Hz ticker for countdowns + bubble expiration
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Expire bubbles whose time has passed.
  useEffect(() => {
    const now = Date.now();
    setChars((prev) => {
      let changed = false;
      const next: Record<string, CharacterLive> = {};
      for (const [k, c] of Object.entries(prev)) {
        if (c.bubble && c.bubble.expiresAt <= now) {
          changed = true;
          next[k] = { ...c, bubble: null };
        } else {
          next[k] = c;
        }
      }
      return changed ? next : prev;
    });
  }, [tick]);

  // Seed characters from hello.dailyPlan.
  useEffect(() => {
    if (!hello?.dailyPlan?.npcs) return;
    setChars((prev) => {
      const next = { ...prev };
      const npcs = hello.dailyPlan?.npcs ?? [];
      for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i];
        const id = npcAgentId(n.name);
        if (next[id]) continue;
        next[id] = {
          npcId: id,
          name: n.name,
          palette: n.palette ?? defaultPalette(i),
          objective: n.objective ?? "",
          position: defaultPositionFor(i),
          thinking: false,
          thinkingTail: "",
          thinkingTokens: 0,
          bubble: null,
          lastReason: null,
          lastActedAt: null,
          nextWakeAt: null,
        };
      }
      return next;
    });
  }, [hello]);

  // WS connect with auto-reconnect.
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;

    const connect = () => {
      if (cancelled) return;
      const userId = getUserId() ?? "dev-user";
      const url = `${WS_BASE}/api/session?userId=${encodeURIComponent(userId)}`;
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        backoffMs = 500;
        setStatus("open");
      });
      const scheduleReconnect = () => {
        if (cancelled) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
      };
      ws.addEventListener("close", () => {
        setStatus("closed");
        scheduleReconnect();
      });
      ws.addEventListener("error", () => setStatus("error"));
      ws.addEventListener("message", (ev) => {
        let msg: { type?: string; [k: string]: unknown };
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === "hello") {
          setHello(msg as unknown as ServerHelloLite);
          return;
        }

        if (msg.type === "agent-thinking") {
          const agentId = String(msg.agentId ?? "");
          const delta = String(msg.delta ?? "");
          if (!agentId) return;
          setChars((prev) => {
            const cur = prev[agentId];
            if (!cur) return prev;
            const tail = (cur.thinkingTail + delta).slice(-THINKING_TAIL_CHARS);
            return {
              ...prev,
              [agentId]: {
                ...cur,
                thinking: true,
                thinkingTail: tail,
                thinkingTokens: cur.thinkingTokens + 1,
              },
            };
          });
          return;
        }

        if (msg.type === "agent-decided") {
          const agentId = String(msg.agentId ?? "");
          if (!agentId) return;
          const action = msg.action as
            | { type?: string; text?: string; position?: string }
            | null;
          const reason = typeof msg.reason === "string" ? msg.reason : "";
          const nextWakeAt =
            typeof msg.nextWakeAt === "number" ? msg.nextWakeAt : null;
          const now = Date.now();

          setChars((prev) => {
            const cur = prev[agentId];
            if (!cur) return prev;
            let nextPos = cur.position;
            let bubble: CharacterLive["bubble"] = cur.bubble;
            const kind = normalizeKind(action?.type);
            if (action) {
              const newPos = normalizePosition(action.position);
              if (newPos) nextPos = newPos;
              if (kind === "say" && action.text) {
                bubble = { kind, text: action.text, expiresAt: now + BUBBLE_MS_SAY };
              } else if (kind === "do" && action.text) {
                bubble = { kind, text: action.text, expiresAt: now + BUBBLE_MS_DO };
              } else if (kind === "move") {
                bubble = {
                  kind,
                  text: action.text || `→ ${nextPos}`,
                  expiresAt: now + BUBBLE_MS_MOVE,
                };
              }
            }
            return {
              ...prev,
              [agentId]: {
                ...cur,
                thinking: false,
                thinkingTail: "",
                position: nextPos,
                bubble,
                lastReason: reason || cur.lastReason,
                lastActedAt: now,
                nextWakeAt,
              },
            };
          });

          setNarration((prev) => {
            const cur = charsRef.current[agentId];
            const entry: NarrationEvent = {
              id: narrationIdRef.current++,
              npcId: agentId,
              name: cur?.name ?? agentId,
              palette: cur?.palette ?? "#888",
              kind: action ? normalizeKind(action.type) : "noop",
              text: action?.text ?? "",
              reason,
              at: now,
            };
            const next = [entry, ...prev];
            return next.slice(0, NARRATION_MAX);
          });
        }
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, []);

  const charList = useMemo(
    () => Object.values(chars).sort((a, b) => a.name.localeCompare(b.name)),
    [chars],
  );

  const now = Date.now();
  void tick;
  const sceneLabel = hello?.scene?.location ?? "the inn at the edge of morning";
  const gameTime = hello?.clock
    ? `${pad2(hello.clock.gameHour)}:${pad2(hello.clock.gameMinute)}`
    : "—:—";

  return (
    <div className="hearth-scene">
      <header className="hs-header">
        <div className="hs-header-left">
          <span className={`hs-status hs-status-${status}`} />
          <strong className="hs-title">{sceneLabel}</strong>
          <span className="hs-meta-pill">{gameTime}</span>
          {hello?.dailyPlan?.date && (
            <span className="hs-meta-pill">plan {hello.dailyPlan.date}</span>
          )}
          <span className="hs-meta-pill">{charList.length} residents</span>
        </div>
        <div className="hs-header-right">
          <span className="hs-meta-faint">ws · {status}</span>
        </div>
      </header>

      <div className="hs-main">
        <section className="hs-stage" aria-label="scene">
          <SceneBackdrop />
          <div className="hs-stage-floor">
            {charList.map((c) => (
              <CharacterSprite key={c.npcId} ch={c} now={now} />
            ))}
          </div>
        </section>

        <aside className="hs-aside">
          <div className="hs-cast">
            <div className="hs-aside-h">CAST</div>
            {charList.length === 0 && (
              <div className="hs-empty">waiting for the day plan…</div>
            )}
            {charList.map((c) => {
              const wakeIn = c.nextWakeAt
                ? Math.max(0, Math.round((c.nextWakeAt - now) / 1000))
                : null;
              return (
                <div key={c.npcId} className="hs-cast-row">
                  <span className="hs-dot" style={{ background: c.palette }} />
                  <div className="hs-cast-text">
                    <div className="hs-cast-name">
                      {c.name}
                      {c.thinking && <span className="hs-thinking-pip">●●●</span>}
                    </div>
                    <div className="hs-cast-objective">{c.objective}</div>
                    <div className="hs-cast-state">
                      at {c.position}
                      {wakeIn != null && <> · wake +{wakeIn}s</>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hs-narration">
            <div className="hs-aside-h">RECENT MOMENTS</div>
            {narration.length === 0 && (
              <div className="hs-empty">no moments yet — the room is still.</div>
            )}
            {narration.map((n) => (
              <div key={n.id} className="hs-narr-row">
                <span className="hs-dot-sm" style={{ background: n.palette }} />
                <div className="hs-narr-text">
                  <div>
                    <strong>{n.name}</strong>
                    {n.kind !== "noop" && <span className={`hs-kind hs-kind-${n.kind}`}> {kindLabel(n.kind)} </span>}
                    {n.text && (
                      <span className={n.kind === "say" ? "hs-said" : "hs-did"}>
                        {n.kind === "say" ? `"${n.text}"` : n.text}
                      </span>
                    )}
                  </div>
                  {n.reason && <div className="hs-narr-reason">{n.reason}</div>}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <SceneStyles />
    </div>
  );
}

function CharacterSprite({ ch, now }: { ch: CharacterLive; now: number }) {
  void now;
  const x = POSITION_X[ch.position];
  return (
    <div
      className="hs-sprite"
      style={{ left: `${x}%` }}
      data-pos={ch.position}
    >
      {ch.bubble && (
        <div className={`hs-bubble hs-bubble-${ch.bubble.kind}`}>
          {ch.bubble.kind === "say" ? `"${ch.bubble.text}"` : ch.bubble.text}
        </div>
      )}
      {ch.thinking && !ch.bubble && (
        <div className="hs-bubble hs-bubble-thinking" title={ch.thinkingTail}>
          <span className="hs-think-anim">thinking…</span>
        </div>
      )}
      <div className="hs-body" style={{ background: ch.palette }} />
      <div className="hs-name">{ch.name}</div>
    </div>
  );
}

function SceneBackdrop() {
  return (
    <svg
      className="hs-backdrop"
      viewBox="0 0 1000 600"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d0a08" />
          <stop offset="100%" stopColor="#1a140d" />
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ff9800" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ff9800" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1000" height="600" fill="url(#sky)" />
      {/* Floor */}
      <rect x="0" y="460" width="1000" height="140" fill="#241911" />
      <line x1="0" y1="460" x2="1000" y2="460" stroke="#3a2a1c" strokeWidth="2" />
      {/* Door (left) */}
      <rect x="40" y="280" width="80" height="180" fill="#1a120b" stroke="#3a2a1c" />
      <circle cx="105" cy="370" r="3" fill="#d4a574" />
      <text x="80" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">DOOR</text>
      {/* Bar */}
      <rect x="180" y="380" width="140" height="80" fill="#3a2a1c" />
      <rect x="180" y="370" width="140" height="14" fill="#5a3f28" />
      <text x="250" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">BAR</text>
      {/* Fire */}
      <rect x="370" y="340" width="120" height="120" fill="#1a120b" stroke="#3a2a1c" />
      <ellipse cx="430" cy="430" rx="60" ry="40" fill="url(#glow)" />
      <path d="M410 440 Q420 410 430 430 Q440 405 450 430 Q445 455 430 455 Q415 455 410 440 Z" fill="#ff9800" opacity="0.85" />
      <text x="430" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">FIRE</text>
      {/* Table */}
      <rect x="560" y="400" width="160" height="14" fill="#5a3f28" />
      <rect x="572" y="414" width="6" height="46" fill="#3a2a1c" />
      <rect x="702" y="414" width="6" height="46" fill="#3a2a1c" />
      <text x="640" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">TABLE</text>
      {/* Window */}
      <rect x="760" y="200" width="100" height="120" fill="#2a3340" stroke="#3a2a1c" strokeWidth="3" />
      <line x1="810" y1="200" x2="810" y2="320" stroke="#3a2a1c" strokeWidth="2" />
      <line x1="760" y1="260" x2="860" y2="260" stroke="#3a2a1c" strokeWidth="2" />
      <text x="810" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">WINDOW</text>
      {/* Stairs */}
      <polygon points="900,460 1000,460 1000,300 940,300" fill="#1a120b" stroke="#3a2a1c" />
      <line x1="940" y1="300" x2="900" y2="460" stroke="#3a2a1c" strokeWidth="1" />
      <line x1="950" y1="320" x2="918" y2="430" stroke="#3a2a1c" strokeWidth="1" />
      <line x1="960" y1="340" x2="932" y2="410" stroke="#3a2a1c" strokeWidth="1" />
      <text x="960" y="490" fontSize="14" fill="#6a5a48" textAnchor="middle" fontFamily="monospace">STAIRS</text>
    </svg>
  );
}

function SceneStyles() {
  return (
    <style>{`
.hearth-scene {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-0, #0a0806);
  color: var(--ink, #f5f0e8);
  font-family: var(--sans, system-ui, sans-serif);
  font-size: 13px;
  overflow: hidden;
}
.hs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line, #2a211a);
  background: linear-gradient(180deg, #0f1320 0%, var(--bg-1, #14110c) 100%);
  flex-shrink: 0;
}
.hs-header-left { display: flex; align-items: center; gap: 10px; }
.hs-title {
  font-family: var(--serif, Georgia, serif);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 13px;
  color: var(--gold, #d4a574);
}
.hs-meta-pill {
  font-family: var(--mono, monospace);
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--line, #2a211a);
  border-radius: 10px;
  color: var(--ink-dim, #9ca3af);
  background: rgba(0,0,0,0.3);
}
.hs-meta-faint { font-family: var(--mono, monospace); font-size: 11px; color: var(--ink-faint, #6a5a48); }
.hs-status {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block;
  background: #666;
}
.hs-status-open { background: #7fcf94; box-shadow: 0 0 8px #7fcf94; }
.hs-status-connecting { background: #e8c977; }
.hs-status-error { background: #e87777; }
.hs-status-closed { background: #888; }

.hs-main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.hs-stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-width: 0;
}
.hs-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.hs-stage-floor {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hs-sprite {
  position: absolute;
  bottom: 14%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  transition: left 1.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.hs-body {
  width: 36px;
  height: 56px;
  border-radius: 8px 8px 4px 4px;
  border: 2px solid rgba(0,0,0,0.5);
  box-shadow: 0 4px 8px rgba(0,0,0,0.6), inset 0 -8px 12px rgba(0,0,0,0.4);
}
.hs-name {
  font-family: var(--mono, monospace);
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--ink, #f5f0e8);
  background: rgba(0,0,0,0.6);
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
.hs-bubble {
  position: absolute;
  bottom: 100%;
  margin-bottom: 8px;
  max-width: 260px;
  min-width: 80px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.6);
  animation: hsBubbleIn 200ms ease-out;
}
.hs-bubble::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -6px;
  border: 6px solid transparent;
  border-top-color: inherit;
}
.hs-bubble-say {
  background: #f5f0e8;
  color: #1a140d;
  border-top-color: #f5f0e8;
}
.hs-bubble-do {
  background: rgba(212, 165, 116, 0.18);
  color: var(--gold, #d4a574);
  font-style: italic;
  border-top-color: rgba(212, 165, 116, 0.18);
  border: 1px solid var(--gold-soft, #c89a3a);
}
.hs-bubble-move {
  background: rgba(138, 176, 200, 0.18);
  color: var(--blue, #8ab0c8);
  font-style: italic;
  border: 1px solid #4a6478;
  border-top-color: rgba(138, 176, 200, 0.18);
}
.hs-bubble-thinking {
  background: rgba(255,255,255,0.06);
  color: var(--ink-dim, #9ca3af);
  border: 1px dashed var(--line, #2a211a);
  border-top-color: rgba(255,255,255,0.06);
  font-size: 11px;
}
.hs-think-anim {
  animation: hsThink 1.5s ease-in-out infinite;
  display: inline-block;
}
@keyframes hsThink {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
@keyframes hsBubbleIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.hs-aside {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--line, #2a211a);
  background: rgba(8,10,16,0.6);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.hs-aside-h {
  font-family: var(--mono, monospace);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--ink-faint, #6a5a48);
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--line-soft, #1a130a);
}
.hs-cast {
  flex: 0 0 auto;
  max-height: 50%;
  overflow: auto;
  border-bottom: 1px solid var(--line, #2a211a);
}
.hs-cast-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-soft, #1a130a);
}
.hs-dot {
  width: 12px; height: 12px; border-radius: 50%;
  flex-shrink: 0;
  margin-top: 2px;
  border: 1px solid rgba(0,0,0,0.4);
}
.hs-dot-sm { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
.hs-cast-text { flex: 1; min-width: 0; }
.hs-cast-name {
  font-weight: 600;
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.hs-thinking-pip {
  font-size: 8px;
  color: var(--gold-soft, #c89a3a);
  letter-spacing: 1px;
  animation: hsThink 1.5s ease-in-out infinite;
}
.hs-cast-objective {
  font-size: 11px;
  color: var(--ink-dim, #9ca3af);
  margin-top: 2px;
}
.hs-cast-state {
  font-family: var(--mono, monospace);
  font-size: 10px;
  color: var(--ink-faint, #6a5a48);
  margin-top: 2px;
}
.hs-narration { flex: 1; overflow: auto; }
.hs-narr-row {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-soft, #1a130a);
  font-size: 12px;
}
.hs-narr-text { flex: 1; min-width: 0; }
.hs-kind {
  font-family: var(--mono, monospace);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-left: 4px;
  margin-right: 4px;
}
.hs-kind-say { color: var(--ink, #f5f0e8); }
.hs-kind-do { color: var(--gold, #d4a574); }
.hs-kind-move { color: var(--blue, #8ab0c8); }
.hs-said { font-style: italic; }
.hs-did { font-style: italic; color: var(--ink-dim, #9ca3af); }
.hs-narr-reason {
  font-size: 11px;
  color: var(--ink-faint, #6a5a48);
  margin-top: 2px;
  font-style: italic;
}
.hs-empty {
  padding: 16px 12px;
  font-style: italic;
  color: var(--ink-faint, #6a5a48);
  font-size: 11px;
}
    `}</style>
  );
}

function pad2(n: number | undefined): string {
  if (n == null) return "00";
  return String(Math.max(0, Math.min(99, Math.floor(n)))).padStart(2, "0");
}

function npcAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `npc:${slug || "unnamed"}`;
}

function defaultPalette(i: number): string {
  const palette = ["#d98a6a", "#8ab0c8", "#7ab858", "#d4a574", "#c89a3a", "#9b6b9e"];
  return palette[i % palette.length];
}

function defaultPositionFor(i: number): ScenePosition {
  return POSITIONS[i % POSITIONS.length];
}

function normalizePosition(p: unknown): ScenePosition | null {
  if (typeof p !== "string") return null;
  const lower = p.toLowerCase();
  if ((POSITIONS as string[]).includes(lower)) return lower as ScenePosition;
  return null;
}

function normalizeKind(k: unknown): "say" | "do" | "move" | "noop" {
  if (k === "say" || k === "do" || k === "move") return k;
  return "noop";
}

function kindLabel(k: "say" | "do" | "move" | "noop"): string {
  if (k === "say") return "says";
  if (k === "do") return "does";
  if (k === "move") return "moves";
  return "—";
}
