import { useEffect, useRef, useState } from "react";
import { BUS_EVENTS, bus } from "./bus";
import type { AgentDecidedEvt, AgentThinkingEvt } from "./types";

interface Row {
  agentId: string;
  label: string;
  visible: string;
  phase: "thinking" | "decided";
  updatedAt: number;
}

const MAX_CHARS = 220;
const REVEAL_CHARS_PER_SEC = 32;
const TICK_MS = 120;
const DECIDED_LINGER_MS = 6000;

function displayLabel(agentId: string): string {
  if (agentId === "director") return "Director";
  if (agentId.startsWith("npc:")) {
    return agentId
      .slice(4)
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return agentId;
}

interface AgentStream {
  label: string;
  pending: string;
  visible: string;
  phase: "thinking" | "decided";
  decidedAt: number | null;
  updatedAt: number;
}

export function ThinkingTicker(): JSX.Element | null {
  const streams = useRef<Map<string, AgentStream>>(new Map());
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const onDelta = (evt: AgentThinkingEvt) => {
      if (!evt.delta) return;
      const s = streams.current.get(evt.agentId) ?? {
        label: displayLabel(evt.agentId),
        pending: "",
        visible: "",
        phase: "thinking" as const,
        decidedAt: null,
        updatedAt: Date.now(),
      };
      if (s.phase === "decided") {
        s.visible = "";
        s.pending = "";
        s.decidedAt = null;
      }
      s.pending += evt.delta;
      s.phase = "thinking";
      s.updatedAt = Date.now();
      streams.current.set(evt.agentId, s);
    };
    const onDecided = (evt: AgentDecidedEvt) => {
      const a = evt.action;
      const brief = a ? `${a.type}${a.text ? ` — ${a.text}` : ""}` : "idle";
      const s = streams.current.get(evt.agentId) ?? {
        label: displayLabel(evt.agentId),
        pending: "",
        visible: "",
        phase: "decided" as const,
        decidedAt: null,
        updatedAt: Date.now(),
      };
      s.pending = "";
      s.visible = brief.slice(-MAX_CHARS);
      s.phase = "decided";
      s.decidedAt = Date.now();
      s.updatedAt = Date.now();
      streams.current.set(evt.agentId, s);
    };
    bus.on(BUS_EVENTS.agentThinking, onDelta);
    bus.on(BUS_EVENTS.agentDecided, onDecided);

    const perTickChars = Math.max(
      1,
      Math.ceil((REVEAL_CHARS_PER_SEC * TICK_MS) / 1000),
    );

    const interval = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, s] of streams.current) {
        if (s.phase === "thinking" && s.pending.length > 0) {
          const take = s.pending.slice(0, perTickChars);
          s.pending = s.pending.slice(perTickChars);
          s.visible = (s.visible + take).slice(-MAX_CHARS);
          s.updatedAt = now;
          changed = true;
        }
        if (
          s.phase === "decided" &&
          s.decidedAt !== null &&
          now - s.decidedAt > DECIDED_LINGER_MS
        ) {
          streams.current.delete(id);
          changed = true;
        }
      }
      if (!changed) return;
      const next: Row[] = [];
      for (const [id, s] of streams.current) {
        next.push({
          agentId: id,
          label: s.label,
          visible: s.visible,
          phase: s.phase,
          updatedAt: s.updatedAt,
        });
      }
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      setRows(next);
    }, TICK_MS);

    return () => {
      bus.off(BUS_EVENTS.agentThinking, onDelta);
      bus.off(BUS_EVENTS.agentDecided, onDecided);
      window.clearInterval(interval);
    };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div className="rp-thinking-ticker" aria-hidden="true">
      {rows.map((row) => (
        <div
          key={row.agentId}
          className={`rp-thinking-row rp-thinking-row--${row.phase}`}
        >
          <span className="rp-thinking-label">{row.label}</span>
          <span className="rp-thinking-text">
            {row.phase === "thinking" && (
              <span className="rp-thinking-dot" aria-hidden="true" />
            )}
            {row.visible || (row.phase === "thinking" ? "…" : "")}
          </span>
        </div>
      ))}
    </div>
  );
}
