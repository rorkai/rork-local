import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage, type ConfigFile, type ConfigValues } from "./types.js";

/** Package root (this file compiles to dist/, so the root is one level up).
 * Static UI assets ship with the package. */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace: where the user launched from. All mutable state lives here so a
 * global `npx rork-local` inside an app repo keeps its state in that repo. */
export const WORK_DIR = process.cwd();

export const CONFIG_PATH = path.join(WORK_DIR, "rork.config.json");

export const PORT = Number(process.env.PORT || 3131);

/** Bind to loopback by default: the API can publish builds and run asc jobs
 * with the user's credentials, so it should not be reachable from the LAN
 * unless explicitly requested (HOST=0.0.0.0). */
export const HOST = process.env.HOST || "127.0.0.1";

export const PREFERRED_DEVICES = [
  "iPhone 17 Pro",
  "iPhone 16 Pro",
  "iPhone 16",
  "iPhone 16e",
];

// ---------------------------------------------------------------------------
// asc binary resolution: ASC_BIN env > PATH > sibling dev checkout
// ---------------------------------------------------------------------------

function resolveAscBin(): string | null {
  if (process.env.ASC_BIN && existsSync(process.env.ASC_BIN)) {
    return process.env.ASC_BIN;
  }
  const onPath = execSync("command -v asc || true", { encoding: "utf8" }).trim();
  if (onPath) return onPath;
  const sibling = path.resolve(PKG_DIR, "../App-Store-Connect-CLI/asc");
  if (existsSync(sibling)) return sibling;
  return null;
}

export const ASC_BIN = resolveAscBin();

// ---------------------------------------------------------------------------
// Config defaults (rork.config.json + env)
// ---------------------------------------------------------------------------

export function readConfigFile(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
  } catch (err) {
    console.warn(`[rork-local] could not parse rork.config.json: ${errorMessage(err)}`);
    return {};
  }
}

export function loadConfig(): ConfigValues {
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

export function getProjectDir(): string {
  return projectDir;
}

export function setProjectDir(dir: string): void {
  const resolved = path.resolve(dir);
  const stat = existsSync(resolved) ? statSync(resolved) : null;
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  projectDir = resolved;
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...readConfigFile(), projectDir: resolved }, null, 2) + "\n",
  );
}
