import { ChevronDown, ChevronUp, Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShotInfo } from "../../src/types";
import { useEscape } from "../hooks/use-escape";
import { control, iconButton, input, label, Modal, muted, primary } from "./ui";

type Preset = { id: string; label: string; w: number; h: number };
type Mockup = {
  id: string;
  label: string;
  url: string;
  inset: { left: number; top: number; width: number; height: number; radiusX: number; radiusY: number };
};
type Bg = { kind: "solid"; color: string } | { kind: "gradient"; from: string; to: string; angle: number };
type Slide = {
  shot: string | null;
  bg: Bg;
  headline: { text: string; color: string; size: number; y: number };
  device: { cx: number; cy: number; scale: number };
  mockupId: string;
};

const PRESETS: Preset[] = [
  { id: "IPHONE_69", label: "iPhone 6.9″ — 1290×2796", w: 1290, h: 2796 },
  { id: "IPHONE_65", label: "iPhone 6.5″ — 1284×2778", w: 1284, h: 2778 },
  { id: "IPHONE_61", label: "iPhone 6.1″ — 1179×2556", w: 1179, h: 2556 },
];

const MOCKUPS: Mockup[] = [
  {
    id: "silver",
    label: "Silver",
    url: "/mockups/iphone-17-pro-silver.png",
    inset: { left: 0.0432, top: 0.0229, width: 0.9147, height: 0.9541, radiusX: 0.075, radiusY: 0.035 },
  },
  {
    id: "deep-blue",
    label: "Deep Blue",
    url: "/mockups/iphone-17-pro-deep-blue.png",
    inset: { left: 0.0432, top: 0.0229, width: 0.9147, height: 0.9541, radiusX: 0.075, radiusY: 0.035 },
  },
  {
    id: "cosmic-orange",
    label: "Cosmic Orange",
    url: "/mockups/iphone-17-pro-cosmic-orange.png",
    inset: { left: 0.0432, top: 0.0229, width: 0.9147, height: 0.9541, radiusX: 0.075, radiusY: 0.035 },
  },
];

const BACKGROUNDS: Bg[] = [
  { kind: "gradient", from: "#6366f1", to: "#a855f7", angle: 160 },
  { kind: "gradient", from: "#0ea5e9", to: "#22d3ee", angle: 160 },
  { kind: "gradient", from: "#f97316", to: "#ec4899", angle: 160 },
  { kind: "gradient", from: "#10b981", to: "#a3e635", angle: 160 },
  { kind: "gradient", from: "#f43f5e", to: "#fbbf24", angle: 160 },
  { kind: "gradient", from: "#334155", to: "#64748b", angle: 160 },
  { kind: "solid", color: "#f5f5f7" },
  { kind: "solid", color: "#ffffff" },
];

// Earlier builds shipped near-black gradients that read as "no background" once
// the phone was composited on top. Decks saved with those are remapped on load.
const RETIRED_BACKGROUNDS = new Set([
  "#1a1a2e>#4a2a6a",
  "#0f2027>#2c5364",
  "#232526>#414345",
  "#42275a>#734b6d",
  "#141e30>#243b55",
  "#3a1c71>#d76d77",
]);

function bgCss(bg: Bg) {
  return bg.kind === "solid" ? bg.color : `linear-gradient(160deg, ${bg.from}, ${bg.to})`;
}

function isLight(hex: string) {
  const v = hex.replace("#", "");
  const n = parseInt(v.length === 3 ? v.replace(/./g, (c) => c + c) : v, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  let pending = imageCache.get(src);
  if (!pending) {
    pending = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    imageCache.set(src, pending);
  }
  return pending;
}

function defaultSlide(shotFile: string | null = null): Slide {
  return {
    shot: shotFile,
    bg: BACKGROUNDS[0],
    headline: { text: "Your headline", color: "#ffffff", size: 110, y: 0.08 },
    device: { cx: 0.5, cy: 0.62, scale: 0.86 },
    mockupId: "silver",
  };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
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

function deviceBox(slide: Slide, mockup: Mockup, W: number, H: number) {
  const outerW = slide.device.scale * W;
  const aspect = 879 / 1832;
  const outerH = outerW / aspect;
  const x = slide.device.cx * W - outerW / 2;
  const y = slide.device.cy * H - outerH / 2;
  return { x, y, outerW, outerH };
}

// Screenshot + bezel composited on their own transparent layer. Drawing this
// layer with a canvas shadow keeps the shadow shaped like the phone; filling a
// rectangle behind the frame instead leaks black through the rounded corners.
function renderPhone(
  mockup: Mockup,
  shotImg: HTMLImageElement | null,
  frameImg: HTMLImageElement | null,
  outerW: number,
  outerH: number,
) {
  const phone = document.createElement("canvas");
  phone.width = Math.max(1, Math.round(outerW));
  phone.height = Math.max(1, Math.round(outerH));
  const ctx = phone.getContext("2d");
  if (!ctx) return phone;

  const sx = mockup.inset.left * phone.width;
  const sy = mockup.inset.top * phone.height;
  const sw = mockup.inset.width * phone.width;
  const sh = mockup.inset.height * phone.height;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, { x: mockup.inset.radiusX * sw, y: mockup.inset.radiusY * sh });
  ctx.clip();
  if (shotImg) {
    const cover = Math.max(sw / shotImg.naturalWidth, sh / shotImg.naturalHeight);
    const dw = shotImg.naturalWidth * cover;
    const dh = shotImg.naturalHeight * cover;
    ctx.drawImage(shotImg, sx + (sw - dw) / 2, sy + (sh - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `500 ${sw * 0.07}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Pick a screenshot", sx + sw / 2, sy + sh / 2);
  }
  ctx.restore();

  if (frameImg) ctx.drawImage(frameImg, 0, 0, phone.width, phone.height);
  return phone;
}

async function renderSlide(ctx: CanvasRenderingContext2D, slide: Slide, W: number, H: number, presetW: number) {
  const k = W / presetW;
  const mockup = MOCKUPS.find((m) => m.id === slide.mockupId) || MOCKUPS[0];
  const [shotImg, frameImg] = await Promise.all([
    slide.shot ? loadImage(`/shots/raw/${slide.shot}`) : Promise.resolve(null),
    loadImage(mockup.url),
  ]);

  // Background
  if (slide.bg.kind === "gradient") {
    const rad = ((slide.bg.angle - 90) * Math.PI) / 180;
    const cx = W / 2;
    const cy = H / 2;
    const len = (Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad))) / 2;
    const grad = ctx.createLinearGradient(
      cx - Math.cos(rad) * len,
      cy - Math.sin(rad) * len,
      cx + Math.cos(rad) * len,
      cy + Math.sin(rad) * len,
    );
    grad.addColorStop(0, slide.bg.from);
    grad.addColorStop(1, slide.bg.to);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = slide.bg.color;
  }
  ctx.fillRect(0, 0, W, H);

  const box = deviceBox(slide, mockup, W, H);
  const phone = renderPhone(mockup, shotImg, frameImg, box.outerW, box.outerH);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.32)";
  ctx.shadowBlur = W * 0.04;
  ctx.shadowOffsetY = W * 0.012;
  ctx.drawImage(phone, box.x, box.y, box.outerW, box.outerH);
  ctx.restore();

  // Headline
  if (slide.headline.text) {
    const size = slide.headline.size * k;
    ctx.save();
    ctx.font = `700 ${size}px -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif`;
    ctx.fillStyle = slide.headline.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const lines = wrapText(ctx, slide.headline.text, W * 0.86);
    lines.forEach((line, i) => {
      ctx.fillText(line, W / 2, slide.headline.y * H + i * size * 1.12);
    });
    ctx.restore();
  }
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${url} failed (${response.status})`);
  return data;
}

export function ScreenshotEditor({
  shot,
  rawShots,
  close,
  saved,
}: {
  shot?: ShotInfo;
  rawShots: ShotInfo[];
  close: () => void;
  saved: () => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [slides, setSlides] = useState<Slide[]>([defaultSlide(shot?.file || rawShots[0]?.file || null)]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);
  const renderToken = useRef(0);

  useEscape(close);

  const current = slides[selected] || slides[0];

  const updateCurrent = useCallback(
    (patch: (slide: Slide) => Slide) => {
      setSlides((prev) => prev.map((slide, i) => (i === selected ? patch(slide) : slide)));
    },
    [selected],
  );

  // Load persisted deck (and seed with the shot we opened from).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/screenshots/deck");
        const data = await res.json();
        if (cancelled || !data?.slides?.length) return;
        const nextPreset = PRESETS.find((p) => p.id === data.deviceType) || PRESETS[0];
        setPreset(nextPreset);
        const nextSlides: Slide[] = data.slides.map((s: Slide) => {
          const stale = s.bg?.kind === "gradient" && RETIRED_BACKGROUNDS.has(`${s.bg.from}>${s.bg.to}`);
          return {
            ...defaultSlide(s.shot),
            ...s,
            bg: stale ? BACKGROUNDS[0] : s.bg,
            mockupId: s.mockupId || "silver",
          };
        });
        if (shot?.file && !nextSlides.some((s) => s.shot === shot.file)) {
          nextSlides.unshift(defaultSlide(shot.file));
          setSelected(0);
        } else if (shot?.file) {
          setSelected(
            Math.max(
              0,
              nextSlides.findIndex((s) => s.shot === shot.file),
            ),
          );
        } else {
          setSelected(Math.min(data.selected || 0, nextSlides.length - 1));
        }
        setSlides(nextSlides);
      } catch {
        /* first open */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shot?.file]);

  // Persist deck (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch("/api/screenshots/deck", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceType: preset.id, selected, slides }),
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [preset.id, selected, slides]);

  // Render main canvas at full App Store resolution.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = preset.w;
    canvas.height = preset.h;
    const token = ++renderToken.current;
    const off = document.createElement("canvas");
    off.width = preset.w;
    off.height = preset.h;
    const offCtx = off.getContext("2d");
    const liveCtx = canvas.getContext("2d");
    if (!offCtx || !liveCtx) return;
    void renderSlide(offCtx, current, preset.w, preset.h, preset.w).then(() => {
      if (token !== renderToken.current) return;
      liveCtx.clearRect(0, 0, preset.w, preset.h);
      liveCtx.drawImage(off, 0, 0);
    });
  }, [current, preset]);

  function canvasPoint(event: React.PointerEvent | React.WheelEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function onPointerDown(event: React.PointerEvent) {
    const pt = canvasPoint(event);
    if (!pt || !current) return;
    const mockup = MOCKUPS.find((m) => m.id === current.mockupId) || MOCKUPS[0];
    const box = deviceBox(current, mockup, preset.w, preset.h);
    if (pt.x < box.x || pt.y < box.y || pt.x > box.x + box.outerW || pt.y > box.y + box.outerH) {
      return;
    }
    drag.current = {
      px: pt.x,
      py: pt.y,
      cx: current.device.cx,
      cy: current.device.cy,
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!drag.current) return;
    const pt = canvasPoint(event);
    if (!pt) return;
    const dx = (pt.x - drag.current.px) / preset.w;
    const dy = (pt.y - drag.current.py) / preset.h;
    updateCurrent((s) => ({
      ...s,
      device: {
        ...s.device,
        cx: Math.min(1.2, Math.max(-0.2, drag.current!.cx + dx)),
        cy: Math.min(1.2, Math.max(-0.2, drag.current!.cy + dy)),
      },
    }));
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onWheel(event: React.WheelEvent) {
    event.preventDefault();
    updateCurrent((s) => ({
      ...s,
      device: {
        ...s.device,
        scale: Math.min(1.2, Math.max(0.4, s.device.scale - event.deltaY * 0.0006)),
      },
    }));
  }

  async function saveAll() {
    setSaving(true);
    setError("");
    try {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = preset.w;
      exportCanvas.height = preset.h;
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      for (let i = 0; i < slides.length; i++) {
        await renderSlide(ctx, slides[i], preset.w, preset.h, preset.w);
        await post("/api/screenshots/slide", {
          name: `slide-${String(i + 1).padStart(2, "0")}`,
          png: exportCanvas.toDataURL("image/png"),
          deviceType: preset.id,
        });
      }
      await saved();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal close={close} className="flex h-[min(92dvh,900px)] w-full max-w-6xl flex-col">
      <div className="flex items-center justify-between border-b border-white/10 p-4">
        <div>
          <h2 className="font-semibold">Screenshot editor</h2>
          <p className={muted}>Compose App Store slides with a real iPhone frame</p>
        </div>
        <div className="flex gap-2">
          <button className={`${primary} gap-2`} disabled={saving} onClick={() => void saveAll()}>
            <Save className="size-4" aria-hidden="true" />
            {saving ? "Saving…" : "Save slides"}
          </button>
          <button type="button" className={iconButton} onClick={close} title="Close" aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[108px_1fr_280px]">
        {/* Deck strip */}
        <div className="space-y-2 overflow-y-auto border-r border-white/10 p-3">
          {slides.map((slide, i) => (
            <DeckThumb
              key={i}
              slide={slide}
              preset={preset}
              active={i === selected}
              index={i}
              onSelect={() => setSelected(i)}
              onUp={() => {
                if (i === 0) return;
                setSlides((prev) => {
                  const next = [...prev];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  return next;
                });
                setSelected(i - 1);
              }}
              onDown={() => {
                if (i >= slides.length - 1) return;
                setSlides((prev) => {
                  const next = [...prev];
                  [next[i], next[i + 1]] = [next[i + 1], next[i]];
                  return next;
                });
                setSelected(i + 1);
              }}
              onDup={() => {
                setSlides((prev) => {
                  const next = [...prev];
                  next.splice(i + 1, 0, structuredClone(prev[i]));
                  return next;
                });
                setSelected(i + 1);
              }}
              onDel={() => {
                setSlides((prev) => {
                  if (prev.length === 1) return [defaultSlide(rawShots[0]?.file || null)];
                  return prev.filter((_, idx) => idx !== i);
                });
                setSelected((s) => Math.max(0, Math.min(s, slides.length - 2)));
              }}
            />
          ))}
          <button
            className={`${control} w-full gap-1`}
            onClick={() => {
              setSlides((prev) => [...prev, defaultSlide(rawShots[0]?.file || null)]);
              setSelected(slides.length);
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add
          </button>
        </div>

        {/* Live canvas */}
        <div ref={stageRef} className="grid min-h-0 place-items-center bg-black/40 p-4">
          <canvas
            ref={canvasRef}
            className="max-h-full max-w-full cursor-grab touch-none rounded-lg shadow-2xl active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          />
        </div>

        {/* Controls */}
        <aside className="space-y-4 overflow-y-auto border-l border-white/10 p-4">
          <label className={label}>
            Canvas size
            <select
              className={input}
              value={preset.id}
              onChange={(e) => setPreset(PRESETS.find((p) => p.id === e.target.value) || PRESETS[0])}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className={label}>
            Screenshot
            <select
              className={input}
              value={current?.shot || ""}
              onChange={(e) => updateCurrent((s) => ({ ...s, shot: e.target.value || null }))}
            >
              <option value="">— none —</option>
              {rawShots.map((s) => (
                <option key={s.file} value={s.file}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className={label}>
            iPhone frame
            <select
              className={input}
              value={current?.mockupId || "silver"}
              onChange={(e) => updateCurrent((s) => ({ ...s, mockupId: e.target.value }))}
            >
              {MOCKUPS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-2">
            <span className="text-sm font-medium">Background</span>
            <div className="grid grid-cols-4 gap-1.5">
              {BACKGROUNDS.map((bg) => (
                <button
                  key={bgCss(bg)}
                  type="button"
                  title={bg.kind === "solid" ? bg.color : `${bg.from} → ${bg.to}`}
                  className="h-8 rounded-md border border-white/15"
                  style={{ background: bgCss(bg) }}
                  onClick={() =>
                    updateCurrent((s) => {
                      const light = isLight(bg.kind === "solid" ? bg.color : bg.to);
                      return {
                        ...s,
                        bg,
                        headline: { ...s.headline, color: light ? "#111114" : "#ffffff" },
                      };
                    })
                  }
                />
              ))}
            </div>
            {current?.bg.kind === "gradient" ? (
              <div className="grid grid-cols-2 gap-2">
                <label className={label}>
                  From
                  <input
                    type="color"
                    className="h-9 w-full"
                    value={current.bg.from}
                    onChange={(e) =>
                      updateCurrent((s) => ({
                        ...s,
                        bg: s.bg.kind === "gradient" ? { ...s.bg, from: e.target.value } : s.bg,
                      }))
                    }
                  />
                </label>
                <label className={label}>
                  To
                  <input
                    type="color"
                    className="h-9 w-full"
                    value={current.bg.to}
                    onChange={(e) =>
                      updateCurrent((s) => ({
                        ...s,
                        bg: s.bg.kind === "gradient" ? { ...s.bg, to: e.target.value } : s.bg,
                      }))
                    }
                  />
                </label>
              </div>
            ) : (
              <label className={label}>
                Color
                <input
                  type="color"
                  className="h-9 w-full"
                  value={current?.bg.kind === "solid" ? current.bg.color : "#ffffff"}
                  onChange={(e) => updateCurrent((s) => ({ ...s, bg: { kind: "solid", color: e.target.value } }))}
                />
              </label>
            )}
          </div>

          <label className={label}>
            Headline
            <input
              className={input}
              value={current?.headline.text || ""}
              onChange={(e) => updateCurrent((s) => ({ ...s, headline: { ...s.headline, text: e.target.value } }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={label}>
              Color
              <input
                type="color"
                className="h-9 w-full"
                value={current?.headline.color || "#ffffff"}
                onChange={(e) => updateCurrent((s) => ({ ...s, headline: { ...s.headline, color: e.target.value } }))}
              />
            </label>
            <label className={label}>
              Size {current?.headline.size}
              <input
                type="range"
                min={48}
                max={160}
                value={current?.headline.size || 110}
                onChange={(e) =>
                  updateCurrent((s) => ({
                    ...s,
                    headline: { ...s.headline, size: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </div>
          <label className={label}>
            Headline position {Math.round((current?.headline.y || 0) * 100)}%
            <input
              type="range"
              min={2}
              max={30}
              value={Math.round((current?.headline.y || 0.08) * 100)}
              onChange={(e) =>
                updateCurrent((s) => ({
                  ...s,
                  headline: { ...s.headline, y: Number(e.target.value) / 100 },
                }))
              }
            />
          </label>
          <label className={label}>
            Device size {Math.round((current?.device.scale || 0.86) * 100)}%
            <input
              type="range"
              min={40}
              max={120}
              value={Math.round((current?.device.scale || 0.86) * 100)}
              onChange={(e) =>
                updateCurrent((s) => ({
                  ...s,
                  device: { ...s.device, scale: Number(e.target.value) / 100 },
                }))
              }
            />
          </label>
          <p className={muted}>Drag the phone to reposition. Scroll to resize.</p>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </aside>
      </div>
    </Modal>
  );
}

function DeckThumb({
  slide,
  preset,
  active,
  index,
  onSelect,
  onUp,
  onDown,
  onDup,
  onDel,
}: {
  slide: Slide;
  preset: Preset;
  active: boolean;
  index: number;
  onSelect: () => void;
  onUp: () => void;
  onDown: () => void;
  onDup: () => void;
  onDel: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const tw = 84;
    canvas.width = tw;
    canvas.height = Math.round((tw * preset.h) / preset.w);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    void renderSlide(ctx, slide, canvas.width, canvas.height, preset.w);
  }, [slide, preset]);

  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-md border ${
        active ? "border-white" : "border-white/15"
      }`}
      onClick={onSelect}
    >
      <canvas ref={ref} className="block w-full" />
      <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 text-[10px] font-medium">{index + 1}</span>
      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0.5 bg-black/70 py-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          className="p-0.5"
          title="Move up"
          onClick={(e) => {
            e.stopPropagation();
            onUp();
          }}
        >
          <ChevronUp className="size-3" />
        </button>
        <button
          type="button"
          className="p-0.5"
          title="Move down"
          onClick={(e) => {
            e.stopPropagation();
            onDown();
          }}
        >
          <ChevronDown className="size-3" />
        </button>
        <button
          type="button"
          className="p-0.5"
          title="Duplicate"
          onClick={(e) => {
            e.stopPropagation();
            onDup();
          }}
        >
          <Copy className="size-3" />
        </button>
        <button
          type="button"
          className="p-0.5 text-red-400"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDel();
          }}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}
