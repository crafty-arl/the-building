import { useEffect, useState } from "react";
import {
  isAuthenticated,
  validateSession,
  register,
  login,
} from "./auth";

interface Props {
  children: React.ReactNode;
  onAuthenticated: () => void;
}

export function AuthGate({ children, onAuthenticated }: Props) {
  const [state, setState] = useState<
    "checking" | "unauthenticated" | "authenticated" | "registering" | "logging-in"
  >("checking");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!isAuthenticated()) {
      setState("unauthenticated");
      return;
    }
    void validateSession().then((valid) => {
      if (valid) {
        setState("authenticated");
        onAuthenticated();
      } else {
        setState("unauthenticated");
      }
    });
  }, []);

  if (state === "checking") {
    return (
      <div className="rp-auth">
        <div className="rp-auth-bg" />
        <div className="rp-auth-card">
          <div className="rp-auth-loading">CHECKING SESSION…</div>
        </div>
      </div>
    );
  }

  if (state === "authenticated") return <>{children}</>;

  const onRegister = async () => {
    setState("registering");
    setError(null);
    const result = await register(name.trim() || undefined);
    if (result.ok) {
      setState("authenticated");
      onAuthenticated();
    } else {
      setError(result.error ?? "registration failed");
      setState("unauthenticated");
    }
  };

  const onLogin = async () => {
    setState("logging-in");
    setError(null);
    const result = await login();
    if (result.ok) {
      setState("authenticated");
      onAuthenticated();
    } else {
      setError(result.error ?? "login failed");
      setState("unauthenticated");
    }
  };

  const busy = state === "registering" || state === "logging-in";

  return (
    <div className="rp-auth">
      <div className="rp-auth-bg" />
      <div className="rp-auth-card">
        <h1 className="rp-auth-title">AUGUR</h1>
        <p className="rp-auth-sub">a building of small stories</p>

        <div className="rp-auth-field">
          <label className="rp-auth-label" htmlFor="rp-auth-name">
            YOUR NAME (OPTIONAL)
          </label>
          <input
            id="rp-auth-name"
            type="text"
            className="rp-auth-input"
            placeholder="Augur Player"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="rp-auth-btn rp-auth-btn-primary"
            onClick={onRegister}
            disabled={busy}
          >
            {state === "registering" ? "REGISTERING…" : "REGISTER THIS DEVICE"}
          </button>
        </div>

        <div className="rp-auth-divider"><span>OR</span></div>

        <button
          type="button"
          className="rp-auth-btn rp-auth-btn-secondary"
          onClick={onLogin}
          disabled={busy}
        >
          {state === "logging-in" ? "SIGNING IN…" : "SIGN IN WITH PASSKEY"}
        </button>

        {error && <p className="rp-auth-error">{error}</p>}

        <p className="rp-auth-note">
          Your device becomes your key. No passwords. Your building syncs across every device you add.
        </p>
      </div>
    </div>
  );
}
