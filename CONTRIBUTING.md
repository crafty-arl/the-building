# Contributing to The Building

Forks, PRs, and issues are all welcome. A few notes to make contributing easier.

## Monorepo layout

- `prototype-ui/` — React + Vite + Canvas client
- `app/worker/` — Cloudflare Worker (LLM proxy, auth, D1 sync)
- `app/worker/schema.sql` — D1 schema
- `docs/` — design notes

## Local setup

```bash
# client
cd prototype-ui
npm install
npm run dev   # http://localhost:5173

# worker
cd app/worker
npm install
npx wrangler dev   # http://localhost:8788
```

You'll need your own Cloudflare account for AI + D1 bindings. The prod deploy targets `augur-prototype` (Pages) and `augur` (Worker); rename both if you're forking.

## Before opening a PR

- `npx tsc --noEmit` passes in both `prototype-ui/` and `app/worker/`
- `npm run build` works for the client
- Keep the literary voice of the game — no emojis in generated content or UI copy unless the user explicitly asks for them

## License

All contributions are licensed under the project's AGPL-3.0 license. By opening a PR you agree your contribution is licensed the same way.

## Filing issues

If you spot a bug, please include:
- What you did
- What you saw
- What you expected
- Device / browser if relevant

If you want to propose a feature or a direction, start a Discussion instead.
