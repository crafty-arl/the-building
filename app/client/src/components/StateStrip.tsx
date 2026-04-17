import { useMemo } from "react";
import { useAugur, activeBranch } from "../state";

/**
 * State strip (frame `E2S2v`). Footsteps pips + vow + fact on the left;
 * objective + turn counter on the right.
 *
 * TODO(proxy): objective is a pack-scoped field that the protocol doesn't
 * carry yet. Hardcoded until scene packs land.
 */
const MAX_PIPS = 8;
const MAX_TURNS = 8;

export function StateStrip() {
  const footsteps = useAugur((s) => s.footsteps);
  const vows = useAugur((s) => s.tree.vows);
  const facts = useAugur((s) => s.tree.facts);
  const tree = useAugur((s) => s.tree);
  const dailyPlan = useAugur((s) => s.dailyPlan);

  const branch = useMemo(
    () => activeBranch(tree.entries, tree.leafId),
    [tree.entries, tree.leafId],
  );
  const turn = branch.length;

  const pips = useMemo(() => {
    const available = Math.max(0, Math.min(MAX_PIPS, footsteps));
    return Array.from({ length: MAX_PIPS }, (_, i) => i < available);
  }, [footsteps]);

  const firstVow = vows[0];
  const firstFactEntry = Object.entries(facts)[0];

  const objective = dailyPlan?.playerObjective ?? "—";

  return (
    <section className="statestrip" aria-label="Scene state">
      <div className="hud-left">
        <div className="hud-group" aria-label="Footsteps remaining">
          <span className="hud-label">Footsteps</span>
          <span className="pips-wrap">
            {pips.map((filled, i) => (
              <span
                key={i}
                className={"pip " + (filled ? "filled" : "spent")}
                aria-hidden
              />
            ))}
          </span>
          <span className="pips-count">
            {Math.max(0, Math.min(MAX_PIPS, footsteps))} / {MAX_PIPS}
          </span>
        </div>

        {firstVow && (
          <>
            <span className="hud-divider" aria-hidden />
            <div className="hud-group">
              <span className="vow-seal" aria-hidden>{"\u25C9"}</span>
              <span className="vow-text">{firstVow}</span>
            </div>
          </>
        )}

        {firstFactEntry && (
          <>
            <span className="hud-divider" aria-hidden />
            <div className="hud-group">
              <span className="fact-seal" aria-hidden>{"\u2726"}</span>
              <span className="fact-text">
                {firstFactEntry[0]} · {firstFactEntry[1]}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="hud-right">
        <span className="hud-label">Objective</span>
        <span className="objective-text">{objective}</span>
        <span className="hud-divider" aria-hidden />
        <span className="hud-label">Turn</span>
        <span className="turn-value">
          {turn} / {MAX_TURNS}
        </span>
      </div>
    </section>
  );
}
