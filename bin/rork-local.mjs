#!/usr/bin/env node
// rork-local CLI entry: run from your app's directory (`npx rork-local`).
// The server detects the project from cwd and keeps mutable state
// (rork.config.json, .rork-local/screenshots) in that directory.
import "../server.mjs";
