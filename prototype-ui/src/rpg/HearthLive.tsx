import { useEffect, useMemo, useRef, useState } from "react";
import { getUserId } from "./auth";
import { currentRoomId } from "./engine";

type WsStatus = "idle" | "connecting" | "open" | "closed" | "error";

interface AgentLive {
  agentId: string;
  thinking: string;
  thinkingCount: number;
  lastAction: { type: string; text?: string; position?: string } | null;
  lastReason: string | null;
  nextWakeAt: number | null;
  position: string | null;
}

interface SceneWireLite {
  id?: string;
  location?: string;
  timeOfDay?: string;
  moods?: string[];
  npcs?: string[];
}

interface NpcDayLite {
  name: string;
  backstory?: string;
  palette?: string;
  objective?: string;
  motive?: string;
  schedule?: Array<{ hour: number; activity: string; mood?: string }>;
}

interface DailyPlanLite {
  date?: string;
  dayOfWeek?: string;
  playerObjective?: string;
  npcs?: NpcDayLite[];
  openingHour?: number;
  closingHour?: number;
  seed?: string;
}

interface ClockLite {
  gameHour?: number;
  gameMinute?: number;
}

interface ServerHelloLite {
  type: "hello";
  userId: string;
  scene?: SceneWireLite;
  dailyPlan?: DailyPlanLite;
  clock?: ClockLite;
  dayComplete?: boolean;
}

interface MomentEntry {
  ts: number;
  agentId: string;
  npcName: string | null;
  action: { type: string; text?: string; position?: string } | null;
  reason: string;
}

const WS_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "ws://localhost:8788"
    : "wss://augur.carl-lewis.workers.dev";

const MAX_MOMENTS = 30;

export function HearthLive() {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<WsStatus>("idle");
  const [terminal, setTerminal] = useState<{ kind: "kicked" | "day-done" | "run-ended"; reason: string } | null>(null);
  const [hello, setHello] = useState<ServerHelloLite | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentLive>>({});
  const [moments, setMoments] = useState<MomentEntry[]>([]);
  const [tick, setTick] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;

    const connect = () => {
      if (cancelled) return;
      const userId = getUserId() ?? "dev-user";
      const roomId = currentRoomId();
      if (!roomId) {
        // No room selected → no DO to address. Try again shortly in case
        // the user is still picking a room.
        setStatus("idle");
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1000);
        return;
      }
      const url =
        `${WS_BASE}/api/session?userId=${encodeURIComponent(userId)}` +
        `&roomId=${encodeURIComponent(roomId)}`;
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        backoffMs = 500;
        setStatus("open");
        setTerminal(null);
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
      ws.addEventListener("close", (ev) => {
        setStatus("closed");
        // Server-initiated terminal closes: stop reconnecting so the dot
        // doesn't cycle. Day-complete is now silent (no close), but keep
        // these guards in case other codepaths still close cleanly.
        if (ev.code === 1000) {
          if (ev.reason === "another-connection") {
            setTerminal({ kind: "kicked", reason: "another tab took over" });
            return;
          }
          if (ev.reason.startsWith("run-ended:")) {
            const why = ev.reason.slice("run-ended:".length);
            setTerminal({ kind: "run-ended", reason: why });
            return;
          }
        }
        scheduleReconnect();
      });
      ws.addEventListener("error", () => setStatus("error"));
      ws.addEventListener("message", (ev) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "hello") {
          const h = msg as unknown as ServerHelloLite;
          setHello(h);
          if (h.dayComplete) {
            setTerminal({ kind: "day-done", reason: "today's run is complete" });
          }
          return;
        }
        if (msg.type === "run-ended") {
          const why = typeof msg.reason === "string" ? msg.reason : "schedule";
          setTerminal({ kind: "run-ended", reason: why });
          return;
        }
        if (msg.type === "kicked") {
          setTerminal({ kind: "kicked", reason: "another tab took over" });
          return;
        }
        if (msg.type === "agent-thinking") {
          const agentId = String(msg.agentId ?? "");
          const delta = String(msg.delta ?? "");
          if (!agentId) return;
          setAgents((prev) => {
            const cur = prev[agentId] ?? newAgent(agentId);
            const next = (cur.thinking + delta).slice(-1200);
            return {
              ...prev,
              [agentId]: { ...cur, thinking: next, thinkingCount: cur.thinkingCount + 1 },
            };
          });
          return;
        }
        if (msg.type === "agent-decided") {
          const agentId = String(msg.agentId ?? "");
          if (!agentId) return;
          const action = (msg.action as AgentLive["lastAction"]) ?? null;
          const reason = typeof msg.reason === "string" ? msg.reason : "";
          setAgents((prev) => {
            const cur = prev[agentId] ?? newAgent(agentId);
            return {
              ...prev,
              [agentId]: {
                ...cur,
                lastAction: action,
                lastReason: reason || null,
                nextWakeAt: typeof msg.nextWakeAt === "number" ? msg.nextWakeAt : null,
                thinking: "",
                position: action?.position ?? cur.position,
              },
            };
          });
          // Append to recent moments timeline.
          setMoments((prev) => {
            const npcName = stripNpcPrefix(agentId);
            const entry: MomentEntry = {
              ts: Date.now(),
              agentId,
              npcName,
              action,
              reason,
            };
            const next = [...prev, entry];
            return next.length > MAX_MOMENTS ? next.slice(-MAX_MOMENTS) : next;
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
  }, [open]);

  // Build a map of agentId → matching NpcDay so per-agent cards can show
  // backstory / objective / motive / scheduled activity.
  const npcsByAgentId = useMemo(() => {
    const map: Record<string, NpcDayLite> = {};
    for (const npc of hello?.dailyPlan?.npcs ?? []) {
      map[`npc:${slugify(npc.name)}`] = npc;
    }
    return map;
  }, [hello?.dailyPlan?.npcs]);

  const list = useMemo(
    () => Object.values(agents).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    [agents],
  );
  const now = Date.now();
  void tick;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...buttonBase, position: "fixed", right: 16, bottom: 16 }}
      >
        ◉ HEARTH
      </button>
    );
  }

  const gameHour = hello?.clock?.gameHour;

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={dotStyle(status, terminal)} />
          <strong style={{ letterSpacing: 1 }}>HEARTH LIVE</strong>
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            {terminal ? terminal.kind : status}
          </span>
        </div>
        <button onClick={() => setOpen(false)} style={closeBtn}>×</button>
      </div>

      {terminal && (
        <div style={terminalBannerStyle}>
          {terminal.kind === "day-done" && "today's in-game schedule is complete — come back tomorrow"}
          {terminal.kind === "kicked" && "this connection was replaced by another tab"}
          {terminal.kind === "run-ended" && `run ended (${terminal.reason})`}
        </div>
      )}

      {hello && (
        <div style={metaStyle}>
          <div>userId: <code>{hello.userId}</code></div>
          {hello.dailyPlan?.date && (
            <div>
              {hello.dailyPlan.dayOfWeek ? `${hello.dailyPlan.dayOfWeek}, ` : ""}
              {hello.dailyPlan.date}
              {typeof hello.dailyPlan.openingHour === "number" &&
              typeof hello.dailyPlan.closingHour === "number"
                ? ` · open ${hello.dailyPlan.openingHour}:00–${hello.dailyPlan.closingHour}:00`
                : ""}
            </div>
          )}
          {hello.clock && (
            <div>
              game time: {String(hello.clock.gameHour ?? 0).padStart(2, "0")}:
              {String(hello.clock.gameMinute ?? 0).padStart(2, "0")}
            </div>
          )}
          {hello.scene && (
            <div>
              scene: {hello.scene.location ?? "—"}
              {hello.scene.timeOfDay ? ` · ${hello.scene.timeOfDay}` : ""}
            </div>
          )}
          {hello.scene?.moods && hello.scene.moods.length > 0 && (
            <div style={{ opacity: 0.7 }}>
              moods: {hello.scene.moods.join(", ")}
            </div>
          )}
          {hello.dailyPlan?.playerObjective && (
            <div style={objectiveStyle}>
              <span style={{ opacity: 0.5, fontSize: 10, letterSpacing: 1 }}>
                YOUR OBJECTIVE
              </span>
              <div>{hello.dailyPlan.playerObjective}</div>
            </div>
          )}
        </div>
      )}

      <div style={{ overflow: "auto", flex: 1 }}>
        <div style={sectionHeaderStyle}>RESIDENTS</div>
        {list.length === 0 && (
          <div style={emptyStyle}>
            no agents have woken yet. dispatcher fires on each agent's self-chosen cadence.
          </div>
        )}
        {list.map((a) => {
          const wakeIn = a.nextWakeAt ? Math.max(0, Math.round((a.nextWakeAt - now) / 1000)) : null;
          const npc = npcsByAgentId[a.agentId];
          const slot =
            npc && typeof gameHour === "number"
              ? slotForHour(npc, gameHour)
              : null;
          return (
            <div key={a.agentId} style={agentCardStyle}>
              <div style={agentHeaderStyle}>
                <strong>
                  {npc?.name ?? a.agentId}
                  {a.position && (
                    <span style={positionStyle}> @ {a.position}</span>
                  )}
                </strong>
                {wakeIn != null && <span style={{ opacity: 0.6 }}>+{wakeIn}s</span>}
              </div>
              {npc?.backstory && (
                <div style={npcMetaStyle}>{npc.backstory}</div>
              )}
              {(npc?.objective || npc?.motive) && (
                <div style={npcMetaGridStyle}>
                  {npc?.objective && (
                    <div>
                      <span style={subLabelStyle}>OBJECTIVE</span>
                      <div>{npc.objective}</div>
                    </div>
                  )}
                  {npc?.motive && (
                    <div>
                      <span style={subLabelStyle}>MOTIVE</span>
                      <div style={{ fontStyle: "italic" }}>{npc.motive}</div>
                    </div>
                  )}
                </div>
              )}
              {slot && (
                <div style={scheduleStyle}>
                  <span style={subLabelStyle}>NOW ({String(gameHour).padStart(2, "0")}:00)</span>
                  <div>
                    {slot.activity}
                    {slot.mood ? ` · ${slot.mood}` : ""}
                  </div>
                </div>
              )}
              {a.thinking && (
                <div style={thinkingStyle}>
                  <span style={subLabelStyle}>THINKING ({a.thinkingCount})</span>
                  <div style={thinkingTextStyle}>{a.thinking}</div>
                </div>
              )}
              {a.lastAction && (
                <div style={actionStyle}>
                  <span style={subLabelStyle}>LAST ACTION</span>
                  <div>
                    {a.lastAction.type}
                    {a.lastAction.text ? `: "${a.lastAction.text}"` : ""}
                    {a.lastAction.position ? ` → ${a.lastAction.position}` : ""}
                  </div>
                </div>
              )}
              {a.lastReason && (
                <div style={reasonStyle}>
                  <span style={subLabelStyle}>REASON</span>
                  <div style={{ fontStyle: "italic" }}>{a.lastReason}</div>
                </div>
              )}
            </div>
          );
        })}

        <div style={sectionHeaderStyle}>RECENT MOMENTS</div>
        {moments.length === 0 ? (
          <div style={emptyStyle}>(nothing has happened yet)</div>
        ) : (
          <div style={momentsListStyle}>
            {[...moments].reverse().map((m, i) => (
              <div key={`${m.ts}-${i}`} style={momentRowStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong>{m.npcName ?? m.agentId}</strong>
                  <span style={{ opacity: 0.5, fontSize: 10 }}>
                    {formatAgo(now - m.ts)}
                  </span>
                </div>
                {m.action ? (
                  <div style={{ marginTop: 2 }}>
                    <span style={{ opacity: 0.6 }}>[{m.action.type}]</span>{" "}
                    {m.action.text ? `"${m.action.text}"` : ""}
                    {m.action.position && (
                      <span style={{ opacity: 0.6 }}> → {m.action.position}</span>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 2, opacity: 0.5 }}>(stayed quiet)</div>
                )}
                {m.reason && (
                  <div style={{ fontSize: 10, opacity: 0.65, fontStyle: "italic", marginTop: 2 }}>
                    {m.reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function newAgent(agentId: string): AgentLive {
  return {
    agentId,
    thinking: "",
    thinkingCount: 0,
    lastAction: null,
    lastReason: null,
    nextWakeAt: null,
    position: null,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripNpcPrefix(agentId: string): string | null {
  if (!agentId.startsWith("npc:")) return null;
  return agentId
    .slice("npc:".length)
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function slotForHour(
  npc: NpcDayLite,
  hour: number,
): { activity: string; mood?: string } | null {
  if (!npc.schedule || npc.schedule.length === 0) return null;
  let chosen = npc.schedule[0];
  for (const s of npc.schedule) {
    if (s.hour <= hour) chosen = s;
    else break;
  }
  return chosen;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 16,
  top: 16,
  bottom: 16,
  width: 360,
  background: "rgba(8,10,16,0.92)",
  border: "1px solid rgba(255,200,120,0.25)",
  borderRadius: 6,
  color: "#e8e0c8",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  display: "flex",
  flexDirection: "column",
  zIndex: 9999,
  boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
};

const headerStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,200,120,0.15)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  color: "inherit",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  padding: "0 4px",
};

const buttonBase: React.CSSProperties = {
  background: "rgba(8,10,16,0.92)",
  color: "#e8e0c8",
  border: "1px solid rgba(255,200,120,0.4)",
  borderRadius: 4,
  padding: "6px 10px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  cursor: "pointer",
  zIndex: 9999,
};

const terminalBannerStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,200,120,0.15)",
  background: "rgba(232,201,119,0.08)",
  color: "#f0d49b",
  fontSize: 11,
  textAlign: "center",
};

const metaStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,200,120,0.1)",
  fontSize: 11,
  opacity: 0.85,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const objectiveStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "4px 6px",
  background: "rgba(255,200,120,0.06)",
  borderLeft: "2px solid rgba(255,200,120,0.4)",
  borderRadius: 2,
};

const sectionHeaderStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 10,
  letterSpacing: 1.5,
  opacity: 0.5,
  borderBottom: "1px solid rgba(255,255,255,0.05)",
  background: "rgba(255,255,255,0.02)",
};

const emptyStyle: React.CSSProperties = {
  padding: 16,
  opacity: 0.6,
  fontStyle: "italic",
};

const agentCardStyle: React.CSSProperties = {
  padding: 10,
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const agentHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
};

const positionStyle: React.CSSProperties = {
  marginLeft: 4,
  opacity: 0.55,
  fontWeight: "normal",
  fontSize: 11,
};

const npcMetaStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.75,
  lineHeight: 1.4,
};

const npcMetaGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6,
  fontSize: 11,
};

const subLabelStyle: React.CSSProperties = {
  opacity: 0.5,
  fontSize: 10,
  letterSpacing: 1,
};

const scheduleStyle: React.CSSProperties = {
  fontSize: 11,
  background: "rgba(120,180,255,0.05)",
  borderLeft: "2px solid rgba(120,180,255,0.4)",
  padding: "4px 6px",
  borderRadius: 2,
};

const thinkingStyle: React.CSSProperties = {
  background: "rgba(255,200,120,0.04)",
  borderLeft: "2px solid rgba(255,200,120,0.4)",
  padding: "4px 6px",
  borderRadius: 2,
};

const thinkingTextStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  maxHeight: 120,
  overflow: "auto",
  marginTop: 2,
  fontSize: 11,
  lineHeight: 1.4,
};

const actionStyle: React.CSSProperties = {
  background: "rgba(120,200,160,0.06)",
  borderLeft: "2px solid rgba(120,200,160,0.5)",
  padding: "4px 6px",
};

const reasonStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.8,
};

const momentsListStyle: React.CSSProperties = {
  padding: "6px 10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const momentRowStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 6px",
  borderLeft: "1px solid rgba(255,255,255,0.1)",
};

function dotStyle(
  status: WsStatus,
  terminal: { kind: "kicked" | "day-done" | "run-ended" } | null,
): React.CSSProperties {
  const color = terminal
    ? terminal.kind === "day-done"
      ? "#9b8be0"
      : "#e8a877"
    : status === "open"
      ? "#7fcf94"
      : status === "connecting"
        ? "#e8c977"
        : status === "error"
          ? "#e87777"
          : "#666";
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    boxShadow: status === "open" && !terminal ? "0 0 6px " + color : "none",
    display: "inline-block",
  };
}
