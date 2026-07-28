import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setupAppController } from "./app-controller";
import { setupEditorController } from "./editor-controller";

function App() {
  useEffect(() => {
    const disposeEditor = setupEditorController();
    const disposeApp = setupAppController();
    return () => {
      disposeApp();
      disposeEditor();
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-rork-bg font-sans text-rork-fg antialiased">
      <header className="topbar">
        <div className="brand">
          <img src="/rork-logo.svg" alt="Rork" className="brand-logo" />
          <span className="brand-badge">Local</span>
        </div>
        <div className="topbar-actions">
          <button id="capture-btn" className="tool-btn" title="Take screenshot">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </button>
          <button id="shots-btn" className="tool-btn" title="Screenshots">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
            <span id="shots-count" className="shots-count hidden">
              0
            </span>
          </button>
          <button id="publish-btn" className="publish-btn" title="Share your app">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" x2="12" y1="2" y2="15" />
            </svg>
            Publish
            <span className="pub-status" aria-hidden="true">
              <span className="pub-dot"></span>
            </span>
          </button>
        </div>
      </header>

      <main className="stage">
        <iframe id="sim-frame" src="/.sim" title="iOS Simulator" allow="clipboard-read; clipboard-write"></iframe>
        <div id="countdown" className="countdown hidden">
          <span id="countdown-num">3</span>
        </div>
        <div id="flash" className="flash"></div>
      </main>

      <footer className="footer">
        powered by&nbsp;
        <a href="https://github.com/EvanBacon/serve-sim" target="_blank" rel="noopener">
          serve-sim
        </a>
        &nbsp;by&nbsp;
        <a className="author" href="https://github.com/EvanBacon" target="_blank" rel="noopener">
          Evan Bacon
        </a>
        &nbsp;·&nbsp;
        <a href="https://github.com/rorkai/App-Store-Connect-CLI" target="_blank" rel="noopener">
          asc
        </a>
        &nbsp;CLI by&nbsp;
        <a className="author" href="https://github.com/rudrankriyam" target="_blank" rel="noopener">
          Rudrank Riyam
        </a>
      </footer>

      <div id="popover" className="popover hidden" role="dialog" aria-label="Publish">
        <header className="popover-header">
          <h2>Publish</h2>
        </header>
        <div className="popover-body">
          <div className="pub-section">
            <div>
              <h4 className="section-title">App Store</h4>
              <p className="section-sub">Submit this app's signed build to TestFlight and the App Store</p>
            </div>
            <div id="pub-status-row" className="status-row hidden">
              <span id="pub-status-dot" className="dot dot-idle"></span>
              <span id="pub-status-label"></span>
            </div>
            <button id="open-wizard-btn" className="cta-btn btn-full">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
              </svg>
              Submit to App Store
            </button>
          </div>
          <div className="popover-divider"></div>
          <div className="pub-section">
            <div>
              <h4 className="section-title">Screenshots</h4>
              <p className="section-sub">Capture, frame, and upload App Store listing screenshots</p>
            </div>
            <button id="open-shots-btn" className="cta-btn cta-secondary btn-full">
              Open Screenshots
            </button>
          </div>
        </div>
      </div>
      <div id="wizard-backdrop" className="sheet-backdrop hidden"></div>
      <div id="wizard" className="sheet hidden" role="dialog" aria-label="Publish to App Store">
        <div className="sheet-header">
          <div className="sheet-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm-1.62 5.53a.9.9 0 0 1 1.23.33l.4.7.41-.7a.9.9 0 0 1 1.55.9l-3.07 5.3h2.61c.85 0 1.33 1 .8 1.66h-7.4a.9.9 0 0 1 0-1.8h2.5l2.63-4.55-.99-1.7a.9.9 0 0 1 .33-1.24v.1zm-3.53 9.6.6-1.03c.35-.4 1.02-.35 1.42.09.3.4.32.94.05 1.4l-.53.92a.9.9 0 0 1-1.55-.9l.01-.48zm10.9-.68h-1.9l1.2 2.06a.9.9 0 1 1-1.56.9L12.4 11.6c-.35-.75-.13-1.66.52-2.06.62.36 1.03.9 1.42 1.57l.61 1.05h2.8a.9.9 0 0 1 0 1.8v-.5z" />
            </svg>
            Publish to App Store
          </div>
          <button id="wizard-close" className="icon-btn" aria-label="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="stepper">
          <div className="stepper-meta">
            <span id="step-count">Step 1 of 3</span>
            <span id="step-name">App Info</span>
          </div>
          <div className="pills" aria-label="Submission progress">
            <span className="pill active current" data-pill="0">
              <span className="pill-bar"></span>
              <span className="pill-label">App Info</span>
            </span>
            <span className="pill" data-pill="1">
              <span className="pill-bar"></span>
              <span className="pill-label">App Store Connect</span>
            </span>
            <span className="pill" data-pill="2">
              <span className="pill-bar"></span>
              <span className="pill-label">Submit</span>
            </span>
          </div>
        </div>

        <div className="sheet-body">
          <section className="step" data-step="0">
            <label className="field project-field">
              <span>Project</span>
              <input
                id="w-project"
                className="mono"
                placeholder="/path/to/your-app"
                autoComplete="off"
                spellCheck="false"
              />
              <em id="w-hint" className="autofill-hint">
                Directory scanned for app.json, Xcode projects, and .ipa builds
              </em>
            </label>
            <div id="w-nodetect" className="banner warn hidden">
              <div className="banner-title">No app project found</div>
              <p>
                Nothing was detected in this folder. Point the Project field at your app's directory (the one with{" "}
                <code>app.json</code> or an Xcode project), or fill in the fields below manually.
              </p>
            </div>
            <div className="step-grid">
              <div className="col">
                <label className="field">
                  <span>App ID</span>
                  <input id="w-app" placeholder="eg. 6759231657" autoComplete="off" spellCheck="false" />
                  <em>Your App Store Connect app ID</em>
                </label>
                <div id="w-create-wrap">
                  <button id="w-create-link" type="button" className="link-btn hidden">
                    + Create new app on App Store Connect
                  </button>
                  <div id="w-create-block" className="create-block hidden">
                    <label className="field">
                      <span>App Name</span>
                      <input id="c-name" placeholder="eg. My App" autoComplete="off" spellCheck="false" />
                    </label>
                    <label className="field">
                      <span>Bundle ID</span>
                      <input
                        id="c-bundle"
                        className="mono"
                        placeholder="eg. com.example.app"
                        autoComplete="off"
                        spellCheck="false"
                      />
                    </label>
                    <label className="field">
                      <span>SKU</span>
                      <input id="c-sku" placeholder="eg. MYAPP123" autoComplete="off" spellCheck="false" />
                    </label>
                    <div className="create-actions">
                      <button id="c-create" type="button" className="cta-btn small-btn">
                        Create App
                      </button>
                      <button id="c-cancel" type="button" className="ghost-btn small-btn">
                        Cancel
                      </button>
                    </div>
                    <p id="c-error" className="form-error hidden"></p>
                    <pre id="c-log" className="console small hidden"></pre>
                  </div>
                </div>
                <label className="field">
                  <span>App Version</span>
                  <input id="w-version" placeholder="eg. 1.0.0" autoComplete="off" spellCheck="false" />
                  <em>Semantic version (major.minor.patch)</em>
                </label>
                <label className="field">
                  <span>IPA path</span>
                  <input
                    id="w-ipa"
                    className="mono"
                    placeholder="eg. build/MyApp.ipa"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <em>The signed build to upload</em>
                </label>
              </div>
              <div className="col">
                <div className="field">
                  <span>Destination</span>
                  <div className="segmented">
                    <label>
                      <input type="radio" name="w-target" defaultValue="testflight" defaultChecked />
                      <span>TestFlight</span>
                    </label>
                    <label>
                      <input type="radio" name="w-target" defaultValue="appstore" />
                      <span>App Store</span>
                    </label>
                  </div>
                  <em id="dest-hint">Distribute the build to beta testers</em>
                </div>
                <label className="field" id="w-field-group">
                  <span>Beta group(s)</span>
                  <input
                    id="w-group"
                    list="group-options"
                    placeholder="eg. External Testers"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <datalist id="group-options"></datalist>
                  <em>Comma-separated TestFlight group names or IDs</em>
                </label>
                <div className="checks">
                  <label className="check">
                    <input type="checkbox" id="w-wait" defaultChecked />
                    <span>Wait for processing</span>
                  </label>
                  <label className="check">
                    <input type="checkbox" id="w-submit" />
                    <span>Submit for review</span>
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section className="step hidden" data-step="1">
            <div id="auth-card" className="auth-card">
              <div className="auth-spinner" id="auth-loading">
                <span className="spinner"></span> Checking App Store Connect credentials…
              </div>
              <div id="auth-results" className="hidden">
                <div className="auth-row">
                  <span id="auth-key-dot" className="dot dot-idle"></span>
                  <span id="auth-key-label">API key (publishing)</span>
                </div>
                <div className="auth-row">
                  <span id="auth-web-dot" className="dot dot-idle"></span>
                  <span id="auth-web-label">Web session (app creation)</span>
                </div>
                <p className="auth-note">
                  Credentials come from <code>asc auth login</code> (API key) and <code>asc web auth login</code> (web
                  session) and are stored locally. Nothing is sent anywhere except Apple.
                </p>
              </div>
              <div id="auth-bad" className="hidden">
                <div className="banner">
                  <div className="banner-title">App Store Connect API key required</div>
                  <p>
                    Publishing talks to the App Store Connect API. Create a key at App Store Connect → Users and Access
                    → Integrations, then run:
                  </p>
                  <pre>asc auth login</pre>
                  <p id="auth-detail" className="auth-detail"></p>
                </div>
              </div>
            </div>
          </section>

          <section className="step hidden" data-step="2">
            <div className="progress-block">
              <div className="progress-heading">
                <span id="prog-title" className="progress-title">
                  Preparing
                </span>
                <span id="prog-pct" className="progress-pct">
                  2%
                </span>
              </div>
              <div className="progress-track">
                <div id="prog-fill" className="progress-fill" style={{ width: "2%" }}>
                  <div className="progress-stripes"></div>
                </div>
              </div>
              <p id="prog-desc" className="progress-desc">
                Starting submission…
              </p>
            </div>
            <pre id="w-log" className="console" aria-live="polite"></pre>
          </section>
        </div>

        <div className="sheet-footer">
          <span id="w-note" className="footer-note"></span>
          <div className="footer-btns">
            <button id="w-back" className="ghost-btn hidden">
              Back
            </button>
            <button id="w-next" className="cta-btn">
              Continue
            </button>
          </div>
        </div>
        <p id="w-error" className="form-error hidden"></p>
      </div>
      <div id="shots-backdrop" className="sheet-backdrop hidden"></div>
      <aside id="shots-panel" className="drawer hidden" aria-label="Screenshots">
        <div className="drawer-header">
          <h2>Screenshots</h2>
          <div className="drawer-header-actions">
            <button id="shots-capture" className="detect-btn" type="button">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ verticalAlign: -1, marginRight: 4 }}
              >
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              Capture
            </button>
            <button id="shots-close" className="icon-btn" aria-label="Close">
              &times;
            </button>
          </div>
        </div>

        <div className="shots-scroll">
          <div className="shots-group">
            <div className="group-title">
              Raw captures{" "}
              <span id="raw-empty" className="group-empty">
                — none yet, hit Capture
              </span>
            </div>
            <div id="raw-grid" className="shot-grid"></div>
          </div>

          <div className="shots-group">
            <div className="group-title-row">
              <div className="group-title">
                Framed{" "}
                <span id="framed-empty" className="group-empty">
                  — frame a capture below
                </span>
              </div>
              <select id="frame-device" className="mini-select"></select>
            </div>
            <div id="framed-grid" className="shot-grid"></div>
          </div>

          <div className="shots-group">
            <div className="group-title-row">
              <div className="group-title">
                Listing slides{" "}
                <span id="listing-empty" className="group-empty">
                  — design in the editor
                </span>
              </div>
              <button id="open-editor-btn" className="detect-btn" type="button">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ verticalAlign: -1, marginRight: 4 }}
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                Open editor
              </button>
            </div>
            <div id="listing-grid" className="shot-grid"></div>
          </div>

          <div className="shots-group upload-group">
            <div className="group-title">Upload to App Store</div>
            <div className="upload-form">
              <label className="field">
                <span>App ID</span>
                <input id="s-app" placeholder="eg. 6759231657" spellCheck="false" />
              </label>
              <div className="upload-row">
                <label className="field">
                  <span>Version</span>
                  <input id="s-version" placeholder="1.0.0" spellCheck="false" />
                </label>
                <label className="field">
                  <span>Device type</span>
                  <select id="s-device-type" className="mini-select tall">
                    <option value="IPHONE_61" selected>
                      IPHONE_61 (6.1")
                    </option>
                    <option value="IPHONE_67">IPHONE_67 (6.7")</option>
                    <option value="IPHONE_65">IPHONE_65 (6.5")</option>
                  </select>
                </label>
              </div>
              <div className="segmented small">
                <label>
                  <input type="radio" name="s-source" defaultValue="framed" defaultChecked />
                  <span>Framed</span>
                </label>
                <label>
                  <input type="radio" name="s-source" defaultValue="raw" />
                  <span>Raw</span>
                </label>
                <label>
                  <input type="radio" name="s-source" defaultValue="listing" />
                  <span>Slides</span>
                </label>
              </div>
              <button id="s-upload" className="cta-btn">
                Accept &amp; Upload
              </button>
              <p id="s-error" className="form-error hidden"></p>
            </div>
            <pre id="s-log" className="console small hidden"></pre>
          </div>
        </div>
      </aside>

      <div id="editor" className="editor hidden" role="dialog" aria-label="Screenshot editor">
        <div className="editor-surface">
          <div className="editor-header">
            <div className="sheet-title">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              Screenshot Editor
            </div>
            <div className="editor-header-actions">
              <select id="ed-preset" className="mini-select tall" title="Canvas size"></select>
              <button id="ed-save" className="cta-btn small-btn">
                Save slides
              </button>
              <button id="ed-close" className="icon-btn" aria-label="Close">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="editor-body">
            <aside className="editor-deck">
              <div id="ed-strip" className="ed-strip"></div>
              <button id="ed-add" className="ghost-btn ed-add" type="button">
                + Add slide
              </button>
            </aside>
            <div className="editor-stage">
              <canvas id="ed-canvas"></canvas>
              <div id="ed-drag-hint" className="ed-drag-hint">
                drag to move the device · scroll to resize
              </div>
            </div>
            <aside className="editor-controls">
              <label className="field">
                <span>Screenshot</span>
                <select id="ed-shot" className="mini-select tall"></select>
                <em>Raw simulator captures — take more with Capture</em>
              </label>

              <div className="field">
                <span>Background</span>
                <div className="segmented small">
                  <label>
                    <input type="radio" name="ed-bg-kind" defaultValue="solid" defaultChecked />
                    <span>Solid</span>
                  </label>
                  <label>
                    <input type="radio" name="ed-bg-kind" defaultValue="gradient" />
                    <span>Gradient</span>
                  </label>
                </div>
              </div>
              <div id="ed-bg-solid" className="ed-color-row">
                <input type="color" id="ed-bg-color" defaultValue="#101014" />
                <span className="ed-color-label">Fill</span>
              </div>
              <div id="ed-bg-gradient" className="hidden">
                <div id="ed-gradient-presets" className="ed-swatches"></div>
                <div className="ed-color-row">
                  <input type="color" id="ed-grad-from" defaultValue="#1a1a2e" />
                  <span className="ed-color-label">From</span>
                  <input type="color" id="ed-grad-to" defaultValue="#4a2a6a" />
                  <span className="ed-color-label">To</span>
                </div>
                <label className="field ed-range">
                  <span>
                    Angle <b id="ed-angle-val">180°</b>
                  </span>
                  <input type="range" id="ed-angle" min="0" max="360" step="15" defaultValue="180" />
                </label>
              </div>

              <label className="field">
                <span>Headline</span>
                <input id="ed-headline" placeholder="Track your progress" autoComplete="off" />
              </label>
              <div className="ed-color-row">
                <input type="color" id="ed-headline-color" defaultValue="#ffffff" />
                <span className="ed-color-label">Text color</span>
              </div>
              <label className="field ed-range">
                <span>
                  Text size <b id="ed-hsize-val">110</b>
                </span>
                <input type="range" id="ed-hsize" min="64" max="180" step="2" defaultValue="110" />
              </label>
              <label className="field ed-range">
                <span>
                  Text position <b id="ed-hy-val">8%</b>
                </span>
                <input type="range" id="ed-hy" min="2" max="40" step="1" defaultValue="8" />
              </label>

              <label className="field ed-range">
                <span>
                  Device size <b id="ed-dscale-val">80%</b>
                </span>
                <input type="range" id="ed-dscale" min="40" max="110" step="1" defaultValue="80" />
              </label>
              <button id="ed-dreset" className="ghost-btn small-btn" type="button">
                Reset device position
              </button>

              <p id="ed-error" className="form-error hidden"></p>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App />);
