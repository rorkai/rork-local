---
name: rork-local-dev
description: Build, restart, and smoke-test the rork-local server when developing this repo. Use after changing anything under src/, before committing server changes, or when the dev server at localhost:3131 misbehaves.
---

# rork-local Development

Use this project-scoped skill when working on rork-local itself. End-user usage
(driving a running server to publish or capture screenshots) lives in the
public `skills/rork-local` skill; do not add internal dev workflows there.

## Workflow

1. After editing `src/`, rebuild and typecheck:

   ```sh
   bun run build
   ```

   Static `public/` changes need no rebuild or restart.

2. Restart the dev server. It normally runs under pm2:

   ```sh
   npx pm2 restart rork-local --update-env
   ```

   If it isn't registered yet:

   ```sh
   ASC_BIN=/path/to/asc npx pm2 start dist/cli.js --name rork-local
   ```

   serve-sim's native helper occasionally segfaults right after startup; pm2
   restarts it automatically — wait a few seconds before declaring failure.

3. Smoke-test from the repo root:

   ```sh
   sh .codex/skills/rork-local-dev/scripts/smoke.sh          # default port 3131
   PORT=3199 sh .codex/skills/rork-local-dev/scripts/smoke.sh
   ```

   It checks `/`, `/.sim`, `/api/status`, and a screenshot capture/delete
   round-trip. All four must pass before committing server changes.

4. If you changed an endpoint, flag, or response shape, update
   `skills/rork-local/SKILL.md` and the README API table in the same change.
