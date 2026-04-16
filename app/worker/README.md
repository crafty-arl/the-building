# Augur Worker (Pages Functions + Hearth DO)

Server side of the Augur web app. A Cloudflare Pages project whose Pages
Functions terminate a WebSocket on `GET /api/session` and route it to a
per-user `Hearth` Durable Object. The DO holds the `SessionTree`, current
scene, footsteps counter, and runs card seams against Cloudflare Workers AI
(Kimi K2.5 + Llama 3.3 70B fp8-fast).

## Layout

```
worker/
  functions/api/session.ts   # Pages Function: WS upgrade + DO routing
  src/hearth.ts              # Hearth Durable Object
  src/seams.ts               # Card mechanic handlers (ported from prototype)
  src/cf-ai.ts               # OpenAI-compat fetch + SSE parser
  src/tree.ts                # SessionTree (port of prototype/src/tree.ts)
  src/cards.ts               # DECK (verbatim port)
  src/scene.ts               # TAVERN (verbatim port)
  src/hand.ts                # derive playable hand from DECK + state
  src/wire.ts                # server state -> wire format projection
  src/messages.ts            # local Message/Usage types (no pi-ai dep)
  wrangler.toml
```

## Run locally

```sh
cd app/worker
npm install
cp .dev.vars.example .dev.vars   # then edit
npm run dev
```

Required env vars (drop into `.dev.vars`):

```
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_KEY=...
```

`wrangler pages dev` serves the functions on http://localhost:8788. Connect
to `ws://localhost:8788/api/session?userId=carl` to open a session.

## Deploy

```sh
wrangler pages deploy ../client/dist
wrangler pages secret put CLOUDFLARE_ACCOUNT_ID
wrangler pages secret put CLOUDFLARE_API_KEY
```

## Notes

- Single connection per user: the DO kicks any prior socket with
  `{type:"kicked", reason:"another-connection"}` before accepting a new one.
- Hibernatable WebSockets via `state.acceptWebSocket(ws)` — idle sessions
  don't burn CPU.
- Tree persists to DO storage on every mutation as the same v1 format the
  prototype uses (`SerializedSession`).
- `sight.scry` currently sends a 1×1 placeholder PNG; node-canvas doesn't run
  in Workers. Real renderer is TODO.
