import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AuthCheck, JobLine, JobStatus, ShotInfo, StatusResponse } from "../src/types";

type Shots = {
  raw: ShotInfo[];
  framed: ShotInfo[];
  listing: ShotInfo[];
  frameDevices: string[];
  deviceTypes: string[];
};

type PublishForm = {
  projectDir: string;
  appId: string;
  ipa: string;
  group: string;
  version: string;
  target: "testflight" | "appstore";
  wait: boolean;
  submit: boolean;
};

const emptyShots: Shots = { raw: [], framed: [], listing: [], frameDevices: [], deviceTypes: [] };
const emptyForm: PublishForm = {
  projectDir: "",
  appId: "",
  ipa: "",
  group: "",
  version: "",
  target: "testflight",
  wait: true,
  submit: false,
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${url} failed (${response.status})`);
  return data as T;
}

function post<T>(url: string, body: unknown = {}): Promise<T> {
  return json<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function useEscape(close: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [close, enabled]);
}

function useServerState() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [lines, setLines] = useState<JobLine[]>([]);

  const refresh = useCallback(async () => {
    setStatus(await json<StatusResponse>("/api/status"));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const events = new EventSource("/api/publish/stream");
    events.addEventListener("status", (event) => {
      const job = JSON.parse((event as MessageEvent).data) as JobStatus;
      setStatus((current) => (current ? { ...current, job } : current));
    });
    events.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as JobLine;
      setLines((current) => [...current.slice(-299), line]);
    });
    return () => {
      window.clearInterval(timer);
      events.close();
    };
  }, [refresh]);

  return { status, lines, refresh, clearLines: () => setLines([]) };
}

const control =
  "inline-flex h-8 items-center justify-center rounded-control border border-white/10 bg-white/[0.04] px-3 text-sm font-medium text-white transition hover:bg-white/[0.09] disabled:pointer-events-none disabled:opacity-40";
const primary = `${control} bg-white text-black hover:bg-white/90`;
const iconButton = `${control} w-8 px-0 text-rork-muted`;
const input =
  "h-9 w-full rounded-control border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/30";
const label = "flex flex-col gap-2 text-sm font-medium";
const muted = "text-xs font-normal text-rork-muted";
const surface =
  "border border-white/10 bg-rork-surface bg-[linear-gradient(rgb(255_255_255/0.02),rgb(255_255_255/0.02))] shadow-2xl backdrop-blur-2xl";

function Modal({ children, close, className = "" }: { children: ReactNode; close: () => void; className?: string }) {
  useEscape(close);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onMouseDown={close}>
      <section
        className={`${surface} ${className} max-h-[calc(100dvh-2rem)] overflow-hidden rounded-sheet`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

function Header({
  running,
  shotCount,
  capture,
  openShots,
  openPublish,
}: {
  running: boolean;
  shotCount: number;
  capture: () => void;
  openShots: () => void;
  openPublish: () => void;
}) {
  return (
    <header className="z-10 flex h-12 shrink-0 items-center justify-between bg-rork-bg px-3">
      <div className="flex items-center gap-2">
        <img src="/rork-logo.svg" alt="Rork" className="h-[22px] w-auto" />
        <span className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-1 text-[10px] font-semibold tracking-wider text-rork-muted uppercase">
          Local
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button className={iconButton} onClick={capture} title="Take screenshot" aria-label="Take screenshot">
          ⌾
        </button>
        <button className={`${iconButton} relative`} onClick={openShots} title="Screenshots" aria-label="Screenshots">
          ▧
          {shotCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-white px-1 text-[10px] leading-4 text-black">
              {shotCount}
            </span>
          )}
        </button>
        <button className={primary} onClick={openPublish}>
          Publish{" "}
          <span className={`ml-2 size-2 rounded-full ${running ? "animate-pulse bg-amber-500" : "bg-black/35"}`} />
        </button>
      </div>
    </header>
  );
}

function PublishDialog({
  status,
  lines,
  refreshStatus,
  close,
}: {
  status: StatusResponse | null;
  lines: JobLine[];
  refreshStatus: () => Promise<void>;
  close: () => void;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<PublishForm>(emptyForm);
  const [auth, setAuth] = useState<AuthCheck | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState("");
  const running = status?.job.state === "running";

  useEffect(() => {
    const detected = status?.detected;
    if (!detected) return;
    setForm((current) => ({
      ...current,
      projectDir: current.projectDir || detected.projectDir,
      appId: current.appId || detected.values.appId,
      ipa: current.ipa || detected.values.ipa,
      group: current.group || detected.values.group || detected.betaGroups[0] || "",
      version: current.version || detected.values.version,
    }));
    setGroups(detected.betaGroups);
  }, [status]);

  const update = <K extends keyof PublishForm>(key: K, value: PublishForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function scanProject() {
    setError("");
    try {
      const result = await post<{ projectDir: string; detected: StatusResponse["detected"] }>("/api/config/project", {
        dir: form.projectDir,
      });
      update("projectDir", result.projectDir);
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function loadGroups() {
    if (!form.appId) return;
    try {
      const result = await json<{ groups: string[] }>(`/api/groups?app=${encodeURIComponent(form.appId)}`);
      setGroups(result.groups);
      if (!form.group && result.groups[0]) update("group", result.groups[0]);
    } catch {
      setGroups([]);
    }
  }

  async function continueFlow() {
    setError("");
    if (step === 0) {
      if (!form.appId || !form.ipa) return setError("App ID and IPA path are required.");
      if (form.target === "testflight" && !form.group) return setError("A TestFlight beta group is required.");
      setStep(1);
      setAuth(await json<AuthCheck>("/api/auth").catch((cause) => ({ ok: false, detail: String(cause) })));
      return;
    }
    if (step === 1) {
      if (!auth?.ok) return setError("App Store Connect authentication is required.");
      await post("/api/publish", form);
      setStep(2);
      await refreshStatus();
      return;
    }
    close();
  }

  return (
    <Modal close={close} className="flex w-full max-w-3xl flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div>
          <h2 className="font-semibold">Publish to App Store</h2>
          <p className={muted}>
            Step {step + 1} of 3 · {["App Info", "Credentials", "Submit"][step]}
          </p>
        </div>
        <button className={iconButton} onClick={close}>
          ×
        </button>
      </div>
      <div className="flex gap-2 px-5 pt-4">
        {[0, 1, 2].map((item) => (
          <span key={item} className={`h-1.5 flex-1 rounded-full ${item <= step ? "bg-white" : "bg-white/10"}`} />
        ))}
      </div>
      <div className="min-h-72 overflow-y-auto p-5">
        {step === 0 && (
          <div className="grid gap-5 sm:grid-cols-2">
            <label className={`${label} sm:col-span-2`}>
              Project directory
              <div className="flex gap-2">
                <input
                  className={`${input} font-mono`}
                  value={form.projectDir}
                  onChange={(e) => update("projectDir", e.target.value)}
                />
                <button className={control} onClick={scanProject}>
                  Scan
                </button>
              </div>
            </label>
            <label className={label}>
              App ID
              <input
                className={input}
                value={form.appId}
                onBlur={loadGroups}
                onChange={(e) => update("appId", e.target.value)}
              />
            </label>
            <label className={label}>
              Version
              <input className={input} value={form.version} onChange={(e) => update("version", e.target.value)} />
            </label>
            <label className={`${label} sm:col-span-2`}>
              IPA path
              <input
                className={`${input} font-mono`}
                value={form.ipa}
                onChange={(e) => update("ipa", e.target.value)}
              />
            </label>
            <label className={label}>
              Destination
              <select
                className={input}
                value={form.target}
                onChange={(e) => update("target", e.target.value as PublishForm["target"])}
              >
                <option value="testflight">TestFlight</option>
                <option value="appstore">App Store</option>
              </select>
            </label>
            {form.target === "testflight" && (
              <label className={label}>
                Beta group
                <input
                  className={input}
                  list="groups"
                  value={form.group}
                  onChange={(e) => update("group", e.target.value)}
                />
                <datalist id="groups">
                  {groups.map((group) => (
                    <option key={group} value={group} />
                  ))}
                </datalist>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.wait} onChange={(e) => update("wait", e.target.checked)} /> Wait for
              processing
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.submit} onChange={(e) => update("submit", e.target.checked)} />{" "}
              Submit for review
            </label>
          </div>
        )}
        {step === 1 && (
          <div className="rounded-control border border-white/10 bg-white/[0.03] p-5">
            {!auth && <p className="text-rork-muted">Checking App Store Connect credentials…</p>}
            {auth && (
              <>
                <p className={`font-medium ${auth.ok ? "text-green-400" : "text-red-400"}`}>
                  {auth.ok ? "Credentials ready" : "Authentication required"}
                </p>
                <p className="mt-2 text-sm text-rork-muted">{auth.detail}</p>
              </>
            )}
          </div>
        )}
        {step === 2 && (
          <div>
            <p className="font-medium">
              {running
                ? "Publishing…"
                : status?.job.state === "success"
                  ? "Publish complete"
                  : status?.job.state === "error"
                    ? "Publish failed"
                    : "Starting…"}
            </p>
            <pre className="mt-4 max-h-64 overflow-auto rounded-control border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-white/75">
              {lines.map((line) => line.text).join("\n")}
            </pre>
          </div>
        )}
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/10 p-4">
        {step > 0 && step < 2 && (
          <button className={control} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button className={primary} onClick={() => void continueFlow()}>
          {step === 0 ? "Continue" : step === 1 ? "Start submission" : "Close"}
        </button>
      </div>
    </Modal>
  );
}

function ShotCard({
  kind,
  shot,
  frame,
  edit,
  remove,
}: {
  kind: "raw" | "framed" | "listing";
  shot: ShotInfo;
  frame?: () => void;
  edit?: () => void;
  remove: () => void;
}) {
  const src = `/shots/${kind}/${shot.file}?t=${shot.mtime}`;
  return (
    <article className="group relative overflow-hidden rounded-control border border-white/10 bg-white/[0.03]">
      <img className="aspect-[9/19.5] w-full bg-black object-cover" src={src} alt={shot.name} />
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 px-2 pt-6 pb-1.5 text-[10px]">
        {shot.name}
      </span>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 opacity-0 transition group-hover:opacity-100">
        {edit && (
          <button className={control} onClick={edit}>
            Edit
          </button>
        )}
        {frame && (
          <button className={control} onClick={frame}>
            Frame
          </button>
        )}
        <a className={control} href={src} target="_blank" rel="noreferrer">
          View
        </a>
        <button className={`${control} text-red-400`} onClick={remove}>
          Delete
        </button>
      </div>
    </article>
  );
}

function ScreenshotsDrawer({
  shots,
  close,
  capture,
  refresh,
  edit,
}: {
  shots: Shots;
  close: () => void;
  capture: () => Promise<void>;
  refresh: () => Promise<void>;
  edit: (shot?: ShotInfo) => void;
}) {
  const [device, setDevice] = useState(shots.frameDevices[0] || "");
  const [error, setError] = useState("");
  useEscape(close);

  async function frame(shot: ShotInfo) {
    try {
      await post("/api/screenshots/frame", { name: shot.name, device });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function remove(kind: string, shot: ShotInfo) {
    await fetch(`/api/screenshots/${kind}/${shot.name}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/60" onMouseDown={close}>
      <aside
        className={`${surface} absolute inset-y-0 right-0 flex w-[min(94vw,480px)] flex-col border-l`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <h2 className="font-semibold">Screenshots</h2>
          <div className="flex gap-2">
            <button className={control} onClick={() => void capture()}>
              Capture
            </button>
            <button className={iconButton} onClick={close}>
              ×
            </button>
          </div>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium tracking-wider text-rork-muted uppercase">Raw captures</h3>
              <select
                className={input}
                style={{ width: 170 }}
                value={device}
                onChange={(e) => setDevice(e.target.value)}
              >
                {shots.frameDevices.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {shots.raw.map((shot) => (
                <ShotCard
                  key={shot.file}
                  kind="raw"
                  shot={shot}
                  edit={() => edit(shot)}
                  frame={() => void frame(shot)}
                  remove={() => void remove("raw", shot)}
                />
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-medium tracking-wider text-rork-muted uppercase">Framed</h3>
            <div className="grid grid-cols-3 gap-2">
              {shots.framed.map((shot) => (
                <ShotCard key={shot.file} kind="framed" shot={shot} remove={() => void remove("framed", shot)} />
              ))}
            </div>
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium tracking-wider text-rork-muted uppercase">Listing slides</h3>
              <button className={control} onClick={() => edit()}>
                Open editor
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {shots.listing.map((shot) => (
                <ShotCard key={shot.file} kind="listing" shot={shot} remove={() => void remove("listing", shot)} />
              ))}
            </div>
          </section>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </aside>
    </div>
  );
}

function ScreenshotEditor({ shot, close, saved }: { shot?: ShotInfo; close: () => void; saved: () => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [headline, setHeadline] = useState("Your headline");
  const [from, setFrom] = useState("#1a1a2e");
  const [to, setTo] = useState("#4a2a6a");
  const [error, setError] = useState("");

  useEscape(close);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    target.width = 430;
    target.height = 932;
    const context = target.getContext("2d");
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, 0, target.height);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    context.fillStyle = gradient;
    context.fillRect(0, 0, target.width, target.height);
    context.fillStyle = "#fff";
    context.textAlign = "center";
    context.font = "700 42px -apple-system, sans-serif";
    context.fillText(headline, target.width / 2, 90, target.width - 50);
    if (!shot) return;
    const image = new Image();
    image.onload = () => {
      const width = 330;
      const height = (image.naturalHeight / image.naturalWidth) * width;
      context.save();
      context.shadowColor = "rgba(0,0,0,.5)";
      context.shadowBlur = 25;
      context.fillStyle = "#111";
      context.roundRect(40, 160, width + 20, height + 20, 42);
      context.fill();
      context.restore();
      context.save();
      context.roundRect(50, 170, width, height, 34);
      context.clip();
      context.drawImage(image, 50, 170, width, height);
      context.restore();
    };
    image.src = `/shots/raw/${shot.file}`;
  }, [from, headline, shot, to]);

  async function save() {
    try {
      await post("/api/screenshots/slide", {
        name: "slide-01",
        png: canvas.current?.toDataURL("image/png"),
        deviceType: "IPHONE_69",
      });
      await saved();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Modal close={close} className="flex h-full w-full max-w-5xl flex-col">
      <div className="flex items-center justify-between border-b border-white/10 p-4">
        <h2 className="font-semibold">Screenshot editor</h2>
        <div className="flex gap-2">
          <button className={primary} onClick={() => void save()}>
            Save slide
          </button>
          <button className={iconButton} onClick={close}>
            ×
          </button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_260px]">
        <div className="grid min-h-0 place-items-center bg-black/30 p-5">
          <canvas ref={canvas} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
        <aside className="space-y-5 overflow-y-auto border-l border-white/10 p-5">
          <label className={label}>
            Headline
            <input className={input} value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </label>
          <label className={label}>
            Gradient start
            <input type="color" className="h-10 w-full" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className={label}>
            Gradient end
            <input type="color" className="h-10 w-full" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <p className={muted}>
            {shot ? `Using ${shot.name}` : "Choose Edit on a raw capture to place it in the slide."}
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </aside>
      </div>
    </Modal>
  );
}

function App() {
  const { status, lines, refresh: refreshStatus } = useServerState();
  const [shots, setShots] = useState<Shots>(emptyShots);
  const [publishOpen, setPublishOpen] = useState(false);
  const [shotsOpen, setShotsOpen] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; shot?: ShotInfo }>({ open: false });
  const [error, setError] = useState("");

  const refreshShots = useCallback(async () => setShots(await json<Shots>("/api/screenshots")), []);
  useEffect(() => void refreshShots(), [refreshShots]);

  async function capture() {
    setError("");
    try {
      await post("/api/screenshots/capture", {
        name: `shot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
      });
      await refreshShots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setShotsOpen(true);
    }
  }

  const shotCount = shots.raw.length + shots.framed.length + shots.listing.length;
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-rork-bg font-sans text-rork-fg antialiased">
      <Header
        running={status?.job.state === "running"}
        shotCount={shotCount}
        capture={() => void capture()}
        openShots={() => setShotsOpen(true)}
        openPublish={() => setPublishOpen(true)}
      />
      <main className="relative flex min-h-0 flex-1">
        <iframe
          className="h-full w-full flex-1 border-0 bg-rork-bg"
          src="/.sim"
          title="iOS Simulator"
          allow="clipboard-read; clipboard-write"
        />
      </main>
      <footer className="flex h-7 shrink-0 items-center justify-center border-t border-white/10 text-[11px] text-rork-muted">
        powered by&nbsp;
        <a
          className="font-medium text-white hover:underline"
          href="https://github.com/EvanBacon/serve-sim"
          target="_blank"
          rel="noreferrer"
        >
          serve-sim
        </a>
        &nbsp;·&nbsp;
        <a
          className="font-medium text-white hover:underline"
          href="https://github.com/rorkai/App-Store-Connect-CLI"
          target="_blank"
          rel="noreferrer"
        >
          asc
        </a>
      </footer>
      {publishOpen && (
        <PublishDialog
          status={status}
          lines={lines}
          refreshStatus={refreshStatus}
          close={() => setPublishOpen(false)}
        />
      )}
      {shotsOpen && (
        <ScreenshotsDrawer
          shots={shots}
          close={() => setShotsOpen(false)}
          capture={capture}
          refresh={refreshShots}
          edit={(shot) => {
            setShotsOpen(false);
            setEditor({ open: true, shot });
          }}
        />
      )}
      {editor.open && (
        <ScreenshotEditor shot={editor.shot} close={() => setEditor({ open: false })} saved={refreshShots} />
      )}
      {error && !shotsOpen && (
        <div className="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-control bg-red-500 px-4 py-2 text-sm text-white shadow-xl">
          {error}
        </div>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App />);
