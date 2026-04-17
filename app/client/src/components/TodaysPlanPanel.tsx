import { useEffect } from "react";
import { useAugur } from "../state";
import type { NpcDay, ScheduleSlot } from "../../../shared/protocol";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Today's-plan overlay — surfaces the DailyPlan that's already on the wire
 * via `hello`. Shows player objective, day seed, and each NPC's backstory
 * + private motive + 16-hour schedule with the current hour highlighted.
 */
export function TodaysPlanPanel({ open, onClose }: Props) {
  const dailyPlan = useAugur((s) => s.dailyPlan);
  const clock = useAugur((s) => s.clock);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="plan-backdrop" onClick={onClose}>
      <div
        className="plan-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Today's plan"
      >
        <header className="plan-header">
          <div>
            <div className="plan-eyebrow">TODAY</div>
            <h2 className="plan-title">
              {dailyPlan
                ? `${dailyPlan.dayOfWeek} · ${dailyPlan.date}`
                : "—"}
            </h2>
          </div>
          <button
            className="plan-close"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {!dailyPlan ? (
          <div className="plan-empty">No plan yet.</div>
        ) : (
          <div className="plan-body">
            <section className="plan-section">
              <div className="plan-label">Objective</div>
              <p className="plan-objective">{dailyPlan.playerObjective}</p>
            </section>

            <section className="plan-section">
              <div className="plan-label">Seed</div>
              <p className="plan-seed">{dailyPlan.seed}</p>
            </section>

            <section className="plan-section">
              <div className="plan-label">
                Residents · {dailyPlan.npcs.length}
              </div>
              <ul className="plan-npc-list">
                {dailyPlan.npcs.map((npc) => (
                  <NpcCard
                    key={npc.name}
                    npc={npc}
                    currentHour={clock?.gameHour ?? null}
                  />
                ))}
              </ul>
            </section>

            <footer className="plan-footnote">
              Open hours {dailyPlan.openingHour}:00 – {dailyPlan.closingHour}:00
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

interface NpcCardProps {
  npc: NpcDay;
  currentHour: number | null;
}

function NpcCard({ npc, currentHour }: NpcCardProps) {
  const currentSlot = currentHour !== null ? slotForHour(npc, currentHour) : null;
  return (
    <li className={`plan-npc plan-npc-${npc.palette}`}>
      <div className="plan-npc-head">
        <span className="plan-npc-swatch" aria-hidden />
        <h3 className="plan-npc-name">{npc.name}</h3>
        <span className="plan-npc-palette">{npc.palette}</span>
      </div>
      <p className="plan-npc-backstory">{npc.backstory}</p>
      <dl className="plan-npc-fields">
        <div>
          <dt>Objective</dt>
          <dd>{npc.objective}</dd>
        </div>
        <div>
          <dt>Motive</dt>
          <dd>{npc.motive}</dd>
        </div>
        {currentSlot && (
          <div>
            <dt>Right now</dt>
            <dd>
              {currentSlot.activity}
              {currentSlot.mood ? ` · ${currentSlot.mood}` : ""}
            </dd>
          </div>
        )}
      </dl>
      <details className="plan-npc-schedule">
        <summary>Schedule</summary>
        <ol>
          {npc.schedule.map((slot) => (
            <li
              key={slot.hour}
              className={
                currentHour === slot.hour ? "plan-slot plan-slot-now" : "plan-slot"
              }
            >
              <span className="plan-slot-hour">
                {String(slot.hour).padStart(2, "0")}:00
              </span>
              <span className="plan-slot-activity">{slot.activity}</span>
              {slot.mood && (
                <span className="plan-slot-mood">{slot.mood}</span>
              )}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function slotForHour(npc: NpcDay, hour: number): ScheduleSlot | null {
  if (npc.schedule.length === 0) return null;
  let pick: ScheduleSlot | null = null;
  for (const s of npc.schedule) {
    if (s.hour <= hour) pick = s;
    else break;
  }
  return pick ?? npc.schedule[0];
}
