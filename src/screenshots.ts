import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ASC_BIN, getProjectDir } from "./config.js";
import { errorMessage, errorStderr, type DeckFile, type ShotInfo } from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Screenshots (capture via simctl, frame + upload via asc)
// ---------------------------------------------------------------------------

// State lives next to the app project (`<project>/.rork-local/screenshots`),
// and the project dir can be re-pointed at runtime, so these are functions
// rather than module constants. The path helpers are pure; directories are
// created only on the write paths (capture/frame/slide/deck save), so browsing
// the UI or listing shots never litters the project with an empty .rork-local.
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function shotsDir(): string {
  return path.join(getProjectDir(), ".rork-local", "screenshots");
}
export function rawDir(): string {
  return path.join(shotsDir(), "raw");
}
export function framedDir(): string {
  return path.join(shotsDir(), "framed");
}
export function listingDir(): string {
  return path.join(shotsDir(), "listing");
}
function deckPath(): string {
  return path.join(shotsDir(), "deck.json");
}

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
  if (!existsSync(dir)) return [];
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
  const outPath = path.join(ensureDir(rawDir()), `${clean}.png`);
  await execFileP("xcrun", ["simctl", "io", "booted", "screenshot", outPath]);
  return { name: clean, file: `${clean}.png` };
}

/** Portrait App Store dimensions accepted per device type, per
 * `asc screenshots sizes --all`. The editor validates exports against these
 * so `asc screenshots upload` won't reject them. */
export const SLIDE_DEVICE_SIZES: Record<string, Array<{ width: number; height: number }>> = {
  IPHONE_69: [
    { width: 1290, height: 2796 }, { width: 1260, height: 2736 }, { width: 1320, height: 2868 },
  ],
  IPHONE_67: [
    { width: 1290, height: 2796 }, { width: 1260, height: 2736 }, { width: 1320, height: 2868 },
  ],
  IPHONE_65: [{ width: 1284, height: 2778 }, { width: 1242, height: 2688 }],
  IPHONE_61: [{ width: 1179, height: 2556 }, { width: 1206, height: 2622 }],
  IPAD_PRO_3GEN_129: [{ width: 2048, height: 2732 }, { width: 2064, height: 2752 }],
};

/** Width/height from a PNG buffer's IHDR chunk (no image library needed). */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) {
    throw new Error("not a PNG file");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Validate + write an editor-exported slide PNG into the listing dir. */
export function saveSlide(
  name: unknown,
  base64Png: string,
  deviceType: string,
): { name: string; file: string; width: number; height: number } {
  const allowed = SLIDE_DEVICE_SIZES[deviceType];
  if (!allowed) {
    throw new Error(
      `unknown device type: ${deviceType} (expected one of ${Object.keys(SLIDE_DEVICE_SIZES).join(", ")})`,
    );
  }
  const data = base64Png.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(data, "base64");
  const { width, height } = pngDimensions(buf);
  if (!allowed.some((d) => d.width === width && d.height === height)) {
    const expect = allowed.map((d) => `${d.width}x${d.height}`).join(", ");
    throw new Error(`slide is ${width}x${height}, but ${deviceType} accepts ${expect}`);
  }
  const clean = sanitizeShotName(name);
  writeFileSync(path.join(ensureDir(listingDir()), `${clean}.png`), buf);
  return { name: clean, file: `${clean}.png`, width, height };
}

/** Editor deck state, persisted so reopening the editor restores slides. */
export function readDeck(): DeckFile | null {
  try {
    return JSON.parse(readFileSync(deckPath(), "utf8")) as DeckFile;
  } catch {
    return null;
  }
}

export function writeDeck(deck: DeckFile): void {
  ensureDir(shotsDir());
  writeFileSync(deckPath(), JSON.stringify(deck));
}

export async function frameScreenshot(
  name: string,
  device: string,
  title?: string,
): Promise<{ name: string; device: string; stdout: string; stderr: string }> {
  const input = path.join(rawDir(), `${name}.png`);
  if (!existsSync(input)) throw new Error(`raw screenshot not found: ${name}`);
  if (!FRAME_DEVICES.includes(device)) throw new Error(`unknown frame device: ${device}`);
  if (!ASC_BIN) throw new Error("asc binary not found");
  const args = [
    "screenshots", "frame",
    "--input", input,
    "--device", device,
    "--output-dir", ensureDir(framedDir()),
    "--output", "json",
  ];
  if (title) args.push("--title", title);
  const { stdout, stderr } = await execFileP(ASC_BIN, args, { timeout: 120000 }).catch((err: unknown) => {
    throw new Error(errorStderr(err).trim() || errorMessage(err));
  });
  return { name, device, stdout: stdout.trim(), stderr: stderr.trim() };
}
