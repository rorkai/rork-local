/** Shared API payload types. These shapes are what the frontend (public/app.js)
 * consumes — keep them byte-compatible with the original server.mjs responses. */

/** User-facing publish values, merged from rork.config.json and env. */
export type ConfigValues = {
  appId: string;
  ipa: string;
  group: string;
  version: string;
};

/** On-disk rork.config.json: user overrides only, never detected values. */
export type ConfigFile = Partial<ConfigValues> & { projectDir?: string };

export type JobKind = "publish" | "screenshots-upload" | "app-create";
export type JobState = "idle" | "running" | "success" | "error";
export type LogStream = "stdout" | "stderr" | "info";

export type JobLine = { t: number; stream: LogStream; text: string };

export type JobResult = { appId: string };

export type JobStatus = {
  kind: JobKind | null;
  state: JobState;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  command: string | null;
  result: JobResult | null;
};

/** Merged view for the UI: explicit config always beats detection. */
export type MergedDetection = {
  values: ConfigValues;
  found: boolean;
  notes: string[];
  betaGroups: string[];
  bundleId: string;
  projectDir: string;
};

export type SimDevice = {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  isAvailable?: boolean;
};

export type ShotInfo = { name: string; file: string; mtime: number; size: number };

export type AuthCheck = { ok: boolean; detail: string };

export type PublishBody = {
  target?: string;
  appId?: string;
  ipa?: string;
  group?: string;
  version?: string;
  submit?: boolean;
  wait?: boolean;
  testNotes?: string;
};

export type StatusResponse = {
  device: { name: string; udid: string; runtime: string } | null;
  asc: { bin: string | null; version: string | null };
  config: ConfigValues;
  detected: MergedDetection;
  job: JobStatus;
};

/** Message from an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** stderr from a child_process exec failure, when present. */
export function errorStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string") {
    return err.stderr;
  }
  return "";
}
