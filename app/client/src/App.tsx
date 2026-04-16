import { useEffect, useMemo, useState } from "react";
import { useAugur } from "./state";
import { createWSClient, type ConnectionStatus } from "./lib/ws";
import { TopBar } from "./components/TopBar";
import { ClawRail } from "./components/ClawRail";
import { ReadingPane } from "./components/ReadingPane";
import { StateStrip } from "./components/StateStrip";
import { DMBar } from "./components/DMBar";
import { ClawHandDrawer } from "./components/ClawHandDrawer";
import { KickedScreen } from "./components/KickedScreen";

/**
 * Fiction Reactor — the DM is watching. Grid:
 *   56px  top bar
 *   1px   rule
 *   1fr   body (claw rail + main prose)
 *   1px   rule
 *   56px  state strip
 *   1px   rule
 *   64px  dm bar
 *
 * Claw's hand drawer opens on top of everything. TODOs tracked inline in
 * the components — objective/pack name/day counter are hardcoded proxies.
 */
export function App() {
  const apply = useAugur((s) => s.applyServer);
  const kicked = useAugur((s) => s.kicked);
  const errorMessage = useAugur((s) => s.errorMessage);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  const ws = useMemo(() => createWSClient(), []);

  useEffect(() => {
    const offMsg = ws.onMessage(apply);
    const offStatus = ws.onStatus(setStatus);
    ws.connect();
    return () => {
      offMsg();
      offStatus();
      ws.close();
    };
  }, [ws, apply]);

  return (
    <div className="reactor">
      <TopBar status={status} />
      <div className="rule-row" aria-hidden />
      <div className="body">
        <ClawRail />
        <ReadingPane />
      </div>
      <div className="rule-row" aria-hidden />
      <StateStrip />
      <div className="rule-row" aria-hidden />
      <DMBar />
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      <ClawHandDrawer
        onPlay={(cardId) => ws.send({ type: "play", cardId })}
      />
      {kicked && <KickedScreen />}
    </div>
  );
}
