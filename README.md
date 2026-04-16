# The Building

An open-source narrative game. Small pixel rooms, directed by an AI, stacked into a building of stories that carries its cast and its ghosts forward.

Built and maintained by **Carl Lewis** ([@craftthefuture](https://github.com/craftthefuture)).

Play it live: **https://augur-prototype.pages.dev**

---

## What it is

You prompt a room into being, pick a hand of ingredient cards, and watch two characters live out a small story on a tiny canvas. When the floor spends itself, it seals — the survivors carry up to the next floor; the ones who fell are remembered. Your building grows, floor by floor, cast by cast, epitaph by epitaph.

No accounts beyond a device passkey. No ads. No gacha. Just a small AI-directed theater you keep returning to.

## For players

Open the live site. Register a passkey on your device — that's the whole onboarding. Your building syncs across every device you add to the same passkey. Pick ingredients, ignite a floor, see what happens. Share a floor's URL to show someone a diorama you prompted.

## For tinkerers

**Fork it.** Run it. Make your building a different thing. Themes, voices, ingredient packs, art direction — all of it is open. I'd genuinely love to see the forks.

Two hard rules, enforced by the license (AGPL-3.0):

1. If you host a public version — paid or free — you must publish your source.
2. You can't take this codebase and turn it into a closed paid service.

Everything else is fair game. Change the aesthetic. Change the director's voice. Replace the AI. Make it about something completely different. The codebase is the point.

## Running locally

This is a monorepo:

- `prototype-ui/` — React + Vite + Canvas client, deploys to Cloudflare Pages
- `app/worker/` — Cloudflare Worker + D1, handles LLM calls, auth, cross-device sync

```bash
# client
cd prototype-ui
npm install
npm run dev

# worker (separate terminal)
cd app/worker
npm install
npx wrangler dev
```

You'll need a Cloudflare account with Workers AI enabled and a D1 database for auth/sync. See `app/worker/schema.sql` for the D1 schema.

## CI/CD

Every push to `main` deploys:
- Client → Cloudflare Pages (project: `augur-prototype`)
- Worker → Cloudflare Workers (name: `augur`)

See `.github/workflows/deploy.yml`.

## License

**AGPL-3.0** — see [`LICENSE`](./LICENSE).

## Credits

Designed and built by Carl Lewis. AI direction via Cloudflare Workers AI.
