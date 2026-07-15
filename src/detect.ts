import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ASC_BIN, getProjectDir, loadConfig } from "./config.js";
import { errorMessage, type ConfigValues, type MergedDetection } from "./types.js";

const execFileP = promisify(execFile);

const SCAN_SKIP = new Set([
  "node_modules", ".git", "Pods", "DerivedData", "build", ".build",
  "dist", ".next", ".expo", "vendor",
]);

function* walkFiles(dir: string, depth = 0): Generator<string> {
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

type DetectHit = { bundleId?: string; version?: string; appName?: string; source?: string };

function detectFromExpo(dir: string): DetectHit {
  const appJsonPath = path.join(dir, "app.json");
  if (!existsSync(appJsonPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(appJsonPath, "utf8")) as Record<string, unknown>;
    const expo = (raw.expo ?? raw) as {
      ios?: { bundleIdentifier?: string };
      version?: string;
      name?: string;
    };
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

function detectFromXcode(dir: string): DetectHit {
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

function findNewestIpa(dir: string): string {
  let newest: { path: string; mtime: number } | null = null;
  const stack: Array<{ p: string; depth: number }> = [{ p: dir, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop()!;
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

async function resolveAppIdFromBundleId(bundleId: string): Promise<string> {
  if (!ASC_BIN || !bundleId) return "";
  try {
    const { stdout } = await execFileP(
      ASC_BIN,
      ["apps", "list", "--bundle-id", bundleId, "--limit", "2", "--output", "json"],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout) as { data?: Array<{ id?: string }> };
    const apps = parsed.data || [];
    if (apps.length === 1) return apps[0].id || "";
    if (apps.length > 1) {
      console.warn(`[rork-local] multiple ASC apps match ${bundleId}; not auto-filling app ID`);
    }
    return "";
  } catch (err) {
    console.warn(
      `[rork-local] asc app lookup failed (${errorMessage(err).split("\n")[0]}); is asc auth configured?`,
    );
    return "";
  }
}

export async function fetchBetaGroups(appId: string): Promise<string[]> {
  if (!ASC_BIN || !appId) return [];
  try {
    const { stdout } = await execFileP(
      ASC_BIN,
      ["testflight", "groups", "list", "--app", appId, "--paginate", "--output", "json"],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout) as {
      data?: Array<{ attributes?: { name?: string }; name?: string }>;
    };
    return (parsed.data || [])
      .map((g) => g.attributes?.name || g.name || "")
      .filter(Boolean);
  } catch (err) {
    console.warn(`[rork-local] beta group lookup failed (${errorMessage(err).split("\n")[0]})`);
    return [];
  }
}

const DETECT_TTL_MS = 60000;

type DetectCache = {
  detected: ConfigValues;
  bundleId: string;
  betaGroups: string[];
  /** app ID the cached betaGroups belong to */
  groupsForAppId: string | null;
  notes: string[];
  at: number;
  refreshing: Promise<DetectCache> | null;
};

const detectCache: DetectCache = {
  detected: { appId: "", ipa: "", group: "", version: "" },
  bundleId: "",
  betaGroups: [],
  groupsForAppId: null,
  notes: [],
  at: 0,
  refreshing: null,
};

/** Xcode-style autofill: scan the project and cache the result. Cheap scans run
 * at most once per DETECT_TTL_MS; the asc network lookup for the app ID only
 * runs on `force`, when the bundle ID changed, or while the app ID is unknown. */
export async function refreshDetection({ force = false } = {}): Promise<DetectCache> {
  if (!force && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache;
  if (detectCache.refreshing) return detectCache.refreshing;

  const projectDir = getProjectDir();
  const run = (async () => {
    const detected: ConfigValues = { appId: "", ipa: "", group: "", version: "" };
    const notes: string[] = [];

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
  void run.finally(() => {
    if (detectCache.refreshing === run) detectCache.refreshing = null;
  });
  return run;
}

/** Merged view for the UI: explicit config always beats detection. */
export function mergedDetection(): MergedDetection {
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
    projectDir: getProjectDir(),
  };
}

/** Detection is never persisted: rork.config.json holds user overrides only,
 * so a freshly built .ipa is always picked up by the next scan. */
export async function warmDetection(): Promise<void> {
  console.log(`[rork-local] auto-detecting publish config from ${getProjectDir()}`);
  const { notes } = await refreshDetection({ force: true });
  if (notes.length === 0) {
    console.log("[rork-local] nothing detected (no app.json, Xcode project, or .ipa found)");
    return;
  }
  for (const note of notes) console.log(`[rork-local]   detected ${note}`);
}
