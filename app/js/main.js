// FlatNotes engine: document model, view transform, input, rendering, undo.

import * as Ink from './ink.js';
import * as store from './store.js';
import { initUI } from './ui.js';

/* ============================== constants ============================== */

export const PAGE_W = 820;
export const PAGE_H = 1160;   // a new page, one band of the raster cache, one sheet on export
export const PAGE_GAP = 30;
const PAGE_RADIUS = 8;

/**
 * Pages have no fixed bottom. Each one is as tall as its own content plus a blank tail, so
 * there is always somewhere below the last thing you wrote to keep going, and writing into
 * that tail simply grows the page again. Heights move in steps rather than continuously, so
 * a stroke running down the page does not resize the world on every point.
 */
const PAGE_TAIL = Math.round(PAGE_H / 2); // blank room kept below the lowest item
const PAGE_STEP = 200;                    // heights are always a whole number of these
const TAIL_TRIGGER = 150;                 // drawing this close to the bottom grows it at once

/**
 * Single-page view keeps the same world strip and draws only the page in focus. The camera is
 * fenced inside that page, so which page is in focus stays a plain question of where the
 * viewport centre is and no second source of truth is needed.
 */
const SINGLE_PAD = 40;        // breathing room left above and below the sheet
const FLIP_OVERSCROLL = 260;  // pushing this far past the fence turns the page

export const PAPERS = {
  white: '#ffffff',
  cream: '#faf4e6',
  gray:  '#eef0f3',
  dark:  '#20232a',
  black: '#000000',
};

const MAX_UNDO = 300;

/* ============================== app state ============================== */

const app = {
  doc: null,
  view: { x: 0, y: 0, zoom: 1 }, // world coords at viewport centre
  tool: 'pen',
  availableTools: ['pen', 'highlighter', 'eraser', 'lasso', 'text', 'shape', 'textify', 'voice'],

  tools: {
    pen:         { color: '#1d1d1f', size: 2.5 },
    highlighter: { color: '#ffd60a', size: 14, opacity: 0.42 },
    eraser:      { mode: 'stroke', size: 16 },
    text:        { color: '#1d1d1f', size: 17 },
    shape:       { kind: 'rect', color: '#1d1d1f', size: 2.5 },
    lasso:       {},
    textify:     {},
    voice:       {},
  },

  settings: {
    theme: 'system',            // system | light | dark
    accent: '#4f6ef7',
    pressure: true,
    gamma: 1.35,                // pressure response curve
    minWidth: 0.32,             // thinnest stroke as fraction of size
    smoothing: 0.65,            // ink smoothing amount
    touchDraw: false,           // draw with finger (palm rejection off)
    penEraser: true,            // back-of-pen / barrel button erases
    defaultTemplate: 'lines',
    defaultPaper: 'white',
    pageView: 'continuous',     // continuous = one page after another | single = one at a time
    pageList: 'big',            // sidebar page list: big | small | list
    toolbarTools: null,         // null = all available
    textifyReplace: true,       // textify removes the circled ink after recognition
    ocrModel: 'glm-ocr',        // which local model textify uses
    ocrUrl: 'http://127.0.0.1:8090', // local llama.cpp server (all models share this port)
    asrModel: 'parakeet-tdt-0.6b-v2', // which local model the voice tool uses
    asrUrl: 'ws://127.0.0.1:8091',    // local sherpa-onnx websocket server
    aiLanguage: 'Spanish',      // target language for the Translate selection action
  },

  undoStack: [],
  redoStack: [],
};
window.app = app; // handy for DevTools & test automation

/* ============================== document ============================== */

let nextId = 1;
const uid = () => 'i' + (nextId++) + '_' + Math.random().toString(36).slice(2, 7);

function newPage() {
  return {
    id: uid(),
    template: app.settings.defaultTemplate,
    paper: app.settings.defaultPaper,
    items: [],
  };
}

function newDoc(name = 'My Notes') {
  return { id: uid(), name, pages: [newPage()], created: Date.now(), modified: Date.now() };
}

/* ---------- page geometry: every page carries its own height ---------- */

const pageHeight = (page) => (page && page.h > PAGE_H ? page.h : PAGE_H);

/**
 * Page tops, as a running total, plus the bottom of the last page in the final slot. Pages
 * no longer sit on a fixed pitch, so this is the one place that turns an index into a
 * position. It is rebuilt whenever a height changes or a page is added or removed.
 */
let tops = null;
let topsFor = null;

const invalidateTops = () => { tops = null; };

function pageTops() {
  settleHeights();
  const pages = app.doc.pages;
  if (tops && topsFor === pages && tops.length === pages.length + 1) return tops;
  const t = new Array(pages.length + 1);
  let y = 0;
  for (let i = 0; i < pages.length; i++) { t[i] = y; y += pageHeight(pages[i]) + PAGE_GAP; }
  t[pages.length] = Math.max(0, y - PAGE_GAP); // the bottom edge of the last page
  tops = t;
  topsFor = pages;
  return t;
}

const pageRect = (i) => ({
  x: -PAGE_W / 2,
  y: pageTops()[i],
  w: PAGE_W,
  h: pageHeight(app.doc.pages[i]),
});

/** Bottom of the last page: how far down the world goes. */
const docBottom = () => pageTops()[app.doc.pages.length];

/** Index of the last page whose top is at or above `wy`, by binary search. */
function pageIndexAbove(wy) {
  const t = pageTops();
  let lo = 0, hi = app.doc.pages.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t[m] <= wy) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

function pageAtWorld(wx, wy) {
  // half a gap of slack on each side, so a point between two pages still lands on one
  const idx = pageIndexAbove(wy + PAGE_GAP / 2);
  if (idx < 0) return -1;
  if (wy > pageTops()[idx] + pageHeight(app.doc.pages[idx]) + PAGE_GAP / 2) return -1;
  // zoomed out in single-page view the neighbours are still under the pointer even though
  // they are not on screen; a page nobody can see must not be drawn on either
  if (singleView() && idx !== currentPageIndex()) return -1;
  return idx;
}

/* ---------- growing and shrinking ---------- */

const bottomCache = new WeakMap(); // page -> bottom of its lowest item
const heightDirty = new Set();     // pages whose content changed since the last settle

/** The bottom edge of the lowest item on a page, 0 when it is empty. */
function contentBottom(page) {
  const hit = bottomCache.get(page);
  if (hit !== undefined) return hit;
  let b = 0;
  for (const it of page.items) {
    const bb = itemBBox(it);
    const y = bb.y + bb.h;
    if (y > b) b = y;
  }
  bottomCache.set(page, b);
  return b;
}

/** The height a page wants: its content plus the tail, rounded up to a whole step. */
const wantedHeight = (page) =>
  Math.max(PAGE_H, Math.ceil((contentBottom(page) + PAGE_TAIL) / PAGE_STEP) * PAGE_STEP);

function setPageHeight(page, h) {
  h = Math.max(PAGE_H, Math.round(h));
  const old = pageHeight(page);
  if (h === old) return false;
  page.h = h;
  invalidateTops();
  dropBandsFrom(page, Math.min(h, old)); // only the bands around the old bottom edge change
  requestRender();
  return true;
}

/**
 * Grow at once, shrink reluctantly: rubbing out the last line of a page must not yank half a
 * screen out from under the pointer, so a page only gets shorter once it is more than a step
 * and a half too tall, and never while it is the page being drawn on.
 */
function fitPageHeight(page, allowShrink = true) {
  const want = wantedHeight(page);
  const cur = pageHeight(page);
  if (want > cur) return setPageHeight(page, want);
  if (allowShrink && want < cur - PAGE_STEP * 1.5) return setPageHeight(page, want);
  return false;
}

/** A page an interaction is anchored to must not shrink underneath it while it is in use. */
function isBusyPage(page) {
  if (pin.mode === 'draw' && pin.stroke && app.doc.pages[pin.stroke.pageIndex] === page) return true;
  if (pin.mode === 'shape' && pin.shape && app.doc.pages[pin.shape.pageIndex] === page) return true;
  if (pin.mode === 'erase' && pin.erasedPages?.has(page)) return true;
  if (editing && app.doc.pages[editing.pageIndex] === page) return true;
  if (voice && voice.page === page) return true;
  return false;
}

let settling = false;
/**
 * Re-fit every page whose content changed. Called from pageTops, so heights are always
 * settled before anything asks where a page is, and undo, redo, erase and paste all get
 * the right height without having to remember to ask for one.
 */
function settleHeights() {
  if (settling || !heightDirty.size || !app.doc) return;
  settling = true;
  let shrank = false;
  for (const page of heightDirty) {
    if (!app.doc.pages.includes(page)) continue;
    const before = pageHeight(page);
    if (fitPageHeight(page, !isBusyPage(page)) && pageHeight(page) < before) shrank = true;
  }
  heightDirty.clear();
  settling = false;
  // A page that got shorter pulls the bottom of the world up with it, which can leave the
  // viewport parked below everything: undo, erase and delete all change content without
  // touching the view. Clamping here catches every one of them, and it has to be after the
  // guard is released because clampView asks for the tops itself.
  if (shrank) clampView();
}

/* ============================== canvases ============================== */

const scene = document.getElementById('scene');
const overlay = document.getElementById('overlay');
const sctx = scene.getContext('2d');
const octx = overlay.getContext('2d');
let dpr = 1, cw = 0, ch = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cw = window.innerWidth;
  ch = window.innerHeight;
  for (const c of [scene, overlay]) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
  }
  if (app.doc) clampView(); // the single-page fence is measured against the window height
  requestRender();
}
window.addEventListener('resize', resize);

/* coordinate transforms */
const s2wX = (sx) => app.view.x + (sx - cw / 2) / app.view.zoom;
const s2wY = (sy) => app.view.y + (sy - ch / 2) / app.view.zoom;
const w2sX = (wx) => (wx - app.view.x) * app.view.zoom + cw / 2;
const w2sY = (wy) => (wy - app.view.y) * app.view.zoom + ch / 2;

const singleView = () => app.settings.pageView === 'single';

/**
 * Where the camera may sit in single-page view, in world units. The sheet may hang no further
 * out than a small margin, and once it fits on screen it stops moving altogether. Both ends are
 * kept inside the page's own span, so the page in focus is always the one under the viewport
 * centre and no separate focus index can drift away from it.
 */
function singleFence(i) {
  const top = pageTops()[i];
  const h = pageHeight(app.doc.pages[i]);
  const half = ch / (2 * app.view.zoom);
  const lo = Math.max(top, top - SINGLE_PAD + half);
  const hi = Math.min(top + h, top + h + SINGLE_PAD - half);
  const mid = top + h / 2;
  return lo > hi ? { lo: mid, hi: mid } : { lo, hi };
}

/** How far the last clamp had to pull the camera back, so a gesture can tell it hit the fence. */
let overscrollY = 0;

function clampView() {
  const v = app.view;
  v.zoom = Ink.clamp(v.zoom, 0.2, 6);
  const mx = PAGE_W * 0.75;
  v.x = Ink.clamp(v.x, -mx, mx);
  const want = v.y;
  if (singleView()) {
    const f = singleFence(currentPageIndex());
    v.y = Ink.clamp(v.y, f.lo, f.hi);
  } else {
    v.y = Ink.clamp(v.y, -PAGE_H * 0.25, docBottom() + PAGE_H * 0.25);
  }
  overscrollY = want - v.y;
  // Pan, pinch, wheel, zoom, page turn, fit and re-seat all end up here, and nothing writes
  // the camera without coming through afterwards, so this is the single place the per-notebook
  // anchor can be told the view moved. It only arms a timer; see saveView.
  saveView();
}

/** Turn to the next or previous page and land on its near edge. Returns false at either end. */
function turnPage(dir) {
  const to = currentPageIndex() + dir;
  if (to < 0 || to >= app.doc.pages.length) return false;
  commitTextEdit();
  clearSel();
  const f = singleFence(to);
  app.view.y = dir > 0 ? f.lo : f.hi;
  overscrollY = 0;
  clampView();
  requestRender();
  return true;
}

/**
 * Scrolling or dragging past the end of the page turns it. A wheel arrives in notches, so its
 * overscroll is added up; a drag holds a fixed start point, so its overscroll is already the
 * whole distance past the edge and is read as it stands.
 */
let flipAccum = 0;
function flipOnOverscroll(accumulate) {
  if (!singleView()) return false;
  // never while something is anchored to the page: a stroke, a text box, a recording
  if (editing || voice || (pin.mode && pin.mode !== 'pan')) return false;
  if (!overscrollY || (flipAccum && Math.sign(flipAccum) !== Math.sign(overscrollY))) flipAccum = 0;
  flipAccum = accumulate ? flipAccum + overscrollY : overscrollY;
  if (Math.abs(flipAccum) < FLIP_OVERSCROLL) return false;
  const dir = flipAccum > 0 ? 1 : -1;
  flipAccum = 0;
  return turnPage(dir);
}

/**
 * Re-seat the camera after the page list itself changed. In single-page view the fence is read
 * off whichever page the centre is over, so a page added or removed above the camera would
 * otherwise leave it fenced to a page the user never asked for.
 */
function reseat(i) {
  if (singleView() && app.doc) goToPage(i);
  else clampView();
}

/* ============================== theme colors ============================== */

let css = {};
function readCss() {
  const s = getComputedStyle(document.documentElement);
  css = {
    bg: s.getPropertyValue('--bg').trim(),
    accent: s.getPropertyValue('--accent').trim(),
  };
}

function resolvedTheme() {
  if (app.settings.theme !== 'system') return app.settings.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.style.setProperty('--accent', app.settings.accent);
  readCss();
  requestRender();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (app.settings.theme === 'system') applyTheme();
});

/* ============================== item rendering ============================== */

const pathCache = new WeakMap();
let onDarkPaper = false; // set by whoever is drawing a page; flips highlighter blend mode
let invertInk = false;   // set alongside it; flips achromatic ink for black paper

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
const colorLuma = (hex) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
};

/** Single source of truth for "is this page dark paper": ink blending and cursors both use it. */
const paperIsDark = (page) => colorLuma(PAPERS[page?.paper] || '#ffffff') < 0.5;

/** Black paper is the one that flips its ink; the soft `dark` paper leaves colours alone. */
const paperInverts = (page) => page?.paper === 'black';

/**
 * How far a colour is from grey, 0..255. Below the threshold a colour is black, white or
 * some shade in between, so flipping its lightness is the whole point. Above it the colour
 * carries real hue and must survive untouched. 24 clears every grey in the palette
 * (#1d1d1f is 2, #6e6e73 is 5) while leaving the coolest one, slate #94a3b8 at 36, alone.
 */
const CHROMA_FLAT = 24;

/**
 * The black-paper display transform: a plain per channel flip, applied only to achromatic
 * colours. It is its own inverse, so restoring the paper restores the exact original pixels.
 * Stored item colours are never touched.
 */
function invertFlat(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  if (Math.max(r, g, b) - Math.min(r, g, b) >= CHROMA_FLAT) return color;
  return '#' + (0xffffff - n).toString(16).padStart(6, '0');
}

const inkColor = (color) => (invertInk ? invertFlat(color) : color);

/** Every page renderer calls this first, so blend mode and inversion can never disagree. */
function setPaperMode(page) {
  onDarkPaper = paperIsDark(page);
  invertInk = paperInverts(page);
}

function strokePath(item) {
  let p = pathCache.get(item);
  if (!p) {
    p = Ink.buildStrokePath(item.points, item.size, {
      pressure: item.tool === 'pen' && app.settings.pressure,
      gamma: app.settings.gamma,
      minScale: app.settings.minWidth,
      smooth: app.settings.smoothing,
    });
    pathCache.set(item, p);
  }
  return p;
}

/* ---------- image decode cache ---------- */

/**
 * One decode per image item, sitting beside the stroke path cache and keyed the same way,
 * so baking a page draws a ready bitmap instead of parsing its data URL again. The decode
 * is asynchronous, so a bake that arrives first draws a placeholder frame and the pages
 * holding the item are invalidated once the bitmap lands. A source that fails to decode is
 * remembered by its settled promise, so a broken data URL can never spin the cache.
 */
const imageCache = new WeakMap();   // item -> decoded HTMLImageElement, safe to draw
const imagePending = new WeakMap(); // item -> the one in flight decode
const imageFailed = new WeakSet();

/** Decode a data URL into an element that is safe to draw synchronously from then on. */
async function decodeDataUrl(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

function decodeItemImage(item) {
  let p = imagePending.get(item);
  if (p) return p;
  p = (async () => {
    let img = null;
    try {
      img = await decodeDataUrl(item.src);
      imageCache.set(item, img);
    } catch (err) {
      imageFailed.add(item);
      console.error('FlatNotes: image decode failed', err);
    }
    // whatever baked a placeholder for it has to run again, now that there is a picture
    for (const page of app.doc?.pages || []) if (page.items.includes(item)) invalidatePage(page);
    requestOverlay();
    return img;
  })();
  imagePending.set(item, p);
  return p;
}

/** The bitmap if it is ready, otherwise null and a decode started in the background. */
function imageBitmap(item) {
  const img = imageCache.get(item);
  if (img) return img;
  if (item.src && !imageFailed.has(item)) decodeItemImage(item);
  return null;
}

/**
 * Resolve every image on these pages. Thumbnails and both exports paint through the
 * synchronous renderers, so they decode first rather than exporting empty frames.
 * Returns null when there is nothing to wait for, which keeps the common save path
 * free of a pointless microtask hop.
 */
function ensureImagesReady(pages) {
  const jobs = [];
  for (const page of pages) {
    for (const it of page.items) {
      if (it.type !== 'image' || imageCache.has(it) || imageFailed.has(it)) continue;
      jobs.push(decodeItemImage(it));
    }
  }
  return jobs.length ? Promise.all(jobs) : null;
}

/**
 * The image's natural size as it looks after its rotation. The crop window is measured in
 * this frame rather than in the raw source, so a quarter turn swaps the two dimensions and
 * every number in the crop keeps meaning what it meant before the turn.
 */
function rotDims(it) {
  return ((it.rot || 0) % 180) ? { rw: it.nh, rh: it.nw } : { rw: it.nw, rh: it.nh };
}

/** An image's crop window, defaulting to the whole rotated picture when it was never cropped. */
function itemCrop(it) {
  if (it.crop) return it.crop;
  const { rw, rh } = rotDims(it);
  return { x: 0, y: 0, w: rw, h: rh };
}

/**
 * Turn the source into its rotated frame, so everything downstream can work in rotated pixels
 * and forget that the stored bytes are sideways. The caller has already scaled into that frame,
 * which is why the picture goes down here at its natural size and nowhere else.
 */
function drawRotatedSource(ctx, img, it) {
  const { rw, rh } = rotDims(it);
  const rot = it.rot || 0;
  if (rot === 90) { ctx.translate(rw, 0); ctx.rotate(Math.PI / 2); }
  else if (rot === 180) { ctx.translate(rw, rh); ctx.rotate(Math.PI); }
  else if (rot === 270) { ctx.translate(0, rh); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img, 0, 0, it.nw, it.nh);
}

/**
 * Photographs are chromatic content, so the black-paper ink inversion never touches them.
 * `rect` lets the live resize preview draw the same decode at a different size without
 * cloning the item, which would miss the cache and decode once per frame. `crop` is the
 * window on the rotated picture that `rect` shows, and it is a parameter for the same
 * reason: a crop drag in flight has a window the item does not carry yet.
 */
function drawImageItem(ctx, it, rect = it, crop = itemCrop(it)) {
  const img = imageBitmap(it);
  if (img) {
    // an unturned picture shown whole is every notebook already on disk, and it keeps being
    // drawn the way it always was, with no transform and no clip edge to soften its border
    if (!it.rot && crop.x === 0 && crop.y === 0 && crop.w === it.nw && crop.h === it.nh) {
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
      return;
    }
    // the axes scale apart because placeImage rounds w and h separately, so an existing rect
    // is never exactly the source aspect and one shared scale would nudge the content sideways
    const sx = rect.w / crop.w, sy = rect.h / crop.h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.translate(rect.x - crop.x * sx, rect.y - crop.y * sy);
    ctx.scale(sx, sy);
    drawRotatedSource(ctx, img, it);
    ctx.restore();
    return;
  }
  // still decoding: a faint frame, so a page loaded from disk never looks like it lost a picture
  ctx.save();
  ctx.strokeStyle = onDarkPaper ? 'rgba(255,255,255,0.22)' : 'rgba(20,23,34,0.16)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.w - 1), Math.max(1, rect.h - 1));
  ctx.restore();
}

function drawItem(ctx, item) {
  const color = inkColor(item.color);
  if (item.type === 'stroke') {
    ctx.globalAlpha = item.opacity ?? 1;
    ctx.globalCompositeOperation = item.tool === 'highlighter' ? (onDarkPaper ? 'screen' : 'multiply') : 'source-over';
    ctx.fillStyle = color;
    ctx.fill(strokePath(item));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  } else if (item.type === 'text') {
    ctx.fillStyle = color;
    ctx.font = `${item.size}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const lh = item.size * 1.35;
    item.text.split('\n').forEach((line, i) => ctx.fillText(line, item.x, item.y + i * lh));
  } else if (item.type === 'shape') {
    drawShape(ctx, item, color);
  } else if (item.type === 'image') {
    drawImageItem(ctx, item);
  }
}

function drawShape(ctx, s, color = inkColor(s.color)) {
  ctx.strokeStyle = color;
  ctx.lineWidth = s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const { x1, y1, x2, y2 } = s;
  ctx.beginPath();
  if (s.kind === 'rect') {
    ctx.roundRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), 2);
  } else if (s.kind === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else if (s.kind === 'line' || s.kind === 'arrow') {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (s.kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const hl = Math.max(10, s.size * 4);
      ctx.moveTo(x2 - hl * Math.cos(a - 0.46), y2 - hl * Math.sin(a - 0.46));
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - hl * Math.cos(a + 0.46), y2 - hl * Math.sin(a + 0.46));
    }
  }
  ctx.stroke();
}

/* ============================== page raster cache ============================== */

/**
 * A page can be tens of thousands of pixels tall, so it is never baked as one bitmap. It is
 * cut into fixed bands of BAND_H, only the bands on screen are ever rastered, and the total
 * pixels held are capped: past the budget the least recently drawn band is thrown away.
 */
const BAND_H = PAGE_H;
const CACHE_M = 26;        // margin around the page in the cache (room for the shadow)
const SHADOW_PAD = 48;     // how far the paper path runs past a band, to keep blur off-canvas
const CACHE_BUDGET = 160 * 1024 * 1024;

const caches = new WeakMap(); // page -> Map(band index -> entry)
const lru = [];               // every live band, least recently drawn first
let cacheBytes = 0;
let frameNo = 0;
let gesturing = false;        // during pinch: reuse cache, rebuild after
const hiddenItems = new Set(); // items temporarily drawn on the overlay instead (move/edit)

const bandCount = (page) => Math.max(1, Math.ceil(pageHeight(page) / BAND_H));

function cacheZoomTarget() {
  const base = Ink.clamp(app.view.zoom, 0.35, 3) * dpr;
  return Math.min(base, 4096 / (BAND_H + CACHE_M * 2));
}

function touchBand(c) {
  c.frame = frameNo;
  const i = lru.indexOf(c);
  if (i >= 0) lru.splice(i, 1);
  lru.push(c);
}

function releaseBand(c) {
  const m = caches.get(c.page);
  if (m && m.get(c.band) === c) m.delete(c.band);
  cacheBytes -= c.bytes;
  c.bytes = 0;
  c.canvas.width = c.canvas.height = 0; // hand the pixels back now rather than at the next GC
}

/** Drop bands from a page below `y`: only those can be affected by a height change. */
function dropBandsFrom(page, y) {
  const m = caches.get(page);
  if (!m) return;
  const from = Math.max(0, Math.floor((y - SHADOW_PAD) / BAND_H));
  for (const [band, c] of [...m]) {
    if (band < from) continue;
    const i = lru.indexOf(c);
    if (i >= 0) lru.splice(i, 1);
    releaseBand(c);
  }
}

/** Evict least recently drawn bands until the budget is met, never one used this frame. */
function trimCache() {
  for (let i = 0; i < lru.length && cacheBytes > CACHE_BUDGET;) {
    const c = lru[i];
    if (c.frame === frameNo) { i++; continue; }
    lru.splice(i, 1);
    releaseBand(c);
  }
}

function ensureBand(page, band) {
  let m = caches.get(page);
  if (!m) { m = new Map(); caches.set(page, m); }
  let c = m.get(band);
  const target = cacheZoomTarget();
  const fresh = c && !c.dirty && (gesturing || Math.abs(c.zoom - target) / target <= 0.2);
  if (!fresh) {
    if (!c) {
      const canvas = document.createElement('canvas');
      c = { canvas, ctx: canvas.getContext('2d'), page, band, zoom: 0, bytes: 0, dirty: true, frame: -1 };
      m.set(band, c);
    }
    bakeBand(page, c, gesturing && c.zoom > 0 ? c.zoom : target);
  }
  touchBand(c);
  trimCache();
  return c;
}

/**
 * Paint one band. The paper is the slice of the page this band shows, extended past both
 * edges by more than the shadow reaches, so an interior band's blur is computed off-canvas
 * and no horizontal seam appears where two bands meet. Only the corners that are really the
 * page's own top or bottom are rounded, and only items that reach into the band are drawn.
 */
function bakeBand(page, c, z) {
  const pageH = pageHeight(page);
  const top = c.band * BAND_H;
  const h = Math.max(1, Math.min(BAND_H, pageH - top)); // the last band is a short one
  const wW = PAGE_W + CACHE_M * 2, wH = h + CACHE_M * 2;
  c.canvas.width = Math.max(1, Math.round(wW * z));
  c.canvas.height = Math.max(1, Math.round(wH * z));
  cacheBytes += c.canvas.width * c.canvas.height * 4 - c.bytes;
  c.bytes = c.canvas.width * c.canvas.height * 4;
  c.wW = wW; c.wH = wH;
  c.zoom = z;
  c.dirty = false;

  const x = c.ctx;
  x.setTransform(z, 0, 0, z, 0, 0);
  x.clearRect(0, 0, wW, wH);

  const pTop = CACHE_M - top;              // where the page's own top sits in band coords
  const pBot = pTop + pageH;
  const y0 = Math.max(pTop, -SHADOW_PAD);
  const y1 = Math.min(pBot, wH + SHADOW_PAD);
  const rTop = y0 === pTop ? PAGE_RADIUS : 0;
  const rBot = y1 === pBot ? PAGE_RADIUS : 0;
  const radii = [rTop, rTop, rBot, rBot];
  const paperPath = () => { x.beginPath(); x.roundRect(CACHE_M, y0, PAGE_W, y1 - y0, radii); };

  x.save();
  x.shadowColor = 'rgba(15,20,45,0.20)';
  x.shadowBlur = 12 * z;                   // device-space blur, hence * z
  x.shadowOffsetY = 3.5 * z;
  x.fillStyle = PAPERS[page.paper] || '#fff';
  paperPath();
  x.fill();
  x.restore();
  // everything else stays inside the paper, rounded corners included
  paperPath();
  x.clip();
  drawPaperBorder(x, page, CACHE_M, y0, PAGE_W, y1 - y0, 1, radii);
  drawTemplate(x, page, CACHE_M, pTop, PAGE_W, pageH, 1, y0, y1);
  // keep the page-local transform for incremental draws
  x.translate(CACHE_M, pTop);
  setPaperMode(page);
  const lo = top - 2, hi = top + h + 2;
  for (const item of page.items) {
    if (hiddenItems.has(item)) continue;
    const b = itemBBox(item);
    if (b.y + b.h < lo || b.y > hi) continue;
    drawItem(x, item);
  }
}

/** The content of a page changed: its thumbnail, its cached bottom and its height all follow. */
function markContent(page) {
  bottomCache.delete(page);
  heightDirty.add(page);
  dirtyThumbs.add(page);
}

function invalidatePage(page) {
  const bands = caches.get(page);
  if (bands) for (const c of bands.values()) c.dirty = true;
  markContent(page);
  requestRender();
}

/** Draw one new item onto whichever up-to-date bands it lands on, instead of rebaking. */
function cacheDrawItem(page, item) {
  const bands = caches.get(page);
  if (bands) {
    const b = itemBBox(item);
    setPaperMode(page);
    for (const c of bands.values()) {
      if (c.dirty) continue;
      const top = c.band * BAND_H;
      if (b.y + b.h < top || b.y > top + BAND_H) continue;
      drawItem(c.ctx, item);
    }
  }
  markContent(page);
}

/* ============================== templates ============================== */

/**
 * A pure black page has nothing to separate it from a dark app background and its drop
 * shadow is invisible there, so it gets a hairline of its own. Other papers need none.
 */
function drawPaperBorder(ctx, page, x, y, w, h, z, radii = PAGE_RADIUS * z) {
  if (page.paper !== 'black') return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = z;
  ctx.beginPath();
  ctx.roundRect(x + z / 2, y + z / 2, w - z, h - z, radii);
  ctx.stroke();
  ctx.restore();
}

/**
 * (x, y, w, h) is the whole page, however tall it is, so the ruling always lines up with the
 * page's own top. (vy0, vy1) is the slice actually being painted: a band, a thumbnail crop or
 * an exported sheet. Only lines inside that slice are emitted, so a page thousands of pixels
 * tall costs the same to draw as a short one.
 */
function drawTemplate(ctx, page, x, y, w, h, z, vy0 = y, vy1 = y + h) {
  // the light-paper line colour is a blue grey, so it has too much chroma for the ink
  // inversion to touch; the template picks its palette from the paper instead
  const dark = paperIsDark(page);
  const line = dark ? 'rgba(255,255,255,0.10)' : 'rgba(64,86,140,0.14)';
  const dot = dark ? 'rgba(255,255,255,0.22)' : 'rgba(64,86,140,0.30)';
  const t = page.template;
  if (t === 'blank') return;
  const from = Math.max(y, vy0), to = Math.min(y + h, vy1);
  if (to <= from) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, from, w, to - from);
  ctx.clip();
  ctx.strokeStyle = line;
  ctx.fillStyle = dot;
  ctx.lineWidth = Math.max(1, 0.8 * z);
  const gap = (t === 'lines' ? 34 : 30) * z;
  // first ruling at or above the slice, so the pattern is identical however it is cut up
  const firstAt = (start) => start + Math.max(0, Math.floor((from - start) / gap)) * gap;
  ctx.beginPath();
  if (t === 'lines') {
    const end = y + h - 20 * z;
    for (let ly = firstAt(y + 70 * z); ly < end && ly <= to; ly += gap) {
      ctx.moveTo(x + 34 * z, ly);
      ctx.lineTo(x + w - 34 * z, ly);
    }
    ctx.stroke();
  } else if (t === 'grid') {
    for (let lx = x + gap; lx < x + w; lx += gap) { ctx.moveTo(lx, from); ctx.lineTo(lx, to); }
    for (let ly = firstAt(y + gap); ly < y + h && ly <= to; ly += gap) { ctx.moveTo(x, ly); ctx.lineTo(x + w, ly); }
    ctx.stroke();
  } else if (t === 'dots') {
    const r = Math.max(1, 1.1 * z);
    for (let ly = firstAt(y + gap); ly < y + h && ly <= to; ly += gap)
      for (let lx = x + gap; lx < x + w; lx += gap) {
        ctx.moveTo(lx + r, ly);
        ctx.arc(lx, ly, r, 0, Math.PI * 2);
      }
    ctx.fill();
  }
  ctx.restore();
}

/* ============================== scene render ============================== */

let renderQueued = false;
export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.fillStyle = css.bg || '#eef0f4';
  sctx.fillRect(0, 0, cw, ch);
  if (!app.doc) return; // boot paints the background before the notebook has been read back
  const pages = app.doc.pages;
  const t = pageTops();
  frameNo++;
  sctx.imageSmoothingQuality = 'high';
  // only the bands on screen are rastered, so a notebook of very tall pages costs the same
  // to draw as a short one
  const topW = s2wY(-60), botW = s2wY(ch + 60);
  const dx = Math.round(w2sX(-PAGE_W / 2 - CACHE_M));
  const dw = Math.round(w2sX(PAGE_W / 2 + CACHE_M)) - dx;
  // single-page view puts one sheet on screen with nothing above or below it; the camera is
  // fenced to that page anyway, so this is the only place the rest of the strip is left out
  const solo = singleView() ? currentPageIndex() : -1;
  const first = solo >= 0 ? solo : Math.max(0, pageIndexAbove(topW));
  const stop = solo >= 0 ? solo : pages.length - 1;
  for (let i = first; i <= stop; i++) {
    if (solo < 0 && t[i] > botW) break;
    const page = pages[i];
    const h = pageHeight(page);
    if (t[i] + h < topW) continue;
    const last = bandCount(page) - 1;
    const from = Ink.clamp(Math.floor((topW - t[i]) / BAND_H), 0, last);
    const to = Ink.clamp(Math.floor((botW - t[i]) / BAND_H), 0, last);
    for (let b = from; b <= to; b++) {
      const c = ensureBand(page, b);
      // Bands are drawn edge to edge with no overlap: the margin is taken only where it is
      // really the outside of the page, and both edges are rounded to whole device pixels so
      // two bands can leave neither a hairline gap nor a double-composited strip between them.
      const mTop = b === 0 ? CACHE_M : 0;
      const mBot = b === last ? CACHE_M : 0;
      const sy = (CACHE_M - mTop) * c.zoom;
      const sh = c.canvas.height - sy - (CACHE_M - mBot) * c.zoom;
      const dy = Math.round(w2sY(t[i] + b * BAND_H - mTop));
      const dh = Math.round(w2sY(t[i] + Math.min((b + 1) * BAND_H, h) + mBot)) - dy;
      sctx.drawImage(c.canvas, 0, sy, c.canvas.width, sh, dx, dy, dw, dh);
    }
  }
  ui?.updatePageIndicator?.();
  updateCursor(); // panning onto a page with different paper flips the cursor colour
  if (sel) { requestOverlay(); positionSelbar(); }
  if (voice) positionVoicePanel(); // keep the recording panel pinned to its spot
}

/* ============================== overlay render ============================== */

let overlayQueued = false;
function requestOverlay() {
  if (overlayQueued) return;
  overlayQueued = true;
  requestAnimationFrame(() => { overlayQueued = false; renderOverlay(); });
}

function renderOverlay() {
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, cw, ch);
  const z = app.view.zoom;

  if (pin.mode === 'draw' && pin.stroke && pin.stroke.points.length) {
    const r = pageRect(pin.stroke.pageIndex);
    setPaperMode(app.doc.pages[pin.stroke.pageIndex]); // live preview blends like the bake will
    octx.save();
    octx.translate(w2sX(r.x), w2sY(r.y));
    octx.scale(z, z);
    drawItem(octx, pin.stroke);
    octx.restore();
  }

  // shape draft
  if (pin.mode === 'shape' && pin.shape) {
    const r = pageRect(pin.shape.pageIndex);
    setPaperMode(app.doc.pages[pin.shape.pageIndex]);
    octx.save();
    octx.translate(w2sX(r.x), w2sY(r.y));
    octx.scale(z, z);
    drawShape(octx, pin.shape.item);
    octx.restore();
  }

  // lasso path
  if (pin.mode === 'lasso' && pin.lasso && pin.lasso.pts.length > 1) {
    const r = pageRect(pin.lasso.pageIndex);
    octx.save();
    octx.translate(w2sX(r.x), w2sY(r.y));
    octx.scale(z, z);
    octx.beginPath();
    const pts = pin.lasso.pts;
    octx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) octx.lineTo(p.x, p.y);
    octx.closePath();
    octx.fillStyle = css.accent + '14';
    octx.fill();
    octx.setLineDash([6 / z, 5 / z]);
    octx.lineWidth = 1.5 / z;
    octx.strokeStyle = css.accent;
    octx.stroke();
    octx.restore();
  }

  // selection: translated items while dragging + dashed bounding box
  if (sel) {
    const r = pageRect(sel.pageIndex);
    const dx = selDelta?.dx || 0, dy = selDelta?.dy || 0;
    if (selDelta) {
      setPaperMode(app.doc.pages[sel.pageIndex]);
      octx.save();
      octx.translate(w2sX(r.x + dx), w2sY(r.y + dy));
      octx.scale(z, z);
      for (const it of sel.items) drawItem(octx, it);
      octx.restore();
    } else if (selResize) {
      // the item is hidden from its page cache, so this live rect is the only copy on screen
      setPaperMode(app.doc.pages[sel.pageIndex]);
      octx.save();
      octx.translate(w2sX(r.x), w2sY(r.y));
      octx.scale(z, z);
      drawImageItem(octx, sel.items[0], selResize);
      octx.restore();
    } else if (selCrop) {
      // likewise hidden: the window and the rect both move under the finger, so the item on
      // the page is stale for the whole drag and this is the only true copy of it
      setPaperMode(app.doc.pages[sel.pageIndex]);
      octx.save();
      octx.translate(w2sX(r.x), w2sY(r.y));
      octx.scale(z, z);
      drawImageItem(octx, sel.items[0], selCrop.rect, selCrop.crop);
      octx.restore();
    }
    // the ghost goes under the dashed box, and follows whichever drag is in flight so that
    // pulling an edge outward uncovers the picture in step with the pointer
    const shown = resizableItem();
    if (shown) {
      drawCropGhost(
        shown,
        selCrop?.rect || selResize || { x: shown.x + dx, y: shown.y + dy, w: shown.w, h: shown.h },
        selCrop?.crop || itemCrop(shown),
      );
    }
    const box = selScreenBox();
    if (box) {
      octx.save();
      octx.setLineDash([6, 5]);
      octx.lineWidth = 1.5;
      octx.strokeStyle = css.accent;
      octx.beginPath();
      octx.roundRect(box.x, box.y, box.w, box.h, 6);
      octx.stroke();
      octx.restore();
      if (resizableItem()) drawResizeHandles(box);
    }
  }

  // eraser ring: follows the paper it is over, falling back to the app theme in the gaps
  if (eraserRing.show) {
    const rr = (app.tools.eraser.size / 2) * z;
    octx.beginPath();
    octx.arc(eraserRing.x, eraserRing.y, rr, 0, Math.PI * 2);
    octx.strokeStyle = darkUnderPointer(eraserRing.x, eraserRing.y)
      ? 'rgba(255,255,255,0.75)' : 'rgba(20,23,34,0.7)';
    octx.lineWidth = 1.5;
    octx.stroke();
  }
}

/**
 * The part of the picture the crop window is hiding, drawn faintly so the user can see that
 * there is something left to drag back. It lives here rather than in drawImageItem because
 * that function bakes into the page raster cache, where a ghost would outlive the selection
 * it belongs to and stay on the page after a deselect. The visible window is punched out of
 * it with an even-odd clip, so the crisp copy underneath is never washed over by its own ghost.
 */
function drawCropGhost(it, rect, crop) {
  const { rw, rh } = rotDims(it);
  if (crop.x <= 0 && crop.y <= 0 && crop.w >= rw && crop.h >= rh) return; // nothing is hidden
  const sx = rect.w / crop.w, sy = rect.h / crop.h;
  const full = { x: rect.x - crop.x * sx, y: rect.y - crop.y * sy, w: rw * sx, h: rh * sy };
  const r = pageRect(sel.pageIndex);
  setPaperMode(app.doc.pages[sel.pageIndex]); // only the not-yet-decoded frame cares, but it does
  octx.save();
  octx.translate(w2sX(r.x), w2sY(r.y));
  octx.scale(app.view.zoom, app.view.zoom);
  octx.beginPath();
  octx.rect(full.x, full.y, full.w, full.h);
  octx.rect(rect.x, rect.y, rect.w, rect.h);
  octx.clip('evenodd');
  octx.globalAlpha = 0.25;
  drawImageItem(octx, it, full, { x: 0, y: 0, w: rw, h: rh });
  octx.restore();
}

/**
 * Grips for a selected image, drawn in screen space so they stay grabbable at any zoom. The
 * corners scale the picture and the edges crop it, so the edges are bars rather than squares:
 * the two do different things and the user has to be able to tell which is which before
 * committing a drag to one of them.
 */
function drawResizeHandles(box) {
  const h = HANDLE / 2;
  octx.save();
  octx.fillStyle = css.accent;
  octx.strokeStyle = '#ffffff';
  octx.lineWidth = 1.5;
  for (const p of handlePoints(box)) {
    octx.beginPath();
    octx.roundRect(p.x - h, p.y - h, HANDLE, HANDLE, 2.5);
    octx.fill();
    octx.stroke();
  }
  for (const p of edgePoints(box)) {
    const along = p.id === 'n' || p.id === 's';
    const w = along ? EDGE_BAR : HANDLE - 2, eh = along ? HANDLE - 2 : EDGE_BAR;
    octx.beginPath();
    octx.roundRect(p.x - w / 2, p.y - eh / 2, w, eh, 2);
    octx.fill();
    octx.stroke();
  }
  octx.restore();
}

/* ============================== cursors ============================== */

/** True when the paper under a screen point is dark; the app theme decides in the page gaps. */
function darkUnderPointer(sx, sy) {
  const wx = s2wX(sx), wy = s2wY(sy);
  const i = pageAtWorld(wx, wy);
  if (i < 0 || Math.abs(wx) > PAGE_W / 2) return resolvedTheme() === 'dark';
  return paperIsDark(app.doc.pages[i]);
}

/**
 * Tool cursors are little SVGs rather than the native crosshair, so their colour can
 * follow the paper instead of the OS: black on white/cream/gray, white on dark paper.
 * A soft halo of the opposite colour keeps them readable over ink.
 */
function cursorFor(tool, dark) {
  const ink = dark ? 'white' : 'black';
  const halo = dark ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.8)';
  const d = tool === 'text' ? 'M12 3v18M9 3h6M9 21h6' : 'M12 2v7M12 15v7M2 12h7M15 12h7';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round">`
    + `<path d="${d}" stroke="${halo}" stroke-width="4"/>`
    + `<path d="${d}" stroke="${ink}" stroke-width="1.7"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${tool === 'text' ? 'text' : 'crosshair'}`;
}

let cursorKey = '';
let hoverGrip = null; // which image grip the pointer is over, corner or edge, if any
/** Cheap enough to call every frame: the DOM is only touched when tool, paper or grip changes. */
function updateCursor() {
  if (!app.doc) return;
  const dark = paperIsDark(app.doc.pages[currentPageIndex()]);
  const key = `${app.tool}|${dark ? 'd' : 'l'}|${hoverGrip || ''}`;
  if (key === cursorKey) return;
  cursorKey = key;
  if (hoverGrip) {
    // an edge crops along one axis only, so it gets the one-axis cursor rather than a diagonal
    overlay.style.cursor = isEdgeGrip(hoverGrip)
      ? ((hoverGrip === 'n' || hoverGrip === 's') ? 'ns-resize' : 'ew-resize')
      : ((hoverGrip === 'nw' || hoverGrip === 'se') ? 'nwse-resize' : 'nesw-resize');
    return;
  }
  overlay.style.cursor = app.tool === 'eraser' ? 'none' : cursorFor(app.tool, dark);
}

/* ============================== undo ============================== */

function pushUndo(cmd) {
  app.undoStack.push(cmd);
  if (app.undoStack.length > MAX_UNDO) app.undoStack.shift();
  app.redoStack.length = 0;
  ui?.updateUndo?.();
  markDirty();
}

function undo() {
  const c = app.undoStack.pop();
  if (!c) return;
  clearSel();
  c.undo();
  app.redoStack.push(c);
  ui?.updateUndo?.();
  markDirty();
  requestRender();
}

function redo() {
  const c = app.redoStack.pop();
  if (!c) return;
  clearSel();
  c.redo();
  app.undoStack.push(c);
  ui?.updateUndo?.();
  markDirty();
  requestRender();
}

/* ============================== pointer input ============================== */

// active pointer interaction
const pin = {
  mode: null,        // draw | erase | pan | pinch | lasso | shape | moveSel | resizeImg | cropImg
  pointerId: null,
  stroke: null,
  erasedPages: null, // Map<page, originalItems>
  panStart: null,
  lasso: null,       // {pageIndex, pts: [{x,y}]}
  shape: null,       // draft shape item + pageIndex
  moveStart: null,   // {wx, wy}
  moveItems: null,   // the items hidden by a moveSel, kept so a drag that loses sel can unhide them
  resize: null,      // {item, grip, ax, ay, start} while dragging an image corner
  crop: null,        // {item, edge, crop0, rect0, sx, sy} while dragging an image edge
};
const touches = new Map(); // pointerId -> {sx, sy}
let pinchStart = null;
let penDown = false;
let spaceHeld = false;
const eraserRing = { show: false, x: 0, y: 0 };

overlay.addEventListener('contextmenu', (e) => e.preventDefault());

function capture(e) {
  try { overlay.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
}

function isPenEraser(e) {
  return e.pointerType === 'pen' && app.settings.penEraser && (e.buttons & 32 || e.buttons & 2);
}

overlay.addEventListener('pointerdown', (e) => {
  ui?.closePopovers?.();
  if (e.pointerType === 'pen') penDown = true;

  // touch → pan/pinch (palm rejection: ignore touch while pen is down)
  if (e.pointerType === 'touch' && !app.settings.touchDraw) {
    if (penDown && pin.mode === 'draw') return;
    touches.set(e.pointerId, { sx: e.clientX, sy: e.clientY });
    if (touches.size === 1) {
      // a finger picks up whatever it lands on, and pans when it lands on bare paper. The pen
      // being down is checked again here because the guard above only covers a live stroke,
      // and a palm can land before the pen ever touches the glass.
      if (!penDown && startTouchSel(e)) return;
      startPan(e);
    } else if (touches.size === 2) {
      startPinch();
    }
    return;
  }

  // a palm that landed before the pen has already grabbed whatever it touched, and that drag
  // owns pin.mode, which the guard below would then hold against every stroke that follows.
  // The pen always wins, so the drag is thrown away rather than committed. cancelSelDrag is a
  // no-op unless a move or resize is actually in flight.
  if (e.pointerType === 'pen') cancelSelDrag();

  if (pin.mode) return; // one interaction at a time

  // middle mouse or space → pan
  if (e.button === 1 || spaceHeld) { startPan(e); capture(e); return; }

  // right click picks up the picture under it whatever the tool is, and starts nothing at all.
  // A pen is excluded on purpose: its barrel button reports button 2 and must keep erasing.
  if (e.button === 2 && e.pointerType !== 'pen') {
    const rx = s2wX(e.clientX), ry = s2wY(e.clientY);
    const ri = pageAtWorld(rx, ry);
    const rr = ri < 0 ? null : pageRect(ri);
    const hit = rr ? imageAt(app.doc.pages[ri], rx - rr.x, ry - rr.y) : null;
    if (hit) selectItem(ri, hit);
    else clearSel();
    return;
  }

  if (e.button !== 0 && !isPenEraser(e)) return;

  const tool = isPenEraser(e) ? 'eraser' : app.tool;
  const wx = s2wX(e.clientX), wy = s2wY(e.clientY);
  const idx = pageAtWorld(wx, wy);
  if (idx < 0) return;
  capture(e);
  pin.pointerId = e.pointerId;

  // a live selection is modal: it takes the drag before any tool sees it, so a picture can be
  // moved and resized without changing tools. A press outside it clears it and falls through,
  // which is what keeps the first point of a stroke started outside a selection.
  if (sel && !isPenEraser(e)) {
    // grips sit inside the padded box, so they are offered before the move handle
    const grip = handleAt(e.clientX, e.clientY);
    if (grip) { startGrip(grip); return; }
    if (pointInSelBox(wx, wy)) {
      const sr = pageRect(sel.pageIndex);
      startSelMove(wx - sr.x, wy - sr.y);
      return;
    }
    clearSel();
  }

  if (tool === 'pen' || tool === 'highlighter') {
    const t = app.tools[tool];
    pin.mode = 'draw';
    pin.stroke = {
      id: uid(), type: 'stroke', tool,
      color: t.color, size: t.size,
      opacity: tool === 'highlighter' ? t.opacity : 1,
      pageIndex: idx, points: [],
    };
    addStrokePoint(e, wx, wy);
  } else if (tool === 'eraser') {
    pin.mode = 'erase';
    pin.erasedPages = new Map();
    eraseAt(wx, wy);
  } else if (tool === 'lasso') {
    // grips, the move handle and clearing all happened above, for every tool
    const r = pageRect(idx);
    pin.mode = 'lasso';
    pin.lasso = { pageIndex: idx, pts: [{ x: wx - r.x, y: wy - r.y }] };
    requestOverlay();
  } else if (tool === 'textify') {
    const r = pageRect(idx);
    clearSel();
    pin.mode = 'lasso';
    pin.lasso = { pageIndex: idx, pts: [{ x: wx - r.x, y: wy - r.y }], textify: true };
    requestOverlay();
  } else if (tool === 'voice') {
    const r = pageRect(idx);
    startVoice(idx, Ink.clamp(wx - r.x, 0, PAGE_W - 40), Ink.clamp(wy - r.y, 0, r.h - 20));
    pin.mode = null;
    pin.pointerId = null;
  } else if (tool === 'text') {
    const r = pageRect(idx);
    const px = wx - r.x, py = wy - r.y;
    const page = app.doc.pages[idx];
    startTextEdit(idx, px, py, textItemAt(page, px, py));
    pin.mode = null;
    pin.pointerId = null;
  } else if (tool === 'shape') {
    const r = pageRect(idx);
    const t = app.tools.shape;
    pin.mode = 'shape';
    pin.shape = {
      pageIndex: idx,
      item: {
        id: uid(), type: 'shape', kind: t.kind, color: t.color, size: t.size,
        x1: Ink.clamp(wx - r.x, 0, PAGE_W), y1: Ink.clamp(wy - r.y, 0, r.h),
        x2: Ink.clamp(wx - r.x, 0, PAGE_W), y2: Ink.clamp(wy - r.y, 0, r.h),
      },
    };
    requestOverlay();
  }
});

function addStrokePoint(e, wx, wy) {
  const r = pageRect(pin.stroke.pageIndex);
  // writing into the tail extends the page there and then, so the stroke keeps following the
  // pen instead of flattening against a bottom edge that is about to move anyway
  const raw = wy - r.y;
  const page = app.doc.pages[pin.stroke.pageIndex];
  if (raw > pageHeight(page) - TAIL_TRIGGER) {
    setPageHeight(page, Math.ceil((raw + PAGE_TAIL) / PAGE_STEP) * PAGE_STEP);
  }
  const px = Ink.clamp(wx - r.x, 0, PAGE_W);
  const py = Ink.clamp(raw, 0, pageHeight(page));
  const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  const pts = pin.stroke.points;
  const last = pts[pts.length - 1];
  if (last && Math.abs(last.x - px) < 0.05 && Math.abs(last.y - py) < 0.05) return;
  pts.push({ x: px, y: py, p });
  pathCache.delete(pin.stroke);
}

overlay.addEventListener('pointermove', (e) => {
  // eraser hover ring
  if (app.tool === 'eraser' || pin.mode === 'erase') {
    eraserRing.show = true;
    eraserRing.x = e.clientX;
    eraserRing.y = e.clientY;
    requestOverlay();
  } else if (eraserRing.show) {
    eraserRing.show = false;
    requestOverlay();
  }

  // grips take over the cursor while any idle tool is over a selected image
  const grip = !pin.mode ? handleAt(e.clientX, e.clientY) : null;
  if (grip !== hoverGrip) { hoverGrip = grip; updateCursor(); }

  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.get(e.pointerId).sx = e.clientX;
    touches.get(e.pointerId).sy = e.clientY;
    if (pinchStart && touches.size >= 2) movePinch();
    else if (isSelDragMode(pin.mode)) moveSelDrag(e);
    else if (pin.mode === 'pan') movePan(e);
    return;
  }

  if (pin.mode === 'pan') { movePan(e); return; }
  if (e.pointerId !== pin.pointerId) return;

  const coalesced = e.getCoalescedEvents?.();
  const events = coalesced && coalesced.length ? coalesced : [e];
  if (pin.mode === 'draw') {
    // pen flipped to eraser mid-stroke? commit and switch
    if (isPenEraser(e)) { finishStroke(); pin.mode = 'erase'; pin.erasedPages = new Map(); }
    else {
      for (const ce of events) addStrokePoint(ce, s2wX(ce.clientX), s2wY(ce.clientY));
      requestOverlay();
      return;
    }
  }
  if (pin.mode === 'erase') {
    for (const ce of events) eraseAt(s2wX(ce.clientX), s2wY(ce.clientY));
  } else if (pin.mode === 'lasso') {
    const r = pageRect(pin.lasso.pageIndex);
    for (const ce of events) {
      pin.lasso.pts.push({
        x: Ink.clamp(s2wX(ce.clientX) - r.x, 0, PAGE_W),
        y: Ink.clamp(s2wY(ce.clientY) - r.y, 0, r.h),
      });
    }
    requestOverlay();
  } else if (isSelDragMode(pin.mode)) {
    moveSelDrag(e);
  } else if (pin.mode === 'shape') {
    const r = pageRect(pin.shape.pageIndex);
    const it = pin.shape.item;
    const page = app.doc.pages[pin.shape.pageIndex];
    const rawY = s2wY(e.clientY) - r.y;
    if (rawY > pageHeight(page) - TAIL_TRIGGER) { // same tail growth as freehand ink
      setPageHeight(page, Math.ceil((rawY + PAGE_TAIL) / PAGE_STEP) * PAGE_STEP);
    }
    let x2 = Ink.clamp(s2wX(e.clientX) - r.x, 0, PAGE_W);
    let y2 = Ink.clamp(rawY, 0, pageHeight(page));
    if (e.shiftKey) {
      const dx = x2 - it.x1, dy = y2 - it.y1;
      if (it.kind === 'line' || it.kind === 'arrow') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x2 = it.x1 + Math.cos(ang) * len;
        y2 = it.y1 + Math.sin(ang) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x2 = it.x1 + Math.sign(dx || 1) * m;
        y2 = it.y1 + Math.sign(dy || 1) * m;
      }
    }
    it.x2 = x2;
    it.y2 = y2;
    requestOverlay();
  }
});

function endPointer(e) {
  if (e.pointerType === 'pen') penDown = false;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchStart = null;
    // a finger that was dragging something commits here, before any remaining finger is handed
    // the pan, so lifting is one undo step whatever else is still on the glass
    if (isSelDragMode(pin.mode)) {
      commitSelDrag(pin.mode);
      pin.mode = null;
      pin.pointerId = null;
    }
    if (touches.size === 1) {
      const [t] = touches.values();
      pin.mode = 'pan';
      pin.panStart = { sx: t.sx, sy: t.sy, vx: app.view.x, vy: app.view.y };
    } else if (touches.size === 0 && pin.mode === 'pan') {
      pin.mode = null;
      endGesture();
    }
    return;
  }
  if (pin.mode === 'pan') { pin.mode = null; endGesture(); return; }
  if (e.pointerId !== pin.pointerId) return;
  if (pin.mode === 'draw') finishStroke();
  if (pin.mode === 'erase') finishErase();
  if (pin.mode === 'lasso') finishLasso();
  if (isSelDragMode(pin.mode)) commitSelDrag(pin.mode);
  if (pin.mode === 'shape') finishShape();
  pin.mode = null;
  pin.pointerId = null;
}
overlay.addEventListener('pointerup', endPointer);
overlay.addEventListener('pointercancel', endPointer);
overlay.addEventListener('pointerleave', (e) => {
  if (eraserRing.show && !pin.mode) { eraserRing.show = false; requestOverlay(); }
});

/* ---------- draw commit ---------- */

function finishStroke() {
  const s = pin.stroke;
  pin.stroke = null;
  requestOverlay();
  if (!s || !s.points.length) return;
  const page = app.doc.pages[s.pageIndex];
  delete s.pageIndex;
  const item = { ...s, bbox: Ink.bboxOfPoints(s.points, s.size) };
  page.items.push(item);
  cacheDrawItem(page, item);
  pushUndo({
    undo: () => { removeItems(page, [item.id]); },
    redo: () => { page.items.push(item); invalidatePage(page); },
  });
  requestRender();
}

function removeItems(page, ids) {
  const set = new Set(ids);
  page.items = page.items.filter((it) => !set.has(it.id));
  invalidatePage(page);
}

/* ---------- erase ---------- */

function shapeOutline(s) {
  const { x1, y1, x2, y2 } = s;
  if (s.kind === 'rect') {
    const ax = Math.min(x1, x2), ay = Math.min(y1, y2);
    const bx = Math.max(x1, x2), by = Math.max(y1, y2);
    return [{ x: ax, y: ay }, { x: bx, y: ay }, { x: bx, y: by }, { x: ax, y: by }, { x: ax, y: ay }];
  }
  if (s.kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
    return pts;
  }
  return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
}

function shapeHitCircle(s, x, y, r) {
  const pts = shapeOutline(s);
  const tol = r + s.size / 2;
  const tol2 = tol * tol;
  for (let i = 1; i < pts.length; i++) {
    if (Ink.segDist2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol2) return true;
  }
  return false;
}

function rectHitCircle(b, x, y, r) {
  const cx = Ink.clamp(x, b.x, b.x + b.w);
  const cy = Ink.clamp(y, b.y, b.y + b.h);
  return (cx - x) ** 2 + (cy - y) ** 2 <= r * r;
}

function eraseHits(it, x, y, r) {
  if (it.type === 'stroke') return Ink.strokeHitCircle(it, x, y, r);
  if (it.type === 'shape') return shapeHitCircle(it, x, y, r);
  // text and images have no outline to split, so touching them anywhere counts
  if (it.type === 'text' || it.type === 'image') return rectHitCircle(itemBBox(it), x, y, r);
  return false;
}

function eraseAt(wx, wy) {
  const idx = pageAtWorld(wx, wy);
  if (idx < 0) return;
  const page = app.doc.pages[idx];
  const r = pageRect(idx);
  const px = wx - r.x, py = wy - r.y;
  const er = app.tools.eraser.size / 2;
  const mode = app.tools.eraser.mode;

  let changed = false;
  if (mode === 'stroke') {
    const keep = [];
    for (const it of page.items) {
      if (eraseHits(it, px, py, er)) {
        if (!pin.erasedPages.has(page)) pin.erasedPages.set(page, page.items.slice());
        changed = true;
      } else keep.push(it);
    }
    if (changed) page.items = keep;
  } else {
    // precise: split strokes around the erased circle; text and shapes go whole
    const out = [];
    for (const it of page.items) {
      if (!eraseHits(it, px, py, er)) { out.push(it); continue; }
      if (!pin.erasedPages.has(page)) pin.erasedPages.set(page, page.items.slice());
      changed = true;
      if (it.type !== 'stroke') continue;
      const rr = er + it.size / 2;
      const rr2 = rr * rr;
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const ns = { ...it, id: uid(), points: run, bbox: Ink.bboxOfPoints(run, it.size) };
          out.push(ns);
        }
        run = [];
      };
      for (const pt of it.points) {
        const dx = pt.x - px, dy = pt.y - py;
        if (dx * dx + dy * dy <= rr2) flush();
        else run.push(pt);
      }
      flush();
    }
    if (changed) page.items = out;
  }
  if (changed) invalidatePage(page);
}

function finishErase() {
  const pagesMap = pin.erasedPages;
  pin.erasedPages = null;
  if (!pagesMap || !pagesMap.size) return;
  const entries = [...pagesMap.entries()].map(([page, before]) => ({ page, before, after: page.items.slice() }));
  pushUndo({
    undo: () => entries.forEach(({ page, before }) => { page.items = before.slice(); invalidatePage(page); }),
    redo: () => entries.forEach(({ page, after }) => { page.items = after.slice(); invalidatePage(page); }),
  });
}

/* ---------- selection (lasso) ---------- */

let sel = null;       // {pageIndex, items: []}
let selDelta = null;  // {dx, dy} while dragging a selection
let selResize = null; // {x, y, w, h} while dragging a corner grip of a lone image
let selCrop = null;   // {rect, crop} while dragging an edge grip of a lone image

function selBBox() {
  if (!sel || !sel.items.length) return null;
  if (selResize) return { ...selResize }; // the live rect is the selection while resizing
  if (selCrop) return { ...selCrop.rect }; // and while cropping, where the rect shrinks with it
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of sel.items) {
    const b = itemBBox(it);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function itemBBox(it) {
  // an image carries its rect directly, so the stored bbox is only a mirror for persistence
  if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.bbox) return it.bbox;
  if (it.type === 'shape') {
    const p = it.size / 2 + 2;
    return { x: Math.min(it.x1, it.x2) - p, y: Math.min(it.y1, it.y2) - p, w: Math.abs(it.x2 - it.x1) + p * 2, h: Math.abs(it.y2 - it.y1) + p * 2 };
  }
  if (it.type === 'text') return measureTextItem(it);
  return { x: 0, y: 0, w: 0, h: 0 };
}

function measureTextItem(it) {
  sctx.font = `${it.size}px "Segoe UI", system-ui, sans-serif`;
  const lines = it.text.split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, sctx.measureText(l).width);
  return { x: it.x, y: it.y, w: Math.max(w, 8), h: lines.length * it.size * 1.35 };
}

function clearSel() {
  if (!sel) return;
  sel = null;
  selDelta = null;
  selResize = null;
  selCrop = null;
  ui?.showSelbar?.(null);
  requestOverlay();
}

/* ---------- picking something up without drawing a lasso around it ---------- */

const TAP_HIT = 10; // page units of slack around a tap, so a tap is a fingertip and not a point

/** The topmost image under a page point, or null. items are in paint order, so walk them back. */
function imageAt(page, px, py) {
  for (let i = page.items.length - 1; i >= 0; i--) {
    const it = page.items[i];
    if (it.type !== 'image') continue;
    if (px >= it.x && px <= it.x + it.w && py >= it.y && py <= it.y + it.h) return it;
  }
  return null;
}

/**
 * The topmost item of any type under a page point, or null. eraseHits is the test the eraser
 * already uses, so grabbing something and rubbing it out agree about what "on an item" means.
 */
function itemAt(page, px, py, r) {
  for (let i = page.items.length - 1; i >= 0; i--) {
    if (eraseHits(page.items[i], px, py, r)) return page.items[i];
  }
  return null;
}

/** Select one item the way finishLasso does: without positionSelbar the selection bar never shows. */
function selectItem(pageIndex, it) {
  sel = { pageIndex, items: [it] };
  selDelta = null;
  selResize = null;
  selCrop = null;
  requestOverlay();
  positionSelbar();
}

/** Is a world point inside the current selection's padded box? */
function pointInSelBox(wx, wy) {
  const b = selBBox();
  if (!b) return false;
  const r = pageRect(sel.pageIndex);
  const px = wx - r.x, py = wy - r.y;
  return px >= b.x - 8 && px <= b.x + b.w + 8 && py >= b.y - 8 && py <= b.y + b.h + 8;
}

/** Start dragging the whole selection, from a point in its own page's coordinates. */
function startSelMove(px, py) {
  pin.mode = 'moveSel';
  pin.moveStart = { x: px, y: py };
  // the hidden items are stashed on pin because sel and selDelta are both dropped by clearSel,
  // and something has to survive that or an abandoned drag has nothing left to unhide
  pin.moveItems = sel.items;
  selDelta = { dx: 0, dy: 0 };
  for (const it of sel.items) hiddenItems.add(it);
  invalidatePage(app.doc.pages[sel.pageIndex]);
}

/**
 * A finger landing on the page picks something up instead of panning: a grip first, then the
 * live selection, then whatever item is under the fingertip. Returns true if it grabbed
 * something, so the caller can fall through to panning when it did not.
 */
function startTouchSel(e) {
  const wx = s2wX(e.clientX), wy = s2wY(e.clientY);
  const idx = pageAtWorld(wx, wy);
  if (idx < 0) return false;
  if (sel) {
    // grips sit inside the padded box, so they are offered before the move handle
    const grip = handleAt(e.clientX, e.clientY);
    if (grip) { pin.pointerId = e.pointerId; startGrip(grip); return true; }
    // a finger anywhere on a multi item selection moves the whole of it, not the item it hit
    if (pointInSelBox(wx, wy)) {
      const sr = pageRect(sel.pageIndex);
      pin.pointerId = e.pointerId;
      startSelMove(wx - sr.x, wy - sr.y);
      return true;
    }
  }
  const r = pageRect(idx);
  const px = wx - r.x, py = wy - r.y;
  const hit = itemAt(app.doc.pages[idx], px, py, TAP_HIT);
  if (!hit) return false; // bare paper: the gesture is a pan, exactly as it has always been
  selectItem(idx, hit);
  pin.pointerId = e.pointerId;
  startSelMove(px, py);
  return true;
}

/** The three pin modes that are a live selection being dragged rather than a tool being used. */
function isSelDragMode(mode) {
  return mode === 'moveSel' || mode === 'resizeImg' || mode === 'cropImg';
}

/** Land whichever of the three drags was in flight. Every lift path goes through here. */
function commitSelDrag(mode) {
  if (mode === 'moveSel') commitSelMove();
  else if (mode === 'resizeImg') commitResize();
  else if (mode === 'cropImg') commitCrop();
}

/** One drag update for a live selection, shared by the mouse, the pen and a single finger. */
function moveSelDrag(e) {
  if (!sel) return; // the selection went away mid drag
  const r = pageRect(sel.pageIndex);
  if (pin.mode === 'moveSel') {
    if (!selDelta) return;
    selDelta.dx = s2wX(e.clientX) - r.x - pin.moveStart.x;
    selDelta.dy = s2wY(e.clientY) - r.y - pin.moveStart.y;
  } else if (pin.mode === 'resizeImg') {
    if (!pin.resize) return;
    updateResize(s2wX(e.clientX) - r.x, s2wY(e.clientY) - r.y);
  } else if (pin.mode === 'cropImg') {
    if (!pin.crop) return;
    updateCrop(s2wX(e.clientX) - r.x, s2wY(e.clientY) - r.y);
  }
  requestOverlay();
  positionSelbar();
}

/**
 * Abandon a move, a resize or a crop without committing it. A second finger turns the gesture
 * into a pinch and startPinch overwrites pin.mode, so without this the dragged items would sit
 * in hiddenItems for ever and vanish from the page. No geometry has to be put back: a drag only
 * ever writes selDelta, selResize or selCrop, never the item, so dropping those three is the
 * restore. The selection itself survives, only the drag is thrown away.
 */
function cancelSelDrag() {
  if (!isSelDragMode(pin.mode)) return;
  const lone = pin.resize?.item || pin.crop?.item;
  const items = pin.mode === 'moveSel' ? (pin.moveItems || []) : (lone ? [lone] : []);
  pin.resize = null;
  pin.crop = null;
  pin.moveItems = null;
  selDelta = null;
  selResize = null;
  selCrop = null;
  pin.mode = null;
  pin.pointerId = null;
  for (const it of items) hiddenItems.delete(it);
  const page = items.length ? app.doc.pages.find((p) => p.items.includes(items[0])) : null;
  if (page) invalidatePage(page);
  requestOverlay();
  positionSelbar();
}

/* ---------- image resize and crop grips ---------- */

const SEL_PAD = 8;      // gap between the dashed box and the content, in screen px
const HANDLE = 9;       // drawn grip size, screen px
const HANDLE_HIT = 13;  // grab radius around a grip, generous enough for a fingertip
const EDGE_BAR = 18;    // length of an edge crop bar, screen px, so it reads as a bar not a dot
const MIN_IMAGE = 24;   // smallest an image can be dragged to, in page units

/** Only a lone image gets grips: strokes and text have no meaningful scale to drag. */
function resizableItem() {
  return sel && sel.items.length === 1 && sel.items[0].type === 'image' ? sel.items[0] : null;
}

/** The padded selection box in screen coords, the one the dashed outline is drawn on. */
function selScreenBox() {
  const b = selBBox();
  if (!b) return null;
  const r = pageRect(sel.pageIndex);
  const z = app.view.zoom;
  const dx = selDelta?.dx || 0, dy = selDelta?.dy || 0;
  return {
    x: w2sX(r.x + b.x + dx) - SEL_PAD,
    y: w2sY(r.y + b.y + dy) - SEL_PAD,
    w: b.w * z + SEL_PAD * 2,
    h: b.h * z + SEL_PAD * 2,
  };
}

const handlePoints = (box) => [
  { id: 'nw', x: box.x, y: box.y },
  { id: 'ne', x: box.x + box.w, y: box.y },
  { id: 'se', x: box.x + box.w, y: box.y + box.h },
  { id: 'sw', x: box.x, y: box.y + box.h },
];

const edgePoints = (box) => [
  { id: 'n', x: box.x + box.w / 2, y: box.y },
  { id: 'e', x: box.x + box.w, y: box.y + box.h / 2 },
  { id: 's', x: box.x + box.w / 2, y: box.y + box.h },
  { id: 'w', x: box.x, y: box.y + box.h / 2 },
];

const isEdgeGrip = (id) => id === 'n' || id === 'e' || id === 's' || id === 'w';

/**
 * Which grip is under a screen point, or null. Grips live inside the box, so this runs first.
 * The corners are tested before the edges and returned without ever looking at an edge: with
 * a 13px grab radius on a box only 16px wider than its content, the two overlap on a small
 * picture, and answering "corner" there is what keeps scaling reachable at all.
 */
function handleAt(sx, sy) {
  if (!resizableItem()) return null;
  const box = selScreenBox();
  if (!box) return null;
  for (const p of handlePoints(box)) {
    if (Math.abs(sx - p.x) <= HANDLE_HIT && Math.abs(sy - p.y) <= HANDLE_HIT) return p.id;
  }
  for (const p of edgePoints(box)) {
    if (Math.abs(sx - p.x) <= HANDLE_HIT && Math.abs(sy - p.y) <= HANDLE_HIT) return p.id;
  }
  return null;
}

/** A corner grip scales the whole picture, an edge grip crops the window it is seen through. */
function startGrip(grip) {
  if (isEdgeGrip(grip)) startCrop(grip);
  else startResize(grip);
}

function startResize(grip) {
  const it = resizableItem();
  pin.mode = 'resizeImg';
  pin.resize = {
    item: it,
    grip,
    // the corner opposite the grip stays put for the whole drag
    ax: (grip === 'nw' || grip === 'sw') ? it.x + it.w : it.x,
    ay: (grip === 'nw' || grip === 'ne') ? it.y + it.h : it.y,
    start: { x: it.x, y: it.y, w: it.w, h: it.h },
  };
  selResize = { x: it.x, y: it.y, w: it.w, h: it.h };
  hiddenItems.add(it);
  invalidatePage(app.doc.pages[sel.pageIndex]);
  requestOverlay();
}

/**
 * Aspect is always preserved: the grip drives one scale factor off the fixed corner, and
 * the larger of the two axis demands wins so the corner keeps up with the pointer.
 */
function updateResize(px, py) {
  const q = pin.resize;
  const s0 = q.start;
  const ratio = s0.w / s0.h;
  const scale = Math.max(Math.abs(px - q.ax) / s0.w, Math.abs(py - q.ay) / s0.h);
  const w = Math.max(MIN_IMAGE, s0.w * scale);
  const h = w / ratio;
  selResize = {
    x: (q.grip === 'nw' || q.grip === 'sw') ? q.ax - w : q.ax,
    y: (q.grip === 'nw' || q.grip === 'ne') ? q.ay - h : q.ay,
    w, h,
  };
}

function commitResize() {
  const q = pin.resize;
  const rect = selResize;
  pin.resize = null;
  selResize = null;
  if (!q) return;
  const it = q.item;
  // Escape or an undo can drop the selection mid drag, so the item is unhidden from the
  // page it is actually on rather than from whatever the selection used to point at
  hiddenItems.delete(it);
  const page = app.doc.pages.find((p) => p.items.includes(it));
  if (!page) return;
  if (!rect) { invalidatePage(page); return; }
  const before = q.start;
  const after = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (Math.abs(after.w - before.w) > 0.5 || Math.abs(after.h - before.h) > 0.5) {
    const apply = (g) => { Object.assign(it, g); it.bbox = { ...g }; invalidatePage(page); };
    apply(after);
    pushUndo({ undo: () => apply(before), redo: () => apply(after) });
  }
  invalidatePage(page);
  requestOverlay();
  positionSelbar();
}

/* ---------- non-destructive crop and quarter turns ---------- */

/** Everything a crop or a quarter turn can change, copied so an undo entry can hold on to it. */
function imageGeom(it) {
  return {
    x: it.x, y: it.y, w: it.w, h: it.h,
    rot: it.rot || 0,
    crop: it.crop ? { ...it.crop } : null,
  };
}

/**
 * Put a geometry snapshot back on an image. A snapshot with no turn and no window deletes the
 * two fields rather than writing defaults into them, so undoing the very first crop or turn
 * leaves the item byte for byte as it was found on disk. bbox is the mirror that persistence
 * and hit testing both read, so it is rewritten from the rect every time.
 */
function applyImageGeom(it, g) {
  it.x = g.x; it.y = g.y; it.w = g.w; it.h = g.h;
  if (g.rot) it.rot = g.rot; else delete it.rot;
  if (g.crop) it.crop = { ...g.crop }; else delete it.crop;
  it.bbox = { x: g.x, y: g.y, w: g.w, h: g.h };
}

/**
 * One clockwise quarter turn of a geometry snapshot, which is the only piece of rotation
 * geometry in the app: anticlockwise is three of these, so there is nothing to get wrong twice.
 * The window is carried into the new frame by the same point map the pixels take, a point at
 * (x, y) landing at (rh - y, x), so the same picture stays visible across the turn. The rect
 * swaps its sides about its own centre, which is what makes the picture turn where it sits
 * instead of jumping off towards a corner. A full window stays full and is left absent.
 */
function turnGeomCW(g, it) {
  const { rh } = rotDims({ rot: g.rot, nw: it.nw, nh: it.nh });
  if (g.crop) g.crop = { x: rh - (g.crop.y + g.crop.h), y: g.crop.x, w: g.crop.h, h: g.crop.w };
  g.rot = (g.rot + 90) % 360;
  const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
  const w = g.h, h = g.w;
  g.w = w; g.h = h;
  g.x = cx - w / 2; g.y = cy - h / 2;
}

/** Turn the selected lone image by a quarter, clockwise for dir 1, the other way for dir -1. */
function rotateSelection(dir) {
  const it = resizableItem();
  if (!it) return;
  const page = app.doc.pages.find((p) => p.items.includes(it));
  if (!page) return;
  const before = imageGeom(it);
  const after = imageGeom(it);
  for (let n = dir > 0 ? 1 : 3; n > 0; n--) turnGeomCW(after, it);
  const apply = (g) => { applyImageGeom(it, g); invalidatePage(page); requestOverlay(); positionSelbar(); };
  apply(after);
  pushUndo({ undo: () => apply(before), redo: () => apply(after) });
}

const rotateSelectionLeft = () => rotateSelection(-1);
const rotateSelectionRight = () => rotateSelection(1);

/**
 * Take hold of one edge of the window. The scale is frozen here for the whole drag: cropping
 * changes what is seen and never how big it is drawn, so the content under the window has to
 * stay exactly where it is while the window closes over it.
 */
function startCrop(edge) {
  const it = resizableItem();
  const crop0 = { ...itemCrop(it) };
  const rect0 = { x: it.x, y: it.y, w: it.w, h: it.h };
  pin.mode = 'cropImg';
  pin.crop = { item: it, edge, crop0, rect0, sx: rect0.w / crop0.w, sy: rect0.h / crop0.h };
  selCrop = { rect: { ...rect0 }, crop: { ...crop0 } };
  hiddenItems.add(it);
  invalidatePage(app.doc.pages[sel.pageIndex]);
  requestOverlay();
}

/**
 * Move the one dragged edge, in rotated-natural pixels, and let the drawn rect follow it. The
 * window is hard stopped at the original picture's own bounds, so a crop can be pulled back out
 * to the whole photograph and not one pixel further.
 */
function updateCrop(px, py) {
  const q = pin.crop;
  const { crop0, rect0, sx, sy } = q;
  const { rw, rh } = rotDims(q.item);
  // the floor gives up on MIN_IMAGE for a picture already smaller than that, because a floor
  // above the current window would answer an inward drag by jumping the edge outward
  const minW = Math.min(MIN_IMAGE / sx, crop0.w);
  const minH = Math.min(MIN_IMAGE / sy, crop0.h);
  const crop = { ...crop0 };
  if (q.edge === 'w') {
    crop.x = Ink.clamp(crop0.x + (px - rect0.x) / sx, 0, crop0.x + crop0.w - minW);
    crop.w = crop0.x + crop0.w - crop.x;
  } else if (q.edge === 'e') {
    crop.w = Ink.clamp(crop0.x + (px - rect0.x) / sx, crop0.x + minW, rw) - crop0.x;
  } else if (q.edge === 'n') {
    crop.y = Ink.clamp(crop0.y + (py - rect0.y) / sy, 0, crop0.y + crop0.h - minH);
    crop.h = crop0.y + crop0.h - crop.y;
  } else {
    crop.h = Ink.clamp(crop0.y + (py - rect0.y) / sy, crop0.y + minH, rh) - crop0.y;
  }
  selCrop = {
    crop,
    rect: {
      x: rect0.x + (crop.x - crop0.x) * sx,
      y: rect0.y + (crop.y - crop0.y) * sy,
      w: crop.w * sx,
      h: crop.h * sy,
    },
  };
}

function commitCrop() {
  const q = pin.crop;
  const live = selCrop;
  pin.crop = null;
  selCrop = null;
  if (!q) return;
  const it = q.item;
  // Escape or an undo can drop the selection mid drag, so the item is unhidden from the
  // page it is actually on rather than from whatever the selection used to point at
  hiddenItems.delete(it);
  const page = app.doc.pages.find((p) => p.items.includes(it));
  if (!page) return;
  if (!live) { invalidatePage(page); return; }
  const before = { ...q.rect0, rot: it.rot || 0, crop: it.crop ? { ...it.crop } : null };
  const after = { ...live.rect, rot: before.rot, crop: { ...live.crop } };
  // the test is on the drawn rect, not on the window, so its half a page unit means the same
  // thing here as it does in commitResize. rect.w is crop.w * sx, so the two never disagree
  // about whether anything moved, but on an upscaled picture the window alone would call a
  // visible drag a click and spring the crop back on release.
  if (Math.abs(after.w - before.w) > 0.5 || Math.abs(after.h - before.h) > 0.5) {
    const apply = (g) => { applyImageGeom(it, g); invalidatePage(page); };
    apply(after);
    pushUndo({ undo: () => apply(before), redo: () => apply(after) });
  }
  invalidatePage(page);
  requestOverlay();
  positionSelbar();
}

function finishLasso() {
  const l = pin.lasso;
  pin.lasso = null;
  if (!l || l.pts.length < 3) {
    // a tap rather than a loop: pick up whatever it landed on, and clear on bare paper
    const page = l && !l.textify ? app.doc.pages[l.pageIndex] : null;
    const hit = page && l.pts[0] ? itemAt(page, l.pts[0].x, l.pts[0].y, TAP_HIT) : null;
    if (hit) selectItem(l.pageIndex, hit);
    else clearSel();
    requestOverlay();
    return;
  }
  if (l.textify) { requestOverlay(); textifyRegion(l); return; }
  const page = app.doc.pages[l.pageIndex];
  const picked = [];
  for (const it of page.items) {
    if (it.type === 'stroke') {
      if (Ink.fractionInPolygon(it.points, l.pts) > 0.5) picked.push(it);
    } else {
      const b = itemBBox(it);
      if (Ink.pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, l.pts)) picked.push(it);
    }
  }
  if (picked.length) {
    sel = { pageIndex: l.pageIndex, items: picked };
    requestOverlay();
    positionSelbar();
  } else {
    clearSel();
  }
  requestOverlay();
}

function positionSelbar() {
  if (!sel) { ui?.showSelbar?.(null); return; }
  const b = selBBox();
  const r = pageRect(sel.pageIndex);
  const dx = selDelta?.dx || 0, dy = selDelta?.dy || 0;
  ui?.showSelbar?.({
    x: w2sX(r.x + b.x + dx),
    y: w2sY(r.y + b.y + dy),
    w: b.w * app.view.zoom,
    h: b.h * app.view.zoom,
  }, { count: sel.items.length, loneImage: !!resizableItem() });
}

function translateItem(it, dx, dy) {
  if (it.type === 'stroke') {
    for (const p of it.points) { p.x += dx; p.y += dy; }
    it.bbox.x += dx; it.bbox.y += dy;
    pathCache.delete(it);
  } else if (it.type === 'text' || it.type === 'image') {
    it.x += dx; it.y += dy;
    if (it.bbox) { it.bbox.x += dx; it.bbox.y += dy; }
  } else if (it.type === 'shape') {
    it.x1 += dx; it.y1 += dy; it.x2 += dx; it.y2 += dy;
    if (it.bbox) { it.bbox.x += dx; it.bbox.y += dy; }
  }
}

function commitSelMove() {
  const d = selDelta;
  const items = pin.moveItems;
  selDelta = null;
  pin.moveItems = null;
  if (!items || !items.length) return; // no drag was in flight, so nothing is hidden either
  // Escape or a notebook switch can drop the selection mid drag, so the items are unhidden and
  // their page is found from the items themselves rather than from whatever sel used to point
  // at. Losing the selection abandons the move, but it can never abandon the items.
  for (const it of items) hiddenItems.delete(it);
  const page = app.doc.pages.find((p) => p.items.includes(items[0]));
  if (d && sel && (Math.abs(d.dx) > 0.01 || Math.abs(d.dy) > 0.01) && page) {
    const { dx, dy } = d;
    for (const it of items) translateItem(it, dx, dy);
    pushUndo({
      undo: () => { for (const it of items) translateItem(it, -dx, -dy); invalidatePage(page); },
      redo: () => { for (const it of items) translateItem(it, dx, dy); invalidatePage(page); },
    });
  }
  if (page) invalidatePage(page);
  requestOverlay();
  positionSelbar();
}

function deleteSelection() {
  if (!sel) return;
  const page = app.doc.pages[sel.pageIndex];
  const items = sel.items;
  const set = new Set(items);
  const before = page.items.slice();
  page.items = page.items.filter((it) => !set.has(it));
  const after = page.items.slice();
  pushUndo({
    undo: () => { page.items = before.slice(); invalidatePage(page); },
    redo: () => { page.items = after.slice(); invalidatePage(page); },
  });
  clearSel();
  invalidatePage(page);
  ui?.toast?.(`Deleted ${items.length} item${items.length > 1 ? 's' : ''}`);
}

function duplicateSelection() {
  if (!sel) return;
  const page = app.doc.pages[sel.pageIndex];
  const clones = sel.items.map((it) => {
    const c = structuredClone(it);
    c.id = uid();
    const img = imageCache.get(it);
    if (img) imageCache.set(c, img); // the copy shares the decode rather than parsing the same data URL again
    translateItem(c, 18, 18);
    return c;
  });
  page.items.push(...clones);
  pushUndo({
    undo: () => { const s = new Set(clones); page.items = page.items.filter((it) => !s.has(it)); invalidatePage(page); },
    redo: () => { page.items.push(...clones); invalidatePage(page); },
  });
  sel = { pageIndex: sel.pageIndex, items: clones };
  invalidatePage(page);
  requestOverlay();
  positionSelbar();
}

/**
 * page.items is paint order: index 0 paints first (bottom), the last index paints last (top).
 * Every item type lives in the same array, so moving one through the stack is nothing more than
 * moving it through this array, and all four operations share one function driven by a mode.
 *
 * front/back are a plain partition: pull the selected items out, keeping their own relative
 * order, and put that block at the far end.
 *
 * forward/backward are a single step each, and the walk direction is what keeps a multi-item
 * selection moving as one block instead of collapsing together. forward walks from the top of
 * the array down: the topmost selected item is considered first, and if it has been swapped
 * past the unselected item above it, the next selected item down the array now finds that same
 * unselected item as ITS neighbour and can swap past it too in the same pass. Walking the other
 * way would let only the top item advance while the ones below it stall behind it. backward is
 * the mirror, walked from the bottom of the array up.
 */
function reorderSelection(mode) {
  if (!sel) return;
  const page = app.doc.pages[sel.pageIndex];
  const set = new Set(sel.items);
  const before = page.items.slice();
  let items;
  if (mode === 'front' || mode === 'back') {
    const selected = before.filter((it) => set.has(it));
    const rest = before.filter((it) => !set.has(it));
    items = mode === 'front' ? rest.concat(selected) : selected.concat(rest);
  } else if (mode === 'forward') {
    items = before.slice();
    for (let i = items.length - 2; i >= 0; i--) {
      if (set.has(items[i]) && !set.has(items[i + 1])) {
        const t = items[i]; items[i] = items[i + 1]; items[i + 1] = t;
      }
    }
  } else if (mode === 'backward') {
    items = before.slice();
    for (let i = 1; i < items.length; i++) {
      if (set.has(items[i]) && !set.has(items[i - 1])) {
        const t = items[i]; items[i] = items[i - 1]; items[i - 1] = t;
      }
    }
  } else {
    return;
  }
  // Already at that end of the stack: nothing moved, so nothing is pushed onto the undo stack
  // and the page is not re-rasterised for no reason.
  let changed = false;
  for (let i = 0; i < items.length; i++) { if (items[i] !== before[i]) { changed = true; break; } }
  if (!changed) return;
  page.items = items;
  const after = page.items.slice();
  pushUndo({
    undo: () => { page.items = before.slice(); invalidatePage(page); },
    redo: () => { page.items = after.slice(); invalidatePage(page); },
  });
  invalidatePage(page);
  positionSelbar();
}

const bringForward = () => reorderSelection('forward');
const sendBackward = () => reorderSelection('backward');
const bringToFront = () => reorderSelection('front');
const sendToBack = () => reorderSelection('back');

/* ---------- textify (local OCR via llama.cpp) ---------- */

// One model call at a time: textify, the selection actions and the title suggestion share it.
let ocrBusy = false;

const VLM_PROMPT =
  'Transcribe all handwritten text in this image exactly as written. Output only the ' +
  'transcription, preserving the original line breaks. No commentary, no markdown, no code fences.';

/**
 * The desktop shell reports the real registry (with on-disk availability and spawn control).
 * In browser mode nothing can be spawned, so we list the same models as "available" and only
 * use the entry to pick the right prompt for whichever server the user started by hand.
 */
const BROWSER_MODELS = [
  { id: 'glm-ocr', label: 'GLM-OCR 0.9B', note: 'Default. Purpose-built OCR, installs itself, ~2 GB.', prompt: 'OCR', available: true },
  { id: 'gemma-4-e4b', label: 'Gemma 4 E4B', note: 'Strong all-rounder, slower, ~6 GB.', prompt: VLM_PROMPT, available: true },
  { id: 'qwen35-4b', label: 'Qwen3.5 4B', note: 'Accurate but slow on CPU, ~6 GB.', prompt: VLM_PROMPT, available: true },
  { id: 'qwen35-08b', label: 'Qwen3.5 0.8B', note: 'Best accuracy per second in testing, ~2 GB.', prompt: VLM_PROMPT, available: true },
];
let ocrModels = BROWSER_MODELS;

async function loadOcrModels() {
  try {
    const list = await window.flatnotes?.listOcrModels?.();
    if (list?.length) ocrModels = list;
  } catch { /* keep the browser-mode fallback */ }
  if (!ocrModels.some((m) => m.id === app.settings.ocrModel && m.available)) {
    const first = ocrModels.find((m) => m.available);
    if (first) app.settings.ocrModel = first.id;
  }
  return ocrModels;
}

const currentOcrModel = () =>
  ocrModels.find((m) => m.id === app.settings.ocrModel) || ocrModels[0] || BROWSER_MODELS[0];

async function ocrHealthy(timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(app.settings.ocrUrl + '/health', { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

async function ensureOcrEngine() {
  const model = currentOcrModel();
  if (window.flatnotes?.startOcr) {
    // Main decides whether the running engine already serves this model or must be swapped.
    const r = await window.flatnotes.startOcr(model.id);
    if (r && r.error === 'not-installed') {
      ui?.toast?.('OCR engine not installed - run ocr\\setup-ocr.ps1 once', 5000);
      return false;
    }
    if (r && r.error === 'model-missing') {
      ui?.toast?.(`${model.label} files not found on disk`, 5000);
      return false;
    }
    if (!r?.starting) return true; // already loaded and healthy
    ui?.toast?.(`Loading ${model.label}…`, 180000);
    // first run may also download the model; poll patiently
    for (let i = 0; i < 150; i++) {
      if (await ocrHealthy(2000)) return true;
      await new Promise((res) => setTimeout(res, 2000));
    }
    ui?.toast?.('OCR engine did not come up - check ocr logs', 5000);
    return false;
  }
  if (await ocrHealthy()) return true;
  ui?.toast?.('OCR engine offline - run ocr\\start-ocr-engine.ps1 first', 5000);
  return false;
}

/**
 * General vision models like to wrap answers in prose or markdown; keep only the transcription.
 */
function sanitizeOcrText(raw) {
  let t = (raw || '').replace(/\r/g, '');
  // reasoning traces: drop closed <think> blocks, and if one was cut off by max_tokens
  // there is no transcription after it, so drop the tail entirely
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<think>[\s\S]*$/i, '');
  // fenced code blocks: keep the contents of the first fence
  const fence = t.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (fence) t = fence[1];
  t = t.replace(/```/g, '');
  const lines = t.split('\n');
  // drop a leading "Here is the transcription:" style preamble
  while (lines.length > 1 && /^\s*(here (is|are)|the (image|text)|transcription|sure|okay|certainly)\b.*:\s*$/i.test(lines[0])) {
    lines.shift();
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trim();
}

/**
 * Paint one item onto the crop: always dark ink on white paper, whatever the page looked
 * like. It resolves its own colour, so the black-paper inversion never reaches the model.
 */
function drawCropItem(x, it) {
  // light ink (e.g. white on dark paper) becomes dark for the white crop
  const color = colorLuma(it.color) > 0.72 ? '#222222' : it.color;
  if (it.type === 'stroke') {
    x.globalAlpha = it.opacity ?? 1;
    // the crop is always white paper, so a highlighter always multiplies
    x.globalCompositeOperation = it.tool === 'highlighter' ? 'multiply' : 'source-over';
    x.fillStyle = color;
    x.fill(strokePath(it));
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
  } else if (it.type === 'text') {
    x.fillStyle = color;
    x.font = `${it.size}px "Segoe UI", system-ui, sans-serif`;
    x.textBaseline = 'top';
    const lh = it.size * 1.35;
    it.text.split('\n').forEach((line, i) => x.fillText(line, it.x, it.y + i * lh));
  } else if (it.type === 'shape') {
    drawShape(x, it, color);
  } else if (it.type === 'image') {
    drawImageItem(x, it); // a picture is already its own colour, nothing to re-resolve
  }
}

/**
 * Render the picked items (strokes, text and shapes alike) onto a clean white crop for
 * the vision model. Returns null when there is nothing to draw.
 */
function renderOcrCrop(picked) {
  let b = null;
  for (const it of picked) {
    const ib = itemBBox(it);
    if (!(ib.w > 0 || ib.h > 0)) continue;
    b = b ? {
      x: Math.min(b.x, ib.x), y: Math.min(b.y, ib.y),
      x2: Math.max(b.x2, ib.x + ib.w), y2: Math.max(b.y2, ib.y + ib.h),
    } : { x: ib.x, y: ib.y, x2: ib.x + ib.w, y2: ib.y + ib.h };
  }
  if (!b) return null;
  const pad = 10;
  const bbox = { x: b.x - pad, y: b.y - pad, w: b.x2 - b.x + pad * 2, h: b.y2 - b.y + pad * 2 };
  const scale = Ink.clamp(1000 / Math.max(bbox.w, bbox.h), 1, 4);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bbox.w * scale);
  cv.height = Math.round(bbox.h * scale);
  const x = cv.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, cv.width, cv.height);
  x.setTransform(scale, 0, 0, scale, -bbox.x * scale, -bbox.y * scale);
  for (const it of picked) drawCropItem(x, it); // page order, so z-order comes free
  return { bbox, dataUrl: cv.toDataURL('image/png') };
}

/**
 * The single request path to the local engine: crop the items, make sure a server is up,
 * send one chat completion and hand back the cleaned answer with the crop bbox.
 * Returns null when there was nothing to send or the engine never came up. Callers own
 * the busy flag, the undo step and whatever they do with the text.
 */
async function runOcrAction(items, prompt, opts = {}) {
  const crop = renderOcrCrop(items);
  if (!crop) return null;
  if (!(await ensureOcrEngine())) return null;
  ui?.toast?.(opts.progress || 'Recognizing…', 240000);
  window.flatnotes?.ocrUsed?.();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 300000);
  try {
    const res = await fetch(app.settings.ocrUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        temperature: 0,
        max_tokens: opts.maxTokens || 1200,
        // reasoning models would otherwise spend the whole budget thinking; ignored by the rest
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: crop.dataUrl } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error('OCR server error ' + res.status);
    const data = await res.json();
    return { bbox: crop.bbox, text: sanitizeOcrText(data.choices?.[0]?.message?.content) };
  } finally {
    clearTimeout(t);
    window.flatnotes?.ocrUsed?.();
  }
}

async function textifyRegion(l) {
  const page = app.doc.pages[l.pageIndex];
  const picked = page.items.filter(
    (it) => it.type === 'stroke' && it.tool === 'pen' && Ink.fractionInPolygon(it.points, l.pts) > 0.5,
  );
  if (!picked.length) { ui?.toast?.('Circle some handwriting to textify'); return; }
  if (ocrBusy) { ui?.toast?.('Already recognizing - one moment'); return; }
  ocrBusy = true;
  try {
    const model = currentOcrModel();
    const out = await runOcrAction(picked, model.prompt || 'OCR');
    if (!out) return;
    const { bbox, text } = out;
    if (!text) { ui?.toast?.('No text recognized'); return; }
    if (!app.doc.pages.includes(page)) return; // notebook or page went away while we waited

    // Size from the ink it replaces. A model that returns one long unwrapped line would
    // otherwise get the full crop height as its font size, so cap by width too.
    const lines = text.split('\n');
    const longest = Math.max(...lines.map((s) => s.length), 1);
    const byHeight = bbox.h / (lines.length * 1.35);
    const byWidth = (bbox.w * 1.9) / longest; // ~0.52em average glyph advance
    const size = Ink.clamp(Math.round(Math.min(byHeight, byWidth)), 11, 40);
    const item = { id: uid(), type: 'text', x: bbox.x + 4, y: bbox.y + 4, text, size, color: app.tools.text.color };
    item.bbox = measureTextItem(item);
    const replace = app.settings.textifyReplace;
    const pickedSet = new Set(picked);
    const before = page.items.slice();
    if (replace) page.items = page.items.filter((it) => !pickedSet.has(it));
    page.items.push(item);
    const after = page.items.slice();
    pushUndo({
      undo: () => { page.items = before.slice(); invalidatePage(page); },
      redo: () => { page.items = after.slice(); invalidatePage(page); },
    });
    invalidatePage(page);
    ui?.toast?.(`Textified ${picked.length} stroke${picked.length > 1 ? 's' : ''} ✓`);
  } catch (err) {
    console.error('FlatNotes textify:', err);
    ui?.toast?.(err.name === 'AbortError' ? 'Recognition timed out' : 'Recognition failed - see console', 4000);
  } finally {
    ocrBusy = false;
  }
}

/* ---------- voice notes (local speech recognition via sherpa-onnx) ---------- */

// Parakeet TDT decodes at roughly 30x real time on this CPU, so the live transcript is
// simply the whole buffer re-decoded every tick. That keeps the on-screen text stable
// (no chunk seams to stitch) and stays ahead of the speaker for note-length recordings.
const VOICE_RATE = 16000;          // what the model expects; the AudioContext resamples for us
const VOICE_TICK_MS = 1200;        // gap between live decodes
const VOICE_MAX_S = 240;           // the server rejects utterances longer than 300 s
const VOICE_SOCKET_TIMEOUT = 20000;

const BROWSER_ASR_MODELS = [
  { id: 'parakeet-tdt-0.6b-v2', label: 'Parakeet TDT 0.6B v2', note: 'Default. English, ~480 MB.', available: true },
  { id: 'parakeet-tdt-0.6b-v3', label: 'Parakeet TDT 0.6B v3', note: 'Multilingual, same speed.', available: true },
];
let asrModels = BROWSER_ASR_MODELS;

async function loadAsrModels() {
  try {
    const list = await window.flatnotes?.listAsrModels?.();
    if (list?.length) asrModels = list;
  } catch { /* keep the browser-mode fallback */ }
  if (!asrModels.some((m) => m.id === app.settings.asrModel && m.available)) {
    const first = asrModels.find((m) => m.available);
    if (first) app.settings.asrModel = first.id;
  }
  return asrModels;
}

const currentAsrModel = () =>
  asrModels.find((m) => m.id === app.settings.asrModel) || asrModels[0] || BROWSER_ASR_MODELS[0];

/** Browser mode has no IPC, so readiness is "does the websocket open". */
function probeAsrSocket(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let ws;
    const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(false); }, timeoutMs);
    try { ws = new WebSocket(app.settings.asrUrl); } catch { clearTimeout(t); resolve(false); return; }
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
}

async function asrHealthy() {
  if (window.flatnotes?.asrHealthy) return !!(await window.flatnotes.asrHealthy());
  return probeAsrSocket();
}

/**
 * Same contract as ensureOcrEngine: the desktop shell spawns and unloads the engine,
 * a browser can only report honestly that it cannot.
 */
async function ensureAsrEngine(onStatus) {
  const model = currentAsrModel();
  if (window.flatnotes?.startAsr) {
    const r = await window.flatnotes.startAsr(model.id);
    if (r && r.error === 'not-installed') {
      ui?.toast?.('Voice engine not installed - run asr\\setup-asr.ps1 once', 5000);
      return false;
    }
    if (r && r.error === 'model-missing') {
      ui?.toast?.(`${model.label} is not downloaded - run asr\\setup-asr.ps1`, 5000);
      return false;
    }
    if (!r?.starting) return true; // already loaded
    onStatus?.(`Loading ${model.label}…`);
    for (let i = 0; i < 60; i++) {
      if (await asrHealthy()) return true;
      await new Promise((res) => setTimeout(res, 1000));
    }
    ui?.toast?.('Voice engine did not come up - check the asr logs', 5000);
    return false;
  }
  if (await probeAsrSocket()) return true;
  ui?.toast?.('Voice engine offline - run asr\\start-asr-engine.ps1 first', 5000);
  return false;
}

// Accumulates ~2048 samples before posting so the main thread gets ~13 messages a second
// instead of one per 128-frame render quantum, and computes the meter level at the source.
const VOICE_WORKLET = `
class FnCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        let sum = 0;
        for (let k = 0; k < this.n; k++) sum += this.buf[k] * this.buf[k];
        const out = this.buf.slice(0);
        this.port.postMessage({ samples: out, rms: Math.sqrt(sum / this.n) }, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('fn-capture', FnCapture);
`;

let voice = null; // the one active recording session, or null
// Kept so a leaked microphone is provable after the fact: these must all read "ended".
let lastVoiceTracks = [];

/**
 * Every exit path funnels through here, so the microphone cannot survive a stop, a cancel,
 * a tool switch, a notebook switch, Escape or the window closing.
 */
function releaseMic(v) {
  clearInterval(v.ticker);
  clearInterval(v.decodeTimer);
  try { v.node?.disconnect(); } catch { /* ignore */ }
  try { v.source?.disconnect(); } catch { /* ignore */ }
  if (v.node) v.node.port.onmessage = null;
  const tracks = v.stream?.getTracks() || [];
  if (tracks.length) lastVoiceTracks = tracks;
  for (const track of tracks) {
    try { track.stop(); } catch { /* ignore */ }
  }
  v.stream = null;
  if (v.ctx && v.ctx.state !== 'closed') { try { v.ctx.close(); } catch { /* ignore */ } }
  v.ctx = null;
}

function releaseVoiceHardware(v) {
  releaseMic(v);
  if (v.ws) {
    try { v.ws.onmessage = null; v.ws.onclose = null; v.ws.onerror = null; v.ws.close(); } catch { /* ignore */ }
    v.ws = null;
  }
}

function endVoice(v) {
  releaseVoiceHardware(v);
  v.dead = true;
  if (voice === v) voice = null;
  hideVoicePanel();
  updateCursor();
}

/** One reply per request, and never two requests in flight, or the stream would desync. */
function asrDecode(v, samples) {
  return new Promise((resolve, reject) => {
    const ws = v.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('socket closed')); return; }
    // A late reply on a reused socket would be read as the answer to the *next* request,
    // so a timed-out connection is retired rather than reused.
    const timer = setTimeout(() => {
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
      if (v.ws === ws) v.ws = null;
      reject(new Error('decode timed out'));
    }, VOICE_SOCKET_TIMEOUT);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.onmessage = null;
      try { resolve(JSON.parse(e.data).text || ''); }
      catch { resolve(''); }
    };
    const header = new ArrayBuffer(8);
    const dv = new DataView(header);
    dv.setInt32(0, v.rate, true);
    dv.setInt32(4, samples.length * 4, true);
    const payload = new Uint8Array(8 + samples.length * 4);
    payload.set(new Uint8Array(header), 0);
    payload.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.length * 4), 8);
    for (let off = 0; off < payload.length; off += 10240) {
      ws.send(payload.subarray(off, Math.min(off + 10240, payload.length)));
    }
  });
}

/** Flatten the recorded chunks into the single contiguous buffer the server wants. */
function voiceSamples(v) {
  const out = new Float32Array(v.total);
  let at = 0;
  for (const c of v.chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function voiceTick(v) {
  if (v.dead || v.busy || !v.ws || v.total === 0 || v.total === v.decodedAt) return;
  v.busy = true;
  const samples = voiceSamples(v);
  try {
    const text = await asrDecode(v, samples);
    if (v.dead) return;
    v.decodedAt = samples.length;
    v.text = text.trim();
    drawVoicePanel(v);
    window.flatnotes?.asrUsed?.();
  } catch (err) {
    if (!v.dead) console.error('FlatNotes voice decode:', err);
  } finally {
    v.busy = false;
  }
}

/** Break a single spoken run-on into page-width lines so the item does not overflow. */
function wrapTranscript(text, size, maxW) {
  sctx.font = `${size}px "Segoe UI", system-ui, sans-serif`;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? line + ' ' + word : word;
    if (line && sctx.measureText(next).width > maxW) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

async function startVoice(pageIndex, x, y) {
  if (voice) { ui?.toast?.('Already recording'); return; }
  const page = app.doc.pages[pageIndex];
  const v = {
    doc: app.doc, page, pageIndex, x, y,
    chunks: [], total: 0, decodedAt: 0, text: '',
    rate: VOICE_RATE, level: 0, started: Date.now(),
    stream: null, ctx: null, node: null, source: null, ws: null,
    busy: false, dead: false, ticker: 0, status: 'Starting…',
  };
  voice = v;
  showVoicePanel(v);
  updateCursor();

  // Start the engine and open the microphone together: the model can take a few seconds
  // on a cold start and nothing the user says in that window should be lost.
  const enginePromise = ensureAsrEngine((s) => { if (!v.dead) { v.status = s; drawVoicePanel(v); } });

  try {
    v.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.error('FlatNotes voice microphone:', err);
    ui?.toast?.(err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'No microphone available', 4000);
    endVoice(v);
    return;
  }
  if (v.dead) { for (const t of v.stream.getTracks()) t.stop(); return; } // cancelled while asking

  try {
    v.ctx = new AudioContext({ sampleRate: VOICE_RATE });
  } catch {
    v.ctx = new AudioContext(); // some devices refuse a forced rate; send whatever we get
  }
  v.rate = Math.round(v.ctx.sampleRate);
  // The worklet is loaded from a blob rather than a URL because the packaged app runs
  // from file://, where addModule on a relative path is blocked.
  const blobUrl = URL.createObjectURL(new Blob([VOICE_WORKLET], { type: 'text/javascript' }));
  try {
    await v.ctx.audioWorklet.addModule(blobUrl);
  } catch (err) {
    console.error('FlatNotes voice worklet:', err);
    ui?.toast?.('Could not start audio capture', 4000);
    endVoice(v);
    return;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  if (v.dead) return;

  v.source = v.ctx.createMediaStreamSource(v.stream);
  v.node = new AudioWorkletNode(v.ctx, 'fn-capture');
  v.node.port.onmessage = (e) => {
    if (v.dead) return;
    v.chunks.push(e.data.samples);
    v.total += e.data.samples.length;
    v.level = Math.max(e.data.rms, v.level * 0.82); // fast attack, slow decay
    if (v.total >= VOICE_MAX_S * v.rate) stopVoice();
  };
  v.source.connect(v.node);
  // A worklet with no downstream connection is not pulled by every engine; a muted gain
  // node keeps it running without echoing the microphone back to the speakers.
  const mute = v.ctx.createGain();
  mute.gain.value = 0;
  v.node.connect(mute).connect(v.ctx.destination);

  v.status = '';
  v.ticker = setInterval(() => { if (!v.dead) drawVoicePanel(v); }, 200);
  drawVoicePanel(v);

  const engineOk = await enginePromise;
  if (v.dead) return;
  if (!engineOk) { endVoice(v); return; }

  try {
    v.ws = await openAsrSocket();
  } catch (err) {
    console.error('FlatNotes voice socket:', err);
    ui?.toast?.('Could not reach the voice engine', 4000);
    endVoice(v);
    return;
  }
  if (v.dead) { try { v.ws.close(); } catch { /* ignore */ } v.ws = null; return; }
  v.ws.onclose = () => { if (!v.dead) v.ws = null; };

  // Re-decode the whole buffer on a fixed cadence. A slow decode simply delays the next
  // one (voiceTick returns immediately while busy) instead of queueing work up.
  v.decodeTimer = setInterval(() => voiceTick(v), VOICE_TICK_MS);
}

function openAsrSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(app.settings.asrUrl);
    ws.binaryType = 'arraybuffer';
    const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, 5000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('connect failed')); };
  });
}

/** Stop, decode whatever is left, and commit it as one ordinary text item. */
async function stopVoice() {
  const v = voice;
  if (!v || v.stopping) return;
  v.stopping = true;
  clearInterval(v.decodeTimer);

  // Release the microphone before the final decode: the audio is already captured, and
  // leaving the recording light on while the model finishes would be a lie.
  const ws = v.ws;
  releaseMic(v);

  v.status = 'Transcribing…';
  drawVoicePanel(v);

  if (ws && v.total > v.decodedAt) {
    // Wait out an in-flight live decode so the final request is not interleaved with it.
    // The bound matches the decode timeout, so the in-flight request has always either
    // answered or retired the socket by the time we give up on it.
    for (let i = 0; i < VOICE_SOCKET_TIMEOUT / 100 && v.busy; i++) await new Promise((r) => setTimeout(r, 100));
    try { v.text = (await asrDecode(v, voiceSamples(v))).trim(); }
    catch (err) { console.error('FlatNotes voice final decode:', err); }
  }
  window.flatnotes?.asrUsed?.();

  const text = v.text.trim();
  endVoice(v);

  if (!text) { ui?.toast?.('Nothing was transcribed'); return; }
  // The final decode is awaited, and the cancel paths stop watching once the session ends,
  // so the notebook or the page can both disappear underneath us. Committing anyway would
  // push an item and an undo entry into a document that is no longer open.
  if (app.doc !== v.doc || !app.doc.pages.includes(v.page)) return;

  const size = app.tools.text.size;
  const wrapped = wrapTranscript(text, size, Math.max(160, PAGE_W - v.x - 24));
  const item = { id: uid(), type: 'text', x: v.x, y: v.y, text: wrapped, size, color: app.tools.text.color };
  item.bbox = measureTextItem(item);
  const page = v.page;
  page.items.push(item);
  pushUndo({
    undo: () => { page.items = page.items.filter((k) => k !== item); invalidatePage(page); },
    redo: () => { page.items.push(item); invalidatePage(page); },
  });
  invalidatePage(page);
  ui?.toast?.('Voice note added ✓');
}

function cancelVoice() {
  if (!voice) return;
  clearInterval(voice.decodeTimer);
  endVoice(voice);
  ui?.toast?.('Recording cancelled');
}

/* ---------- recording panel ---------- */

const voicePanel = document.createElement('div');
voicePanel.id = 'voicepanel';
voicePanel.className = 'glass';
voicePanel.innerHTML = `
  <div class="vp-head">
    <span class="vp-dot"></span>
    <span class="vp-time">0:00</span>
    <div class="vp-meter"><i></i></div>
    <button class="vp-btn vp-stop">Stop</button>
    <button class="vp-btn vp-cancel">Cancel</button>
  </div>
  <div class="vp-text"></div>`;
document.body.appendChild(voicePanel);
voicePanel.querySelector('.vp-stop').addEventListener('click', stopVoice);
voicePanel.querySelector('.vp-cancel').addEventListener('click', cancelVoice);
voicePanel.addEventListener('pointerdown', (e) => e.stopPropagation());

function showVoicePanel(v) {
  voicePanel.style.display = 'block';
  positionVoicePanel();
  drawVoicePanel(v);
}

function hideVoicePanel() {
  voicePanel.style.display = 'none';
}

function positionVoicePanel() {
  if (!voice) return;
  // Deleting an earlier page shifts every index below it, so the anchor is the page itself.
  const idx = app.doc.pages.indexOf(voice.page);
  if (idx < 0) return;
  const r = pageRect(idx);
  const w = voicePanel.offsetWidth || 320;
  const left = Ink.clamp(w2sX(r.x + voice.x), 8, Math.max(8, cw - w - 8));
  const top = Ink.clamp(w2sY(r.y + voice.y), 70, Math.max(70, ch - voicePanel.offsetHeight - 12));
  voicePanel.style.left = left + 'px';
  voicePanel.style.top = top + 'px';
}

function drawVoicePanel(v) {
  const secs = Math.floor((Date.now() - v.started) / 1000);
  voicePanel.querySelector('.vp-time').textContent =
    Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  // rms is small even when speaking loudly, so scale it into something readable
  voicePanel.querySelector('.vp-meter i').style.width =
    Ink.clamp(v.level * 320, 0, 100) + '%';
  voicePanel.classList.toggle('busy', !!v.status);
  const body = voicePanel.querySelector('.vp-text');
  body.textContent = v.status || v.text || 'Listening…';
  body.classList.toggle('dim', !v.text || !!v.status);
  positionVoicePanel();
}

/* ---------- AI actions on a lasso selection ---------- */

const AI_LANGUAGES = ['Arabic', 'English', 'French', 'German', 'Japanese', 'Spanish'];

/**
 * One model call each, all going through runOcrAction. The prompts spell out "output only
 * the result" because every model here likes to introduce its answer otherwise.
 */
const AI_ACTIONS = [
  {
    id: 'summarize',
    label: 'Summarize',
    note: 'Condense the selection into a few short lines',
    progress: 'Summarizing…',
    prompt: () =>
      'Read the handwritten note in this image. Write a summary of it in at most three short lines. '
      + 'Output only the summary, no commentary, no markdown, no code fences.',
  },
  {
    id: 'solve',
    label: 'Solve',
    note: 'Work out a handwritten sum or equation',
    progress: 'Solving…',
    prompt: () =>
      'Read the handwritten arithmetic or algebra in this image and work it out. Output only one '
      + 'line: the expression, then =, then the result. No commentary, no working, no code fences.',
  },
  {
    id: 'translate',
    label: 'Translate',
    note: 'Transcribe and translate',
    progress: 'Translating…',
    prompt: (lang) =>
      `Read the handwritten text in this image and translate it into ${lang}. Output only the `
      + `${lang} translation, one line per line of the original. No commentary, no code fences.`,
  },
  {
    id: 'tidy',
    label: 'Tidy',
    note: 'Rewrite the selection as clean bullet points',
    progress: 'Tidying…',
    prompt: () =>
      'Read the handwritten notes in this image and rewrite them as clean bullet points. Output '
      + 'one bullet per line, each starting with "- ". No commentary, no headings, no code fences.',
  },
];

/**
 * drawItem never wraps text and the page cache clips to the paper, so a long answer would
 * silently run off the page. Break it to widthPx, at ~0.52em average glyph advance.
 */
function wrapForPage(text, size, widthPx) {
  const max = Math.max(12, Math.floor(widthPx / (size * 0.52)));
  const out = [];
  for (const line of text.split('\n')) {
    let cur = '';
    for (let word of line.split(/\s+/)) {
      while (word.length > max) { // a single unbreakable run, chop it
        if (cur) { out.push(cur); cur = ''; }
        out.push(word.slice(0, max));
        word = word.slice(max);
      }
      if (!word) continue;
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= max) cur += ' ' + word;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    else if (!line.trim()) out.push(''); // keep deliberate blank lines
  }
  return out.join('\n');
}

const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Build the result text item at pos, wrapped and measured so it really fits the page. */
function makeResultItem(text, pos) {
  const size = app.tools.text.size;
  const room = PAGE_W - pos.x - 16;
  let budget = room;
  let item;
  for (let i = 0; i < 4; i++) {
    item = {
      id: uid(), type: 'text', x: pos.x, y: pos.y,
      text: wrapForPage(text, size, budget), size, color: app.tools.text.color,
    };
    item.bbox = measureTextItem(item);
    if (item.bbox.w <= room) break;
    budget *= room / item.bbox.w; // the 0.52em estimate undershot these glyphs, tighten
  }
  return item;
}

/**
 * Run one AI action over the current selection and drop the answer in as a new text item
 * just below the selection (beside it when the page bottom is in the way). The original
 * items are never touched, and the whole thing is a single undo step.
 */
async function aiAction(kind) {
  const def = AI_ACTIONS.find((a) => a.id === kind);
  if (!def) return;
  if (!sel || !sel.items.length) { ui?.toast?.('Lasso something first'); return; }
  if (ocrBusy) { ui?.toast?.('Already working - one moment'); return; }
  const page = app.doc.pages[sel.pageIndex];
  const items = sel.items.slice();
  const box = selBBox();
  ocrBusy = true;
  try {
    const out = await runOcrAction(items, def.prompt(app.settings.aiLanguage), { progress: def.progress });
    if (!out) return;
    if (!out.text) { ui?.toast?.('The model returned nothing'); return; }
    if (!app.doc.pages.includes(page)) { ui?.toast?.('Notebook changed, result dropped', 3000); return; }

    let item = makeResultItem(out.text, { x: Ink.clamp(box.x, 8, PAGE_W - 160), y: box.y + box.h + 14 });
    if (item.y + item.bbox.h > pageHeight(page) - 8) {
      // no room underneath: put it beside the selection instead
      item = makeResultItem(out.text, { x: Ink.clamp(box.x + box.w + 16, 8, PAGE_W - 160), y: box.y });
    }
    const fitX = Ink.clamp(item.x, 8, Math.max(8, PAGE_W - item.bbox.w - 8));
    if (fitX !== item.x) item = makeResultItem(out.text, { x: fitX, y: item.y }); // re-wrap for the new x
    // a second action on the same selection would otherwise land on top of the first
    for (let i = 0; i < 8; i++) {
      const hit = page.items.find((k) => k.type === 'text' && rectsOverlap(itemBBox(k), item.bbox));
      if (!hit) break;
      const hb = itemBBox(hit);
      item.y = hb.y + hb.h + 8;
      item.bbox = measureTextItem(item);
    }
    item.y = Ink.clamp(item.y, 8, Math.max(8, pageHeight(page) - item.bbox.h - 8));
    item.bbox = measureTextItem(item);

    // snapshot only now: anything drawn while the model was thinking stays put on undo
    const before = page.items.slice();
    page.items.push(item);
    const after = page.items.slice();
    pushUndo({
      undo: () => { page.items = before.slice(); invalidatePage(page); },
      redo: () => { page.items = after.slice(); invalidatePage(page); },
    });
    invalidatePage(page);
    positionSelbar();
    ui?.toast?.(`${def.label} ✓`);
  } catch (err) {
    console.error('FlatNotes AI action:', err);
    ui?.toast?.(err.name === 'AbortError' ? `${def.label} timed out` : `${def.label} failed - see console`, 4000);
  } finally {
    ocrBusy = false;
  }
}

/* ---------- auto title ---------- */

const TITLE_PROMPT =
  'This image is the first page of a handwritten notebook. Suggest a title for the notebook, '
  + 'at most five words. Output only the title on one line: no quotes, no label, no code fences.';

/** Squeeze a model answer down to something that reads like a notebook name. */
function cleanTitle(raw) {
  let t = ((raw || '').split('\n').find((l) => l.trim()) || '').trim();
  t = t.replace(/^(suggested\s+)?title\s*[:.-]\s*/i, '');
  t = t.replace(/^[*#\s"'`]+|[*#\s"'`]+$/g, '');
  t = t.replace(/[.,;:]+$/, '').trim();
  return t.length > 48 ? t.slice(0, 48).trim() : t;
}

/**
 * Read the first page and propose a name for the notebook. Nothing is renamed here: the
 * caller shows the suggestion and only applies it if the user says yes.
 */
async function suggestDocTitle() {
  if (ocrBusy) { ui?.toast?.('Already working - one moment'); return null; }
  const page = app.doc.pages[0];
  if (!page.items.length) { ui?.toast?.('Page 1 is empty, nothing to name it from'); return null; }
  ocrBusy = true;
  try {
    const out = await runOcrAction(page.items.slice(), TITLE_PROMPT, {
      progress: 'Reading page 1…', maxTokens: 120,
    });
    if (!out) return null;
    const name = cleanTitle(out.text);
    if (!name) { ui?.toast?.('No title came back'); return null; }
    ui?.toast?.('Suggestion ready', 1200);
    return name;
  } catch (err) {
    console.error('FlatNotes title suggestion:', err);
    ui?.toast?.(err.name === 'AbortError' ? 'Title suggestion timed out' : 'Title suggestion failed - see console', 4000);
    return null;
  } finally {
    ocrBusy = false;
  }
}

/* ---------- text tool ---------- */

const textEdit = document.createElement('div');
textEdit.id = 'textedit';
textEdit.contentEditable = 'plaintext-only';
textEdit.spellcheck = false;
document.body.appendChild(textEdit);
let editing = null; // {item|null, pageIndex, x, y}
let editGuard = false; // suppress the blur that fires while a new edit is being set up

function startTextEdit(pageIndex, x, y, item = null) {
  commitTextEdit();
  editGuard = true;
  editing = { item, pageIndex, x: item ? item.x : x, y: item ? item.y : y };
  const t = app.tools.text;
  const size = item ? item.size : t.size;
  const raw = item ? item.color : t.color;
  const color = paperInverts(app.doc.pages[pageIndex]) ? invertFlat(raw) : raw;
  if (item) { hiddenItems.add(item); invalidatePage(app.doc.pages[pageIndex]); }
  const r = pageRect(pageIndex);
  textEdit.style.display = 'block';
  textEdit.style.left = w2sX(r.x + editing.x) + 'px';
  textEdit.style.top = w2sY(r.y + editing.y) + 'px';
  textEdit.style.fontSize = size * app.view.zoom + 'px';
  textEdit.style.color = color;
  textEdit.style.maxWidth = (PAGE_W - editing.x - 10) * app.view.zoom + 'px';
  textEdit.innerText = item ? item.text : '';
  setTimeout(() => {
    editGuard = false;
    textEdit.focus();
    const range = document.createRange();
    range.selectNodeContents(textEdit);
    range.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, 0);
}

function commitTextEdit() {
  if (!editing) return;
  const e = editing;
  editing = null;
  const text = textEdit.innerText.replace(/\n$/, '');
  textEdit.style.display = 'none';
  const page = app.doc.pages[e.pageIndex];
  if (e.item) hiddenItems.delete(e.item);

  if (!text.trim()) {
    // empty: delete existing item if we were editing one
    if (e.item) {
      const before = page.items.slice();
      page.items = page.items.filter((it) => it !== e.item);
      const after = page.items.slice();
      pushUndo({
        undo: () => { page.items = before.slice(); invalidatePage(page); },
        redo: () => { page.items = after.slice(); invalidatePage(page); },
      });
    }
    invalidatePage(page);
    return;
  }

  if (e.item) {
    const it = e.item;
    const oldText = it.text;
    it.text = text;
    it.bbox = measureTextItem(it);
    pushUndo({
      undo: () => { it.text = oldText; it.bbox = measureTextItem(it); invalidatePage(page); },
      redo: () => { it.text = text; it.bbox = measureTextItem(it); invalidatePage(page); },
    });
  } else {
    const t = app.tools.text;
    const it = { id: uid(), type: 'text', x: e.x, y: e.y, text, size: t.size, color: t.color };
    it.bbox = measureTextItem(it);
    page.items.push(it);
    pushUndo({
      undo: () => { page.items = page.items.filter((k) => k !== it); invalidatePage(page); },
      redo: () => { page.items.push(it); invalidatePage(page); },
    });
  }
  invalidatePage(page);
}

textEdit.addEventListener('blur', () => { if (!editGuard) commitTextEdit(); });
textEdit.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); textEdit.blur(); }
  e.stopPropagation();
});

function textItemAt(page, x, y) {
  for (let i = page.items.length - 1; i >= 0; i--) {
    const it = page.items[i];
    if (it.type !== 'text') continue;
    const b = itemBBox(it);
    if (x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4) return it;
  }
  return null;
}

/* ---------- images ---------- */

const IMAGE_MARGIN = 40; // keep a pasted or dropped picture clear of the page edge

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

/**
 * Put an encoded image on a page. The natural size is kept alongside the drawn rect so a
 * resize can preserve the aspect ratio, and anything larger than the page is scaled down
 * to fit rather than dropped in overflowing. `cx`/`cy` are the wanted centre in page coords.
 */
async function placeImage(src, pageIndex, cx, cy) {
  const page = app.doc.pages[pageIndex];
  if (!page) return null;
  let img;
  try { img = await decodeDataUrl(src); }
  catch (err) { console.error('FlatNotes: image decode failed', err); ui?.toast?.('That image could not be read'); return null; }
  if (!app.doc.pages.includes(page)) return null; // the notebook changed while we decoded

  const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
  if (!nw || !nh) { ui?.toast?.('That image could not be read'); return null; }
  const fit = Math.min(1, (PAGE_W - IMAGE_MARGIN * 2) / nw, (PAGE_H - IMAGE_MARGIN * 2) / nh);
  const w = Math.round(nw * fit), h = Math.round(nh * fit);
  const x = Math.round(Ink.clamp(cx - w / 2, 8, PAGE_W - w - 8));
  const y = Math.round(Ink.clamp(cy - h / 2, 8, Math.max(8, pageHeight(page) - h - 8)));

  const it = { id: uid(), type: 'image', x, y, w, h, nw, nh, src, bbox: { x, y, w, h } };
  imageCache.set(it, img); // decoded already, so the first bake never sees a placeholder
  page.items.push(it);
  cacheDrawItem(page, it);
  pushUndo({
    undo: () => { page.items = page.items.filter((k) => k !== it); invalidatePage(page); },
    redo: () => { page.items.push(it); invalidatePage(page); },
  });
  requestRender();
  return it;
}

/** The page point under a screen position, falling back to the middle of the page in view. */
function imageDropPoint(sx, sy) {
  if (sx != null) {
    const wx = s2wX(sx), wy = s2wY(sy);
    const i = pageAtWorld(wx, wy);
    if (i >= 0) {
      const r = pageRect(i);
      return { pageIndex: i, x: Ink.clamp(wx - r.x, 0, PAGE_W), y: Ink.clamp(wy - r.y, 0, r.h) };
    }
  }
  const i = currentPageIndex();
  const r = pageRect(i);
  return { pageIndex: i, x: Ink.clamp(s2wX(cw / 2) - r.x, 0, PAGE_W), y: Ink.clamp(s2wY(ch / 2) - r.y, 0, r.h) };
}

/** Read one image file and drop it on the page under (sx, sy), or the page in view. */
async function addImageFile(file, sx = null, sy = null) {
  let src;
  try { src = await fileToDataUrl(file); }
  catch (err) { console.error('FlatNotes: image read failed', err); ui?.toast?.('That image could not be read'); return null; }
  const t = imageDropPoint(sx, sy);
  const it = await placeImage(src, t.pageIndex, t.x, t.y);
  if (it) ui?.toast?.('Image added');
  return it;
}

window.addEventListener('paste', async (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return; // the text editor owns its own paste
  const entry = [...(e.clipboardData?.items || [])].find((k) => k.kind === 'file' && k.type.startsWith('image/'));
  const file = entry?.getAsFile();
  if (!file) return;
  e.preventDefault();
  await addImageFile(file);
});

// dragover must be prevented or the drop never fires, and drop must be prevented or the
// browser navigates away from the app to show the file
window.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.items || [])].some((k) => k.kind === 'file')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  ui?.setDropActive?.(true);
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) ui?.setDropActive?.(false); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  ui?.setDropActive?.(false);
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) { ui?.toast?.('Only image files can be dropped on a page'); return; }
  for (const f of files) await addImageFile(f, e.clientX, e.clientY);
});

/* ---------- shape tool ---------- */

function finishShape() {
  const d = pin.shape;
  pin.shape = null;
  requestOverlay();
  if (!d) return;
  const it = d.item;
  if (Math.abs(it.x2 - it.x1) < 3 && Math.abs(it.y2 - it.y1) < 3) return;
  const page = app.doc.pages[d.pageIndex];
  it.bbox = itemBBox(it);
  page.items.push(it);
  cacheDrawItem(page, it);
  pushUndo({
    undo: () => { page.items = page.items.filter((k) => k !== it); invalidatePage(page); },
    redo: () => { page.items.push(it); invalidatePage(page); },
  });
  requestRender();
}

/* ---------- pan & zoom ---------- */

function startPan(e) {
  pin.mode = 'pan';
  pin.panStart = { sx: e.clientX, sy: e.clientY, vx: app.view.x, vy: app.view.y };
}

function movePan(e) {
  let sx, sy;
  if (e.pointerType === 'touch' && touches.size) {
    const [t] = touches.values();
    sx = t.sx; sy = t.sy;
  } else { sx = e.clientX; sy = e.clientY; }
  app.view.x = pin.panStart.vx - (sx - pin.panStart.sx) / app.view.zoom;
  app.view.y = pin.panStart.vy - (sy - pin.panStart.sy) / app.view.zoom;
  clampView();
  // a drag that turned the page takes a fresh grip, or the next move would read its distance
  // against the page it just left and swing straight back
  if (flipOnOverscroll(false)) pin.panStart = { sx, sy, vx: app.view.x, vy: app.view.y };
  requestRender();
}

function startPinch() {
  cancelSelDrag(); // must run first: it nulls pin.mode, which the line below then claims
  const [a, b] = [...touches.values()];
  gesturing = true;
  pin.mode = 'pinch';
  pinchStart = {
    dist: Math.hypot(a.sx - b.sx, a.sy - b.sy),
    zoom: app.view.zoom,
    mwx: s2wX((a.sx + b.sx) / 2),
    mwy: s2wY((a.sy + b.sy) / 2),
  };
}

function movePinch() {
  const [a, b] = [...touches.values()];
  const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
  const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
  app.view.zoom = Ink.clamp(pinchStart.zoom * (dist / pinchStart.dist), 0.2, 6);
  // keep pinch-start world midpoint under fingers
  app.view.x = pinchStart.mwx - (mx - cw / 2) / app.view.zoom;
  app.view.y = pinchStart.mwy - (my - ch / 2) / app.view.zoom;
  clampView();
  requestRender();
  ui?.updateZoom?.();
}

let gestureEndTimer = 0;
function endGesture() {
  clearTimeout(gestureEndTimer);
  gestureEndTimer = setTimeout(() => { gesturing = false; requestRender(); }, 90);
}

function zoomAt(sx, sy, factor) {
  const wx = s2wX(sx), wy = s2wY(sy);
  app.view.zoom = Ink.clamp(app.view.zoom * factor, 0.2, 6);
  app.view.x = wx - (sx - cw / 2) / app.view.zoom;
  app.view.y = wy - (sy - ch / 2) / app.view.zoom;
  clampView();
  gesturing = true;
  endGesture();
  requestRender();
  ui?.updateZoom?.();
}

window.addEventListener('wheel', (e) => {
  if (e.target.closest?.('#ui')) return;
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0022));
  } else {
    app.view.x += (e.shiftKey ? e.deltaY : e.deltaX) / app.view.zoom;
    app.view.y += (e.shiftKey ? 0 : e.deltaY) / app.view.zoom;
    clampView();
    flipOnOverscroll(true);
    requestRender();
  }
}, { passive: false });

const fitWidthZoom = () => Ink.clamp((cw - 140) / PAGE_W, 0.2, 2.2);
const fitPageZoom = () => Ink.clamp(Math.min((cw - 140) / PAGE_W, (ch - 120) / PAGE_H), 0.2, 2.2);

/** Zoom about the viewport centre, which is exactly what view.x/y already track. */
function setZoom(z) {
  app.view.zoom = Ink.clamp(z, 0.2, 6);
  clampView();
  gesturing = true;
  endGesture();
  requestRender();
  ui?.updateZoom?.();
}

function fitWidth() {
  app.view.x = 0;
  setZoom(fitWidthZoom());
}

function fitPage() {
  app.view.y = pageRect(currentPageIndex()).y + PAGE_H / 2;
  app.view.x = 0;
  setZoom(fitPageZoom());
}

/* ---------- keyboard ---------- */

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.code === 'Space') { spaceHeld = true; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (sel) { e.preventDefault(); deleteSelection(); return; } }
  if (e.key === 'Escape') { if (voice) cancelVoice(); clearSel(); return; }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    goToPage(currentPageIndex() + (e.key === 'PageDown' ? 1 : -1));
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'd') { if (sel) { e.preventDefault(); duplicateSelection(); } return; }
  // Shift changes step-vs-extreme here, not the character, but e.key reports the character the
  // layout actually produces: on a US layout Shift+] is '}' and Shift+[ is '{', so both spellings
  // are matched and e.shiftKey alone decides between one step and the far end. Same idiom as the
  // '=' / '+' zoom key below.
  if (mod && (e.key === ']' || e.key === '}')) { if (sel) { e.preventDefault(); e.shiftKey ? bringToFront() : bringForward(); } return; }
  if (mod && (e.key === '[' || e.key === '{')) { if (sel) { e.preventDefault(); e.shiftKey ? sendToBack() : sendBackward(); } return; }
  if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key === 's') { e.preventDefault(); saveNow().then(() => ui?.toast?.('Saved')); }
  else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(cw / 2, ch / 2, 1.25); }
  else if (mod && e.key === '-') { e.preventDefault(); zoomAt(cw / 2, ch / 2, 0.8); }
  else if (mod && e.key === '0') { e.preventDefault(); fitWidth(); }
  else if (!mod) {
    const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text', s: 'shape', x: 'textify', v: 'voice' };
    const t = map[e.key.toLowerCase()];
    if (t && app.availableTools.includes(t)) setTool(t);
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

/* ============================== app API (used by ui.js) ============================== */

function setTool(t) {
  if (t !== app.tool) {
    commitTextEdit();
    if (voice) cancelVoice(); // never keep the microphone open once the tool changes
    if (t !== 'lasso') clearSel();
  }
  app.tool = t;
  updateCursor();
  ui?.updateToolbar?.();
}

/** The page the middle of the viewport is on. Pages vary in height, so this is a search. */
function currentPageIndex() {
  if (!app.doc) return 0;
  return Ink.clamp(pageIndexAbove(app.view.y), 0, app.doc.pages.length - 1);
}

function addPage() {
  const page = newPage();
  app.doc.pages.push(page);
  pushUndo({
    undo: () => { app.doc.pages.pop(); reseat(app.doc.pages.length - 1); requestRender(); ui?.refreshSidebar?.(); },
    redo: () => { app.doc.pages.push(page); reseat(app.doc.pages.length - 1); requestRender(); ui?.refreshSidebar?.(); },
  });
  // scroll to it
  app.view.y = pageRect(app.doc.pages.length - 1).y + ch / (2 * app.view.zoom) - 60;
  clampView();
  requestRender();
  ui?.refreshSidebar?.();
  ui?.toast?.('Page added');
}

/* ============================== persistence ============================== */

let saveTimer = 0;
const dirtyThumbs = new Set();

function markDirty() {
  if (!app.doc) return;
  app.doc.modified = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

/**
 * The sidebar stays a grid of sheets however tall the pages get, so a thumbnail is the top
 * PAGE_H of the page rather than the whole thing squashed into a sliver. Drawn straight
 * rather than downscaled from the band cache, so baking one never rasters a page that is
 * thousands of pixels tall.
 */
function renderThumb(page) {
  const w = 168, h = Math.round(PAGE_H / PAGE_W * w);
  const scale = w / PAGE_W;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const x = cv.getContext('2d');
  x.fillStyle = PAPERS[page.paper] || '#fff';
  x.fillRect(0, 0, w, h);
  drawPaperBorder(x, page, 0, 0, w, h, 1, 2);
  drawTemplate(x, page, 0, 0, w, pageHeight(page) * scale, scale, 0, h);
  x.setTransform(scale, 0, 0, scale, 0, 0);
  setPaperMode(page);
  for (const it of page.items) {
    const b = itemBBox(it);
    if (b.y > PAGE_H) continue; // below the crop
    drawItem(x, it);
  }
  return cv.toDataURL('image/jpeg', 0.72);
}

let thumbJob = 0;
/**
 * Fill in any missing page thumbnails in the background. An imported notebook only ever had
 * one baked, because the import never goes through the autosave path, so without this its
 * page list is a column of blank sheets until something else happens to save it. One page at
 * a time with a yield in between, and the whole job is abandoned the moment the open
 * notebook changes.
 */
async function bakeMissingThumbs(doc) {
  const job = ++thumbJob;
  const todo = doc.pages.filter((p) => !p.thumb);
  if (!todo.length) return;
  let done = 0;
  for (const page of todo) {
    if (job !== thumbJob || app.doc !== doc || !doc.pages.includes(page)) return;
    const pending = ensureImagesReady([page]);
    if (pending) await pending;
    if (job !== thumbJob || app.doc !== doc || !doc.pages.includes(page)) return;
    try { page.thumb = renderThumb(page); } catch { /* a thumbnail is cosmetic */ }
    if (++done % 6 === 0) ui?.refreshSidebar?.();
    await new Promise((r) => setTimeout(r)); // let the UI breathe between pages
  }
  ui?.refreshSidebar?.();
  markDirty(); // keep them, so this only ever happens once per notebook
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!app.doc) return;
  // a thumbnail must not be baked mid decode; null when every image is ready, so the
  // usual save (no images, or all decoded) never pays for a microtask hop
  const pending = ensureImagesReady(app.doc.pages);
  if (pending) await pending;
  for (const page of dirtyThumbs) {
    if (app.doc.pages.includes(page)) page.thumb = renderThumb(page);
  }
  for (const page of app.doc.pages) {
    if (!page.thumb) page.thumb = renderThumb(page);
  }
  dirtyThumbs.clear();
  try {
    await store.saveDoc(app.doc);
  } catch (err) {
    console.error('FlatNotes: save failed', err);
  }
  ui?.refreshSidebar?.();
}

window.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('beforeunload', () => { if (voice) releaseVoiceHardware(voice); saveNow(); flushView(); });
// beforeunload does not always run when a window is destroyed; pagehide does. saveNow is too
// heavy to run from here, but the camera anchor is one small key and losing it is exactly the
// case the anchor exists for: the user closing the window.
window.addEventListener('pagehide', () => { if (voice) releaseVoiceHardware(voice); flushView(); });

/* ---------- camera memory, one anchor per notebook ---------- */

/**
 * Where each notebook was left, keyed by document id and mirrored into KV under `views`. It
 * lives here rather than on the document record because listDocs sorts the sidebar by
 * doc.modified, so writing the camera onto the record would bump modified on every pan and
 * make the sidebar reshuffle itself while the user is scrolling.
 */
let views = {};
let viewTimer = 0;

/** Nothing read back out of KV is trusted to be the shape this version wrote. */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The anchor is page-relative rather than an absolute world y. Page heights are derived from
 * their content and re-settled on every load, so the same y lands on different content once a
 * page above has grown or shrunk; a page index plus an offset inside that page survives it.
 */
function captureView() {
  pageTops(); // settle first: a settle that shrinks a page clamps the camera, and the index
              // and the offset below have to be read off the same, final, geometry
  const page = currentPageIndex();
  return { page, oy: app.view.y - pageTops()[page], x: app.view.x, zoom: app.view.zoom };
}

function stampView() {
  if (!app.doc) return;
  views[app.doc.id] = captureView();
  // this also runs while the window is being torn down, where a transaction can be aborted
  // out from under it. A camera position that failed to reach disk on the way out is not
  // worth a console error, so it goes quietly.
  store.setKV('views', views).catch(() => { /* the window is leaving */ });
}

/**
 * Called from clampView, which means once per frame of a pan, so all it does is move the
 * timer. Measuring the camera here instead would be wrong twice over: captureView goes
 * through pageTops, which settles heights and can clamp the view straight back into this
 * function, and setDoc clamps the fit-width camera it installs before restoreView has had
 * its turn, which would overwrite the very anchor that is about to be read. Reading the
 * camera only when the timer fires avoids both.
 */
function saveView() {
  if (!app.doc) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(stampView, 400);
}

/** Write the pending anchor now, for the moments the camera is about to be abandoned. */
function flushView() {
  clearTimeout(viewTimer);
  viewTimer = 0;
  stampView();
}

/**
 * Put the camera back where this notebook was left. Everything stored is treated as suspect:
 * pages may have been deleted since the anchor was written, and a record left by a future
 * version can hold anything at all, so an anchor that does not check out leaves the camera
 * exactly where setDoc put it. clampView gets the last word, which is what keeps a restore
 * inside the single-page fence.
 */
function restoreView(docId) {
  if (!app.doc || app.doc.id !== docId) return;
  const a = views[docId];
  if (!a || typeof a !== 'object' || !isNum(a.page) || !isNum(a.oy)) return;
  const page = Ink.clamp(Math.round(a.page), 0, app.doc.pages.length - 1);
  if (isNum(a.x)) app.view.x = a.x;
  if (isNum(a.zoom)) app.view.zoom = Ink.clamp(a.zoom, 0.2, 6);
  app.view.y = pageTops()[page] + a.oy; // asked for fresh, so heights are settled first
  clampView();
  requestRender();
  // the page indicator is redrawn by the render above, but the zoom readout is only ever
  // pushed by whoever changed the zoom, and setDoc last pushed the fit-width figure
  ui?.updateZoom?.();
}

/* ============================== notebooks & pages ============================== */

function setDoc(doc) {
  // the outgoing notebook's camera is about to be replaced by this one's, so whatever the
  // debounce is still holding has to go to disk before it is lost
  if (app.doc && app.doc !== doc) flushView();
  commitTextEdit();
  if (voice) cancelVoice(); // the anchor page is about to disappear
  clearSel();
  app.doc = doc;
  app.undoStack.length = 0;
  app.redoStack.length = 0;
  dirtyThumbs.clear();
  hiddenItems.clear();
  invalidateTops();
  // a notebook written before pages could grow has no stored heights, and one written after
  // still gets them re-derived, so the tail below the last item is always the right size
  for (const p of doc.pages) { bottomCache.delete(p); heightDirty.add(p); }
  store.setKV('lastDoc', doc.id);
  fitWidth();
  app.view.y = ch / (2 * app.view.zoom) - 30;
  reseat(0);
  ui?.updateUndo?.();
  ui?.setTitle?.(doc.name);
  ui?.refreshSidebar?.();
  requestRender();
  bakeMissingThumbs(doc);
}

async function switchDoc(id) {
  if (app.doc?.id === id) return;
  await saveNow();
  const doc = await store.loadDoc(id);
  if (doc) { setDoc(doc); restoreView(doc.id); }
}

async function createDoc() {
  await saveNow();
  const doc = newDoc('New Notebook');
  // a new notebook lands in whichever collection is open, which is the one the user is looking at
  const open = currentOpenCollection();
  if (open && app.collections.some((c) => c.id === open)) doc.collection = open;
  setDoc(doc);
  markDirty();
}

async function removeDoc(id) {
  await store.deleteDoc(id);
  if (app.doc?.id === id) {
    const list = await store.listDocs();
    if (list.length) {
      // this is a switch the user did not ask for, but it is still a switch: without the
      // restore the notebook we land on would have its own anchor overwritten with the top
      // of its first page, losing a position it had done nothing to deserve losing
      const doc = await store.loadDoc(list[0].id);
      if (doc) { setDoc(doc); restoreView(doc.id); }
    } else {
      setDoc(newDoc());
      markDirty();
    }
  }
  // after the swap above, never before it: setDoc flushes the outgoing notebook's camera, and
  // that notebook is this one, so dropping the anchor any earlier would only see it written
  // straight back
  if (id in views) { delete views[id]; store.setKV('views', views); }
  ui?.refreshSidebar?.();
}

function renameDoc(name) {
  app.doc.name = (name || '').trim() || 'Untitled';
  markDirty();
  ui?.setTitle?.(app.doc.name);
}

/* ---------- rejoining the pages that arrived as slices (US-023) ---------- */

// The gap between two rejoined slices. The exporter collapsed empty vertical runs down to
// its own MARGIN when it cut a page, so matching that value puts the content back at the
// spacing the slicing itself produced.
const MERGE_GAP = 24;

const itemsTop = (items) => (items.length ? Math.min(...items.map((it) => itemBBox(it).y)) : 0);
const itemsBottom = (items) => (items.length ? Math.max(...items.map((it) => { const b = itemBBox(it); return b.y + b.h; })) : 0);

/**
 * The importer used to cut one OneNote page into as many sheets as its height needed, which
 * is exactly what made a long page read badly. It wrote the page title onto the first sheet
 * only, so an untitled page is a continuation of the one above it. Verified against the real
 * import before this was written: 225 titled pages for 225 OneNote pages, 321 untitled
 * continuations, and not one notebook whose first page lacks a title.
 *
 * Each continuation is dropped below the running content of the page it belongs to, keeping
 * its own internal layout exactly. The seams are recorded on `page.merged`, so the join is
 * reversible, and `doc.slicesMerged` makes a second run a no-op.
 */
function mergeSlicePages(pages) {
  const out = [];
  for (const p of pages) {
    if (!out.length || p.title) {
      p.merged = [{ title: p.title || null, items: p.items.length, dy: 0 }];
      out.push(p);
      continue;
    }
    const host = out[out.length - 1];
    const dy = p.items.length ? itemsBottom(host.items) + MERGE_GAP - itemsTop(p.items) : 0;
    for (const it of p.items) translateItem(it, 0, dy);
    host.merged.push({ title: null, items: p.items.length, dy: Math.round(dy) });
    host.items.push(...p.items);
    // OneNote's own handwriting OCR rides along with the text it belongs to
    if (p.ocrText) host.ocrText = host.ocrText ? host.ocrText + '\n' + p.ocrText : p.ocrText;
  }
  // the top of a rejoined page is exactly what its first slice held, so the thumbnails that
  // are already stored stay correct and none of them has to be baked again
  for (const p of out) {
    bottomCache.delete(p);
    p.h = wantedHeight(p);
  }
  return out;
}

/**
 * Run the rejoin over every imported notebook. One notebook is read, merged and written at a
 * time, so an interrupted run simply leaves the rest for the next one. The notebook that
 * happens to be open is merged in memory as well, because autosave would otherwise write the
 * sliced copy straight back over the merged one.
 */
async function mergeOneNoteSlices(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const list = await store.listDocs();
  const report = { scanned: 0, merged: [], skipped: [], pagesBefore: 0, pagesAfter: 0, ms: 0 };
  const t0 = Date.now();
  for (let i = 0; i < list.length; i++) {
    const meta = list[i];
    report.scanned++;
    onProgress({ done: i, total: list.length, name: meta.name });
    const open = app.doc && meta.id === app.doc.id;
    const doc = open ? app.doc : await store.loadDoc(meta.id);
    if (!doc) { report.skipped.push({ name: meta.name, why: 'unreadable' }); continue; }
    if (doc.origin !== 'onenote') { report.skipped.push({ name: doc.name, why: 'not imported' }); continue; }
    if (doc.slicesMerged) { report.skipped.push({ name: doc.name, why: 'already merged' }); continue; }
    const before = doc.pages.length;
    const pages = mergeSlicePages(doc.pages);
    doc.pages = pages;
    doc.slicesMerged = true;
    doc.modified = Date.now();
    report.pagesBefore += before;
    report.pagesAfter += pages.length;
    try {
      await store.saveDoc(doc);
    } catch (err) {
      console.error('FlatNotes: rejoining slices failed for', doc.name, err);
      report.skipped.push({ name: doc.name, why: 'could not be saved' });
      continue;
    }
    report.merged.push({ name: doc.name, before, after: pages.length, tallest: Math.max(...pages.map(pageHeight)) });
    if (open) { invalidateTops(); setDoc(doc); }
  }
  report.ms = Date.now() - t0;
  ui?.refreshSidebar?.();
  return report;
}

/* ---------- collections (US-022) ---------- */

/*
 * A grouping level above notebooks: collection -> notebook -> pages. A collection is only an
 * id, a name and a sort order, so the whole set lives in the kv store as one record rather
 * than becoming a third entity with its own lifecycle. A notebook points at one through
 * doc.collection, which saveDoc mirrors into the meta record so the sidebar can draw the
 * tree without touching a single document body.
 *
 * Nothing here ever assumes a collection id still resolves: a notebook whose collection has
 * been deleted falls back to the top level in the sidebar, which is the difference between a
 * missing group and a missing notebook.
 */

app.collections = [];

// null means "never set", which is different from "" (every collection deliberately collapsed)
let openCollection = null;
let sbScroll = 0;
let sbScrollTimer = 0;

const listCollections = () => app.collections.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

async function saveCollections() {
  await store.setKV('collections', app.collections.map((c) => ({ id: c.id, name: c.name, order: c.order })));
}

const collectionKey = (name) => String(name || '').trim().toLowerCase();

/** Matched by name so that a repeated import or a re-run of the migration cannot duplicate one. */
function findCollection(name) {
  const k = collectionKey(name);
  return k ? app.collections.find((c) => collectionKey(c.name) === k) || null : null;
}

async function ensureCollection(name) {
  return findCollection(name) || await createCollection(name);
}

async function createCollection(name) {
  const c = { id: uid(), name: String(name || '').trim() || 'New collection', order: app.collections.length };
  app.collections.push(c);
  await saveCollections();
  ui?.refreshSidebar?.();
  return c;
}

async function renameCollection(id, name) {
  const c = app.collections.find((x) => x.id === id);
  if (!c) return false;
  c.name = String(name || '').trim() || c.name;
  await saveCollections();
  ui?.refreshSidebar?.();
  return true;
}

/**
 * Deleting a collection never deletes notebooks. Every member is ungrouped and stays exactly
 * where it was, which is why the collection record goes first: if this is interrupted the
 * leftover notebooks point at an id that no longer exists, and the sidebar already treats
 * that as ungrouped.
 */
async function deleteCollection(id) {
  const i = app.collections.findIndex((c) => c.id === id);
  if (i < 0) return 0;
  app.collections.splice(i, 1);
  await saveCollections();
  if (openCollection === id) setOpenCollection('');
  const metas = await store.listDocs();
  let freed = 0;
  for (const m of metas) {
    if (m.collection !== id) continue;
    if (await patchDocHeader(m.id, { collection: null })) freed++;
  }
  ui?.refreshSidebar?.();
  return freed;
}

/**
 * Both stores have to move together, and the open notebook is the awkward case: autosave
 * rewrites docs and meta from the in-memory document, so patching the database underneath it
 * would simply be undone by the next save. The open one is therefore changed in memory and
 * written the normal way.
 */
async function patchDocHeader(id, fields) {
  if (app.doc?.id === id) {
    Object.assign(app.doc, fields);
    if ('name' in fields) ui?.setTitle?.(app.doc.name);
    await saveNow();
    return true;
  }
  return !!(await store.patchDoc(id, fields));
}

/** Move a notebook into a collection, or out of every collection with a null id. */
async function setDocCollection(id, collectionId) {
  const cid = collectionId && app.collections.some((c) => c.id === collectionId) ? collectionId : null;
  const ok = await patchDocHeader(id, { collection: cid });
  // otherwise the notebook would appear to vanish into a row that is still collapsed
  if (ok && cid) setOpenCollection(cid);
  ui?.refreshSidebar?.();
  return ok;
}

/** Exactly one collection is expanded at a time, and which one survives a restart. */
function currentOpenCollection() {
  return openCollection ?? (app.doc?.collection || '');
}

function setOpenCollection(id) {
  openCollection = id || '';
  store.setKV('openCollection', openCollection);
}

function setSidebarScroll(v) {
  sbScroll = v || 0;
  clearTimeout(sbScrollTimer);
  sbScrollTimer = setTimeout(() => store.setKV('sbScroll', sbScroll), 400);
}

/** `Notebook / Section` split on the FIRST separator, shared by the importer and the migration. */
function splitNotebookName(name) {
  const s = String(name || '');
  const cut = s.indexOf(' / ');
  if (cut <= 0) return { collection: '', name: s.trim() };
  return { collection: s.slice(0, cut).trim(), name: s.slice(cut + 3).trim() };
}

/**
 * US-022 migration. The OneNote import had no grouping level to write to, so it composed
 * notebook names as `Notebook / Section`. Splitting those restores the original hierarchy:
 * one collection per OneNote notebook, each notebook renamed to just its section.
 *
 * Idempotent by construction. A notebook is only ever touched while it is still ungrouped,
 * and the first run gives every one of them a collection, so a second run finds nothing to
 * do. Collections are matched by name before being created, so a re-run cannot duplicate
 * them either. A notebook that already belongs to a collection is left alone even when its
 * name contains ' / ', because there the slash is part of a name the user chose.
 *
 * Collections are all created and persisted before any notebook is rewritten, so an
 * interrupted run can never leave a notebook pointing at a collection that was never saved.
 * The notebooks themselves go one transaction at a time, so a partial run is consistent and
 * simply running it again finishes the job.
 */
async function migrateOneNoteCollections(opts = {}) {
  const t0 = performance.now();
  // every notebook is read and written whole, which is a few hundred milliseconds each on an
  // image heavy import, so the caller is told where it has got to rather than left waiting
  const onProgress = opts.onProgress || (() => {});
  const metas = await store.listDocs();
  const jobs = [];
  for (const m of metas) {
    if (m.collection) continue;                      // already grouped: never re-split
    const split = splitNotebookName(m.name);
    if (!split.collection || !split.name) continue;  // 'My Notes' and any lopsided slash stay put
    jobs.push({ id: m.id, from: m.name, ...split });
  }

  const createdNames = [];
  for (const job of jobs) {
    if (findCollection(job.collection)) continue;
    createdNames.push((await createCollection(job.collection)).name);
  }

  const moved = [];
  for (const job of jobs) {
    const c = findCollection(job.collection);
    if (!c) continue;
    onProgress({ done: moved.length, total: jobs.length, name: job.name });
    if (await patchDocHeader(job.id, { name: job.name, collection: c.id })) {
      moved.push({ id: job.id, from: job.from, to: job.name, collection: c.name });
    }
  }
  onProgress({ done: moved.length, total: jobs.length });

  ui?.refreshSidebar?.();
  return {
    ok: true,
    scanned: metas.length,
    created: createdNames,
    moved,
    ms: Math.round(performance.now() - t0),
  };
}

/* ---------- OneNote import (US-021) ---------- */

/**
 * The exporter has already done the geometry, so an imported item only needs an id and the
 * bbox the renderer expects, computed with the same helpers a hand drawn item uses. Points
 * arrive as a flat x, y, p array, which keeps a 1.7 million point corpus down to a sane
 * file size.
 */
function itemFromOneNote(raw) {
  if (raw.t === 's') {
    const pts = raw.pts || [];
    const points = [];
    for (let i = 0; i + 2 < pts.length; i += 3) points.push({ x: pts[i], y: pts[i + 1], p: pts[i + 2] });
    if (!points.length) return null;
    const it = {
      id: uid(), type: 'stroke', tool: raw.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: raw.color || '#1d1d1f', size: raw.size || 2, opacity: raw.opacity ?? 1, points,
    };
    it.bbox = Ink.bboxOfPoints(points, it.size);
    return it;
  }
  if (raw.t === 't') {
    if (!raw.text) return null;
    const it = { id: uid(), type: 'text', x: raw.x, y: raw.y, text: raw.text, size: raw.size || 17, color: raw.color || '#1d1d1f' };
    it.bbox = measureTextItem(it);
    return it;
  }
  if (raw.t === 'i') {
    const b = { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
    return {
      id: uid(), type: 'image', ...b,
      nw: raw.nw || Math.round(raw.w), nh: raw.nh || Math.round(raw.h),
      src: raw.src, bbox: { ...b },
    };
  }
  return null;
}

/**
 * A staged section carries its OneNote notebook and section names as separate fields, so the
 * hierarchy can go straight into a collection. Only staging written before US-022 has just
 * the composed `Notebook / Section`, which is split as a fallback.
 */
function oneNoteNames(sec) {
  const split = splitNotebookName(sec.name);
  return {
    collection: String(sec.notebook || split.collection || '').trim(),
    name: String(sec.section || split.name || '').trim() || 'OneNote import',
  };
}

/** One staged OneNote section becomes one new FlatNotes document, never an existing one. */
function docFromOneNoteSection(sec, collectionId = null) {
  const now = Date.now();
  const pages = (sec.pages || []).map((p) => {
    const page = { id: uid(), template: 'blank', paper: 'white', items: [] };
    if (p.title) page.title = p.title;          // OneNote page titles have nowhere else to live
    if (p.ocrText) page.ocrText = p.ocrText;    // OneNote's own handwriting OCR, kept, not drawn
    for (const raw of p.items || []) {
      const it = itemFromOneNote(raw);
      if (it) page.items.push(it);
    }
    // a OneNote page is one page here however long it is, so it arrives at its full height
    page.h = wantedHeight(page);
    return page;
  });
  if (!pages.length) pages.push({ id: uid(), template: 'blank', paper: 'white', items: [] });
  return {
    id: uid(),
    name: oneNoteNames(sec).name,     // the section alone: the notebook it came from is the collection
    collection: collectionId || null,
    pages,
    created: now,
    modified: now,
    origin: 'onenote',
    slicesMerged: true, // nothing was sliced, so there is nothing for the rejoin to do
    originId: sec.sectionId || null,
  };
}

/**
 * Run the exporter, then turn every staged section into a new notebook. Strictly additive:
 * no existing document is read, rewritten or deleted, and the open document is left alone,
 * so an import can never damage the notes already here. Each notebook is written once with
 * a single saveDoc rather than through autosave, because autosave rewrites the whole
 * document and an image heavy section is tens of megabytes.
 */
async function importOneNote(opts = {}) {
  const fn = window.flatnotes;
  if (!fn?.onenoteExport) return { ok: false, error: 'desktop-only' };
  const onProgress = opts.onProgress || (() => {});
  const off = fn.onOnenoteProgress ? fn.onOnenoteProgress(onProgress) : null;
  try {
    const res = await fn.onenoteExport({ sections: opts.sections, maxPages: opts.maxPages });
    if (!res.ok) return res;
    const files = res.files || [];
    const created = [];
    const failed = [];   // a section that cannot be read or saved must never pass as success
    for (let i = 0; i < files.length; i++) {
      onProgress({ phase: 'save', done: i, total: files.length });
      const r = await fn.onenoteRead(files[i]);
      if (!r.ok) { failed.push({ file: files[i], why: r.error || 'read failed' }); continue; }
      let sec;
      try { sec = JSON.parse(r.json); }
      catch (err) { failed.push({ file: files[i], why: 'unreadable JSON' }); continue; }
      // one collection per OneNote notebook, reused across sections and across re-imports
      const colName = oneNoteNames(sec).collection;
      const col = colName ? await ensureCollection(colName) : null;
      const doc = docFromOneNoteSection(sec, col?.id || null);
      // the sidebar takes its thumbnail from the first page, and an imported notebook never
      // goes through the autosave path that would otherwise bake one
      const first = doc.pages[0];
      const pending = ensureImagesReady([first]);
      if (pending) await pending;
      try { first.thumb = renderThumb(first); } catch { /* a thumbnail is cosmetic */ }
      try {
        await store.saveDoc(doc);
      } catch (err) {
        console.error('FlatNotes: saving an imported notebook failed', err);
        failed.push({ file: files[i], name: doc.name, why: 'could not be saved' });
        continue;
      }
      created.push({ id: doc.id, name: doc.name, pages: doc.pages.length });
      onProgress({ phase: 'save', done: i + 1, total: files.length, name: doc.name });
    }
    // staged JSON is a full copy of the notes, so it only survives a partial import, where
    // it is the one thing that would let the missing sections be retried
    if (opts.keepStaging !== true && !failed.length) await fn.onenoteClear?.();
    ui?.refreshSidebar?.();
    return { ok: true, created, failed, stats: res.stats || null };
  } catch (err) {
    console.error('FlatNotes: OneNote import failed', err);
    return { ok: false, error: 'exception', detail: String(err) };
  } finally {
    off?.();
  }
}

/**
 * A page keeps whatever name it is given, and OneNote page titles survive an import as that
 * name. Anything unnamed is simply numbered, and the number follows its position, so
 * inserting a page never leaves a stale "Page 3" sitting fourth in the list.
 */
const pageName = (page, i) => (page && page.title ? page.title : `Page ${i + 1}`);
const pageLabel = (i) => pageName(app.doc.pages[i], i);

function renamePage(i, name) {
  const page = app.doc.pages[i];
  if (!page) return;
  const before = page.title || '';
  const after = String(name || '').trim().slice(0, 80);
  if (after === before) return;
  const apply = (t) => {
    if (t) page.title = t; else delete page.title;
    ui?.refreshSidebar?.();
    ui?.updatePageIndicator?.();
  };
  apply(after);
  pushUndo({ undo: () => apply(before), redo: () => apply(after) });
}

function goToPage(i) {
  i = Ink.clamp(i, 0, app.doc.pages.length - 1);
  // leaving a page in single-page view hides it outright, so anything anchored to it goes with
  // it: a text box being edited is committed and a selection is dropped rather than left
  // floating over a page nobody can see
  if (singleView() && i !== currentPageIndex()) { commitTextEdit(); clearSel(); }
  // in single-page view the top of the fence is already the top of the page, and going through
  // it keeps the camera inside the page it was asked for however far it is zoomed out
  app.view.y = singleView() ? singleFence(i).lo : pageRect(i).y + (ch / 2 - 90) / app.view.zoom;
  flipAccum = 0;
  clampView();
  requestRender();
}

function deletePage(i) {
  if (app.doc.pages.length <= 1) { ui?.toast?.('A notebook needs at least one page'); return; }
  if (voice && app.doc.pages[i] === voice.page) cancelVoice(); // its anchor page is going away
  clearSel();
  const [pg] = app.doc.pages.splice(i, 1);
  pushUndo({
    undo: () => { app.doc.pages.splice(i, 0, pg); reseat(i); requestRender(); ui?.refreshSidebar?.(); },
    redo: () => { app.doc.pages.splice(i, 1); reseat(i); requestRender(); ui?.refreshSidebar?.(); },
  });
  reseat(i);
  requestRender();
  ui?.refreshSidebar?.();
}

function duplicatePage(i) {
  const src = app.doc.pages[i];
  const copy = structuredClone(src);
  copy.id = uid();
  for (let k = 0; k < copy.items.length; k++) {
    copy.items[k].id = uid();
    const img = imageCache.get(src.items[k]);
    if (img) imageCache.set(copy.items[k], img); // the copied page shares every decode
  }
  app.doc.pages.splice(i + 1, 0, copy);
  pushUndo({
    undo: () => { app.doc.pages.splice(i + 1, 1); reseat(i); requestRender(); ui?.refreshSidebar?.(); },
    redo: () => { app.doc.pages.splice(i + 1, 0, copy); reseat(i + 1); requestRender(); ui?.refreshSidebar?.(); },
  });
  requestRender();
  ui?.refreshSidebar?.();
  ui?.toast?.('Page duplicated');
}

function setPageStyle(opts) {
  const page = app.doc.pages[currentPageIndex()];
  const before = { template: page.template, paper: page.paper };
  const after = { template: opts.template ?? page.template, paper: opts.paper ?? page.paper };
  Object.assign(page, after);
  app.settings.defaultTemplate = after.template;
  app.settings.defaultPaper = after.paper;
  saveSettings();
  invalidatePage(page);
  updateCursor();
  pushUndo({
    undo: () => { Object.assign(page, before); invalidatePage(page); updateCursor(); },
    redo: () => { Object.assign(page, after); invalidatePage(page); updateCursor(); },
  });
}

function saveSettings() {
  store.setKV('settings', JSON.parse(JSON.stringify(app.settings)));
}

/** Switch between the continuous strip and one page at a time, keeping the page you are on. */
function setPageView(mode) {
  const want = mode === 'single' ? 'single' : 'continuous';
  if (want === app.settings.pageView) return;
  app.settings.pageView = want;
  saveSettings();
  goToPage(currentPageIndex()); // re-seat the camera under whichever rule now applies
  ui?.updatePageIndicator?.();
}

/** How the sidebar lists pages: sheets two or three to a row, or plain named rows. */
function setPageList(mode) {
  app.settings.pageList = ['big', 'small', 'list'].includes(mode) ? mode : 'big';
  saveSettings();
  ui?.refreshSidebar?.();
}

/* ============================== export ============================== */

/**
 * Paint a slice of a page (paper, template, items) flat onto a canvas. `top` and `h` are in
 * page units: a PDF asks for one sheet at a time, a PNG for the whole thing. Pass a canvas
 * in to reuse it.
 */
function renderPageToCanvas(page, scale, cv = document.createElement('canvas'), top = 0, h = PAGE_H) {
  cv.width = Math.round(PAGE_W * scale);
  cv.height = Math.round(h * scale); // resizing also resets the context state
  const x = cv.getContext('2d');
  x.fillStyle = PAPERS[page.paper] || '#fff';
  x.fillRect(0, 0, cv.width, cv.height);
  drawPaperBorder(x, page, 0, 0, cv.width, cv.height, scale);
  drawTemplate(x, page, 0, -top * scale, cv.width, pageHeight(page) * scale, scale, 0, cv.height);
  x.setTransform(scale, 0, 0, scale, 0, -top * scale);
  setPaperMode(page);
  for (const item of page.items) {
    const b = itemBBox(item);
    if (b.y + b.h < top || b.y > top + h) continue; // off this slice
    drawItem(x, item);
  }
  return cv;
}

/**
 * How much of a page is worth exporting: down to the last item, never the blank tail, so a
 * page that is deliberately kept short does not turn into an empty second sheet.
 */
const exportHeight = (page) => Math.max(PAGE_H, Math.ceil(contentBottom(page)) + 24);
const sheetCount = (page) => Math.max(1, Math.ceil(contentBottom(page) / PAGE_H));

/** Strip anything a file system would object to; the name is only used for the download. */
const safeFileName = (s) => String(s || 'Notes').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Notes';

function downloadBlob(bytes, type, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); // some engines ignore a click on a detached anchor
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // revoking at once cancels the download
}

// The tallest a browser will reliably hand back as a PNG; a very long page is exported at a
// lower scale rather than being cut in half.
const PNG_MAX_PX = 8000;

async function exportPagePNG() {
  const i = currentPageIndex();
  const page = app.doc.pages[i];
  await ensureImagesReady([page]); // renderPageToCanvas is synchronous, so decode first
  const tall = exportHeight(page);
  const scale = Math.min(2.5, PNG_MAX_PX / tall);
  const cv = renderPageToCanvas(page, scale, undefined, 0, tall);
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = `${safeFileName(app.doc.name)} - ${safeFileName(pageLabel(i))}.png`;
  a.click();
  // a very long page cannot be exported at full scale, and saying so is better than handing
  // back a sliver that looks like a bug
  ui?.toast?.(scale < 2.5
    ? `Exported ${pageLabel(i)} as PNG, scaled down to fit ${PNG_MAX_PX} px`
    : `Exported ${pageLabel(i)} as PNG`, scale < 2.5 ? 4000 : 1800);
}

/* ---------- PDF, written by hand so the app keeps its zero dependencies ---------- */

const PDF_PT_W = 595.28;                        // A4 width in points
const PDF_PT_H = PDF_PT_W * (PAGE_H / PAGE_W);  // height follows the real page aspect
const PDF_SCALE = 2.5;                          // raster scale, matches the PNG export
const PDF_QUALITY = 0.9;

/** Latin-1 bytes of an ASCII string; every literal we emit stays inside 0-255 on purpose. */
function asciiBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

/** Raw JPEG bytes from a canvas, data URL header stripped, ready to embed as DCTDecode. */
function canvasJpegBytes(cv, quality) {
  const url = cv.toDataURL('image/jpeg', quality);
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * Build a PDF with one JPEG page per notebook page. Object layout is
 * 1 = Catalog, 2 = Pages, then three per page: Page dict, content stream, image XObject.
 * Offsets for the xref table are taken from real byte lengths, never string lengths,
 * so the file stays valid however the notebook is named.
 */
async function buildPDF(pages, onProgress) {
  await ensureImagesReady(pages); // every page is rastered synchronously below
  // a PDF sheet is a fixed size, so a tall page becomes as many sheets as its content needs
  const sheets = [];
  for (const page of pages) {
    const n = sheetCount(page);
    for (let s = 0; s < n; s++) sheets.push({ page, top: s * PAGE_H });
  }
  const chunks = [];
  let len = 0;
  const put = (part) => {
    const b = typeof part === 'string' ? asciiBytes(part) : part;
    chunks.push(b);
    len += b.length;
  };

  const n = sheets.length;
  const size = 2 + n * 3 + 1;          // objects 1..(size-1) plus the free object 0
  const offsets = new Array(size).fill(0);
  const pageId = (i) => 3 + i * 3;     // page dict, then content, then image
  const obj = (id, body) => { offsets[id] = len; put(`${id} 0 obj\n${body}\nendobj\n`); };

  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'); // the binary comment marks the file as non-ASCII

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${sheets.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);

  const W = PDF_PT_W.toFixed(2), H = PDF_PT_H.toFixed(2);
  const cv = document.createElement('canvas'); // one canvas for the whole export

  for (let i = 0; i < n; i++) {
    onProgress?.(i, n);
    renderPageToCanvas(sheets[i].page, PDF_SCALE, cv, sheets[i].top, PAGE_H);
    const jpeg = canvasJpegBytes(cv, PDF_QUALITY);
    const id = pageId(i);

    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}]`
      + ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);

    const content = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`; // fill the page with the image
    obj(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    offsets[id + 2] = len;
    put(`${id + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height}`
      + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    put(jpeg);
    put('\nendstream\nendobj\n');

    if (i < n - 1) await new Promise((r) => setTimeout(r)); // let the UI breathe between pages
  }

  // xref rows are exactly 20 bytes: 10 digit offset, space, 5 digit generation, space, type, space, LF
  const xrefAt = len;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  put(table);
  put(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

let pdfBusy = false;

/** scope: 'page' for the page in view, 'notebook' for every page. */
async function exportPDF(scope = 'page') {
  if (pdfBusy) { ui?.toast?.('Already exporting - one moment'); return; }
  pdfBusy = true;
  const i = currentPageIndex();
  const pages = scope === 'notebook' ? app.doc.pages.slice() : [app.doc.pages[i]];
  try {
    let sheets = 0;
    const bytes = await buildPDF(pages, (done, total) => {
      sheets = total;
      if (total > 1) ui?.toast?.(`Exporting PDF - sheet ${done + 1} of ${total}…`, 120000);
    });
    const name = safeFileName(app.doc.name);
    downloadBlob(bytes, 'application/pdf', pages.length > 1 ? `${name}.pdf` : `${name} - ${pageLabel(i)}.pdf`);
    // a tall page becomes several sheets, so the count worth reporting is the sheet count
    ui?.toast?.(pages.length > 1
      ? `Exported ${pages.length} pages as PDF (${sheets} sheets)`
      : `Exported ${pageLabel(i)} as PDF${sheets > 1 ? ` (${sheets} sheets)` : ''}`);
  } catch (err) {
    console.error(err);
    ui?.toast?.('PDF export failed - see console', 4000);
  } finally {
    pdfBusy = false;
  }
}

Object.assign(app, {
  setTool,
  undo, redo,
  canUndo: () => app.undoStack.length > 0,
  canRedo: () => app.redoStack.length > 0,
  zoomIn: () => zoomAt(cw / 2, ch / 2, 1.25),
  zoomOut: () => zoomAt(cw / 2, ch / 2, 0.8),
  setZoom,
  fitWidth, fitPage,
  fitWidthZoom, fitPageZoom,
  addPage,
  applyTheme,
  requestRender,
  invalidateAllPaths: () => { app.doc.pages.forEach((p) => { p.items.forEach((i) => pathCache.delete(i)); invalidatePage(p); }); },
  currentPageIndex,
  pageCount: () => app.doc.pages.length,
  // persistence & documents
  saveSettings,
  saveNow,
  listDocs: store.listDocs,
  loadDoc: store.loadDoc, // read a notebook without opening it (maintenance jobs, tests)
  switchDoc, createDoc, removeDoc, renameDoc,
  // collections
  listCollections,
  createCollection, renameCollection, deleteCollection,
  setDocCollection,
  openCollection: currentOpenCollection,
  setOpenCollection,
  sidebarScroll: () => sbScroll,
  setSidebarScroll,
  migrateOneNoteCollections,
  mergeOneNoteSlices,
  goToPage, deletePage, duplicatePage, setPageStyle,
  pageLabel, renamePage,
  setPageView, setPageList, turnPage,
  singleView,
  pageHeight: (i) => pageHeight(app.doc.pages[i]), // exposed for tests and the sidebar
  pageSheets: (i) => sheetCount(app.doc.pages[i]),
  cacheStats: () => ({ bands: lru.length, bytes: cacheBytes, budget: CACHE_BUDGET }),
  currentPage: () => app.doc.pages[currentPageIndex()],
  // selection
  deleteSelection, duplicateSelection, clearSel,
  hasSelection: () => !!sel,
  // a quarter turn is offered on the selection rather than on an item, because only a lone
  // image can take one and resizableItem is the one place that rule is written down
  rotateSelectionLeft, rotateSelectionRight,
  // layer order: any selection, any item type
  bringForward, sendBackward, bringToFront, sendToBack,
  // images
  placeImage,
  addImageFile,
  addImage: (src, opts = {}) => placeImage(
    src,
    opts.pageIndex ?? currentPageIndex(),
    opts.x ?? PAGE_W / 2,
    opts.y ?? PAGE_H / 2,
  ),
  ensureImagesReady,
  exportPagePNG,
  exportPDF,
  buildPDF, // exposed so the PDF bytes can be checked without a real download
  renderPageToCanvas, // and so exported pixels can be sampled without one either
  renderOcrCrop,      // likewise: the crop can be inspected without an engine running
  PAPERS,
  ocrHealthy,
  loadOcrModels,
  currentOcrModel,
  sanitizeOcrText,
  // voice notes
  asrHealthy,
  loadAsrModels,
  currentAsrModel,
  startVoice, stopVoice, cancelVoice,
  isRecording: () => !!voice,
  voiceTrackStates: () => lastVoiceTracks.map((t) => t.readyState),
  voiceState: () => (voice ? { total: voice.total, rate: voice.rate, text: voice.text, status: voice.status,
    tracks: (voice.stream?.getTracks() || []).map((t) => t.readyState) } : null),
  // OneNote import
  importOneNote,
  oneNoteAvailable: () => window.flatnotes?.onenoteAvailable?.() ?? Promise.resolve({ ok: false }),
  oneNoteList: () => window.flatnotes?.onenoteList?.() ?? Promise.resolve({ ok: false, error: 'desktop-only' }),
  docFromOneNoteSection, // exposed so an import can be checked without running the exporter
  // AI actions on a selection + auto title
  aiAction,
  aiActions: AI_ACTIONS.map((a) => ({ id: a.id, label: a.label, note: a.note })),
  aiLanguages: AI_LANGUAGES,
  suggestDocTitle,
});

/* ============================== boot ============================== */

let ui = null;

async function boot() {
  try {
    const saved = await store.getKV('settings');
    if (saved) Object.assign(app.settings, saved);
  } catch { /* fresh start */ }

  try {
    const cols = await store.getKV('collections');
    if (Array.isArray(cols)) app.collections = cols.filter((c) => c && c.id).map((c, i) => ({ ...c, order: c.order ?? i }));
    const open = await store.getKV('openCollection');
    if (typeof open === 'string') openCollection = open;
    const scroll = await store.getKV('sbScroll');
    if (typeof scroll === 'number') sbScroll = scroll;
    // read last, so a bad camera record cannot cost the sidebar state above it
    const savedViews = await store.getKV('views');
    if (savedViews && typeof savedViews === 'object' && !Array.isArray(savedViews)) views = savedViews;
  } catch { /* fresh start */ }

  // resolve the real model registry now, so a saved ocrModel that is no longer
  // on disk is corrected before the first Textify rather than when the picker opens
  await loadOcrModels();
  await loadAsrModels();

  readCss();
  applyTheme();
  resize();

  let doc = null;
  try {
    const lastId = await store.getKV('lastDoc');
    if (lastId) doc = await store.loadDoc(lastId);
    if (!doc) {
      const list = await store.listDocs();
      if (list.length) doc = await store.loadDoc(list[0].id);
    }
  } catch { /* fresh start */ }

  app.doc = doc || newDoc();
  ui = initUI(app);
  app.ui = ui;
  setDoc(app.doc);
  // after setDoc, which fits the width and then puts the camera at the top of page one
  restoreView(app.doc.id);
  setTool('pen');
}

boot();
