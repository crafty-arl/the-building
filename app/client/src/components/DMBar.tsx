import { useAugur } from "../state";

/**
 * DM interjection bar (frame `h3uyI`). Left cluster: Pause, Fork here,
 * Gift a card, Change objective — all stubs for this iteration. Right
 * cluster: "claw is deciding" label + Open Claw's thought (toggles the
 * rail) + "Claw's hand (n)" pill (pragmatic bridge until Claw auto-plays).
 */
export function DMBar() {
  const clawOpen = useAugur((s) => s.clawThoughtOpen);
  const setClawOpen = useAugur((s) => s.setClawThoughtOpen);
  const setHandOpen = useAugur((s) => s.setHandDrawerOpen);
  const hand = useAugur((s) => s.hand);
  const streaming = useAugur((s) => s.streamingTurn);

  const clawStatus = streaming ? "claw is writing" : "claw is deciding";

  return (
    <section className="dmbar" aria-label="DM interjections">
      <div className="dmbar-left">
        <StubButton icon={<PauseIcon />} label="Pause" />
        <StubButton icon={<BranchIcon />} label="Fork here" />
        <StubButton icon={<GiftIcon />} label="Gift a card" />
        <StubButton icon={<TargetIcon />} label="Change objective" />
      </div>
      <div className="dmbar-right">
        <span className="dm-live-label">{clawStatus}</span>
        <button
          className="dm-btn dm-btn-hand"
          type="button"
          onClick={() => setHandOpen(true)}
          title="Show the cards Claw could play next"
        >
          Claw's hand ({hand.length})
        </button>
        <button
          className="dm-btn dm-btn-claw"
          type="button"
          onClick={() => setClawOpen(!clawOpen)}
          aria-pressed={clawOpen}
        >
          <span className="dm-btn-icon"><EyeIcon /></span>
          {clawOpen ? "Hide Claw's thought" : "Open Claw's thought"}
        </button>
      </div>
    </section>
  );
}

function StubButton({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  const onClick = () => {
    console.log(`[dm] stub: ${label}`);
    alert(`${label} — coming soon.`);
  };
  return (
    <button className="dm-btn" type="button" onClick={onClick}>
      <span className="dm-btn-icon">{icon}</span>
      {label}
    </button>
  );
}

// ─── Icons (lucide) ────────────────────────────────────────────────────────

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function PauseIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
