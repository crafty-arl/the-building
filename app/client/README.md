# Augur — client

Vite + React + TypeScript UI for Augur. Talks to the Cloudflare Worker / Hearth
Durable Object over WebSocket using the contract in `app/shared/protocol.ts`.

## Run

```bash
cd app/client
npm install     # or pnpm install
npm run dev     # http://localhost:5173
```

The dev server proxies `/api` (including the `/api/session` WebSocket upgrade)
to `http://localhost:8788`, the default port for `wrangler pages dev` /
`wrangler dev`. Start the worker in another terminal:

```bash
cd app/worker
wrangler dev
```

The client connects to `ws(s)://<host>/api/session?userId=dev-user`. The
`dev-user` query parameter is a temporary stub; PassKey-derived identity
replaces it once auth lands.

## Layout of this package

```
src/
  App.tsx               three-column layout, top bar, kicked overlay
  main.tsx              React entry
  state.ts              Zustand store; reduces ServerMessage → UI state
  styles.css            single dark, serif stylesheet
  lib/
    ws.ts               typed WS client w/ backoff reconnect (stops on kicked)
    glyphs.ts           seam → glyph mapping (mechanic ids never rendered)
  components/
    Scene.tsx           location, time-of-day, moods, streaming prose
    Timeline.tsx        tree entries; active path bright, off-path greyed
    Hand.tsx            cards (fiction + effect + footstep cost only)
    Footsteps.tsx       counter in top bar
    ConnectionDot.tsx   connection status indicator
    ExportButton.tsx    always-visible (currently disabled) per Principle 7
    KickedScreen.tsx    full-screen takeover for ServerKicked
```

## Three-Layer rule (Principle 1)

The card UI renders `card.fiction`, `card.effect`, `card.footsteps`, and a
rarity badge. It never renders `card.mechanic`. The Timeline maps the seam
family (`time.*`, `mind.*`, …) to a glyph; the raw mechanic id never reaches
the DOM.

## Out of scope (left as TODOs in code)

Wards panel · Memory panel · Momentum meter · Mind stance icon · Reasoning
trace pane · Multi-scene navigation · Keepsake minting animation · Tree
animations (leaf-moves, candle-softens) · PassKey auth · Real Export pipeline.
