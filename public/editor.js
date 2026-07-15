// Screenshot editor: composes App Store listing slides (background + headline
// + device-framed capture) on a <canvas> at exact App Store resolution.
// Exports deterministic PNGs via toDataURL and saves them through
// POST /api/screenshots/slide; deck state persists via /api/screenshots/deck.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");

  // Portrait presets matching `asc screenshots sizes` device types.
  const PRESETS = [
    { id: "IPHONE_69", label: 'iPhone 6.9″ — 1290×2796', w: 1290, h: 2796 },
    { id: "IPHONE_65", label: 'iPhone 6.5″ — 1284×2778', w: 1284, h: 2778 },
    { id: "IPHONE_61", label: 'iPhone 6.1″ — 1179×2556', w: 1179, h: 2556 },
    { id: "IPAD_PRO_3GEN_129", label: 'iPad 12.9″ — 2048×2732', w: 2048, h: 2732 },
  ];

  const GRADIENTS = [
    { from: "#1a1a2e", to: "#4a2a6a" }, // indigo night
    { from: "#0f2027", to: "#2c5364" }, // deep teal
    { from: "#232526", to: "#414345" }, // graphite
    { from: "#42275a", to: "#734b6d" }, // plum
    { from: "#141e30", to: "#243b55" }, // midnight navy
    { from: "#3a1c71", to: "#d76d77" }, // violet sunset
  ];

  const state = {
    preset: PRESETS[0],
    selected: 0,
    slides: [],
    rawShots: [],
    open: false,
  };

  function defaultSlide(shotFile) {
    return {
      shot: shotFile || null,
      bg: { kind: "gradient", color: "#101014", from: "#1a1a2e", to: "#4a2a6a", angle: 180 },
      headline: { text: "Your headline", color: "#ffffff", size: 110, y: 0.08 },
      device: { cx: 0.5, cy: 0.64, scale: 0.8 },
    };
  }

  // -- image cache ----------------------------------------------------------

  const imageCache = new Map();
  function loadImage(src) {
    if (!imageCache.has(src)) {
      imageCache.set(
        src,
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        }),
      );
    }
    return imageCache.get(src);
  }

  // -- rendering ------------------------------------------------------------

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawBackground(ctx, slide, W, H) {
    const bg = slide.bg;
    if (bg.kind === "gradient") {
      const rad = ((bg.angle - 90) * Math.PI) / 180;
      const cx = W / 2, cy = H / 2;
      const len = (Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad))) / 2;
      const grad = ctx.createLinearGradient(
        cx - Math.cos(rad) * len, cy - Math.sin(rad) * len,
        cx + Math.cos(rad) * len, cy + Math.sin(rad) * len,
      );
      grad.addColorStop(0, bg.from);
      grad.addColorStop(1, bg.to);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = bg.color;
    }
    ctx.fillRect(0, 0, W, H);
  }

  /** Device geometry in canvas pixels; shared by renderer and hit-testing. */
  function deviceRect(slide, img, W, H) {
    const outerW = slide.device.scale * W;
    const pad = outerW * 0.032; // bezel thickness
    const screenW = outerW - pad * 2;
    const aspect = img && img.naturalWidth ? img.naturalWidth / img.naturalHeight : 1290 / 2796;
    const screenH = screenW / aspect;
    const outerH = screenH + pad * 2;
    const x = slide.device.cx * W - outerW / 2;
    const y = slide.device.cy * H - outerH / 2;
    return { x, y, outerW, outerH, pad, screenW, screenH };
  }

  function drawDevice(ctx, slide, img, W, H) {
    const d = deviceRect(slide, img, W, H);
    const outerR = d.outerW * 0.135;
    const screenR = Math.max(outerR - d.pad, d.outerW * 0.09);

    ctx.save();
    // soft drop shadow behind the whole device
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = W * 0.045;
    ctx.shadowOffsetY = W * 0.012;
    ctx.fillStyle = "#1b1b1f";
    roundedRectPath(ctx, d.x, d.y, d.outerW, d.outerH, outerR);
    ctx.fill();
    ctx.restore();

    // hairline highlight on the frame edge
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = Math.max(2, W * 0.0016);
    roundedRectPath(ctx, d.x, d.y, d.outerW, d.outerH, outerR);
    ctx.stroke();
    ctx.restore();

    // screenshot clipped to the screen area (cover fit, top-aligned)
    if (img) {
      ctx.save();
      roundedRectPath(ctx, d.x + d.pad, d.y + d.pad, d.screenW, d.screenH, screenR);
      ctx.clip();
      const scale = Math.max(d.screenW / img.naturalWidth, d.screenH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, d.x + d.pad + (d.screenW - dw) / 2, d.y + d.pad, dw, dh);
      ctx.restore();
    } else {
      ctx.save();
      ctx.fillStyle = "#000";
      roundedRectPath(ctx, d.x + d.pad, d.y + d.pad, d.screenW, d.screenH, screenR);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = `500 ${d.screenW * 0.06}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Pick a screenshot →", d.x + d.outerW / 2, d.y + d.outerH / 2);
      ctx.restore();
    }
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = probe;
      }
      if (lines.length === 3) break;
    }
    if (line && lines.length < 3) lines.push(line);
    return lines;
  }

  function drawHeadline(ctx, slide, W, H, k) {
    const h = slide.headline;
    if (!h.text) return;
    const size = h.size * k;
    ctx.save();
    ctx.font = `700 ${size}px -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif`;
    ctx.fillStyle = h.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const lines = wrapText(ctx, h.text, W * 0.86);
    const lineHeight = size * 1.12;
    lines.forEach((line, i) => {
      ctx.fillText(line, W / 2, h.y * H + i * lineHeight);
    });
    ctx.restore();
  }

  /** Render one slide onto ctx at W×H. k scales absolute values (font px)
   * that are stored relative to the preset's full resolution. */
  async function renderSlide(ctx, slide, W, H) {
    const k = W / state.preset.w;
    const img = slide.shot ? await loadImage(`/shots/raw/${slide.shot}`) : null;
    drawBackground(ctx, slide, W, H);
    drawDevice(ctx, slide, img, W, H);
    drawHeadline(ctx, slide, W, H, k);
  }

  // -- main canvas ----------------------------------------------------------

  const canvas = () => $("ed-canvas");
  let renderToken = 0;

  async function renderMain() {
    const slide = state.slides[state.selected];
    if (!slide) return;
    const el = canvas();
    if (el.width !== state.preset.w || el.height !== state.preset.h) {
      el.width = state.preset.w;
      el.height = state.preset.h;
    }
    const token = ++renderToken;
    const ctx = el.getContext("2d");
    // render into the live canvas only if no newer render started meanwhile
    const off = document.createElement("canvas");
    off.width = el.width;
    off.height = el.height;
    await renderSlide(off.getContext("2d"), slide, off.width, off.height);
    if (token !== renderToken) return;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(off, 0, 0);
  }

  // -- deck strip -----------------------------------------------------------

  async function renderStrip() {
    const strip = $("ed-strip");
    strip.innerHTML = "";
    for (let i = 0; i < state.slides.length; i++) {
      const item = document.createElement("div");
      item.className = `ed-thumb${i === state.selected ? " active" : ""}`;
      const thumb = document.createElement("canvas");
      const tw = 108;
      thumb.width = tw;
      thumb.height = Math.round((tw * state.preset.h) / state.preset.w);
      item.appendChild(thumb);

      const idx = document.createElement("span");
      idx.className = "ed-thumb-num";
      idx.textContent = String(i + 1);
      item.appendChild(idx);

      const tools = document.createElement("div");
      tools.className = "ed-thumb-tools";
      const mk = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        tools.appendChild(b);
      };
      mk("↑", "Move up", () => moveSlide(i, -1));
      mk("↓", "Move down", () => moveSlide(i, 1));
      mk("⧉", "Duplicate", () => duplicateSlide(i));
      mk("✕", "Delete", () => deleteSlide(i));
      item.appendChild(tools);

      item.addEventListener("click", () => selectSlide(i));
      strip.appendChild(item);
      renderSlide(thumb.getContext("2d"), state.slides[i], thumb.width, thumb.height);
    }
  }

  function selectSlide(i) {
    state.selected = Math.max(0, Math.min(i, state.slides.length - 1));
    syncControls();
    renderMain();
    renderStrip();
  }

  function moveSlide(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.slides.length) return;
    const [s] = state.slides.splice(i, 1);
    state.slides.splice(j, 0, s);
    state.selected = j;
    afterMutation();
  }

  function duplicateSlide(i) {
    state.slides.splice(i + 1, 0, JSON.parse(JSON.stringify(state.slides[i])));
    state.selected = i + 1;
    afterMutation();
  }

  function deleteSlide(i) {
    if (state.slides.length === 1) {
      state.slides[0] = defaultSlide(state.rawShots[0]?.file || null);
    } else {
      state.slides.splice(i, 1);
    }
    state.selected = Math.min(state.selected, state.slides.length - 1);
    afterMutation();
  }

  function afterMutation() {
    syncControls();
    renderMain();
    renderStrip();
    scheduleDeckSave();
  }

  // -- deck persistence -----------------------------------------------------

  let deckTimer = null;
  function scheduleDeckSave() {
    clearTimeout(deckTimer);
    deckTimer = setTimeout(() => {
      fetch("/api/screenshots/deck", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceType: state.preset.id,
          selected: state.selected,
          slides: state.slides,
        }),
      }).catch(() => {});
    }, 600);
  }

  // -- controls -------------------------------------------------------------

  function current() {
    return state.slides[state.selected];
  }

  function syncControls() {
    const s = current();
    if (!s) return;
    $("ed-preset").value = state.preset.id;

    const shotSel = $("ed-shot");
    shotSel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    shotSel.appendChild(none);
    for (const shot of state.rawShots) {
      const opt = document.createElement("option");
      opt.value = shot.file;
      opt.textContent = shot.name;
      shotSel.appendChild(opt);
    }
    shotSel.value = s.shot || "";

    document.querySelector(`input[name="ed-bg-kind"][value="${s.bg.kind}"]`).checked = true;
    $("ed-bg-color").value = s.bg.color;
    $("ed-grad-from").value = s.bg.from;
    $("ed-grad-to").value = s.bg.to;
    $("ed-angle").value = String(s.bg.angle);
    $("ed-angle-val").textContent = `${s.bg.angle}°`;
    (s.bg.kind === "gradient" ? show : hide)($("ed-bg-gradient"));
    (s.bg.kind === "solid" ? show : hide)($("ed-bg-solid"));

    $("ed-headline").value = s.headline.text;
    $("ed-headline-color").value = s.headline.color;
    $("ed-hsize").value = String(s.headline.size);
    $("ed-hsize-val").textContent = String(s.headline.size);
    $("ed-hy").value = String(Math.round(s.headline.y * 100));
    $("ed-hy-val").textContent = `${Math.round(s.headline.y * 100)}%`;

    $("ed-dscale").value = String(Math.round(s.device.scale * 100));
    $("ed-dscale-val").textContent = `${Math.round(s.device.scale * 100)}%`;
  }

  function onEdit(fn) {
    return (e) => {
      const s = current();
      if (!s) return;
      fn(s, e);
      renderMain();
      renderStrip();
      scheduleDeckSave();
    };
  }

  function bindControls() {
    const presetSel = $("ed-preset");
    for (const p of PRESETS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      presetSel.appendChild(opt);
    }
    presetSel.addEventListener("change", () => {
      state.preset = PRESETS.find((p) => p.id === presetSel.value) || PRESETS[0];
      renderMain();
      renderStrip();
      scheduleDeckSave();
    });

    const swatches = $("ed-gradient-presets");
    for (const g of GRADIENTS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ed-swatch";
      b.style.background = `linear-gradient(160deg, ${g.from}, ${g.to})`;
      b.title = `${g.from} → ${g.to}`;
      b.addEventListener(
        "click",
        onEdit((s) => {
          s.bg.kind = "gradient";
          s.bg.from = g.from;
          s.bg.to = g.to;
          syncControls();
        }),
      );
      swatches.appendChild(b);
    }

    for (const radio of document.querySelectorAll('input[name="ed-bg-kind"]')) {
      radio.addEventListener(
        "change",
        onEdit((s) => {
          s.bg.kind = radio.value;
          syncControls();
        }),
      );
    }
    $("ed-bg-color").addEventListener("input", onEdit((s, e) => { s.bg.color = e.target.value; }));
    $("ed-grad-from").addEventListener("input", onEdit((s, e) => { s.bg.from = e.target.value; }));
    $("ed-grad-to").addEventListener("input", onEdit((s, e) => { s.bg.to = e.target.value; }));
    $("ed-angle").addEventListener(
      "input",
      onEdit((s, e) => {
        s.bg.angle = Number(e.target.value);
        $("ed-angle-val").textContent = `${s.bg.angle}°`;
      }),
    );

    $("ed-shot").addEventListener("change", onEdit((s, e) => { s.shot = e.target.value || null; }));

    $("ed-headline").addEventListener("input", onEdit((s, e) => { s.headline.text = e.target.value; }));
    $("ed-headline-color").addEventListener("input", onEdit((s, e) => { s.headline.color = e.target.value; }));
    $("ed-hsize").addEventListener(
      "input",
      onEdit((s, e) => {
        s.headline.size = Number(e.target.value);
        $("ed-hsize-val").textContent = e.target.value;
      }),
    );
    $("ed-hy").addEventListener(
      "input",
      onEdit((s, e) => {
        s.headline.y = Number(e.target.value) / 100;
        $("ed-hy-val").textContent = `${e.target.value}%`;
      }),
    );
    $("ed-dscale").addEventListener(
      "input",
      onEdit((s, e) => {
        s.device.scale = Number(e.target.value) / 100;
        $("ed-dscale-val").textContent = `${e.target.value}%`;
      }),
    );
    $("ed-dreset").addEventListener(
      "click",
      onEdit((s) => {
        s.device = { cx: 0.5, cy: 0.64, scale: 0.8 };
        syncControls();
      }),
    );

    $("ed-add").addEventListener("click", () => {
      const prev = current();
      const slide = prev ? JSON.parse(JSON.stringify(prev)) : defaultSlide(state.rawShots[0]?.file);
      slide.headline.text = "Your headline";
      state.slides.push(slide);
      state.selected = state.slides.length - 1;
      afterMutation();
    });

    $("ed-close").addEventListener("click", close);
    $("ed-save").addEventListener("click", saveSlides);
    bindCanvasInteraction();
  }

  // -- drag / wheel on the canvas -------------------------------------------

  function canvasPoint(e) {
    const el = canvas();
    const rect = el.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * el.width,
      y: ((e.clientY - rect.top) / rect.height) * el.height,
    };
  }

  function bindCanvasInteraction() {
    const el = canvas();
    let drag = null;

    el.addEventListener("pointerdown", async (e) => {
      const s = current();
      if (!s) return;
      const p = canvasPoint(e);
      const img = s.shot ? await loadImage(`/shots/raw/${s.shot}`) : null;
      const d = deviceRect(s, img, el.width, el.height);
      if (p.x >= d.x && p.x <= d.x + d.outerW && p.y >= d.y && p.y <= d.y + d.outerH) {
        drag = { dx: p.x - s.device.cx * el.width, dy: p.y - s.device.cy * el.height };
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const s = current();
      const p = canvasPoint(e);
      s.device.cx = Math.min(1.2, Math.max(-0.2, (p.x - drag.dx) / el.width));
      s.device.cy = Math.min(1.3, Math.max(0.1, (p.y - drag.dy) / el.height));
      renderMain();
    });
    el.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      renderStrip();
      scheduleDeckSave();
    });
    el.addEventListener(
      "wheel",
      (e) => {
        const s = current();
        if (!s) return;
        e.preventDefault();
        const next = s.device.scale * (e.deltaY < 0 ? 1.03 : 0.97);
        s.device.scale = Math.min(1.4, Math.max(0.3, next));
        $("ed-dscale").value = String(Math.round(s.device.scale * 100));
        $("ed-dscale-val").textContent = `${Math.round(s.device.scale * 100)}%`;
        renderMain();
        renderStrip();
        scheduleDeckSave();
      },
      { passive: false },
    );
  }

  // -- save (export PNGs at exact resolution) --------------------------------

  async function saveSlides() {
    const btn = $("ed-save");
    const errEl = $("ed-error");
    hide(errEl);
    btn.disabled = true;
    try {
      for (let i = 0; i < state.slides.length; i++) {
        btn.textContent = `Saving ${i + 1}/${state.slides.length}…`;
        const off = document.createElement("canvas");
        off.width = state.preset.w;
        off.height = state.preset.h;
        await renderSlide(off.getContext("2d"), state.slides[i], off.width, off.height);
        const png = off.toDataURL("image/png");
        const res = await fetch("/api/screenshots/slide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `slide-${String(i + 1).padStart(2, "0")}`,
            png,
            deviceType: state.preset.id,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `save failed (${res.status})`);
      }
      btn.textContent = "Saved ✓";
      window.__rork?.refreshShots?.();
      setTimeout(() => {
        btn.textContent = "Save slides";
        btn.disabled = false;
      }, 1600);
    } catch (err) {
      errEl.textContent = err.message;
      show(errEl);
      btn.textContent = "Save slides";
      btn.disabled = false;
    }
    scheduleDeckSave();
  }

  // -- open / close ----------------------------------------------------------

  async function open(opts = {}) {
    const editorEl = $("editor");
    show(editorEl);
    state.open = true;

    const [shotsRes, deckRes] = await Promise.all([
      fetch("/api/screenshots").then((r) => r.json()).catch(() => null),
      fetch("/api/screenshots/deck").then((r) => r.json()).catch(() => null),
    ]);
    state.rawShots = shotsRes?.raw || [];

    const deck = deckRes?.deck;
    if (deck && Array.isArray(deck.slides) && deck.slides.length > 0) {
      state.slides = deck.slides;
      state.preset = PRESETS.find((p) => p.id === deck.deviceType) || PRESETS[0];
      state.selected = Math.min(deck.selected || 0, state.slides.length - 1);
    } else {
      state.slides = [defaultSlide(state.rawShots[0]?.file || null)];
      state.selected = 0;
    }

    if (opts.shotFile) {
      const idx = state.slides.findIndex((s) => s.shot === opts.shotFile);
      if (idx >= 0) {
        state.selected = idx;
      } else {
        const onlyPlaceholder =
          state.slides.length === 1 && !state.slides[0].shot && state.slides[0].headline.text === "Your headline";
        if (onlyPlaceholder) {
          state.slides[0].shot = opts.shotFile;
        } else {
          state.slides.push(defaultSlide(opts.shotFile));
          state.selected = state.slides.length - 1;
        }
      }
    }

    syncControls();
    renderMain();
    renderStrip();
  }

  function close() {
    hide($("editor"));
    state.open = false;
    scheduleDeckSave();
    window.__rork?.refreshShots?.();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) close();
  });

  bindControls();
  window.__rorkEditor = { open };
})();
