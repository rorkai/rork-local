import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Response } from "express";

import { ASC_BIN } from "./config.js";
import type { JobKind, JobLine, JobResult, JobState, JobStatus, LogStream, PublishBody } from "./types.js";

// ---------------------------------------------------------------------------
// Job runner (single concurrent asc job, log fan-out over SSE)
// ---------------------------------------------------------------------------

type Job = {
  kind: JobKind | null;
  state: JobState;
  lines: JobLine[];
  proc: ChildProcess | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  command: string | null;
  result: JobResult | null;
  stdoutText: string;
};

const job: Job = {
  kind: null,
  state: "idle",
  lines: [],
  proc: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  command: null,
  result: null,
  stdoutText: "",
};

const sseClients = new Set<Response>();

function pushLine(stream: LogStream, text: string): void {
  const line: JobLine = { t: Date.now(), stream, text };
  job.lines.push(line);
  if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
  broadcast("line", line);
}

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

export function jobStatus(): JobStatus {
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

export function isJobRunning(): boolean {
  return job.state === "running";
}

export function cancelJob(): boolean {
  if (job.proc) {
    job.proc.kill("SIGTERM");
    // Not always a publish — the same runner handles screenshot uploads and
    // app creation.
    pushLine("info", "Job cancelled by user.");
    return true;
  }
  return false;
}

/** Attach an SSE client: replays current status + buffered lines, then streams. */
export function attachSseClient(res: Response, onClose: (cb: () => void) => void): void {
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
  onClose(() => sseClients.delete(res));
}

/** Recursively find a created app ID in asc JSON output without assuming an
 * exact response shape (prefers explicit appId/adamId keys over generic id). */
function findAppId(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  for (const key of ["appId", "adamId"]) {
    if (typeof obj[key] === "string" || typeof obj[key] === "number") return String(obj[key]);
  }
  if ((typeof obj.id === "string" || typeof obj.id === "number") && /^\d+$/.test(String(obj.id))) {
    return String(obj.id);
  }
  for (const value of Object.values(obj)) {
    const found = findAppId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function startAscJob(kind: JobKind, args: string[], doneMessage: string): void {
  if (!ASC_BIN) throw new Error("asc binary not found");
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

  const wire = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
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

function buildPublishArgs(body: PublishBody): string[] {
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

export function startPublish(body: PublishBody): void {
  const args = buildPublishArgs(body);
  startAscJob("publish", args, "Publish complete.");
}
