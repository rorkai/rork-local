import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ASC_BIN, WORK_DIR } from "./config.js";
import { errorMessage, errorStderr, type ShotInfo } from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Screenshots (capture via simctl, frame + upload via asc)
// ---------------------------------------------------------------------------

export const SHOTS_DIR = path.join(WORK_DIR, ".rork-local", "screenshots");
export const RAW_DIR = path.join(SHOTS_DIR, "raw");
export const FRAMED_DIR = path.join(SHOTS_DIR, "framed");
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(FRAMED_DIR, { recursive: true });

export const FRAME_DEVICES = [
  "iphone-air", "iphone-17-pro", "iphone-17-pro-max", "iphone-17", "iphone-16e",
];

export function sanitizeShotName(name: unknown): string {
  const clean = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || `shot-${Date.now()}`;
}

export function listShots(dir: string): ShotInfo[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => {
      const stat = statSync(path.join(dir, f));
      return { name: f.replace(/\.png$/, ""), file: f, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export async function captureScreenshot(name: unknown): Promise<{ name: string; file: string }> {
  const clean = sanitizeShotName(name);
  const outPath = path.join(RAW_DIR, `${clean}.png`);
  await execFileP("xcrun", ["simctl", "io", "booted", "screenshot", outPath]);
  return { name: clean, file: `${clean}.png` };
}

export async function frameScreenshot(
  name: string,
  device: string,
  title?: string,
): Promise<{ name: string; device: string; stdout: string; stderr: string }> {
  const input = path.join(RAW_DIR, `${name}.png`);
  if (!existsSync(input)) throw new Error(`raw screenshot not found: ${name}`);
  if (!FRAME_DEVICES.includes(device)) throw new Error(`unknown frame device: ${device}`);
  if (!ASC_BIN) throw new Error("asc binary not found");
  const args = [
    "screenshots", "frame",
    "--input", input,
    "--device", device,
    "--output-dir", FRAMED_DIR,
    "--output", "json",
  ];
  if (title) args.push("--title", title);
  const { stdout, stderr } = await execFileP(ASC_BIN, args, { timeout: 120000 }).catch((err: unknown) => {
    throw new Error(errorStderr(err).trim() || errorMessage(err));
  });
  return { name, device, stdout: stdout.trim(), stderr: stderr.trim() };
}
