import type { ClientMessage, ServerMessage } from "../../../shared/protocol";

type Listener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "kicked";

export interface WSClient {
  connect(): void;
  send(msg: ClientMessage): void;
  onMessage(cb: Listener): () => void;
  onStatus(cb: StatusListener): () => void;
  close(): void;
}

interface Options {
  /** Override URL builder. Default uses location + /api/session?userId=dev-user. */
  url?: () => string;
}

const DEFAULT_USER = "dev-user";

function defaultUrl(): string {
  // TODO: replace `dev-user` with PassKey-derived id once auth lands.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/session?userId=${encodeURIComponent(DEFAULT_USER)}`;
}

export function createWSClient(opts: Options = {}): WSClient {
  const buildUrl = opts.url ?? defaultUrl;
  const listeners = new Set<Listener>();
  const statusListeners = new Set<StatusListener>();
  let ws: WebSocket | null = null;
  let kicked = false;
  let manuallyClosed = false;
  let backoffMs = 500;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(s: ConnectionStatus) {
    for (const l of statusListeners) l(s);
  }

  function scheduleReconnect() {
    if (kicked || manuallyClosed) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 15_000);
  }

  function open() {
    setStatus("connecting");
    try {
      ws = new WebSocket(buildUrl());
    } catch (err) {
      console.warn("[ws] construct failed", err);
      setStatus("disconnected");
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      backoffMs = 500;
      setStatus("connected");
    });
    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch (err) {
        console.warn("[ws] bad frame", err, ev.data);
        return;
      }
      if (msg.type === "kicked") {
        kicked = true;
        setStatus("kicked");
      }
      for (const l of listeners) l(msg);
    });
    ws.addEventListener("close", () => {
      if (kicked) {
        setStatus("kicked");
        return;
      }
      setStatus("disconnected");
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close handler will run after this; just log.
      console.warn("[ws] error");
    });
  }

  return {
    connect() {
      manuallyClosed = false;
      kicked = false;
      open();
    },
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[ws] send while not open; dropping", msg);
        return;
      }
      ws.send(JSON.stringify(msg));
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    close() {
      manuallyClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
  };
}
