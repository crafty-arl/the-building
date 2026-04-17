import { useEffect } from "react";
import { useAugur } from "../state";

export function SoftWarningBanner() {
  const softWarningMs = useAugur((s) => s.softWarningMs);
  const dismiss = useAugur((s) => s.dismissSoftWarning);

  useEffect(() => {
    if (softWarningMs == null) return;
    const t = setTimeout(dismiss, 20_000);
    return () => clearTimeout(t);
  }, [softWarningMs, dismiss]);

  if (softWarningMs == null) return null;
  const minutes = Math.max(1, Math.round(softWarningMs / 60_000));
  return (
    <div className="soft-warning-banner" role="status">
      About {minutes} minute{minutes === 1 ? "" : "s"} left in this run.
      <button type="button" onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
