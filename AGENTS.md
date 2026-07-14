# AGENTS.md

rork-local is a localhost Rork-style app preview: a live iOS Simulator stream in
the browser (via [serve-sim](https://github.com/EvanBacon/serve-sim)) plus
one-click TestFlight / App Store publishing and screenshot tooling (via the
[asc](https://github.com/rudrankriyam/App-Store-Connect-CLI) CLI). Users run
`npx rork-local` from their app project and get the UI at `http://localhost:3131`.

## Conventions

- Prefer kebab-case for all TS/JS files.
- Only support maintained Node.js LTS releases (currently Node 20+).
- The published `dist/` artifacts must run on plain Node — Bun is a dev/build
  tool only, never a runtime requirement for `npx rork-local` users.
- No interactive prompts in the server; everything the UI does must also be
  reachable through the plain HTTP API.
- The browser UI (`public/`) is served as static assets with no bundler or
  build step. Keep it vanilla HTML/CSS/JS.

## Build and dev

```sh
bun install
bun run dev        # run src/cli.ts directly under Bun (port 3131)
bun run build      # bun build → dist/ (node target) + tsc declarations
bun run typecheck  # tsc --noEmit
bun start          # node dist/cli.js (runs the built output)
```

- Server code lives in `src/` (`server.ts` HTTP wiring, `detect.ts` project
  auto-detection, `jobs.ts` asc job runner + SSE, `screenshots.ts`, `sim.ts`
  simulator bootstrap, `config.ts`, `types.ts` shared API payload types).
- The published bin points straight at `dist/cli.js` (shebang preserved by
  `bun build`); rebuild before testing server changes through the bin.
- Static asset changes under `public/` need no server restart.
- The dev server typically runs under pm2 (`npx pm2 restart rork-local
--update-env` from the project dir). serve-sim's native helper occasionally
  segfaults right after startup; pm2 absorbs it — retry once if a bare start
  dies within seconds.
- `asc` resolution: `ASC_BIN` env > `PATH`. Set `ASC_BIN=/path/to/asc` when the
  CLI is not installed globally.

## E2E testing via the HTTP API

Everything the UI does is drivable with `curl` against a running server. The
endpoint reference lives in [`skills/rork-local/SKILL.md`](skills/rork-local/SKILL.md)
— that skill is the agent-facing API contract; read it instead of guessing
routes. The smoke-test script in `.codex/skills/rork-local-dev` exercises the
essentials after a server change.

Live App Store Connect calls need `asc auth login` (API key) and, for app
creation, `asc web auth login`. Prefer read-only calls when verifying; never
publish to a real app without explicit user intent.

## Keeping the skill honest

`skills/rork-local/SKILL.md` documents the CLI + HTTP surface for coding
agents. When you change an endpoint, flag, or response shape, update the skill
in the same change.
