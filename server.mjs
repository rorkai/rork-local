import express from "express";
import { simMiddleware } from "serve-sim/middleware";
import { spawn, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, unlinkSync, rmSync, copyFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
// Package directory: static UI assets ship with the package.
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
// Workspace: where the user launched from. All mutable state lives here so a
// global `npx rork-local` inside an app repo keeps its state in that repo.
const WORK_DIR = process.cwd();
const CONFIG_PATH = path.join(WORK_DIR, "rork.config.json");

const PORT = Number(process.env.PORT || 3131);
const PREFERRED_DEVICES = [
  "iPhone 17 Pro",
  "iPhone 16 Pro",
  "iPhone 16",
  "iPhone 16e",
];

// ---------------------------------------------------------------------------
// asc binary resolution
// ---------------------------------------------------------------------------

function resolveAscBin() {
  if (process.env.ASC_BIN && existsSync(process.env.ASC_BIN)) {
    return process.env.ASC_BIN;
  }
  const onPath = execSync("command -v asc || true", { encoding: "utf8" }).trim();
  if (onPath) return onPath;
  const sibling = path.resolve(PKG_DIR, "../App-Store-Connect-CLI/asc");
  if (existsSync(sibling)) return sibling;
  return null;
}

const ASC_BIN = resolveAscBin();

// ---------------------------------------------------------------------------
// Config defaults (rork.config.json + env)
// ---------------------------------------------------------------------------

function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.warn(`[rork-local] could not parse rork.config.json: ${err.message}`);
    return {};
  }
}

function loadConfig() {
  const fileConfig = readConfigFile();
  return {
    appId: process.env.ASC_APP_ID || fileConfig.appId || "",
    ipa: fileConfig.ipa || "",
    group: fileConfig.group || "",
    version: fileConfig.version || "",
  };
}

// Detection target. Precedence: rork.config.json projectDir > RORK_PROJECT env
// > argv > cwd. Mutable at runtime via POST /api/config/project.
let projectDir = path.resolve(
  readConfigFile().projectDir || process.env.RORK_PROJECT || process.argv[2] || WORK_DIR,
);

function setProjectDir(dir) {
  const resolved = path.resolve(dir);
  const stat = existsSync(resolved) && statSync(resolved);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  projectDir = resolved;
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfigFile(), projectDir: resolved }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Config auto-detection from an app codebase
// ---------------------------------------------------------------------------

const SCAN_SKIP = new Set([
  "node_modules", ".git", "Pods", "DerivedData", "build", ".build",
  "dist", ".next", ".expo", "vendor",
]);

function* walkFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".ipa") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // .xcodeproj/.xcarchive are directories we want to look inside;
      // build dirs are skipped except when hunting IPAs (handled separately).
      if (SCAN_SKIP.has(entry.name)) continue;
      yield* walkFiles(full, depth + 1);
    } else {
      yield full;
    }
  }
}

function detectFromExpo(dir) {
  const appJsonPath = path.join(dir, "app.json");
  if (!existsSync(appJsonPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(appJsonPath, "utf8"));
    const expo = raw.expo || raw;
    return {
      bundleId: expo?.ios?.bundleIdentifier || "",
      version: expo?.version || "",
      appName: expo?.name || "",
      source: "app.json (Expo)",
    };
  } catch {
    return {};
  }
}

function detectFromXcode(dir) {
  for (const file of walkFiles(dir)) {
    if (!file.endsWith("project.pbxproj")) continue;
    try {
      const pbx = readFileSync(file, "utf8");
      const bundleId = pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;"]+);/)?.[1]?.trim() || "";
      const version = pbx.match(/MARKETING_VERSION = ([^;"]+);/)?.[1]?.trim() || "";
      if (bundleId && !bundleId.includes("$(")) {
        return { bundleId, version, source: path.relative(dir, file) };
      }
    } catch {
      /* unreadable pbxproj */
    }
  }
  return {};
}

function findNewestIpa(dir) {
  let newest = null;
  const stack = [{ p: dir, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop();
    if (depth > 6) continue;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        // IPAs commonly live in build/ dirs, so only skip the huge trees.
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "Pods") continue;
        stack.push({ p: full, depth: depth + 1 });
      } else if (entry.name.endsWith(".ipa")) {
        const mtime = statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
      }
    }
  }
  return newest?.path || "";
}

async function resolveAppIdFromBundleId(bundleId) {
  if (!ASC_BIN || !bundleId) return "";
  try {
    const { stdout } = await execFileP(
      ASC_BIN,
      ["apps", "list", "--bundle-id", bundleId, "--limit", "2", "--output", "json"],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout);
    const apps = parsed.data || [];
    if (apps.length === 1) return apps[0].id || "";
    if (apps.length > 1) {
      console.warn(`[rork-local] multiple ASC apps match ${bundleId}; not auto-filling app ID`);
    }
    return "";
  } catch (err) {
    console.warn(`[rork-local] asc app lookup failed (${err.message.split("\n")[0]}); is asc auth configured?`);
    return "";
  }
}

async function fetchBetaGroups(appId) {
  if (!ASC_BIN || !appId) return [];
  try {
    const { stdout } = await execFileP(
      ASC_BIN,
      ["testflight", "groups", "list", "--app", appId, "--paginate", "--output", "json"],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout);
    return (parsed.data || [])
      .map((g) => g.attributes?.name || g.name || "")
      .filter(Boolean);
  } catch (err) {
    console.warn(`[rork-local] beta group lookup failed (${err.message.split("\n")[0]})`);
    return [];
  }
}

const DETECT_TTL_MS = 60000;
const detectCache = {
  detected: { appId: "", ipa: "", group: "", version: "" },
  bundleId: "",
  betaGroups: [],
  groupsForAppId: null, // app ID the cached betaGroups belong to
  notes: [],
  at: 0,
  refreshing: null,
};

// Xcode-style autofill: scan the project and cache the result. Cheap scans run
// at most once per DETECT_TTL_MS; the asc network lookup for the app ID only
// runs on `force`, when the bundle ID changed, or while the app ID is unknown.
async function refreshDetection({ force = false } = {}) {
  if (!force && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache;
  if (detectCache.refreshing) return detectCache.refreshing;

  const run = (async () => {
    const detected = { appId: "", ipa: "", group: "", version: "" };
    const notes = [];

    const expo = detectFromExpo(projectDir);
    const xcode = expo.bundleId ? {} : detectFromXcode(projectDir);
    const bundleId = expo.bundleId || xcode.bundleId || "";
    detected.version = expo.version || xcode.version || "";
    if (bundleId) notes.push(`bundle ID ${bundleId} from ${expo.source || xcode.source}`);

    detected.ipa = findNewestIpa(projectDir);
    if (detected.ipa) notes.push(`ipa ${detected.ipa}`);

    const prevAppId = detectCache.detected.appId;
    if (bundleId && (force || bundleId !== detectCache.bundleId || !prevAppId)) {
      detected.appId = await resolveAppIdFromBundleId(bundleId);
    } else {
      detected.appId = prevAppId;
    }
    if (detected.appId) notes.push(`ASC app ID ${detected.appId}`);

    // Beta groups: network call, so only on startup/forced refresh or when the
    // effective app ID changes — never on routine status polls.
    const effectiveAppId = loadConfig().appId || detected.appId;
    if (effectiveAppId && (force || effectiveAppId !== detectCache.groupsForAppId)) {
      detectCache.betaGroups = await fetchBetaGroups(effectiveAppId);
      detectCache.groupsForAppId = effectiveAppId;
      if (detectCache.betaGroups.length > 0) {
        notes.push(`beta groups: ${detectCache.betaGroups.join(", ")}`);
      }
    } else if (!effectiveAppId) {
      detectCache.betaGroups = [];
      detectCache.groupsForAppId = null;
    }
    detected.group = detectCache.betaGroups[0] || "";

    detectCache.detected = detected;
    detectCache.bundleId = bundleId;
    detectCache.notes = notes;
    detectCache.at = Date.now();
    console.log(`[rork-local] detection (${projectDir}): ${notes.join("; ") || "nothing found"}`);
    return detectCache;
  })();
  // Clear via .finally, never inside the runner: a scan with no async work
  // completes before the assignment below, and clearing inside would leave a
  // permanently-stale resolved promise in `refreshing`.
  detectCache.refreshing = run;
  run.finally(() => {
    if (detectCache.refreshing === run) detectCache.refreshing = null;
  });
  return run;
}

// Merged view for the UI: explicit config always beats detection.
function mergedDetection() {
  const cfg = loadConfig();
  const d = detectCache.detected;
  return {
    values: {
      appId: cfg.appId || d.appId,
      ipa: cfg.ipa || d.ipa,
      group: cfg.group || d.group,
      version: cfg.version || d.version,
    },
    found: detectCache.notes.length > 0,
    notes: detectCache.notes,
    betaGroups: detectCache.betaGroups,
    bundleId: detectCache.bundleId,
    projectDir,
  };
}

// Detection is never persisted: rork.config.json holds user overrides only,
// so a freshly built .ipa is always picked up by the next scan.
async function warmDetection() {
  console.log(`[rork-local] auto-detecting publish config from ${projectDir}`);
  const { notes } = await refreshDetection({ force: true });
  if (notes.length === 0) {
    console.log("[rork-local] nothing detected (no app.json, Xcode project, or .ipa found)");
    return;
  }
  for (const note of notes) console.log(`[rork-local]   detected ${note}`);
}

// ---------------------------------------------------------------------------
// Simulator bootstrap
// ---------------------------------------------------------------------------

async function listSimulators() {
  const { stdout } = await execFileP("xcrun", ["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout);
  const devices = [];
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    for (const d of list) {
      if (d.isAvailable) devices.push({ ...d, runtime });
    }
  }
  return devices;
}

async function ensureBootedSimulator() {
  const devices = await listSimulators();
  const booted = devices.filter((d) => d.state === "Booted");
  if (booted.length > 0) {
    console.log(`[rork-local] using booted simulator: ${booted[0].name}`);
    return booted[0];
  }
  const candidate =
    PREFERRED_DEVICES.map((name) => devices.find((d) => d.name === name)).find(Boolean) ||
    devices.find((d) => d.name.startsWith("iPhone"));
  if (!candidate) {
    throw new Error("No available iPhone simulators found. Install one via Xcode.");
  }
  console.log(`[rork-local] booting simulator: ${candidate.name} (${candidate.udid})`);
  await execFileP("xcrun", ["simctl", "boot", candidate.udid]);
  // Open Simulator.app so the device renders frames (headless boots can stay black).
  await execFileP("open", ["-a", "Simulator"]).catch(() => {});
  await execFileP("xcrun", ["simctl", "bootstatus", candidate.udid]);
  return { ...candidate, state: "Booted" };
}

function startServeSimHelper() {
  const bin = path.join(PKG_DIR, "node_modules", ".bin", "serve-sim");
  return new Promise((resolve) => {
    const proc = spawn(bin, ["--detach", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("exit", (code) => {
      if (code === 0) {
        console.log("[rork-local] serve-sim helper started");
      } else {
        console.warn(`[rork-local] serve-sim --detach exited ${code}: ${out.trim()}`);
      }
      resolve(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Job runner (single concurrent asc job, log fan-out over SSE)
// ---------------------------------------------------------------------------

const job = {
  kind: null, // publish | screenshots-upload
  state: "idle", // idle | running | success | error
  lines: [],
  proc: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  command: null,
};
const sseClients = new Set();

function pushLine(stream, text) {
  const line = { t: Date.now(), stream, text };
  job.lines.push(line);
  if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
  broadcast("line", line);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function jobStatus() {
  return {
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    command: job.command,
    result: job.result || null,
  };
}

// Recursively find a created app ID in asc JSON output without assuming an
// exact response shape (prefers explicit appId/adamId keys over generic id).
function findAppId(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const key of ["appId", "adamId"]) {
    if (typeof node[key] === "string" || typeof node[key] === "number") return String(node[key]);
  }
  if ((typeof node.id === "string" || typeof node.id === "number") && /^\d+$/.test(String(node.id))) {
    return String(node.id);
  }
  for (const value of Object.values(node)) {
    const found = findAppId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function startAscJob(kind, args, doneMessage) {
  job.kind = kind;
  job.state = "running";
  job.lines = [];
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.exitCode = null;
  job.command = `asc ${args.join(" ")}`;
  job.result = null;
  job.stdoutText = "";
  broadcast("status", jobStatus());
  pushLine("info", `$ ${job.command}`);

  const proc = spawn(ASC_BIN, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.proc = proc;

  const wire = (stream, name) => {
    let buf = "";
    stream.on("data", (chunk) => {
      if (name === "stdout" && job.stdoutText.length < 262144) {
        job.stdoutText += chunk.toString();
      }
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const text = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (text) pushLine(name, text);
      }
    });
    stream.on("end", () => {
      if (buf.trim()) pushLine(name, buf.trim());
    });
  };
  wire(proc.stdout, "stdout");
  wire(proc.stderr, "stderr");

  proc.on("error", (err) => {
    pushLine("stderr", `failed to start asc: ${err.message}`);
    job.state = "error";
    job.exitCode = -1;
    job.finishedAt = Date.now();
    job.proc = null;
    broadcast("status", jobStatus());
  });

  proc.on("exit", (code) => {
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.state = code === 0 ? "success" : "error";
    job.proc = null;
    if (kind === "app-create" && code === 0) {
      try {
        const appId = findAppId(JSON.parse(job.stdoutText.trim()));
        if (appId) {
          job.result = { appId };
          pushLine("info", `Created app ID: ${appId}`);
        }
      } catch {
        /* non-JSON output; leave result empty */
      }
    }
    pushLine("info", code === 0 ? doneMessage : `asc exited with code ${code}`);
    broadcast("status", jobStatus());
  });
}

function buildPublishArgs(body) {
  const { target, appId, ipa, group, version, submit, wait, testNotes } = body;
  if (!appId) throw new Error("App Store Connect app ID is required");
  if (!ipa) throw new Error("IPA path is required");
  if (!existsSync(ipa)) throw new Error(`IPA not found at: ${ipa}`);
  if (target !== "appstore" && !group) {
    throw new Error("Beta group is required for TestFlight publishing");
  }

  const args = ["publish"];
  if (target === "appstore") {
    args.push("appstore", "--app", appId, "--ipa", ipa);
    if (version) args.push("--version", version);
    if (wait) args.push("--wait");
    if (submit) args.push("--submit", "--confirm");
  } else {
    args.push("testflight", "--app", appId, "--ipa", ipa);
    if (group) args.push("--group", group);
    if (wait) args.push("--wait");
    if (testNotes) args.push("--test-notes", testNotes);
    if (submit) args.push("--submit", "--confirm");
  }
  args.push("--output", "json", "--pretty");
  return args;
}

function startPublish(body) {
  const args = buildPublishArgs(body);
  startAscJob("publish", args, "Publish complete.");
}

// ---------------------------------------------------------------------------
// Screenshots (capture via simctl, frame + upload via asc)
// ---------------------------------------------------------------------------

const SHOTS_DIR = path.join(WORK_DIR, ".rork-local", "screenshots");
const RAW_DIR = path.join(SHOTS_DIR, "raw");
const FRAMED_DIR = path.join(SHOTS_DIR, "framed");
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(FRAMED_DIR, { recursive: true });

const FRAME_DEVICES = ["iphone-air", "iphone-17-pro", "iphone-17-pro-max", "iphone-17", "iphone-16e"];

function sanitizeShotName(name) {
  const clean = String(name || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || `shot-${Date.now()}`;
}

function listShots(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => {
      const stat = statSync(path.join(dir, f));
      return { name: f.replace(/\.png$/, ""), file: f, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function captureScreenshot(name) {
  const clean = sanitizeShotName(name);
  const outPath = path.join(RAW_DIR, `${clean}.png`);
  await execFileP("xcrun", ["simctl", "io", "booted", "screenshot", outPath]);
  return { name: clean, file: `${clean}.png` };
}

async function frameScreenshot(name, device, title) {
  const input = path.join(RAW_DIR, `${name}.png`);
  if (!existsSync(input)) throw new Error(`raw screenshot not found: ${name}`);
  if (!FRAME_DEVICES.includes(device)) throw new Error(`unknown frame device: ${device}`);
  const args = [
    "screenshots", "frame",
    "--input", input,
    "--device", device,
    "--output-dir", FRAMED_DIR,
    "--output", "json",
  ];
  if (title) args.push("--title", title);
  const { stdout, stderr } = await execFileP(ASC_BIN, args, { timeout: 120000 }).catch((err) => {
    throw new Error(err.stderr?.trim() || err.message);
  });
  return { name, device, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

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
  let ascVersion = null;
  if (ASC_BIN) {
    try {
      const { stdout } = await execFileP(ASC_BIN, ["--version"]);
      ascVersion = stdout.trim();
    } catch {
      /* ignore */
    }
  }
  await refreshDetection().catch(() => {});
  res.json({
    device: device ? { name: device.name, udid: device.udid, runtime: device.runtime } : null,
    asc: { bin: ASC_BIN, version: ascVersion },
    config: loadConfig(),
    detected: mergedDetection(),
    job: jobStatus(),
  });
});

app.post("/api/config/detect", async (_req, res) => {
  try {
    const { detected, bundleId, notes } = await refreshDetection({ force: true });
    res.json({ detected, bundleId, notes, projectDir: projectDir, merged: mergedDetection() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/config/project", async (req, res) => {
  const dir = String(req.body?.dir || "").trim();
  if (!dir) return res.status(400).json({ error: "Project directory is required" });
  try {
    setProjectDir(dir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await refreshDetection({ force: true }).catch(() => {});
  res.json({ ok: true, projectDir, detected: mergedDetection() });
});

async function apiKeyAuthStatus() {
  try {
    const { stdout } = await execFileP(ASC_BIN, ["auth", "status", "--output", "json"], { timeout: 15000 });
    const status = JSON.parse(stdout);
    const hasCredentials =
      (Array.isArray(status.credentials) && status.credentials.length > 0) ||
      status.environmentCredentialsComplete === true;
    return {
      ok: hasCredentials,
      detail: hasCredentials ? "" : "No stored credentials. Run `asc auth login` to add an API key.",
    };
  } catch (err) {
    return { ok: false, detail: (err.stderr || err.message || "").split("\n")[0] };
  }
}

async function webAuthStatus() {
  try {
    const { stdout } = await execFileP(ASC_BIN, ["web", "auth", "status", "--output", "json"], { timeout: 20000 });
    const status = JSON.parse(stdout);
    return {
      ok: status.authenticated === true,
      detail: status.authenticated ? "" : "No cached web session. Run `asc web auth login`.",
    };
  } catch (err) {
    return { ok: false, detail: (err.stderr || err.message || "").split("\n")[0] };
  }
}

app.get("/api/auth", async (_req, res) => {
  if (!ASC_BIN) {
    const missing = { ok: false, detail: "asc binary not found" };
    return res.json({ ...missing, apiKey: missing, web: missing });
  }
  const [apiKey, web] = await Promise.all([apiKeyAuthStatus(), webAuthStatus()]);
  // Top-level ok/detail mirror the API-key check for older clients.
  res.json({ ok: apiKey.ok, detail: apiKey.detail, apiKey, web });
});

// First-publish flow: create the App Store Connect app via a cached web
// session. Relies on `asc web auth login` having been run beforehand; without
// a session asc fails fast (stdin is not a TTY, so it cannot prompt).
app.post("/api/apps/create", (req, res) => {
  if (!ASC_BIN) return res.status(500).json({ error: "asc binary not found" });
  if (job.state === "running") return res.status(409).json({ error: "Another job is already running" });
  const { name, bundleId, sku } = req.body || {};
  if (!name) return res.status(400).json({ error: "App name is required" });
  if (!bundleId) return res.status(400).json({ error: "Bundle ID is required" });
  if (!sku) return res.status(400).json({ error: "SKU is required" });
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

app.get("/api/screenshots", (_req, res) => {
  res.json({ raw: listShots(RAW_DIR), framed: listShots(FRAMED_DIR), frameDevices: FRAME_DEVICES });
});

app.post("/api/screenshots/capture", async (req, res) => {
  try {
    const shot = await captureScreenshot(req.body?.name || `shot-${Date.now()}`);
    res.json({ ok: true, shot });
  } catch (err) {
    res.status(500).json({ error: err.message.split("\n")[0] });
  }
});

app.post("/api/screenshots/frame", async (req, res) => {
  if (!ASC_BIN) return res.status(500).json({ error: "asc binary not found" });
  const { name, device = "iphone-air", title } = req.body || {};
  try {
    const result = await frameScreenshot(sanitizeShotName(name), device, title);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message.split("\n").slice(0, 3).join(" ") });
  }
});

app.delete("/api/screenshots/:kind/:name", (req, res) => {
  const { kind, name } = req.params;
  const dir = kind === "framed" ? FRAMED_DIR : RAW_DIR;
  const file = path.join(dir, `${sanitizeShotName(name)}.png`);
  if (existsSync(file)) unlinkSync(file);
  res.json({ ok: true });
});

app.post("/api/screenshots/upload", (req, res) => {
  if (!ASC_BIN) return res.status(500).json({ error: "asc binary not found" });
  if (job.state === "running") return res.status(409).json({ error: "Another job is already running" });
  const { appId, version, deviceType = "IPHONE_65", source = "framed", locale = "en-US" } = req.body || {};
  if (!appId) return res.status(400).json({ error: "App Store Connect app ID is required" });
  if (!version) return res.status(400).json({ error: "App Store version is required" });
  const dir = source === "raw" ? RAW_DIR : FRAMED_DIR;
  const shots = listShots(dir);
  if (shots.length === 0) return res.status(400).json({ error: `No ${source} screenshots to upload` });

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
    return res.status(500).json({ error: "asc binary not found. Set ASC_BIN or install asc on PATH." });
  }
  if (job.state === "running") {
    return res.status(409).json({ error: "A publish is already running" });
  }
  try {
    startPublish(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true, job: jobStatus() });
});

app.post("/api/publish/cancel", (_req, res) => {
  if (job.proc) {
    job.proc.kill("SIGTERM");
    pushLine("info", "Publish cancelled by user.");
  }
  res.json({ ok: true });
});

app.get("/api/publish/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: status\ndata: ${JSON.stringify(jobStatus())}\n\n`);
  for (const line of job.lines) {
    res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
  }
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  if (!ASC_BIN) {
    console.warn("[rork-local] warning: asc binary not found (set ASC_BIN); publish will be disabled");
  } else {
    console.log(`[rork-local] using asc at ${ASC_BIN}`);
  }

  try {
    await ensureBootedSimulator();
  } catch (err) {
    console.warn(`[rork-local] simulator bootstrap failed: ${err.message}`);
  }
  await warmDetection();
  await startServeSimHelper();

  const server = app.listen(PORT, () => {
    console.log(`\n  Rork Local ready → http://localhost:${PORT}\n`);
  });
  server.on("upgrade", (req, socket, head) => sim.handleUpgrade(req, socket, head));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
