import { useEffect, useState } from "react";
import type { StoryBible, StoryState } from "../../../app/shared/protocol";
import { BUS_EVENTS, bus } from "./bus";

interface Props {
  storyBible: StoryBible | null;
  storyState: StoryState | null;
}

interface AcceptedFlash {
  text: string;
  at: number;
}

const FLASH_TTL_MS = 6000;

export function ActBanner(props: Props): JSX.Element | null {
  const { storyBible } = props;
  const [liveState, setLiveState] = useState<StoryState | null>(
    props.storyState,
  );
  const [flash, setFlash] = useState<AcceptedFlash | null>(null);

  useEffect(() => {
    setLiveState(props.storyState);
  }, [props.storyState]);

  useEffect(() => {
    const onAdvanced = (s: StoryState) => setLiveState(s);
    const onDirective = (evt: AcceptedFlash) => {
      setFlash(evt);
      window.setTimeout(() => {
        setFlash((cur) => (cur && cur.at === evt.at ? null : cur));
      }, FLASH_TTL_MS);
    };
    bus.on(BUS_EVENTS.storyAdvanced, onAdvanced);
    bus.on(BUS_EVENTS.directiveAccepted, onDirective);
    return () => {
      bus.off(BUS_EVENTS.storyAdvanced, onAdvanced);
      bus.off(BUS_EVENTS.directiveAccepted, onDirective);
    };
  }, []);

  if (!storyBible || !liveState) return null;
  const idx = Math.max(
    0,
    Math.min(liveState.currentActIndex, storyBible.acts.length - 1),
  );
  const act = storyBible.acts[idx];
  if (!act) return null;

  return (
    <div className="rp-act-banner" aria-live="polite">
      <div className="rp-act-banner-head">
        <span className="rp-act-banner-badge">
          Act {idx + 1} / {storyBible.acts.length}
        </span>
        <span className="rp-act-banner-name">{act.name}</span>
      </div>
      <div className="rp-act-banner-pressure">{act.pressure}</div>
      {flash && <div className="rp-act-banner-flash">↑ {flash.text}</div>}
    </div>
  );
}
