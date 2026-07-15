---
name: rork-local
description: Preview an iOS app in a live simulator tab and publish it to TestFlight or the App Store with rork-local. Use when the user wants to run rork-local, see their app in the browser-based simulator, capture or frame App Store screenshots, or publish a built .ipa via the asc CLI from localhost.
license: Apache-2.0
---

# rork-local

rork-local serves a localhost web UI (default `http://localhost:3131`) with a live iOS
simulator stream (via serve-sim) plus one-click App Store Connect publishing and
screenshot tooling (via the `asc` CLI). Everything the UI does is also exposed as a
plain HTTP API, so you can drive it end to end with `curl`.

## Prerequisites

- macOS with Xcode command line tools (`xcrun simctl`), Node.js 20+.
- The `asc` CLI on `PATH`, or `ASC_BIN=/path/to/asc` in the environment.
- `asc auth login` completed once (publishing and app-ID detection call the
  App Store Connect API). Check with `asc auth status`.
- Optional: `asc web auth login` for creating brand-new App Store Connect apps.
- Optional: `pipx install "koubou==0.18.1"` for screenshot framing.

## Start

Run from the iOS app project's directory (detection scans the cwd):

```sh
npx rork-local            # → http://localhost:3131
PORT=4000 npx rork-local  # custom port
npx rork-local /path/to/app-project  # explicit project dir
```

Startup boots a simulator if none is running, starts the serve-sim helper, and
auto-detects publish config (bundle ID, version, newest .ipa, ASC app ID, beta
groups) from the project. User overrides live in `<project>/rork.config.json`;
mutable state (screenshots) lives in `<project>/.rork-local/`.

The UI at `/` embeds the simulator (`/.sim`), a Publish popover, an App Store
submission wizard, and a Screenshots panel.

## HTTP API

All endpoints are JSON over `http://localhost:3131` (adjust for PORT).

### Status and configuration

```sh
# Booted device, asc binary + version, merged config/detection, current job
curl -s localhost:3131/api/status

# Force a re-scan of the project (picks up freshly built .ipa files)
curl -s -X POST localhost:3131/api/config/detect

# Point detection at a different project directory (persists to rork.config.json)
curl -s -X POST localhost:3131/api/config/project \
  -H 'content-type: application/json' -d '{"dir":"/path/to/app"}'

# Auth health: apiKey = `asc auth` (publishing), web = `asc web auth` (app creation)
curl -s localhost:3131/api/auth

# TestFlight beta groups for an explicit app ID → {"groups":["External Testers",…]}
curl -s "localhost:3131/api/groups?app=6759231657"
```

This endpoint returns `502` with `{ "error": "…" }` when the `asc` lookup
fails, so callers can distinguish an app with no groups from a transient or
authentication failure.

`GET /api/status` → `{ device, asc, config, detected, job }`. `detected.values`
holds the merged autofill (`appId`, `ipa`, `group`, `version`; explicit config
wins over detection), `detected.betaGroups` lists TestFlight groups, and `job`
is the current job status (see below).

### Publishing

One asc job runs at a time (`409` if busy). Job kinds: `publish`,
`screenshots-upload`, `app-create`. Job states: `idle | running | success | error`.

```sh
# TestFlight (group is required for TestFlight)
curl -s -X POST localhost:3131/api/publish \
  -H 'content-type: application/json' \
  -d '{"target":"testflight","appId":"6759231657","ipa":"build/MyApp.ipa","group":"External Testers","wait":true}'

# App Store (optionally submit for review)
curl -s -X POST localhost:3131/api/publish \
  -H 'content-type: application/json' \
  -d '{"target":"appstore","appId":"6759231657","ipa":"build/MyApp.ipa","version":"1.2.0","submit":true}'

# Cancel the running job
curl -s -X POST localhost:3131/api/publish/cancel

# Live logs: SSE stream (events: `status` with JobStatus, `line` with {t,stream,text}).
# Replays buffered lines on connect, so late attachment is fine.
curl -sN localhost:3131/api/publish/stream
```

Poll `GET /api/status` and inspect `.job.state` / `.job.exitCode` if you don't
want to hold the SSE stream open.

### Screenshots

```sh
# List raw, framed, and listing (editor-made) screenshots, the supported frame
# devices, and the valid slide dimensions per App Store device type
curl -s localhost:3131/api/screenshots

# Capture the booted simulator's screen (name optional)
curl -s -X POST localhost:3131/api/screenshots/capture \
  -H 'content-type: application/json' -d '{"name":"home"}'

# Frame a raw capture into a marketing bezel (requires koubou)
curl -s -X POST localhost:3131/api/screenshots/frame \
  -H 'content-type: application/json' \
  -d '{"name":"home","device":"iphone-17-pro","title":"Track everything"}'

# Delete a screenshot (kind: raw | framed | listing)
curl -s -X DELETE localhost:3131/api/screenshots/raw/home

# Upload shots to an App Store version (runs as a job).
# source: framed | raw | listing (slides exported from the screenshot editor)
curl -s -X POST localhost:3131/api/screenshots/upload \
  -H 'content-type: application/json' \
  -d '{"appId":"6759231657","version":"1.2.0","deviceType":"IPHONE_61","source":"framed"}'
```

Image files are served at `/shots/raw/<file>.png`, `/shots/framed/<file>.png`,
and `/shots/listing/<file>.png`.

### Screenshot editor slides

The web UI ships a manual slide editor (screenshots drawer → "Open editor"):
background + headline + device-framed capture composed on a canvas at exact
App Store resolution. Its API surface:

```sh
# Save one exported slide PNG (base64 or data URL) into the listing set.
# The PNG's dimensions must match the device type (see slideSizes in
# GET /api/screenshots) or the request is rejected with 400.
curl -s -X POST localhost:3131/api/screenshots/slide \
  -H 'content-type: application/json' \
  -d "{\"name\":\"slide-01\",\"deviceType\":\"IPHONE_65\",\"png\":\"$(base64 -i slide.png)\"}"

# Read / persist the editor deck state (slides layout JSON; the client owns
# the slide schema — the server just stores it)
curl -s localhost:3131/api/screenshots/deck
curl -s -X PUT localhost:3131/api/screenshots/deck \
  -H 'content-type: application/json' \
  -d '{"deviceType":"IPHONE_65","selected":0,"slides":[]}'
```

Saved slides upload with `POST /api/screenshots/upload` using
`"source":"listing"` and the matching `deviceType`.

### First publish (no App Store Connect app yet)

Requires a cached web session from `asc web auth login`:

```sh
curl -s -X POST localhost:3131/api/apps/create \
  -H 'content-type: application/json' \
  -d '{"name":"My App","bundleId":"com.example.myapp","sku":"MYAPP123"}'
```

Runs as an `app-create` job; on success `job.result.appId` carries the new app ID.

## Tips

- Empty publish fields? Check `detected.notes` in `/api/status` — it explains
  what was (not) found, and `POST /api/config/project` retargets detection.
- The simulator preview at `/.sim` is the embedded serve-sim UI; use the
  serve-sim skill/CLI for taps, gestures, and camera injection.
- `503`/no response right after start: the server boots the simulator first;
  retry after a few seconds.
