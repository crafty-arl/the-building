import { useEffect, useRef, useState } from "react";
import { BUS_EVENTS, bus } from "./bus";
import type { AgentDecidedEvt } from "./types";

interface NarrationLine {
  id: number;
  kind: string;
  fullText: string;
  shown: string;
  enqueuedAt: number;
  completedAt: number | null;
}

const HOLD_AFTER_COMPLETE_MS = 8000;
const REVEAL_CHARS_PER_SEC = 28;
const TICK_MS = 80;

export function DirectorNarration(): JSX.Element | null {
  const queue = useRef<NarrationLine[]>([]);
  const nextId = useRef(1);
  const [visible, setVisible] = useState<NarrationLine[]>([]);

  useEffect(() => {
    const onDecided = (evt: AgentDecidedEvt) => {
      if (evt.agentId !== "director") return;
      const text = evt.action?.text?.trim();
      if (!text) return;
      const kind = evt.action?.type ?? "beat";
      queue.current.push({
        id: nextId.current++,
        kind,
        fullText: text,
        shown: "",
        enqueuedAt: Date.now(),
        completedAt: null,
      });
    };
    bus.on(BUS_EVENTS.agentDecided, onDecided);

    const perTickChars = Math.max(
      1,
      Math.ceil((REVEAL_CHARS_PER_SEC * TICK_MS) / 1000),
    );

    const interval = window.setInterval(() => {
      const now = Date.now();
      const active = queue.current[0];
      let changed = false;
      if (active) {
        if (active.shown.length < active.fullText.length) {
          active.shown = active.fullText.slice(
            0,
            active.shown.length + perTickChars,
          );
          if (active.shown.length >= active.fullText.length) {
            active.completedAt = now;
          }
          changed = true;
        } else if (
          active.completedAt !== null &&
          now - active.completedAt > HOLD_AFTER_COMPLETE_MS
        ) {
          queue.current.shift();
          changed = true;
        }
      }
      if (changed) {
        setVisible(active ? [{ ...active }] : []);
      } else if (!active && visible.length > 0) {
        setVisible([]);
      }
    }, TICK_MS);

    return () => {
      bus.off(BUS_EVENTS.agentDecided, onDecided);
      window.clearInterval(interval);
    };
  }, []);

  if (visible.length === 0) return null;
  return (
    <div className="rp-director-narration" aria-live="polite">
      {visible.map((l) => (
        <div
          key={l.id}
          className={`rp-director-line rp-director-line--${l.kind}`}
        >
          <span className="rp-director-kind">{l.kind}</span>
          <span className="rp-director-text">
            {l.shown}
            {l.completedAt === null && (
              <span className="rp-director-caret" aria-hidden="true">
                ▍
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
