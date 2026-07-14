import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { PKG_DIR, PREFERRED_DEVICES } from "./config.js";
import type { SimDevice } from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Simulator bootstrap
// ---------------------------------------------------------------------------

export async function listSimulators(): Promise<SimDevice[]> {
  const { stdout } = await execFileP("xcrun", ["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout) as {
    devices: Record<string, Array<Omit<SimDevice, "runtime">>>;
  };
  const devices: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    for (const d of list) {
      if (d.isAvailable) devices.push({ ...d, runtime });
    }
  }
  return devices;
}

export async function ensureBootedSimulator(): Promise<SimDevice> {
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

/** Start serve-sim's detached helper (owns the device stream). */
export function startServeSimHelper(): Promise<boolean> {
  const bin = path.join(PKG_DIR, "node_modules", ".bin", "serve-sim");
  return new Promise((resolve) => {
    const proc = spawn(bin, ["--detach", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.stderr.on("data", (d: Buffer) => (out += d));
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
