import { useAugur } from "../state";

const REASON_LABEL: Record<string, string> = {
  time: "Run over",
  footsteps: "No footsteps left",
  schedule: "The day is done",
};

export function RunEndOverlay() {
  const runEnd = useAugur((s) => s.runEnd);
  const dailyPlan = useAugur((s) => s.dailyPlan);
  if (!runEnd) return null;
  return (
    <div className="run-end-overlay" role="dialog" aria-modal>
      <div className="run-end-card">
        <div className="run-end-header">{REASON_LABEL[runEnd.reason] ?? "Run ended"}</div>
        <div className="run-end-epitaph">{runEnd.epitaph}</div>
        {dailyPlan && (
          <div className="run-end-foot">
            Come back tomorrow — a new {dailyPlan.dayOfWeek} is waiting.
          </div>
        )}
      </div>
    </div>
  );
}
