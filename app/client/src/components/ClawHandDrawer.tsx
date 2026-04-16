import { useMemo } from "react";
import { useAugur } from "../state";
import { glyphForMechanic } from "../lib/glyphs";
import type { CardWire } from "../../../shared/protocol";

interface Props {
  onPlay: (cardId: string) => void;
}

/**
 * Bottom sheet listing Claw's current CardWire hand as tarot cards. Frame
 * this as "instructing Claw" — it exists only as a pragmatic bridge until
 * the server grows a Claw-agent that auto-plays.
 */
export function ClawHandDrawer({ onPlay }: Props) {
  const open = useAugur((s) => s.handDrawerOpen);
  const setOpen = useAugur((s) => s.setHandDrawerOpen);
  const hand = useAugur((s) => s.hand);
  const entries = useAugur((s) => s.tree.entries);

  const playedIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.card?.id) s.add(e.card.id);
    return s;
  }, [entries]);

  if (!open) return null;

  return (
    <>
      <div
        className="hand-drawer-backdrop"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        className="hand-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Claw's hand"
      >
        <div className="hand-drawer-head">
          <div>
            <div className="hand-drawer-title">What should Claw do next?</div>
            <div className="hand-drawer-sub">
              choose a card to instruct the agent
            </div>
          </div>
          <button
            className="hand-drawer-close"
            type="button"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="hand-row">
          {hand.map((card) => (
            <CardView
              key={card.id}
              card={card}
              playedThisScene={playedIds.has(card.id)}
              onPlay={(id) => {
                onPlay(id);
                setOpen(false);
              }}
            />
          ))}
          {hand.length === 0 && (
            <p className="prose-paragraph muted" style={{ padding: "16px 0" }}>
              No cards in hand.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function CardView({
  card,
  playedThisScene,
  onPlay,
}: {
  card: CardWire;
  playedThisScene: boolean;
  onPlay: (id: string) => void;
}) {
  const spent = !card.playable || playedThisScene;
  const isKeepsake = card.rarity === "keepsake";
  const glyph = glyphForMechanic(card.mechanic);

  const className = [
    "tarot",
    isKeepsake ? "tarot-keepsake" : "",
    spent ? "tarot-spent" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const title = `${card.fiction}\n\n${card.effect}`;

  return (
    <button
      type="button"
      className={className}
      disabled={spent}
      onClick={() => !spent && onPlay(card.id)}
      aria-label={card.fiction}
      title={title}
    >
      <div
        className="tarot-frame"
        aria-hidden
        style={
          isKeepsake
            ? undefined
            : glyph.color
              ? { color: glyph.color }
              : undefined
        }
      >
        <span className="tarot-glyph">{glyph.char}</span>
      </div>
      <div className="tarot-name">{card.fiction}</div>
      <div className="tarot-foot">
        {isKeepsake ? (
          <span className="tarot-keepsake-label">KEEPSAKE</span>
        ) : (
          <span className="tarot-cost">−{card.footsteps}</span>
        )}
      </div>
    </button>
  );
}
