import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { simMiddleware } from "serve-sim/middleware";

import { ASC_BIN, HOST, PKG_DIR, PORT, getProjectDir, loadConfig, setProjectDir } from "./config.js";
import { mergedDetection, refreshDetection, warmDetection } from "./detect.js";
import {
  attachSseClient, cancelJob, isJobRunning, jobStatus, startAscJob, startPublish,
} from "./jobs.js";
import {
  FRAMED_DIR, FRAME_DEVICES, LISTING_DIR, RAW_DIR, SHOTS_DIR, SLIDE_DEVICE_SIZES,
  captureScreenshot, frameScreenshot, listShots, normalizeShotName, readDeck, sanitizeShotName, saveSlide, writeDeck,
} from "./screenshots.js";
import { ensureBootedSimulator, listSimulators, startServeSimHelper } from "./sim.js";
import { errorMessage, errorStderr, type AuthCheck, type PublishBody, type StatusResponse } from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
// Editor slides arrive as base64 PNGs at App Store resolution (a few MB each).
app.use(express.json({ limit: "40mb" }));

const sim = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
app.use(sim);

app.use(express.static(path.join(PKG_DIR, "public")));

app.get("/api/status", async (_req, res) => {
  let device = null;
  try {
    const devices = await listSimulators();
    device = devices.find((d) => d.state === "Booted") || null;
  } catch {
    /* simctl unavailable */
  }
  let ascVersion: string | null = null;
  if (ASC_BIN) {
    try {
      const { stdout } = await execFileP(ASC_BIN, ["--version"]);
      ascVersion = stdout.trim();
    } catch {
      /* ignore */
    }
  }
  await refreshDetection().catch(() => {});
  const body: StatusResponse = {
    device: device ? { name: device.name, udid: device.udid, runtime: device.runtime } : null,
    asc: { bin: ASC_BIN, version: ascVersion },
    config: loadConfig(),
    detected: mergedDetection(),
    job: jobStatus(),
  };
  res.json(body);
});

app.post("/api/config/detect", async (_req, res) => {
  try {
    const { detected, bundleId, notes } = await refreshDetection({ force: true });
    res.json({ detected, bundleId, notes, projectDir: getProjectDir(), merged: mergedDetection() });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

app.post("/api/config/project", async (req, res) => {
  const dir = String((req.body as { dir?: string } | undefined)?.dir || "").trim();
  if (!dir) {
    res.status(400).json({ error: "Project directory is required" });
    return;
  }
  try {
    setProjectDir(dir);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
    return;
  }
  await refreshDetection({ force: true }).catch(() => {});
  res.json({ ok: true, projectDir: getProjectDir(), detected: mergedDetection() });
});

async function apiKeyAuthStatus(): Promise<AuthCheck> {
  try {
    const { stdout } = await execFileP(ASC_BIN!, ["auth", "status", "--output", "json"], { timeout: 15000 });
    const status = JSON.parse(stdout) as {
      credentials?: unknown[];
      environmentCredentialsComplete?: boolean;
    };
    const hasCredentials =
      (Array.isArray(status.credentials) && status.credentials.length > 0) ||
      status.environmentCredentialsComplete === true;
    return {
      ok: hasCredentials,
      detail: hasCredentials ? "" : "No stored credentials. Run `asc auth login` to add an API key.",
    };
  } catch (err) {
    return { ok: false, detail: (errorStderr(err) || errorMessage(err)).split("\n")[0] };
  }
}

async function webAuthStatus(): Promise<AuthCheck> {
  try {
    const { stdout } = await execFileP(ASC_BIN!, ["web", "auth", "status", "--output", "json"], { timeout: 20000 });
    const status = JSON.parse(stdout) as { authenticated?: boolean };
    return {
      ok: status.authenticated === true,
      detail: status.authenticated ? "" : "No cached web session. Run `asc web auth login`.",
    };
  } catch (err) {
    return { ok: false, detail: (errorStderr(err) || errorMessage(err)).split("\n")[0] };
  }
}

app.get("/api/auth", async (_req, res) => {
  if (!ASC_BIN) {
    const missing: AuthCheck = { ok: false, detail: "asc binary not found" };
    res.json({ ...missing, apiKey: missing, web: missing });
    return;
  }
  const [apiKey, web] = await Promise.all([apiKeyAuthStatus(), webAuthStatus()]);
  // Top-level ok/detail mirror the API-key check for older clients.
  res.json({ ok: apiKey.ok, detail: apiKey.detail, apiKey, web });
});

// First-publish flow: create the App Store Connect app via a cached web
// session. Relies on `asc web auth login` having been run beforehand; without
// a session asc fails fast (stdin is not a TTY, so it cannot prompt).
app.post("/api/apps/create", (req, res) => {
  if (!ASC_BIN) {
    res.status(500).json({ error: "asc binary not found" });
    return;
  }
  if (isJobRunning()) {
    res.status(409).json({ error: "Another job is already running" });
    return;
  }
  const { name, bundleId, sku } = (req.body ?? {}) as { name?: string; bundleId?: string; sku?: string };
  if (!name) {
    res.status(400).json({ error: "App name is required" });
    return;
  }
  if (!bundleId) {
    res.status(400).json({ error: "Bundle ID is required" });
    return;
  }
  if (!sku) {
    res.status(400).json({ error: "SKU is required" });
    return;
  }
  const args = [
    "web", "apps", "create",
    "--name", name,
    "--bundle-id", bundleId,
    "--sku", sku,
    "--output", "json",
  ];
  startAscJob("app-create", args, "App created.");
  res.json({ ok: true, job: jobStatus() });
});

// -- screenshots --

app.use("/shots/raw", express.static(RAW_DIR));
app.use("/shots/framed", express.static(FRAMED_DIR));
app.use("/shots/listing", express.static(LISTING_DIR));

app.get("/api/screenshots", (_req, res) => {
  res.json({
    raw: listShots(RAW_DIR),
    framed: listShots(FRAMED_DIR),
    listing: listShots(LISTING_DIR),
    frameDevices: FRAME_DEVICES,
    slideSizes: SLIDE_DEVICE_SIZES,
  });
});

app.post("/api/screenshots/capture", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { name?: string };
    const shot = await captureScreenshot(body.name || `shot-${Date.now()}`);
    res.json({ ok: true, shot });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err).split("\n")[0] });
  }
});

app.post("/api/screenshots/frame", async (req, res) => {
  const { name, device = "iphone-air", title } = (req.body ?? {}) as {
    name?: unknown;
    device?: unknown;
    title?: unknown;
  };
  const normalizedName = typeof name === "string" ? normalizeShotName(name.trim()) : "";
  if (!normalizedName) {
    // Without this, sanitizeShotName falls back to a generated shot-<ts> name
    // and the caller gets a baffling "raw screenshot not found: shot-…" 500.
    res.status(400).json({ error: "name is required (a raw screenshot's name)" });
    return;
  }
  if (typeof device !== "string" || !FRAME_DEVICES.includes(device)) {
    res.status(400).json({ error: `device must be one of: ${FRAME_DEVICES.join(", ")}` });
    return;
  }
  if (title !== undefined && typeof title !== "string") {
    res.status(400).json({ error: "title must be a string" });
    return;
  }
  if (!ASC_BIN) {
    res.status(500).json({ error: "asc binary not found" });
    return;
  }
  try {
    const result = await frameScreenshot(normalizedName, device, title);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err).split("\n").slice(0, 3).join(" ") });
  }
});

app.delete("/api/screenshots/:kind/:name", (req, res) => {
  const { kind, name } = req.params;
  const dir = kind === "framed" ? FRAMED_DIR : kind === "listing" ? LISTING_DIR : RAW_DIR;
  const file = path.join(dir, `${sanitizeShotName(name)}.png`);
  if (existsSync(file)) unlinkSync(file);
  res.json({ ok: true });
});

// -- screenshot editor (slides) --

// Save one editor-exported slide PNG into the listing dir. Dimensions are
// validated against the device type so the App Store upload won't reject it.
app.post("/api/screenshots/slide", (req, res) => {
  const { name, png, deviceType = "IPHONE_65" } = (req.body ?? {}) as {
    name?: string;
    png?: string;
    deviceType?: string;
  };
  if (!png) {
    res.status(400).json({ error: "png (base64) is required" });
    return;
  }
  try {
    const slide = saveSlide(name || `slide-${Date.now()}`, png, deviceType);
    res.json({ ok: true, slide });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.get("/api/screenshots/deck", (_req, res) => {
  res.json({ deck: readDeck() });
});

app.put("/api/screenshots/deck", (req, res) => {
  const body = (req.body ?? {}) as { deviceType?: string; selected?: number; slides?: unknown[] };
  if (!Array.isArray(body.slides)) {
    res.status(400).json({ error: "slides array is required" });
    return;
  }
  writeDeck({
    deviceType: String(body.deviceType || "IPHONE_65"),
    selected: typeof body.selected === "number" ? body.selected : 0,
    slides: body.slides,
  });
  res.json({ ok: true });
});

app.post("/api/screenshots/upload", (req, res) => {
  if (!ASC_BIN) {
    res.status(500).json({ error: "asc binary not found" });
    return;
  }
  if (isJobRunning()) {
    res.status(409).json({ error: "Another job is already running" });
    return;
  }
  const {
    appId, version, deviceType = "IPHONE_65", source = "framed", locale = "en-US",
  } = (req.body ?? {}) as {
    appId?: string;
    version?: string;
    deviceType?: string;
    source?: string;
    locale?: string;
  };
  if (!appId) {
    res.status(400).json({ error: "App Store Connect app ID is required" });
    return;
  }
  if (!version) {
    res.status(400).json({ error: "App Store version is required" });
    return;
  }
  const dir = source === "raw" ? RAW_DIR : source === "listing" ? LISTING_DIR : FRAMED_DIR;
  const shots = listShots(dir);
  if (shots.length === 0) {
    res.status(400).json({ error: `No ${source} screenshots to upload` });
    return;
  }

  // App-scoped fan-out upload expects locale directories under --path.
  const uploadRoot = path.join(SHOTS_DIR, "upload");
  rmSync(uploadRoot, { recursive: true, force: true });
  const localeDir = path.join(uploadRoot, locale);
  mkdirSync(localeDir, { recursive: true });
  for (const shot of shots) copyFileSync(path.join(dir, shot.file), path.join(localeDir, shot.file));

  const args = [
    "screenshots", "upload",
    "--app", appId,
    "--version", version,
    "--path", uploadRoot,
    "--device-type", deviceType,
    "--output", "json", "--pretty",
  ];
  startAscJob("screenshots-upload", args, "Screenshots uploaded.");
  res.json({ ok: true, job: jobStatus() });
});

app.post("/api/publish", (req, res) => {
  if (!ASC_BIN) {
    res.status(500).json({ error: "asc binary not found. Set ASC_BIN or install asc on PATH." });
    return;
  }
  if (isJobRunning()) {
    res.status(409).json({ error: "A publish is already running" });
    return;
  }
  try {
    startPublish((req.body ?? {}) as PublishBody);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
    return;
  }
  res.json({ ok: true, job: jobStatus() });
});

app.post("/api/publish/cancel", (_req, res) => {
  cancelJob();
  res.json({ ok: true });
});

app.get("/api/publish/stream", (req, res) => {
  attachSseClient(res, (cb) => req.on("close", cb));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  if (!ASC_BIN) {
    console.warn("[rork-local] warning: asc binary not found (set ASC_BIN); publish will be disabled");
  } else {
    console.log(`[rork-local] using asc at ${ASC_BIN}`);
  }

  try {
    await ensureBootedSimulator();
  } catch (err) {
    console.warn(`[rork-local] simulator bootstrap failed: ${errorMessage(err)}`);
  }
  await warmDetection();
  await startServeSimHelper();

  const server = app.listen(PORT, HOST, () => {
    // Surface a non-default bind so an env-driven rebind is never silent.
    const bound = HOST === "127.0.0.1" ? "" : `  (listening on ${HOST})`;
    console.log(`\n  Rork Local ready → http://localhost:${PORT}${bound}\n`);
  });
  server.on("upgrade", (req, socket, head) => sim.handleUpgrade(req, socket, head));
}
