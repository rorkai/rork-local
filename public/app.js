const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let jobRunning = false;
let jobKind = null;
let wizardStep = 0;
let authOk = null; // null = unknown, true/false after check (API key)
let frameDevices = [];
let lastDetected = null; // most recent merged detection from /api/status
let simDeviceSlug = ""; // booted simulator name as a frame-device slug
let frameDeviceTouched = false; // user picked a frame device manually

const STEP_NAMES = ["App Info", "App Store Connect", "Submit"];

// friendly progress titles + rough percents keyed by substrings of asc output
const PROGRESS_MAP = [
  [/uploading|upload started/i, ["Uploading to TestFlight", "Uploading your build to Apple…", 40]],
  [/waiting|processing/i, ["Processing", "Apple is processing your build…", 65]],
  [/distribut|adding.*group|beta group/i, ["Distributing", "Adding build to beta groups…", 80]],
  [/submit/i, ["Submitting", "Submitting for review…", 90]],
  [/creating|version/i, ["Preparing version", "Finding or creating the App Store version…", 25]],
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

/** Show an inline form error and make sure it's actually on screen — error
 * elements can sit below the fold of a scrolled panel. */
function showError(el, message) {
  el.textContent = message;
  show(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function appendLine(pre, line) {
  const span = document.createElement("span");
  span.className = `l-${line.stream}`;
  span.textContent = line.text + "\n";
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// topbar: publish popover
// ---------------------------------------------------------------------------

const popover = $("popover");

$("publish-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  popover.classList.toggle("hidden");
  if (!popover.classList.contains("hidden")) loadStatus();
});
popover.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => hide(popover));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hide(popover);
    closeWizard();
    closeShots();
  }
});

$("open-wizard-btn").addEventListener("click", () => {
  hide(popover);
  openWizard();
});
$("open-shots-btn").addEventListener("click", () => {
  hide(popover);
  openShots();
});

// ---------------------------------------------------------------------------
// wizard (bottom sheet)
// ---------------------------------------------------------------------------

const wizard = $("wizard");
const wizardBackdrop = $("wizard-backdrop");
const wNext = $("w-next");
const wBack = $("w-back");
const wError = $("w-error");
const wLog = $("w-log");

function openWizard() {
  show(wizard);
  show(wizardBackdrop);
  loadStatus(); // refresh autofill (picks up newly built IPAs)
  if (jobRunning && jobKind === "publish") {
    setWizardStep(2);
  } else if (wizardStep === 2 && !jobRunning) {
    // returning after a finished run: keep the result view
    setWizardStep(2);
  } else {
    setWizardStep(0);
  }
}

function closeWizard() {
  hide(wizard);
  hide(wizardBackdrop);
}

$("wizard-close").addEventListener("click", closeWizard);
wizardBackdrop.addEventListener("click", closeWizard);

function setWizardStep(step) {
  wizardStep = step;
  hide(wError);
  for (const section of wizard.querySelectorAll(".step")) {
    section.classList.toggle("hidden", Number(section.dataset.step) !== step);
  }
  $("step-count").textContent = `Step ${step + 1} of 3`;
  $("step-name").textContent = STEP_NAMES[step];
  wizard.querySelectorAll(".pill").forEach((pill, i) => {
    pill.classList.toggle("active", i <= step);
    pill.classList.toggle("current", i === step);
  });

  wBack.classList.toggle("hidden", step === 0 || (step === 2 && jobRunning));
  if (step === 0) {
    wNext.textContent = "Continue";
    wNext.disabled = false;
    $("w-note").textContent = "";
  } else if (step === 1) {
    wNext.textContent = "Start Submission";
    wNext.disabled = authOk === null;
    $("w-note").textContent = "";
    runAuthCheck();
  } else {
    wNext.textContent = "Close";
    wNext.disabled = false;
    $("w-note").textContent = jobRunning
      ? "You can close now — publish will continue in background"
      : "";
  }
}

wBack.addEventListener("click", () => setWizardStep(Math.max(0, wizardStep - 1)));

wNext.addEventListener("click", async () => {
  if (wizardStep === 0) {
    const err = validateStep0();
    if (err) {
      wError.textContent = err;
      show(wError);
      return;
    }
    setWizardStep(1);
  } else if (wizardStep === 1) {
    await startSubmission();
  } else {
    closeWizard();
  }
});

function wizardTarget() {
  return wizard.querySelector('input[name="w-target"]:checked').value;
}

function validateStep0() {
  if (!$("w-app").value.trim()) return "App ID is required";
  if (!$("w-ipa").value.trim()) return "IPA path is required";
  if (wizardTarget() === "testflight" && !$("w-group").value.trim()) {
    return "TestFlight needs at least one beta group — create one in App Store Connect or enter its name/ID";
  }
  return null;
}

for (const radio of wizard.querySelectorAll('input[name="w-target"]')) {
  radio.addEventListener("change", () => {
    const testflight = wizardTarget() === "testflight";
    $("w-field-group").classList.toggle("hidden", !testflight);
    $("dest-hint").textContent = testflight
      ? "Distribute the build to beta testers"
      : "Attach the build to an App Store version";
  });
}

function applyAutofill(detected) {
  if (!detected) return;
  lastDetected = detected;
  const values = detected.values || {};
  const fill = (id, value) => {
    const input = $(id);
    if (value && !input.value) input.value = value;
  };
  fill("w-app", values.appId);
  fill("w-ipa", values.ipa);
  fill("w-group", values.group);
  fill("w-version", values.version);
  fill("s-app", values.appId);
  fill("s-version", values.version);

  const project = $("w-project");
  if (detected.projectDir && !project.value && document.activeElement !== project) {
    project.value = detected.projectDir;
  }

  // Don't clobber groups fetched for a manually entered App ID with an empty
  // detection result on the next status poll.
  const detectedGroups = detected.betaGroups || [];
  if (detectedGroups.length > 0 || !groupsFetchedFor) {
    const options = $("group-options");
    options.innerHTML = "";
    for (const name of detectedGroups) {
      const opt = document.createElement("option");
      opt.value = name;
      options.appendChild(opt);
    }
  }

  $("w-hint").textContent = detected.found
    ? `Auto-filled from ${detected.projectDir}`
    : "No app project found here";
  $("w-nodetect").classList.toggle("hidden", detected.found);
  updateCreateLink();
}

// -- project directory field --

let projectPosting = false;

async function submitProjectDir() {
  const input = $("w-project");
  const dir = input.value.trim();
  if (!dir || projectPosting) return;
  if (lastDetected && dir === lastDetected.projectDir) return;
  projectPosting = true;
  $("w-hint").textContent = "Scanning project…";
  try {
    const data = await postJSON("/api/config/project", { dir });
    input.value = data.projectDir;
    applyAutofill(data.detected);
  } catch (err) {
    $("w-hint").textContent = err.message;
  } finally {
    projectPosting = false;
  }
}

// Typing an App ID detection couldn't resolve should still surface the app's
// TestFlight groups (the datalist + default) instead of blocking validation.
let groupsFetchedFor = "";

async function refetchGroupsForAppId() {
  const appId = $("w-app").value.trim();
  if (!appId || appId === groupsFetchedFor) return;
  groupsFetchedFor = appId;
  try {
    const res = await fetch(`/api/groups?app=${encodeURIComponent(appId)}`);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.groups)) return;
    const options = $("group-options");
    options.innerHTML = "";
    for (const name of data.groups) {
      const opt = document.createElement("option");
      opt.value = name;
      options.appendChild(opt);
    }
    const group = $("w-group");
    if (!group.value && data.groups.length > 0) group.value = data.groups[0];
  } catch {
    /* offline or asc unavailable; validation copy already explains the manual path */
  }
}

$("w-app").addEventListener("change", refetchGroupsForAppId);

$("w-project").addEventListener("change", submitProjectDir);
$("w-project").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitProjectDir();
  }
});

// -- first-publish app creation --

const createLink = $("w-create-link");
const createBlock = $("w-create-block");
const cError = $("c-error");
const cLog = $("c-log");

function updateCreateLink() {
  const hasApp = Boolean($("w-app").value.trim());
  createLink.classList.toggle("hidden", hasApp || !createBlock.classList.contains("hidden"));
  if (hasApp && !jobRunning) hide(createBlock);
}

$("w-app").addEventListener("input", updateCreateLink);

createLink.addEventListener("click", () => {
  hide(createLink);
  show(createBlock);
  if (!$("c-bundle").value && lastDetected?.bundleId) {
    $("c-bundle").value = lastDetected.bundleId;
  }
});

$("c-cancel").addEventListener("click", () => {
  hide(createBlock);
  hide(cError);
  updateCreateLink();
});

$("c-create").addEventListener("click", async () => {
  hide(cError);
  const name = $("c-name").value.trim();
  const bundleId = $("c-bundle").value.trim();
  const sku = $("c-sku").value.trim();
  const missing = !name ? "App Name" : !bundleId ? "Bundle ID" : !sku ? "SKU" : null;
  if (missing) {
    cError.textContent = `${missing} is required`;
    show(cError);
    return;
  }
  cLog.textContent = "";
  show(cLog);
  $("c-create").disabled = true;
  try {
    await postJSON("/api/apps/create", { name, bundleId, sku });
  } catch (err) {
    cError.textContent = err.message;
    show(cError);
    $("c-create").disabled = false;
  }
});

async function runAuthCheck() {
  show($("auth-loading"));
  hide($("auth-results"));
  hide($("auth-bad"));
  try {
    const res = await fetch("/api/auth");
    const data = await res.json();
    const apiKey = data.apiKey || { ok: Boolean(data.ok), detail: data.detail || "" };
    const web = data.web || { ok: false, detail: "" };
    authOk = Boolean(apiKey.ok);
    hide($("auth-loading"));

    $("auth-key-dot").className = `dot ${apiKey.ok ? "dot-on" : "dot-err"}`;
    $("auth-key-label").textContent = apiKey.ok
      ? "API key (publishing) — configured"
      : "API key (publishing) — missing";
    $("auth-web-dot").className = `dot ${web.ok ? "dot-on" : "dot-amber"}`;
    $("auth-web-label").textContent = web.ok
      ? "Web session (app creation) — signed in"
      : "Web session (app creation) — not signed in; run `asc web auth login` if you need to create apps";
    show($("auth-results"));

    if (!apiKey.ok) {
      $("auth-detail").textContent = apiKey.detail || "";
      show($("auth-bad"));
    }
  } catch {
    authOk = false;
    hide($("auth-loading"));
    show($("auth-bad"));
  }
  if (wizardStep === 1) wNext.disabled = !authOk;
}

async function startSubmission() {
  hide(wError);
  wLog.textContent = "";
  setProgress("spinner", "Preparing", "Starting submission…");
  try {
    await postJSON("/api/publish", {
      target: wizardTarget(),
      appId: $("w-app").value.trim(),
      ipa: $("w-ipa").value.trim(),
      group: $("w-group").value.trim(),
      version: $("w-version").value.trim(),
      wait: $("w-wait").checked,
      submit: $("w-submit").checked,
    });
    setWizardStep(2);
  } catch (err) {
    wError.textContent = err.message;
    show(wError);
  }
}

// Rork-style striped progress bar: state is "spinner" (running), "done", "fail".
function setProgress(state, title, desc, pct) {
  const fill = $("prog-fill");
  const percent = state === "done" || state === "fail" ? 100 : (pct ?? 2);
  fill.className = state === "spinner" ? "progress-fill" : `progress-fill ${state}`;
  fill.style.width = `${percent}%`;
  const title_ = $("prog-title");
  title_.textContent = title;
  title_.classList.toggle("fail", state === "fail");
  $("prog-pct").textContent = state === "spinner" ? `${percent}%` : "";
  $("prog-desc").textContent = desc;
}

function updateProgressFromLine(text) {
  for (const [re, [title, desc, pct]] of PROGRESS_MAP) {
    if (re.test(text)) {
      setProgress("spinner", title, desc, pct);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// screenshots panel
// ---------------------------------------------------------------------------

const shotsPanel = $("shots-panel");
const shotsBackdrop = $("shots-backdrop");
const sLog = $("s-log");
const sError = $("s-error");

function openShots() {
  show(shotsPanel);
  show(shotsBackdrop);
  refreshShots();
}
function closeShots() {
  hide(shotsPanel);
  hide(shotsBackdrop);
}

$("shots-btn").addEventListener("click", openShots);
$("shots-close").addEventListener("click", closeShots);
shotsBackdrop.addEventListener("click", closeShots);

function flashShutter() {
  const flash = $("flash");
  flash.classList.remove("on");
  void flash.offsetWidth; // restart animation
  flash.classList.add("on");
}

async function captureShot() {
  flashShutter();
  try {
    await postJSON("/api/screenshots/capture", { name: `shot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}` });
    await refreshShots();
  } catch (err) {
    show(shotsPanel);
    show(shotsBackdrop);
    showError(sError, err.message);
  }
}

$("capture-btn").addEventListener("click", captureShot);
$("shots-capture").addEventListener("click", captureShot);

function shotCard({ kind, shot }) {
  const card = document.createElement("div");
  card.className = `shot-card ${kind}`;
  const img = document.createElement("img");
  img.src = `/shots/${kind}/${shot.file}?t=${shot.mtime}`;
  img.alt = shot.name;
  img.loading = "lazy";
  card.appendChild(img);

  const name = document.createElement("div");
  name.className = "shot-name";
  name.textContent = shot.name;
  card.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "shot-actions";

  if (kind === "raw") {
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      closeShots();
      window.__rorkEditor?.open({ shotFile: shot.file });
    });
    actions.appendChild(editBtn);

    const frameBtn = document.createElement("button");
    frameBtn.textContent = "Frame";
    frameBtn.addEventListener("click", async () => {
      frameBtn.textContent = "Framing…";
      frameBtn.disabled = true;
      hide(sError);
      try {
        await postJSON("/api/screenshots/frame", {
          name: shot.name,
          device: $("frame-device").value,
        });
        await refreshShots();
      } catch (err) {
        showError(sError, err.message);
        frameBtn.textContent = "Frame";
        frameBtn.disabled = false;
      }
    });
    actions.appendChild(frameBtn);
  }

  const viewBtn = document.createElement("button");
  viewBtn.textContent = "View";
  viewBtn.addEventListener("click", () => window.open(img.src, "_blank"));
  actions.appendChild(viewBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", async () => {
    await fetch(`/api/screenshots/${kind}/${shot.name}`, { method: "DELETE" });
    await refreshShots();
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

async function refreshShots() {
  try {
    const res = await fetch("/api/screenshots");
    const data = await res.json();

    if (frameDevices.length === 0 && data.frameDevices) {
      frameDevices = data.frameDevices;
      const select = $("frame-device");
      select.innerHTML = "";
      for (const device of frameDevices) {
        const opt = document.createElement("option");
        opt.value = device;
        opt.textContent = device;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => (frameDeviceTouched = true));
      applyFrameDeviceDefault();
    }

    const rawGrid = $("raw-grid");
    const framedGrid = $("framed-grid");
    const listingGrid = $("listing-grid");
    const listing = data.listing || [];
    rawGrid.innerHTML = "";
    framedGrid.innerHTML = "";
    listingGrid.innerHTML = "";
    for (const shot of data.raw) rawGrid.appendChild(shotCard({ kind: "raw", shot }));
    for (const shot of data.framed) framedGrid.appendChild(shotCard({ kind: "framed", shot }));
    for (const shot of listing) listingGrid.appendChild(shotCard({ kind: "listing", shot }));

    $("raw-empty").classList.toggle("hidden", data.raw.length > 0);
    $("framed-empty").classList.toggle("hidden", data.framed.length > 0);
    $("listing-empty").classList.toggle("hidden", listing.length > 0);

    const count = data.raw.length + data.framed.length + listing.length;
    const badge = $("shots-count");
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  } catch {
    /* server unreachable; status poll will surface it */
  }
}

$("s-upload").addEventListener("click", async () => {
  hide(sError);
  sLog.textContent = "";
  show(sLog);
  try {
    await postJSON("/api/screenshots/upload", {
      appId: $("s-app").value.trim(),
      version: $("s-version").value.trim(),
      deviceType: $("s-device-type").value,
      source: shotsPanel.querySelector('input[name="s-source"]:checked').value,
    });
  } catch (err) {
    showError(sError, err.message);
  }
});

// ---------------------------------------------------------------------------
// status + SSE
// ---------------------------------------------------------------------------

/** Default the frame bezel to the booted simulator ("iPhone 17 Pro" →
 * "iphone-17-pro") until the user picks one themselves. */
function applyFrameDeviceDefault() {
  if (frameDeviceTouched || !simDeviceSlug || frameDevices.length === 0) return;
  if (frameDevices.includes(simDeviceSlug)) $("frame-device").value = simDeviceSlug;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const status = await res.json();
    if (status.device?.name) {
      simDeviceSlug = status.device.name.toLowerCase().replace(/\s+/g, "-");
      applyFrameDeviceDefault();
    }
    applyAutofill(status.detected);
    applyJobStatus(status.job);
  } catch {
    /* server unreachable; retry on next poll */
  }
}

function applyJobStatus(job) {
  if (!job) return;
  jobRunning = job.state === "running";
  jobKind = job.kind;
  $("publish-btn").classList.toggle("running", jobRunning);

  // popover status row
  const row = $("pub-status-row");
  const dot = $("pub-status-dot");
  const label = $("pub-status-label");
  if (job.state === "idle" || !job.kind) {
    hide(row);
  } else {
    show(row);
    const what =
      job.kind === "screenshots-upload" ? "Screenshot upload" :
      job.kind === "app-create" ? "App creation" : "Publish";
    if (job.state === "running") {
      dot.className = "dot dot-amber";
      label.textContent = `${what} in progress…`;
    } else if (job.state === "success") {
      dot.className = "dot dot-on";
      label.textContent = `${what} succeeded`;
    } else {
      dot.className = "dot dot-err";
      label.textContent = `${what} failed`;
    }
  }

  // app-create terminal states: drop the new app ID into the form
  if (job.kind === "app-create" && !jobRunning && job.state !== "idle") {
    $("c-create").disabled = false;
    if (job.state === "success" && job.result?.appId) {
      // fill-if-empty so a later status poll never clobbers user edits
      $("w-app").value = $("w-app").value || job.result.appId;
      $("s-app").value = $("s-app").value || job.result.appId;
      hide(createBlock);
      hide(cError);
      updateCreateLink();
    } else if (job.state === "error") {
      cError.textContent = "App creation failed — see output above (a cached web session from `asc web auth login` is required)";
      show(cError);
    }
  }

  // wizard progress card terminal states
  if (job.kind === "publish" && !jobRunning && job.state !== "idle") {
    if (job.state === "success") {
      setProgress("done", "Complete", "Your app has been uploaded!");
    } else if (job.state === "error") {
      setProgress("fail", "Failed", `asc exited with code ${job.exitCode}`);
    }
    $("w-note").textContent = "";
    if (wizardStep === 2) wBack.classList.remove("hidden");
  }
}

function connectStream() {
  const source = new EventSource("/api/publish/stream");
  source.addEventListener("status", (e) => applyJobStatus(JSON.parse(e.data)));
  source.addEventListener("line", (e) => {
    const line = JSON.parse(e.data);
    if (jobKind === "screenshots-upload") {
      show(sLog);
      appendLine(sLog, line);
    } else if (jobKind === "app-create") {
      show(cLog);
      appendLine(cLog, line);
    } else {
      appendLine(wLog, line);
      updateProgressFromLine(line.text);
    }
  });
  source.onerror = () => {
    source.close();
    setTimeout(connectStream, 2000);
  };
}

// ---------------------------------------------------------------------------
// hide serve-sim wordmark inside the same-origin /.sim iframe
// ---------------------------------------------------------------------------

function hideServeSimBranding() {
  const frame = $("sim-frame");
  let observer = null;

  const hideWordmark = (doc) => {
    try {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        // Only touch small leaf-ish elements whose text is exactly the target,
        // never a container that happens to include the text.
        if (el.childElementCount > 1) continue;
        const text = (el.textContent || "").trim().toLowerCase();
        if (text === "serve-sim" || text === "serve sim") {
          const target = el.closest("header, h1, h2, a") || el;
          if ((target.textContent || "").trim().length <= 12) {
            target.style.visibility = "hidden";
          } else {
            el.style.visibility = "hidden";
          }
        } else if (text === "ax tree" && el.childElementCount === 0) {
          // Tools-panel section header (literal "AX Tree", uppercased by CSS).
          // Mutate the existing text node instead of textContent so React's
          // reference to the node stays valid across re-renders.
          const node = el.firstChild;
          if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = "Element selector";
        }
      }
    } catch {
      /* iframe not ready or DOM changed shape; ignore */
    }
  };

  const attach = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      hideWordmark(doc);
      if (observer) observer.disconnect();
      // serve-sim's preview is a React app: re-hide after re-renders.
      observer = new MutationObserver(() => hideWordmark(doc));
      observer.observe(doc.body, { childList: true, subtree: true });
    } catch {
      /* cross-origin or not loaded yet; ignore */
    }
  };

  frame.addEventListener("load", () => {
    attach();
    // React mounts after document load; retry briefly.
    for (const delay of [250, 750, 1500, 3000]) setTimeout(attach, delay);
  });
  attach();
}

hideServeSimBranding();

// ---------------------------------------------------------------------------
// keep the simulator centered in the /.sim iframe's visible space
//
// serve-sim's stage is a full-width flex column centered on the *viewport*,
// with compensating padding when its fixed side panels are open. That
// compensation bails out (returns 0) when the shift would exceed the panel
// width — common in narrow windows — leaving the device centered on the full
// viewport while a panel overlays one side, i.e. off-center in the space you
// can actually see. We override the stage padding via injected CSS custom
// properties measured from the actually-open panels.
// ---------------------------------------------------------------------------

function centerSimStage() {
  const frame = $("sim-frame");
  const STYLE_ID = "rork-center-fix";
  const MIN_STAGE_WIDTH = 280;

  const tick = () => {
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !doc.body || !doc.head || !win) return;

      if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
          div[class*="h-screen"][class*="bg-page"] {
            padding-left: calc(24px + var(--rork-inset-left, 0px)) !important;
            padding-right: calc(24px + var(--rork-inset-right, 0px)) !important;
          }`;
        doc.head.appendChild(style);
      }

      // Open drawers are <aside aria-hidden="false"> pinned to an edge.
      let left = 0;
      let right = 0;
      for (const aside of doc.querySelectorAll('aside[aria-hidden="false"]')) {
        const rect = aside.getBoundingClientRect();
        if (rect.width <= 0) continue;
        if (rect.left < 40) {
          left = Math.max(left, rect.right);
        } else if (rect.right > win.innerWidth - 40) {
          right = Math.max(right, win.innerWidth - rect.left);
        }
      }
      // If compensating would crush the stage, fall back to full-viewport
      // centering (serve-sim's own behavior).
      if (win.innerWidth - left - right - 48 < MIN_STAGE_WIDTH) {
        left = 0;
        right = 0;
      }
      doc.documentElement.style.setProperty("--rork-inset-left", `${left}px`);
      doc.documentElement.style.setProperty("--rork-inset-right", `${right}px`);
    } catch {
      /* iframe not ready or DOM changed; try again next tick */
    }
  };

  // Interval instead of observers: survives iframe reloads, tracks panel
  // open/close/resize animations, and two queries per tick is cheap.
  setInterval(tick, 400);
  frame.addEventListener("load", tick);
}

centerSimStage();

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

loadStatus();
refreshShots();
connectStream();
setInterval(loadStatus, 15000);

$("open-editor-btn").addEventListener("click", () => {
  closeShots();
  window.__rorkEditor?.open({});
});

// Bridge for editor.js (loaded after this script).
window.__rork = { refreshShots };
