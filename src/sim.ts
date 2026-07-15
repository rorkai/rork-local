import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/** Locate serve-sim's CLI entry. Under npm's flat install (npx, global
 * installs) serve-sim is a sibling of this package, so PKG_DIR/node_modules
 * only exists in a dev checkout — resolve through the module system and read
 * the bin field instead, falling back to the local .bin shim. */
function resolveServeSimCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // The package's exports map doesn't expose ./package.json, so resolve a
    // real entry point and walk up to the package root from there.
    const middleware = require.resolve("serve-sim/middleware");
    let pkgDir = path.dirname(middleware);
    while (pkgDir !== path.dirname(pkgDir)) {
      const candidate = path.join(pkgDir, "package.json");
      if (existsSync(candidate)) {
        const metadata = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (metadata.name === "serve-sim") break;
      }
      pkgDir = path.dirname(pkgDir);
    }
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    if (pkg.name !== "serve-sim") throw new Error("serve-sim package root not found");
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["serve-sim"];
    if (rel) {
      const cli = path.join(pkgDir, rel);
      if (existsSync(cli)) return cli;
    }
  } catch {
    /* fall through to the dev-checkout shim */
  }
  const local = path.join(PKG_DIR, "node_modules", ".bin", "serve-sim");
  return existsSync(local) ? local : null;
}

/** Start serve-sim's detached helper (owns the device stream). */
export function startServeSimHelper(): Promise<boolean> {
  const cli = resolveServeSimCli();
  if (!cli) {
    console.warn("[rork-local] serve-sim CLI not found; simulator streaming disabled");
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cli, "--detach", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.stderr.on("data", (d: Buffer) => (out += d));
    proc.on("error", (err) => {
      // Without this handler a missing/broken binary emits no `exit` event and
      // the promise would never settle, hanging startup.
      console.warn(`[rork-local] failed to start serve-sim helper: ${err.message}`);
      resolve(false);
    });
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
