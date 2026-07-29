import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { simMiddleware } from "serve-sim/middleware";

import { ASC_BIN, PKG_DIR, PORT, getProjectDir, loadConfig, setProjectDir } from "./config.js";
import { fetchBetaGroups, mergedDetection, refreshDetection, warmDetection } from "./detect.js";
import {
  attachSseClient, cancelJob, isJobRunning, jobStatus, startAscJob, startPublish,
} from "./jobs.js";
import { createRouter, requestPath, sendError, sendJson, serveStatic } from "./http.js";
import {
  FRAME_DEVICES, SLIDE_DEVICE_SIZES, captureScreenshot, frameScreenshot, framedDir,
  listShots, listingDir, rawDir, readDeck, sanitizeShotName, saveSlide, shotsDir, writeDeck,
} from "./screenshots.js";
import { ensureBootedSimulator, listSimulators, startServeSimHelper } from "./sim.js";
import { errorMessage, errorStderr, type AuthCheck, type PublishBody, type StatusResponse } from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// Editor slides arrive as base64 PNGs at App Store resolution (a few MB each).
const router = createRouter({ bodyLimitBytes: 40 * 1024 * 1024 });

const serveSimBrandOverride =
  '<style id="rork-local-serve-sim-overrides">a[aria-label="Open serve-sim"]{display:none!important}</style>';

router.use((req, res, next) => {
  const pathname = requestPath(req);
  if (pathname !== "/.sim" && pathname !== "/.sim/") {
    next();
    return;
  }

  const end = res.end.bind(res);
  res.end = ((
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    let output = chunk;
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      const html = chunk.toString().replace("</head>", `${serveSimBrandOverride}</head>`);
      output = Buffer.isBuffer(chunk) ? Buffer.from(html) : html;
    }

    if (output === undefined) return end();
    if (typeof encoding === "function") return end(output, encoding);
    if (encoding === undefined) return callback ? end(output, callback) : end(output);
    return end(output, encoding, callback);
  }) as typeof res.end;
  next();
});

const sim = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
router.use(sim);

// The shots root follows the (runtime-mutable) project dir, so resolve the
// directory per request instead of binding it once at startup.
const SHOT_DIRS: Array<[string, () => string]> = [
  ["/shots/raw", rawDir],
  ["/shots/framed", framedDir],
  ["/shots/listing", listingDir],
];

router.use((req, res, next) => {
  const pathname = requestPath(req);
  for (const [prefix, dir] of SHOT_DIRS) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (serveStatic(dir(), pathname.slice(prefix.length), req, res)) return;
    sendError(res, 404, "Screenshot not found");
    return;
  }
  next();
});

router.use((req, res, next) => {
  if (serveStatic(path.join(PKG_DIR, "public"), requestPath(req), req, res)) return;
  next();
});

router.get("/api/status", async (_req, res) => {
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
  sendJson(res, 200, body);
});

router.post("/api/config/detect", async (_req, res) => {
  try {
    const { detected, bundleId, notes } = await refreshDetection({ force: true });
    sendJson(res, 200, {
      detected, bundleId, notes, projectDir: getProjectDir(), merged: mergedDetection(),
    });
  } catch (err) {
    sendError(res, 500, errorMessage(err));
  }
});

router.post("/api/config/project", async (_req, res, { body }) => {
  const dir = String((body as { dir?: string } | undefined)?.dir || "").trim();
  if (!dir) {
    sendError(res, 400, "Project directory is required");
    return;
  }
  try {
    setProjectDir(dir);
  } catch (err) {
    sendError(res, 400, errorMessage(err));
    return;
  }
  await refreshDetection({ force: true }).catch(() => {});
  sendJson(res, 200, { ok: true, projectDir: getProjectDir(), detected: mergedDetection() });
});

// Beta groups for an explicit app ID — the wizard calls this when the user
// types an App ID that detection didn't resolve, so TestFlight validation can
// still offer the app's real groups.
router.get("/api/groups", async (_req, res, { query }) => {
  const appId = String(query.get("app") || "").trim();
  if (!appId) {
    sendError(res, 400, "app query parameter is required");
    return;
  }
  if (!ASC_BIN) {
    sendError(res, 500, "asc binary not found");
    return;
  }
  try {
    sendJson(res, 200, { groups: await fetchBetaGroups(appId) });
  } catch (err) {
    sendError(res, 502, errorMessage(err).split("\n")[0] as string);
  }
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
    return { ok: false, detail: (errorStderr(err) || errorMessage(err)).split("\n")[0] as string };
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
    return { ok: false, detail: (errorStderr(err) || errorMessage(err)).split("\n")[0] as string };
  }
}

router.get("/api/auth", async (_req, res) => {
  if (!ASC_BIN) {
    const missing: AuthCheck = { ok: false, detail: "asc binary not found" };
    sendJson(res, 200, { ...missing, apiKey: missing, web: missing });
    return;
  }
  const [apiKey, web] = await Promise.all([apiKeyAuthStatus(), webAuthStatus()]);
  // Top-level ok/detail mirror the API-key check for older clients.
  sendJson(res, 200, { ok: apiKey.ok, detail: apiKey.detail, apiKey, web });
});

// First-publish flow: create the App Store Connect app via a cached web
// session. Relies on `asc web auth login` having been run beforehand; without
// a session asc fails fast (stdin is not a TTY, so it cannot prompt).
router.post("/api/apps/create", (_req, res, { body }) => {
  if (!ASC_BIN) {
    sendError(res, 500, "asc binary not found");
    return;
  }
  if (isJobRunning()) {
    sendError(res, 409, "Another job is already running");
    return;
  }
  const { name, bundleId, sku } = (body ?? {}) as { name?: string; bundleId?: string; sku?: string };
  if (!name) {
    sendError(res, 400, "App name is required");
    return;
  }
  if (!bundleId) {
    sendError(res, 400, "Bundle ID is required");
    return;
  }
  if (!sku) {
    sendError(res, 400, "SKU is required");
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
  sendJson(res, 200, { ok: true, job: jobStatus() });
});

// -- screenshots --

router.get("/api/screenshots", (_req, res) => {
  sendJson(res, 200, {
    raw: listShots(rawDir()),
    framed: listShots(framedDir()),
    listing: listShots(listingDir()),
    frameDevices: FRAME_DEVICES,
    slideSizes: SLIDE_DEVICE_SIZES,
  });
});

router.post("/api/screenshots/capture", async (_req, res, { body }) => {
  try {
    const payload = (body ?? {}) as { name?: string };
    const shot = await captureScreenshot(payload.name || `shot-${Date.now()}`);
    sendJson(res, 200, { ok: true, shot });
  } catch (err) {
    sendError(res, 500, errorMessage(err).split("\n")[0] as string);
  }
});

router.post("/api/screenshots/frame", async (_req, res, { body }) => {
  if (!ASC_BIN) {
    sendError(res, 500, "asc binary not found");
    return;
  }
  const { name, device = "iphone-air", title } = (body ?? {}) as {
    name?: string;
    device?: string;
    title?: string;
  };
  try {
    const result = await frameScreenshot(sanitizeShotName(name), device, title);
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    sendError(res, 500, errorMessage(err).split("\n").slice(0, 3).join(" "));
  }
});

router.delete("/api/screenshots/:kind/:name", (_req, res, { params }) => {
  const { kind, name } = params;
  const dir = kind === "framed" ? framedDir() : kind === "listing" ? listingDir() : rawDir();
  const file = path.join(dir, `${sanitizeShotName(name)}.png`);
  if (existsSync(file)) unlinkSync(file);
  sendJson(res, 200, { ok: true });
});

// -- screenshot editor (slides) --

// Save one editor-exported slide PNG into the listing dir. Dimensions are
// validated against the device type so the App Store upload won't reject it.
router.post("/api/screenshots/slide", (_req, res, { body }) => {
  const { name, png, deviceType = "IPHONE_65" } = (body ?? {}) as {
    name?: string;
    png?: string;
    deviceType?: string;
  };
  if (!png) {
    sendError(res, 400, "png (base64) is required");
    return;
  }
  try {
    const slide = saveSlide(name || `slide-${Date.now()}`, png, deviceType);
    sendJson(res, 200, { ok: true, slide });
  } catch (err) {
    sendError(res, 400, errorMessage(err));
  }
});

router.get("/api/screenshots/deck", (_req, res) => {
  sendJson(res, 200, { deck: readDeck() });
});

router.put("/api/screenshots/deck", (_req, res, { body }) => {
  const payload = (body ?? {}) as { deviceType?: string; selected?: number; slides?: unknown[] };
  if (!Array.isArray(payload.slides)) {
    sendError(res, 400, "slides array is required");
    return;
  }
  writeDeck({
    deviceType: String(payload.deviceType || "IPHONE_65"),
    selected: typeof payload.selected === "number" ? payload.selected : 0,
    slides: payload.slides,
  });
  sendJson(res, 200, { ok: true });
});

router.post("/api/screenshots/upload", (_req, res, { body }) => {
  if (!ASC_BIN) {
    sendError(res, 500, "asc binary not found");
    return;
  }
  if (isJobRunning()) {
    sendError(res, 409, "Another job is already running");
    return;
  }
  const {
    appId, version, deviceType = "IPHONE_65", source = "framed", locale = "en-US",
  } = (body ?? {}) as {
    appId?: string;
    version?: string;
    deviceType?: string;
    source?: string;
    locale?: string;
  };
  if (!appId) {
    sendError(res, 400, "App Store Connect app ID is required");
    return;
  }
  if (!version) {
    sendError(res, 400, "App Store version is required");
    return;
  }
  const dir = source === "raw" ? rawDir() : source === "listing" ? listingDir() : framedDir();
  const shots = listShots(dir);
  if (shots.length === 0) {
    sendError(res, 400, `No ${source} screenshots to upload`);
    return;
  }

  // App-scoped fan-out upload expects locale directories under --path.
  const uploadRoot = path.join(shotsDir(), "upload");
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
  sendJson(res, 200, { ok: true, job: jobStatus() });
});

router.post("/api/publish", (_req, res, { body }) => {
  if (!ASC_BIN) {
    sendError(res, 500, "asc binary not found. Set ASC_BIN or install asc on PATH.");
    return;
  }
  if (isJobRunning()) {
    sendError(res, 409, "A publish is already running");
    return;
  }
  try {
    startPublish((body ?? {}) as PublishBody);
  } catch (err) {
    sendError(res, 400, errorMessage(err));
    return;
  }
  sendJson(res, 200, { ok: true, job: jobStatus() });
});

router.post("/api/publish/cancel", (_req, res) => {
  cancelJob();
  sendJson(res, 200, { ok: true });
});

router.get("/api/publish/stream", (req, res) => {
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

  const server = createServer((req, res) => router.handle(req, res));
  server.listen(PORT, () => {
    console.log(`\n  Rork Local ready → http://localhost:${PORT}\n`);
  });
  server.on("upgrade", (req, socket, head) => sim.handleUpgrade(req, socket, head));
}
