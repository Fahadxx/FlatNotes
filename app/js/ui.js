// FlatNotes UI: toolbar, popovers, chrome. Built as DOM on top of the canvases.

/* ---------- tiny helpers ---------- */

const html = (s) => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild;
};

const SVG = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}${extra}</svg>`;

export const ICONS = {
  pen: SVG(['M21.17 6.83a2.85 2.83 0 0 0-4-4L3.5 16.5 2 22l5.5-1.5Z', 'm15 5 4 4']),
  highlighter: SVG(['m9 11-6 6v3h9l3-3', 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4Z']),
  eraser: SVG(['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9']),
  lasso: SVG(['M7 22a5 5 0 0 1-2-4', 'M7 16.93c.96.43 1.96.74 2.99.91', 'M3.34 14A6.8 6.8 0 0 1 2 10c0-4.42 4.48-8 10-8s10 3.58 10 8a7.19 7.19 0 0 1-.33 2'], '<circle cx="5" cy="18" r="3"/><path d="M14.33 22h-.09a.35.35 0 0 1-.24-.32v-10a.34.34 0 0 1 .33-.34c.08 0 .15.03.21.08l7.34 6a.33.33 0 0 1-.21.59h-4.49l-2.57 3.85a.35.35 0 0 1-.28.14Z"/>'),
  text: SVG(['M4 7V5h16v2', 'M12 5v14', 'M9 19h6']),
  textify: SVG(['M9 15.5 12 7.5l3 8', 'M10.1 13.2h3.8'], '<circle cx="12" cy="12" r="9.2" stroke-dasharray="3.4 2.7"/>'),
  voice: SVG(['M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M5 10.5V11a7 7 0 0 0 14 0v-.5', 'M12 18v4', 'M9 22h6']),
  shape: SVG([], '<circle cx="8" cy="8" r="5"/><rect x="12" y="12" width="9" height="9" rx="1.5"/>'),
  undo: SVG(['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13']),
  redo: SVG(['M21 7v6h-6', 'M3 17a9 9 0 0 1 15-6.7L21 13']),
  plus: SVG(['M5 12h14', 'M12 5v14']),
  menu: SVG(['M4 6h16', 'M4 12h16', 'M4 18h16']),
  sun: SVG(['M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm6.3 17.7-1.4 1.4', 'm19.1 4.9-1.4 1.4'], '<circle cx="12" cy="12" r="4"/>'),
  moon: SVG(['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z']),
  settings: SVG(['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4']),
  fit: SVG(['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M8 21H5a2 2 0 0 1-2-2v-3', 'M16 21h3a2 2 0 0 0 2-2v-3']),
  page: SVG(['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M8 13h8', 'M8 17h5']),
  book: SVG(['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20']),
  chevron: SVG(['m9 5 7 7-7 7']),
  folder: SVG(['M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.6.8l1.2 1.6a2 2 0 0 0 1.6.8H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z']),
  folderPlus: SVG(['M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.6.8l1.2 1.6a2 2 0 0 0 1.6.8H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z', 'M12 11.5v5', 'M9.5 14h5']),
  close: SVG(['M18 6 6 18', 'm6 6 12 12']),
  trash: SVG(['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6']),
  copy: SVG(['M20 8v13a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1Z', 'M16 7V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3']),
  sparkle: SVG(['M11 3.2 12.9 8l4.8 1.9-4.8 1.9L11 16.6 9.1 11.8 4.3 9.9 9.1 8Z', 'M18 15.2l.75 1.9 1.9.75-1.9.75-.75 1.9-.75-1.9-1.9-.75 1.9-.75Z']),
  viewBig: SVG([], '<rect x="3" y="4" width="7.6" height="16" rx="1.6"/><rect x="13.4" y="4" width="7.6" height="16" rx="1.6"/>'),
  viewSmall: SVG([], '<rect x="2.6" y="5.5" width="5" height="13" rx="1.3"/><rect x="9.5" y="5.5" width="5" height="13" rx="1.3"/><rect x="16.4" y="5.5" width="5" height="13" rx="1.3"/>'),
  viewList: SVG(['M9 6h12', 'M9 12h12', 'M9 18h12'], '<circle cx="4.6" cy="6" r="1.1"/><circle cx="4.6" cy="12" r="1.1"/><circle cx="4.6" cy="18" r="1.1"/>'),
  rotateLeft: SVG(['M3 12a9 9 0 1 0 9-9c-2.52 0-4.93 1-6.74 2.74L3 8', 'M3 3v5h5']),
  rotateRight: SVG(['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5']),
  layerFront: SVG(['M8 8.5 12 5.5 16 8.5', 'M8 5 12 2 16 5'], '<rect x="7" y="10" width="10" height="6" rx="1.5"/>'),
  layerForward: SVG(['M8 9 12 5 16 9'], '<rect x="7" y="10" width="10" height="6" rx="1.5"/>'),
  layerBackward: SVG(['M8 17 12 21 16 17'], '<rect x="7" y="10" width="10" height="6" rx="1.5"/>'),
  layerBack: SVG(['M8 17.5 12 20.5 16 17.5', 'M8 20 12 23 16 20'], '<rect x="7" y="10" width="10" height="6" rx="1.5"/>'),
};

/** The sidebar page list styles, in the order their buttons appear. */
const PAGE_LISTS = [
  { id: 'big', icon: 'viewBig', label: 'Big previews', hint: 'Two sheets to a row' },
  { id: 'small', icon: 'viewSmall', label: 'Small previews', hint: 'Three sheets to a row' },
  { id: 'list', icon: 'viewList', label: 'List', hint: 'Names only, no previews' },
];

export const PEN_COLORS = [
  '#1d1d1f', '#6e6e73', '#ffffff', '#e0342b', '#f0731d', '#f5b60d', '#159a51',
  '#0d9488', '#2563eb', '#6366f1', '#9333ea', '#ec4899', '#8b5a2b', '#134e4a',
];
export const HL_COLORS = ['#ffd60a', '#ffb01f', '#ff5c8a', '#4cd964', '#38bdf8', '#a78bfa', '#94a3b8'];
const SIZE_PRESETS = { pen: [1.5, 2.5, 4, 6, 9], highlighter: [8, 14, 20, 30] };
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4];

const TOOL_DEFS = [
  { id: 'pen', name: 'Pen' },
  { id: 'highlighter', name: 'Highlighter' },
  { id: 'eraser', name: 'Eraser' },
  { id: 'lasso', name: 'Lasso' },
  { id: 'text', name: 'Text' },
  { id: 'shape', name: 'Shapes' },
  { id: 'textify', name: 'Textify - circle ink to turn it into text' },
  { id: 'voice', name: 'Voice - tap a spot and speak, it becomes text' },
];

/* ============================== init ============================== */

export function initUI(app) {
  const uiRoot = document.getElementById('ui');

  /* ---------- top chrome ---------- */

  const topbar = html(`<div class="topbar">
    <div class="chip glass" id="chip-left">
      <button class="icon-btn small" id="btn-menu" title="Notebooks">${ICONS.menu}</button>
      <div class="doc-title" id="doc-title">My Notes</div>
      <button class="icon-btn small" id="btn-suggest" title="Suggest a title from page 1">${ICONS.sparkle}</button>
    </div>
    <div id="toolbar" class="glass"></div>
    <div class="chip glass" id="chip-right">
      <div class="zoom-label" id="zoom-label" title="Zoom (Ctrl+0 fits width)">100%</div>
      <button class="icon-btn small" id="btn-addpage" title="Add page">${ICONS.plus}</button>
      <button class="icon-btn small" id="btn-pagestyle" title="Page style">${ICONS.page}</button>
      <button class="icon-btn small" id="btn-theme" title="Theme">${ICONS.moon}</button>
      <button class="icon-btn small" id="btn-settings" title="Settings">${ICONS.settings}</button>
    </div>
  </div>`);
  uiRoot.appendChild(topbar);

  const toolbar = topbar.querySelector('#toolbar');
  const toast = html(`<div id="toast" class="glass"></div>`);
  const pageInd = html(`<div id="pageind" class="glass"></div>`);
  uiRoot.append(toast, pageInd);

  /* ---------- selection action bar ---------- */

  const selbar = html(`<div id="selbar" class="glass">
    <button class="icon-btn small" id="sel-ai" title="AI actions on this selection">${ICONS.sparkle}</button>
    <div class="tb-sep"></div>
    <button class="icon-btn small sel-rotate" id="sel-rotleft" title="Rotate left">${ICONS.rotateLeft}</button>
    <button class="icon-btn small sel-rotate" id="sel-rotright" title="Rotate right">${ICONS.rotateRight}</button>
    <div class="tb-sep sel-rotate"></div>
    <button class="icon-btn small" id="sel-front" title="Bring to front (Ctrl+Shift+])">${ICONS.layerFront}</button>
    <button class="icon-btn small" id="sel-forward" title="Bring forward (Ctrl+])">${ICONS.layerForward}</button>
    <button class="icon-btn small" id="sel-backward" title="Send backward (Ctrl+[)">${ICONS.layerBackward}</button>
    <button class="icon-btn small" id="sel-back" title="Send to back (Ctrl+Shift+[)">${ICONS.layerBack}</button>
    <div class="tb-sep"></div>
    <button class="icon-btn small" id="sel-dup" title="Duplicate (Ctrl+D)">${ICONS.copy}</button>
    <button class="icon-btn small" id="sel-del" title="Delete (Del)" style="color:var(--danger)">${ICONS.trash}</button>
    <div class="tb-sep"></div>
    <button class="icon-btn small" id="sel-close" title="Deselect (Esc)">${ICONS.close}</button>
  </div>`);
  uiRoot.appendChild(selbar);
  selbar.querySelector('#sel-ai').addEventListener('click', (e) => openAiMenu(e.currentTarget));
  selbar.querySelector('#sel-rotleft').addEventListener('click', () => app.rotateSelectionLeft());
  selbar.querySelector('#sel-rotright').addEventListener('click', () => app.rotateSelectionRight());
  selbar.querySelector('#sel-front').addEventListener('click', () => app.bringToFront());
  selbar.querySelector('#sel-forward').addEventListener('click', () => app.bringForward());
  selbar.querySelector('#sel-backward').addEventListener('click', () => app.sendBackward());
  selbar.querySelector('#sel-back').addEventListener('click', () => app.sendToBack());
  selbar.querySelector('#sel-dup').addEventListener('click', () => app.duplicateSelection());
  selbar.querySelector('#sel-del').addEventListener('click', () => app.deleteSelection());
  selbar.querySelector('#sel-close').addEventListener('click', () => app.clearSel());

  // ctx carries what kind of selection this is: rotate is lone-image only, layer order
  // (always shown alongside it) works for any selection. The rotate group's own trailing
  // tb-sep is toggled with it so hiding it never stalls a stray separator next to the layer group.
  function showSelbar(rect, ctx) {
    if (!rect) { selbar.classList.remove('show'); return; }
    const loneImage = !!ctx?.loneImage;
    selbar.querySelectorAll('.sel-rotate').forEach((el) => { el.style.display = loneImage ? '' : 'none'; });
    selbar.classList.add('show');
    const w = selbar.offsetWidth;
    selbar.style.left = Math.max(8, Math.min(rect.x + rect.w / 2 - w / 2, innerWidth - w - 8)) + 'px';
    const above = rect.y - 54;
    selbar.style.top = (above > 60 ? above : rect.y + rect.h + 18) + 'px';
  }

  /* ---------- image drop target ---------- */

  const dropveil = html(`<div id="dropveil"><span>Drop an image on the page</span></div>`);
  uiRoot.appendChild(dropveil);
  const setDropActive = (on) => dropveil.classList.toggle('show', !!on);

  /* ---------- toolbar buttons ---------- */

  function buildToolbar() {
    toolbar.innerHTML = '';
    const shown = app.settings.toolbarTools || app.availableTools;
    for (const def of TOOL_DEFS) {
      if (!app.availableTools.includes(def.id) || !shown.includes(def.id)) continue;
      const b = html(`<button class="icon-btn" data-tool="${def.id}" title="${def.name}">${ICONS[def.id]}<i class="tint"></i></button>`);
      b.addEventListener('click', () => {
        if (app.tool === def.id) openToolPopover(def.id, b);
        else app.setTool(def.id);
      });
      bindToolHover(def.id, b);
      toolbar.appendChild(b);
    }
    toolbar.appendChild(html(`<div class="tb-sep"></div>`));
    const undoBtn = html(`<button class="icon-btn" id="btn-undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>`);
    const redoBtn = html(`<button class="icon-btn" id="btn-redo" title="Redo (Ctrl+Y)">${ICONS.redo}</button>`);
    undoBtn.addEventListener('click', () => app.undo());
    redoBtn.addEventListener('click', () => app.redo());
    toolbar.append(undoBtn, redoBtn);
    updateToolbar();
    updateUndo();
  }

  function updateToolbar() {
    toolbar.querySelectorAll('[data-tool]').forEach((b) => {
      const t = b.dataset.tool;
      b.classList.toggle('active', app.tool === t);
      const tint = b.querySelector('.tint');
      if (tint) {
        const ts = app.tools[t];
        tint.style.background = ts && ts.color && (t === 'pen' || t === 'highlighter' || t === 'text' || t === 'shape') ? ts.color : 'transparent';
      }
    });
  }

  function updateUndo() {
    const u = toolbar.querySelector('#btn-undo');
    const r = toolbar.querySelector('#btn-redo');
    if (u) u.disabled = !app.canUndo();
    if (r) r.disabled = !app.canRedo();
  }

  /* ---------- popovers ---------- */

  let activePopover = null;
  let syncZoomPop = null;

  // Hover preview state: a popover opened by hovering is owned by the hover logic
  // and closes itself again; one opened by a click keeps the old dismiss rules.
  const HOVER_OPEN_MS = 400;
  const HOVER_CLOSE_MS = 300;
  let hoverBtn = null;
  let hoverPending = null;
  let hoverPopTool = null;
  let hoverInPop = false;
  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;

  function closePopovers() {
    syncZoomPop = null;
    cancelHoverTimers();
    hoverPopTool = null;
    hoverInPop = false;
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function openPopover(anchor, contentEl) {
    closePopovers();
    const pop = html(`<div class="popover glass"></div>`);
    pop.appendChild(contentEl);
    uiRoot.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(ar.left + ar.width / 2 - pw / 2, innerWidth - pw - 8)) + 'px';
    // below the anchor by default, flipped above when the viewport bottom is in the way
    const below = ar.bottom + 10;
    pop.style.top = (below + ph > innerHeight - 8 ? Math.max(8, ar.top - ph - 10) : below) + 'px';
    requestAnimationFrame(() => pop.classList.add('show'));
    activePopover = pop;
    bindPopoverHover(pop);
    return pop;
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.popover') || e.target.closest?.('#toolbar')) return;
    hoverBtn = null;
    cancelHoverTimers();
    if (activePopover) closePopovers();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    cancelHoverTimers();
    if (activePopover) closePopovers();
  });

  /* ---------- hover to preview tool options ---------- */

  const canHover = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen';

  function cancelHoverTimers() {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    hoverOpenTimer = 0;
    hoverCloseTimer = 0;
    hoverPending = null;
  }

  function scheduleHoverClose() {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = 0;
      if (hoverBtn || hoverInPop || !hoverPopTool) return;
      closePopovers();
    }, HOVER_CLOSE_MS);
  }

  function bindToolHover(tool, btn) {
    const enter = (e) => {
      if (!canHover(e) || e.buttons !== 0) return;
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = 0;
      hoverBtn = btn;
      hoverInPop = false;
      if (hoverPopTool === tool || hoverPending === btn) return;
      clearTimeout(hoverOpenTimer);
      hoverPending = btn;
      // A preview is already up, so swapping to another tool needs no settling delay.
      hoverOpenTimer = setTimeout(() => {
        hoverPending = null;
        if (hoverBtn !== btn) return;
        openToolPopover(tool, btn);
        hoverPopTool = tool;
      }, hoverPopTool ? 0 : HOVER_OPEN_MS);
    };
    btn.addEventListener('pointerover', enter);
    btn.addEventListener('pointermove', enter);
    btn.addEventListener('pointerout', (e) => {
      if (!canHover(e) || (e.relatedTarget && btn.contains(e.relatedTarget))) return;
      if (hoverBtn === btn) hoverBtn = null;
      if (hoverPending === btn) { clearTimeout(hoverOpenTimer); hoverPending = null; }
      scheduleHoverClose();
    });
    btn.addEventListener('pointercancel', () => {
      hoverBtn = null;
      cancelHoverTimers();
      if (hoverPopTool) closePopovers();
    });
  }

  function bindPopoverHover(pop) {
    const stay = (e) => {
      if (!canHover(e)) return;
      hoverInPop = true;
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = 0;
    };
    pop.addEventListener('pointerover', stay);
    pop.addEventListener('pointermove', stay);
    pop.addEventListener('pointerout', (e) => {
      if (!canHover(e) || (e.relatedTarget && pop.contains(e.relatedTarget))) return;
      hoverInPop = false;
      scheduleHoverClose();
    });
    pop.addEventListener('pointercancel', () => {
      hoverInPop = false;
      cancelHoverTimers();
    });
  }

  /* ---------- tool popovers ---------- */

  function ocrModelList() {
    const list = html(`<div class="model-list"></div>`);
    app.loadOcrModels().then((models) => {
      list.textContent = '';
      for (const m of models) {
        const row = html(`<button class="model-row"${m.available ? '' : ' disabled'}>
          <span class="model-name">${m.label}</span>
          <span class="model-note">${m.available ? (m.note || '') : 'not installed'}</span>
        </button>`);
        row.classList.toggle('sel', m.id === app.settings.ocrModel);
        if (m.available) {
          row.addEventListener('click', () => {
            app.settings.ocrModel = m.id;
            app.saveSettings();
            list.querySelectorAll('.model-row').forEach((x) => x.classList.toggle('sel', x === row));
            showToast(`Textify will use ${m.label}`);
          });
        }
        list.appendChild(row);
      }
    });
    return list;
  }

  function asrModelList() {
    const list = html(`<div class="model-list"></div>`);
    app.loadAsrModels().then((models) => {
      list.textContent = '';
      for (const m of models) {
        const row = html(`<button class="model-row"${m.available ? '' : ' disabled'}>
          <span class="model-name">${m.label}</span>
          <span class="model-note">${m.available ? (m.note || '') : 'not installed'}</span>
        </button>`);
        row.classList.toggle('sel', m.id === app.settings.asrModel);
        if (m.available) {
          row.addEventListener('click', () => {
            app.settings.asrModel = m.id;
            app.saveSettings();
            list.querySelectorAll('.model-row').forEach((x) => x.classList.toggle('sel', x === row));
            showToast(`Voice will use ${m.label}`);
          });
        }
        list.appendChild(row);
      }
    });
    return list;
  }

  function swatchGrid(colors, current, onPick) {
    const grid = html(`<div class="swatches"></div>`);
    for (const c of colors) {
      const s = html(`<button class="swatch" style="background:${c}" title="${c}"></button>`);
      if (c.toLowerCase() === (current || '').toLowerCase()) s.classList.add('sel');
      s.addEventListener('click', () => {
        onPick(c);
        grid.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
        s.classList.add('sel');
      });
      grid.appendChild(s);
    }
    const custom = html(`<label class="swatch custom" title="Custom color"><input type="color" value="${current || '#000000'}"></label>`);
    custom.querySelector('input').addEventListener('input', (e) => onPick(e.target.value));
    grid.appendChild(custom);
    return grid;
  }

  function sizeRow(presets, current, color, onPick) {
    const row = html(`<div class="size-row"></div>`);
    const maxP = presets[presets.length - 1];
    for (const s of presets) {
      const d = Math.max(4, Math.min(22, (s / maxP) * 22 + 3));
      const b = html(`<button class="size-dot" title="${s}px"><i style="width:${d}px;height:${d}px"></i></button>`);
      if (Math.abs(s - current) < 0.01) b.classList.add('sel');
      b.addEventListener('click', () => {
        onPick(s);
        row.querySelectorAll('.size-dot').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      row.appendChild(b);
    }
    return row;
  }

  function openToolPopover(tool, anchor) {
    const t = app.tools[tool];
    const box = html(`<div></div>`);

    if (tool === 'pen' || tool === 'highlighter' || tool === 'text' || tool === 'shape') {
      const colors = tool === 'highlighter' ? HL_COLORS : PEN_COLORS;
      const sec = html(`<div class="pop-section"><div class="pop-label">Color</div></div>`);
      sec.appendChild(swatchGrid(colors, t.color, (c) => { t.color = c; updateToolbar(); }));
      box.appendChild(sec);
    }

    if (tool === 'pen' || tool === 'highlighter') {
      const sec = html(`<div class="pop-section"><div class="pop-label">Thickness</div></div>`);
      sec.appendChild(sizeRow(SIZE_PRESETS[tool], t.size, t.color, (s) => { t.size = s; }));
      const slider = html(`<div class="slider-row"><input type="range" min="1" max="${tool === 'pen' ? 16 : 40}" step="0.5" value="${t.size}"><output>${t.size}</output></div>`);
      const inp = slider.querySelector('input');
      inp.addEventListener('input', () => {
        t.size = parseFloat(inp.value);
        slider.querySelector('output').textContent = t.size;
        sec.querySelectorAll('.size-dot').forEach((x) => x.classList.remove('sel'));
      });
      sec.appendChild(slider);
      box.appendChild(sec);
    }

    if (tool === 'highlighter') {
      const sec = html(`<div class="pop-section"><div class="pop-label">Opacity</div>
        <div class="slider-row"><input type="range" min="0.15" max="0.8" step="0.05" value="${t.opacity}"><output>${Math.round(t.opacity * 100)}%</output></div></div>`);
      const inp = sec.querySelector('input');
      inp.addEventListener('input', () => {
        t.opacity = parseFloat(inp.value);
        sec.querySelector('output').textContent = Math.round(t.opacity * 100) + '%';
      });
      box.appendChild(sec);
    }

    if (tool === 'eraser') {
      const sec1 = html(`<div class="pop-section"><div class="pop-label">Mode</div>
        <div class="seg">
          <button data-m="stroke">Erase stroke</button>
          <button data-m="point">Precise</button>
        </div></div>`);
      sec1.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('sel', t.mode === b.dataset.m);
        b.addEventListener('click', () => {
          t.mode = b.dataset.m;
          sec1.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        });
      });
      const sec2 = html(`<div class="pop-section"><div class="pop-label">Size</div>
        <div class="slider-row"><input type="range" min="4" max="80" step="1" value="${t.size}"><output>${t.size}</output></div></div>`);
      const inp = sec2.querySelector('input');
      inp.addEventListener('input', () => {
        t.size = parseInt(inp.value, 10);
        sec2.querySelector('output').textContent = t.size;
      });
      box.append(sec1, sec2);
    }

    if (tool === 'voice') {
      const sec = html(`<div class="pop-section"><div class="pop-label">Speech model</div>
        <div class="model-list"></div>
        <div class="set-row" style="font-size:12px;color:var(--text-dim);margin-top:8px">Engine: <span id="asr-status">checking…</span></div>
        <div style="font-size:11.5px;color:var(--text-dim);margin-top:4px">Tap a spot on the page and speak. The transcript appears live and becomes an ordinary text item when you press Stop. Runs locally and loads on demand.</div>
      </div>`);
      sec.querySelector('.model-list').replaceWith(asrModelList());
      app.asrHealthy().then((ok) => {
        const el = sec.querySelector('#asr-status');
        if (el) { el.textContent = ok ? 'ready' : 'off (starts on first use)'; el.style.color = ok ? 'var(--accent)' : ''; }
      });
      box.appendChild(sec);
    }

    if (tool === 'textify') {
      const sec = html(`<div class="pop-section"><div class="pop-label">Recognition model</div>
        <div class="model-list"></div>
        <div class="set-row" style="margin-top:8px"><div>Replace ink with text</div>
          <label class="switch"><input type="checkbox"${app.settings.textifyReplace ? ' checked' : ''}><i></i></label></div>
        <div class="set-row" style="font-size:12px;color:var(--text-dim)">Engine: <span id="ocr-status">checking…</span></div>
        <div style="font-size:11.5px;color:var(--text-dim);margin-top:4px">Circle handwriting with the pen, it becomes editable text. Models run locally and load on demand; switching model restarts the engine.</div>
      </div>`);
      sec.querySelector('.switch input').addEventListener('change', (e) => {
        app.settings.textifyReplace = e.target.checked;
        app.saveSettings();
      });

      sec.querySelector('.model-list').replaceWith(ocrModelList());

      app.ocrHealthy().then((ok) => {
        const el = sec.querySelector('#ocr-status');
        if (el) { el.textContent = ok ? 'ready' : 'off (starts on first use)'; el.style.color = ok ? 'var(--accent)' : ''; }
      });
      box.appendChild(sec);
    }

    if (tool === 'text') {
      const sec = html(`<div class="pop-section"><div class="pop-label">Text size</div>
        <div class="slider-row"><input type="range" min="10" max="48" step="1" value="${t.size}"><output>${t.size}</output></div></div>`);
      const inp = sec.querySelector('input');
      inp.addEventListener('input', () => {
        t.size = parseInt(inp.value, 10);
        sec.querySelector('output').textContent = t.size;
      });
      box.appendChild(sec);
    }

    if (tool === 'shape') {
      const secW = html(`<div class="pop-section"><div class="pop-label">Thickness</div>
        <div class="slider-row"><input type="range" min="1" max="12" step="0.5" value="${t.size}"><output>${t.size}</output></div></div>`);
      const inpW = secW.querySelector('input');
      inpW.addEventListener('input', () => {
        t.size = parseFloat(inpW.value);
        secW.querySelector('output').textContent = t.size;
      });
      box.appendChild(secW);
      const sec = html(`<div class="pop-section"><div class="pop-label">Shape</div>
        <div class="seg">
          <button data-k="line">Line</button>
          <button data-k="arrow">Arrow</button>
          <button data-k="rect">Box</button>
          <button data-k="ellipse">Oval</button>
        </div></div>`);
      sec.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('sel', t.kind === b.dataset.k);
        b.addEventListener('click', () => {
          t.kind = b.dataset.k;
          sec.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        });
      });
      box.appendChild(sec);
    }

    openPopover(anchor, box);
  }

  /* ---------- AI actions on a selection ---------- */

  function openAiMenu(anchor) {
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">AI actions</div>
        <div class="model-list" id="ai-list"></div>
      </div>
      <div class="pop-section"><div class="pop-label">Translate into</div>
        <div class="zoom-grid" id="ai-langs"></div>
      </div>
    </div>`);

    const noteFor = (a) => (a.id === 'translate' ? `${a.note} into ${app.settings.aiLanguage}` : a.note);
    const list = box.querySelector('#ai-list');
    for (const a of app.aiActions) {
      const row = html(`<button class="model-row">
        <span class="model-name">${a.label}</span>
        <span class="model-note">${escapeHtml(noteFor(a))}</span>
      </button>`);
      row.addEventListener('click', () => { closePopovers(); app.aiAction(a.id); });
      list.appendChild(row);
    }

    const langs = box.querySelector('#ai-langs');
    for (const l of app.aiLanguages) {
      const b = html(`<button>${l}</button>`);
      b.classList.toggle('sel', l === app.settings.aiLanguage);
      b.addEventListener('click', () => {
        app.settings.aiLanguage = l;
        app.saveSettings();
        langs.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        list.querySelectorAll('.model-note').forEach((n, i) => { n.textContent = noteFor(app.aiActions[i]); });
      });
      langs.appendChild(b);
    }

    // Be straight about model fit: GLM-OCR only transcribes, it does not reason.
    const m = app.currentOcrModel();
    if (m.id === 'glm-ocr') {
      box.appendChild(html(`<div class="ai-hint">These actions need reasoning, and ${escapeHtml(m.label)}
        is a transcription-only model. Gemma 4 E4B or Qwen3.5 answer them far better - pick one in the
        Textify tool or in Settings.</div>`));
    }

    openPopover(anchor, box);
  }

  /* ---------- right chip ---------- */

  const zoomLabel = topbar.querySelector('#zoom-label');

  zoomLabel.addEventListener('click', () => {
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">Zoom</div>
        <div class="zoom-grid"></div>
      </div>
      <div class="pop-section"><div class="pop-label">Fit</div>
        <div class="seg" id="zoom-fit">
          <button data-f="width">Fit width</button>
          <button data-f="page">Fit page</button>
        </div>
      </div>
    </div>`);
    const grid = box.querySelector('.zoom-grid');
    for (const z of ZOOM_PRESETS) {
      const b = html(`<button data-z="${z}">${Math.round(z * 100)}%</button>`);
      b.addEventListener('click', () => app.setZoom(z));
      grid.appendChild(b);
    }
    const fitW = box.querySelector('[data-f="width"]');
    const fitP = box.querySelector('[data-f="page"]');
    fitW.addEventListener('click', () => app.fitWidth());
    fitP.addEventListener('click', () => app.fitPage());
    const near = (a, b) => Math.abs(a - b) < 0.005;
    const mark = () => {
      const z = app.view.zoom;
      grid.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', near(z, parseFloat(b.dataset.z))));
      fitW.classList.toggle('sel', near(z, app.fitWidthZoom()));
      fitP.classList.toggle('sel', near(z, app.fitPageZoom()));
    };
    mark();
    openPopover(zoomLabel, box);
    syncZoomPop = mark;
  });

  function updateZoom() {
    zoomLabel.textContent = Math.round(app.view.zoom * 100) + '%';
    syncZoomPop?.();
  }

  topbar.querySelector('#btn-addpage').addEventListener('click', () => app.addPage());

  const themeBtn = topbar.querySelector('#btn-theme');
  function themeIcon() {
    const cur = document.documentElement.dataset.theme;
    themeBtn.innerHTML = cur === 'dark' ? ICONS.sun : ICONS.moon;
  }
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    app.settings.theme = cur === 'dark' ? 'light' : 'dark';
    app.applyTheme();
    themeIcon();
    app.saveSettings?.();
  });

  /* ---------- settings panel ---------- */

  const ACCENTS = ['#4f6ef7', '#7c3aed', '#0ea5a5', '#e0342b', '#f0731d', '#159a51', '#ec4899', '#64748b'];

  const settingsEl = html(`<div id="settings" class="glass hidden">
    <div class="set-head"><h2>Settings</h2>
      <button class="icon-btn small" id="set-close">${ICONS.close}</button>
    </div>
    <div class="set-body"></div>
  </div>`);
  uiRoot.appendChild(settingsEl);
  const setBody = settingsEl.querySelector('.set-body');

  const toggleSettings = () => {
    settingsEl.classList.toggle('hidden');
    if (!settingsEl.classList.contains('hidden')) buildSettings();
  };
  topbar.querySelector('#btn-settings').addEventListener('click', toggleSettings);
  settingsEl.querySelector('#set-close').addEventListener('click', toggleSettings);

  function toggleRow(label, hint, value, onChange) {
    const row = html(`<div class="set-row"><div>${label}${hint ? `<div class="hint">${hint}</div>` : ''}</div>
      <label class="switch"><input type="checkbox"${value ? ' checked' : ''}><i></i></label></div>`);
    row.querySelector('input').addEventListener('change', (e) => onChange(e.target.checked));
    return row;
  }

  function sliderRow(label, min, max, step, value, fmt, onChange) {
    const row = html(`<div class="set-row"><div>${label}</div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">
      <output>${fmt(value)}</output></div>`);
    const inp = row.querySelector('input');
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      row.querySelector('output').textContent = fmt(v);
      onChange(v);
    });
    return row;
  }

  /** A labelled row of mutually exclusive buttons, for settings that are a choice of three. */
  function choiceRow(label, hint, options, value, onPick) {
    const row = html(`<div class="set-choice"><div class="set-choice-label">${label}${hint ? `<div class="hint">${hint}</div>` : ''}</div>
      <div class="seg"></div></div>`);
    const seg = row.querySelector('.seg');
    for (const o of options) {
      const b = html(`<button title="${escapeHtml(o.hint || '')}">${escapeHtml(o.label)}</button>`);
      b.classList.toggle('sel', o.id === value);
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
        onPick(o.id);
      });
      seg.appendChild(b);
    }
    return row;
  }

  const inkChanged = () => { app.saveSettings(); app.invalidateAllPaths(); };

  /* ---------- OneNote import ---------- */

  /**
   * The earlier import had no collections to write to, so it composed notebook names as
   * `Notebook / Section`. This rebuilds the real hierarchy from those names. It is offered
   * rather than run automatically, and it is safe to press twice: a notebook is only touched
   * while it is still ungrouped and its name still carries a ' / '.
   */
  function rebuildCollectionsRow() {
    const wrap = html(`<div style="margin-top:14px"></div>`);
    const btn = html(`<button class="pill-btn" style="width:100%">${ICONS.folderPlus}<span>Rebuild collections from imported names</span></button>`);
    const note = html(`<div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-top:8px;white-space:pre-line">Splits notebooks named "Notebook / Section" into a collection and a notebook. Nothing is deleted and no page is changed.</div>`);
    wrap.appendChild(btn);
    wrap.appendChild(note);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      note.textContent = 'Rebuilding...';
      try {
        const r = await app.migrateOneNoteCollections({
          onProgress: (p) => {
            note.textContent = p.done < p.total
              ? `Rebuilding: ${p.done} of ${p.total}${p.name ? '\n' + p.name : ''}`
              : 'Finishing...';
          },
        });
        note.textContent = r.moved.length
          ? `Done in ${(r.ms / 1000).toFixed(1)}s. ${r.moved.length} notebook${r.moved.length === 1 ? '' : 's'} moved into `
            + `${r.created.length} new collection${r.created.length === 1 ? '' : 's'}${r.created.length ? ': ' + r.created.join(', ') : ''}.`
          : `Nothing to do: no ungrouped notebook is still named "Notebook / Section". (${r.scanned} checked in ${r.ms} ms.)`;
        refreshSidebar();
      } catch (err) {
        note.textContent = 'Rebuild failed - see console.';
        console.error('FlatNotes: collection rebuild failed', err);
      } finally {
        btn.disabled = false;
      }
    });
    return wrap;
  }

  // Two steps on purpose: the first click only looks, so the user sees how much is about to
  // come across before anything is written. The import itself only ever adds notebooks.
  function oneNoteGroup() {
    const g = html(`<div class="set-group"><div class="pop-label">Import</div>
      <div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-bottom:8px">Copies your OneNote notebooks in as new FlatNotes notebooks, one per OneNote section, with the handwriting kept as real ink. Nothing already here is changed.</div></div>`);
    const btn = html(`<button class="pill-btn" style="width:100%">${ICONS.book}<span>Import from OneNote</span></button>`);
    const status = html(`<div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-top:8px;white-space:pre-line"></div>`);
    g.appendChild(btn);
    g.appendChild(status);
    g.appendChild(rebuildCollectionsRow());

    if (!window.flatnotes?.onenoteList) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      status.textContent = 'Available in the desktop app only.';
      return g;
    }

    let plan = null;   // the section list, once we have looked
    let busy = false;

    const setLabel = (t) => { btn.querySelector('span').textContent = t; };

    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;

      try {
        if (!plan) {
          status.textContent = 'Looking for OneNote...';
          const avail = await app.oneNoteAvailable();
          if (!avail?.ok) {
            status.textContent = 'The OneNote helper is not built yet.\nRun onenote\\setup-onenote.ps1 once, then try again.';
            return;
          }
          const list = await app.oneNoteList();
          if (!list?.ok) {
            status.textContent = 'OneNote did not answer: ' + (list?.detail || list?.error || 'unknown error');
            return;
          }
          plan = list.sections || [];
          const pages = plan.reduce((a, s) => a + (s.pageCount || 0), 0);
          const books = new Set(plan.map((s) => s.notebook)).size;
          status.textContent = `Found ${books} notebook${books === 1 ? '' : 's'}, ${plan.length} sections, ${pages} pages.\nEach section becomes one new FlatNotes notebook. This can take a few minutes.`;
          setLabel('Start import');
          return;
        }

        setLabel('Importing...');
        const t0 = Date.now();
        const res = await app.importOneNote({
          onProgress: (p) => {
            if (p.phase === 'export') status.textContent = `Reading OneNote: page ${p.done} of ${p.total}`;
            else if (p.phase === 'section') status.textContent = `Reading OneNote: section ${p.index} of ${p.total} done`;
            else if (p.phase === 'save') status.textContent = `Creating notebooks: ${p.done} of ${p.total}${p.name ? '\n' + p.name : ''}`;
            else if (p.phase === 'warn') status.textContent = 'Warning: ' + p.message;
          },
        });

        if (!res?.ok) {
          const why = res?.error === 'not-installed'
            ? 'the helper is not built, run onenote\\setup-onenote.ps1'
            : (res?.detail || res?.error || 'unknown error');
          status.textContent = 'Import failed: ' + why;
          setLabel('Import from OneNote');
          plan = null;
          return;
        }

        const s = res.stats || {};
        const secs = Math.round((Date.now() - t0) / 1000);
        const skipped = [];
        if (s.skippedTables) skipped.push(`${s.skippedTables} tables`);
        if (s.skippedImages) skipped.push(`${s.skippedImages} images in a format the app cannot draw`);
        if (s.skippedFiles) skipped.push(`${s.skippedFiles} attachments`);
        if (s.skippedTags) skipped.push(`${s.skippedTags} tags`);
        if (s.skippedPrintouts) skipped.push(`${s.skippedPrintouts} printouts`);
        if (s.pageFailures) skipped.push(`${s.pageFailures} pages OneNote would not hand over`);
        const lost = res.failed || [];
        status.textContent =
          `Imported ${res.created.length} notebooks, ${s.flatPages ?? '?'} pages from ${s.onenotePages ?? '?'} OneNote pages `
          + `in ${secs}s.\n${s.strokes ?? 0} ink strokes, ${s.images ?? 0} pictures, ${s.texts ?? 0} text blocks.`
          + (skipped.length ? `\nNot brought across: ${skipped.join(', ')}.` : '')
          + (lost.length ? `\n${lost.length} section${lost.length === 1 ? '' : 's'} could not be created: `
              + lost.map((f) => (f.name || f.file) + ' (' + f.why + ')').join(', ')
              + '. The exported copy has been kept so you can import again.' : '')
          + '\nOpen them from the notebooks sidebar.';
        setLabel('Import again');
        plan = null;
        refreshSidebar();
      } finally {
        busy = false;
        btn.disabled = false;
      }
    });

    return g;
  }

  function buildSettings() {
    const s = app.settings;
    setBody.innerHTML = '';

    // Appearance
    const gApp = html(`<div class="set-group"><div class="pop-label">Appearance</div></div>`);
    const themeSeg = html(`<div class="seg" style="margin-bottom:10px">
      <button data-t="system">System</button><button data-t="light">Light</button><button data-t="dark">Dark</button></div>`);
    themeSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('sel', s.theme === b.dataset.t);
      b.addEventListener('click', () => {
        s.theme = b.dataset.t;
        app.applyTheme(); themeIcon(); app.saveSettings();
        themeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
      });
    });
    gApp.appendChild(themeSeg);
    const accents = html(`<div class="set-row"><div>Accent</div><div class="accent-dots"></div></div>`);
    const dots = accents.querySelector('.accent-dots');
    for (const c of ACCENTS) {
      const d = html(`<button class="swatch" style="background:${c}"></button>`);
      if (c === s.accent) d.classList.add('sel');
      d.addEventListener('click', () => {
        s.accent = c;
        app.applyTheme(); app.saveSettings();
        dots.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x === d));
      });
      dots.appendChild(d);
    }
    gApp.appendChild(accents);
    setBody.appendChild(gApp);

    // Pen & ink
    const gPen = html(`<div class="set-group"><div class="pop-label">Pen &amp; ink</div></div>`);
    gPen.appendChild(toggleRow('Pressure sensitivity', 'Stroke width follows pen pressure', s.pressure, (v) => { s.pressure = v; inkChanged(); }));
    gPen.appendChild(sliderRow('Pressure response', 0.6, 2.4, 0.05, s.gamma, (v) => (v < 1 ? 'soft' : v > 1.7 ? 'firm' : 'mid'), (v) => { s.gamma = v; inkChanged(); }));
    gPen.appendChild(sliderRow('Minimum width', 0.1, 0.7, 0.02, s.minWidth, (v) => Math.round(v * 100) + '%', (v) => { s.minWidth = v; inkChanged(); }));
    gPen.appendChild(sliderRow('Smoothing', 0, 1, 0.05, s.smoothing, (v) => Math.round(v * 100) + '%', (v) => { s.smoothing = v; inkChanged(); }));
    setBody.appendChild(gPen);

    // Input
    const gIn = html(`<div class="set-group"><div class="pop-label">Input</div></div>`);
    gIn.appendChild(toggleRow('Pen eraser', 'Back of pen / barrel button erases', s.penEraser, (v) => { s.penEraser = v; app.saveSettings(); }));
    gIn.appendChild(toggleRow('Draw with touch', 'Off = fingers pan &amp; zoom only (palm rejection)', s.touchDraw, (v) => { s.touchDraw = v; app.saveSettings(); }));
    setBody.appendChild(gIn);

    // Pages
    const gPv = html(`<div class="set-group"><div class="pop-label">Pages</div></div>`);
    gPv.appendChild(choiceRow('Page view', 'How the pages of a notebook are laid out', [
      { id: 'continuous', label: 'Continuous', hint: 'One page after another, scroll straight through' },
      { id: 'single', label: 'One page', hint: 'Only the page you are on, nothing above or below' },
    ], s.pageView, (v) => app.setPageView(v)));
    gPv.appendChild(choiceRow('Page list', 'How the pages appear in the sidebar',
      PAGE_LISTS.map((v) => ({ id: v.id, label: v.id === 'big' ? 'Big' : v.id === 'small' ? 'Small' : 'List', hint: v.hint })),
      s.pageList, (v) => app.setPageList(v)));
    setBody.appendChild(gPv);

    // Toolbar
    const gTb = html(`<div class="set-group"><div class="pop-label">Toolbar</div>
      <div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-bottom:4px">Choose which tools appear in the toolbar</div></div>`);
    const names = { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', lasso: 'Lasso', text: 'Text', shape: 'Shapes', textify: 'Textify (OCR)', voice: 'Voice (speech to text)' };
    for (const id of app.availableTools) {
      const shown = !s.toolbarTools || s.toolbarTools.includes(id);
      gTb.appendChild(toggleRow(names[id], '', shown, (v) => {
        let list = s.toolbarTools ? s.toolbarTools.slice() : app.availableTools.slice();
        if (v) { if (!list.includes(id)) list.push(id); }
        else {
          if (list.length <= 1) { showToast('Keep at least one tool'); buildSettings(); return; }
          list = list.filter((x) => x !== id);
          if (app.tool === id) app.setTool(list[0]);
        }
        s.toolbarTools = list;
        app.saveSettings();
        buildToolbar();
      }));
    }
    setBody.appendChild(gTb);

    // Textify
    const gOcr = html(`<div class="set-group"><div class="pop-label">Textify / recognition model</div>
      <div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-bottom:8px">Models run locally and load on demand; switching model restarts the engine. The AI actions in the selection bar use the same model, and GLM-OCR only transcribes, so pick a general vision model for those.</div></div>`);
    gOcr.appendChild(ocrModelList());
    gOcr.appendChild(toggleRow('Replace ink with text', 'Circled handwriting is swapped for the recognized text', s.textifyReplace, (v) => {
      s.textifyReplace = v;
      app.saveSettings();
    }));
    setBody.appendChild(gOcr);

    // Voice
    const gAsr = html(`<div class="set-group"><div class="pop-label">Voice / speech model</div>
      <div class="hint" style="font-size:11.5px;color:var(--text-dim);margin-bottom:8px">Speech recognition runs locally and loads on demand. Install the engine and weights once with asr\\setup-asr.ps1.</div></div>`);
    gAsr.appendChild(asrModelList());
    setBody.appendChild(gAsr);

    // Import
    setBody.appendChild(oneNoteGroup());

    // Page
    const gPg = html(`<div class="set-group"><div class="pop-label">Export</div></div>`);
    const expBtn = (icon, label, fn) => {
      const gap = gPg.children.length > 1 ? ';margin-top:6px' : ''; // only between buttons
      const b = html(`<button class="pill-btn" style="width:100%${gap}">${icon}<span>${label}</span></button>`);
      b.addEventListener('click', fn);
      gPg.appendChild(b);
    };
    expBtn(ICONS.page, 'Current page as PNG', () => app.exportPagePNG());
    expBtn(ICONS.page, 'Current page as PDF', () => app.exportPDF('page'));
    expBtn(ICONS.book, 'Whole notebook as PDF', () => app.exportPDF('notebook'));
    setBody.appendChild(gPg);

    // About
    setBody.appendChild(html(`<div class="set-group"><div class="pop-label">About</div>
      <div class="set-row" style="color:var(--text-dim);font-size:12.5px">FlatNotes - smooth pen notes.<br>P/H/E/L/T/S switch tools · Ctrl+Z undo · Ctrl+D duplicate · Space+drag pan · Ctrl+scroll zoom</div></div>`));
  }

  /* ---------- page style popover ---------- */

  topbar.querySelector('#btn-pagestyle').addEventListener('click', (e) => {
    if (activePopover) { closePopovers(); return; }
    const page = app.currentPage();
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">Template</div>
        <div class="seg" id="ps-template">
          <button data-t="blank">Blank</button>
          <button data-t="lines">Lines</button>
          <button data-t="grid">Grid</button>
          <button data-t="dots">Dots</button>
        </div>
      </div>
      <div class="pop-section"><div class="pop-label">Paper</div>
        <div class="swatches" id="ps-paper"></div>
      </div>
    </div>`);
    box.querySelectorAll('#ps-template button').forEach((b) => {
      b.classList.toggle('sel', page.template === b.dataset.t);
      b.addEventListener('click', () => {
        app.setPageStyle({ template: b.dataset.t });
        box.querySelectorAll('#ps-template button').forEach((x) => x.classList.toggle('sel', x === b));
      });
    });
    const pp = box.querySelector('#ps-paper');
    for (const [id, color] of Object.entries(app.PAPERS)) {
      const s = html(`<button class="swatch" style="background:${color}" title="${id}"></button>`);
      if (id === 'black') s.classList.add('paper-black');
      if (page.paper === id) s.classList.add('sel');
      s.addEventListener('click', () => {
        app.setPageStyle({ paper: id });
        pp.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
        s.classList.add('sel');
      });
      pp.appendChild(s);
    }
    openPopover(e.currentTarget, box);
  });

  /* ---------- document title (rename inline) ---------- */

  const titleEl = topbar.querySelector('#doc-title');
  titleEl.contentEditable = 'plaintext-only';
  titleEl.spellcheck = false;
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => app.renameDoc(titleEl.textContent));

  // Suggesting a title is offered, never automatic: the button reads page 1 and the
  // notebook is only renamed if the suggestion is accepted. Renaming stays reversible
  // by editing the title in place, exactly as before.
  const suggestBtn = topbar.querySelector('#btn-suggest');
  const UNTITLED = ['', 'my notes', 'new notebook', 'untitled'];

  function setTitle(name) {
    titleEl.textContent = name;
    suggestBtn.classList.toggle('offer', UNTITLED.includes((name || '').trim().toLowerCase()));
  }

  suggestBtn.addEventListener('click', async () => {
    suggestBtn.disabled = true;
    try {
      const name = await app.suggestDocTitle();
      if (name) openTitleSuggestion(suggestBtn, name);
    } finally {
      suggestBtn.disabled = false;
    }
  });

  function openTitleSuggestion(anchor, name) {
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">Suggested title</div>
        <div class="title-suggest">${escapeHtml(name)}</div>
        <div class="seg" style="margin-top:10px">
          <button id="ts-use">Use this title</button>
          <button id="ts-keep">Keep current</button>
        </div>
        <div class="ai-hint" style="margin-top:10px">Read from page 1. Nothing is renamed unless you
          accept, and you can always type over the title afterwards.</div>
      </div>
    </div>`);
    box.querySelector('#ts-use').addEventListener('click', () => {
      app.renameDoc(name);
      closePopovers();
      showToast('Notebook renamed - edit the title to change it');
    });
    box.querySelector('#ts-keep').addEventListener('click', () => closePopovers());
    openPopover(anchor, box);
  }

  /* ---------- sidebar ---------- */

  const sidebar = html(`<div id="sidebar" class="glass hidden">
    <div class="sb-head"><h2>Notebooks</h2>
      <div class="sb-head-btns">
        <button class="icon-btn small" id="sb-newcol" title="New collection">${ICONS.folderPlus}</button>
        <button class="icon-btn small" id="sb-close">${ICONS.close}</button>
      </div>
    </div>
    <div class="sb-list nb" id="sb-notebooks"></div>
    <div class="sb-head"><h2>Pages</h2>
      <div class="sb-head-btns">
        <div class="pg-views" id="sb-pgviews">
          ${PAGE_LISTS.map((v) => `<button class="icon-btn tiny" data-v="${v.id}" title="${v.label} - ${v.hint}">${ICONS[v.icon]}</button>`).join('')}
        </div>
        <button class="icon-btn small" id="sb-addpage" title="Add page">${ICONS.plus}</button>
      </div>
    </div>
    <div class="sb-list" id="sb-pagewrap"><div class="sb-pages" id="sb-pages"></div></div>
    <div class="sb-foot">
      <button class="pill-btn" id="sb-new">${ICONS.plus}<span>New notebook</span></button>
    </div>
  </div>`);
  uiRoot.appendChild(sidebar);

  const sbToggle = () => {
    sidebar.classList.toggle('hidden');
    if (!sidebar.classList.contains('hidden')) refreshSidebar();
  };
  topbar.querySelector('#btn-menu').addEventListener('click', sbToggle);
  sidebar.querySelector('#sb-close').addEventListener('click', sbToggle);
  sidebar.querySelector('#sb-new').addEventListener('click', () => app.createDoc());
  sidebar.querySelector('#sb-addpage').addEventListener('click', () => app.addPage());

  const NB_DOTS = ['#4f6ef7', '#e0342b', '#159a51', '#f0731d', '#9333ea', '#0d9488', '#ec4899'];
  const nbDot = (id) => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NB_DOTS[h % NB_DOTS.length];
  };

  const nbBox = sidebar.querySelector('#sb-notebooks');
  // the list is rebuilt on every refresh, so the scroll position has to be remembered for it
  nbBox.addEventListener('scroll', () => app.setSidebarScroll(nbBox.scrollTop), { passive: true });

  function nbItem(d) {
    const item = html(`<button class="nb-item${d.id === app.doc.id ? ' sel' : ''}">
      <i class="nb-dot" style="background:${nbDot(d.id)}"></i>
      <span>${escapeHtml(d.name)}</span>
      <small>${d.pageCount || 1}</small>
      <span class="nb-move" title="Move to a collection">${ICONS.folder}</span>
      <span class="nb-del" title="Delete notebook">${ICONS.trash}</span>
    </button>`);
    item.addEventListener('click', (e) => {
      if (e.target.closest('.nb-del') || e.target.closest('.nb-move')) return;
      app.switchDoc(d.id);
    });
    const move = item.querySelector('.nb-move');
    move.addEventListener('click', () => openMovePop(move, d));
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); openMovePop(item, d); });
    const del = item.querySelector('.nb-del');
    del.addEventListener('click', () => {
      if (del.classList.contains('confirm')) {
        app.removeDoc(d.id);
      } else {
        del.classList.add('confirm');
        showToast('Tap the bin again to delete notebook');
        setTimeout(() => del.classList.remove('confirm'), 2500);
      }
    });
    return item;
  }

  /**
   * collection -> notebook -> pages, drawn entirely from the meta records: no document body
   * is ever read to build this list. Exactly one collection is expanded at a time, and a
   * notebook whose collection no longer exists is shown at the top level rather than being
   * lost inside a group that is not there any more.
   */
  async function refreshSidebar() {
    if (sidebar.classList.contains('hidden')) return;
    const docs = await app.listDocs();
    nbBox.innerHTML = '';
    // a brand new notebook has not been saved yet, so it is not in the meta list
    const shown = docs.some((d) => d.id === app.doc.id) ? docs
      : [{ id: app.doc.id, name: app.doc.name, pageCount: app.doc.pages.length, collection: app.doc.collection }, ...docs];

    const cols = app.listCollections();
    const live = new Set(cols.map((c) => c.id));
    const openId = app.openCollection();
    const groups = new Map(cols.map((c) => [c.id, []]));
    const loose = [];
    for (const d of shown) {
      if (d.collection && live.has(d.collection)) groups.get(d.collection).push(d);
      else loose.push(d);
    }

    for (const c of cols) {
      const kids = groups.get(c.id);
      const isOpen = c.id === openId;
      const row = html(`<div class="col-row${isOpen ? ' open' : ''}">
        <button class="col-item">
          <i class="col-chev">${ICONS.chevron}</i>
          <span>${escapeHtml(c.name)}</span>
          <small>${kids.length}</small>
          <span class="nb-del col-del" title="Delete collection">${ICONS.trash}</span>
        </button>
      </div>`);
      const head = row.querySelector('.col-item');
      head.addEventListener('click', (e) => {
        if (e.target.closest('.col-del')) return;
        app.setOpenCollection(isOpen ? '' : c.id);
        refreshSidebar();
      });
      head.addEventListener('contextmenu', (e) => { e.preventDefault(); openCollectionPop(head, c); });
      const del = row.querySelector('.col-del');
      del.addEventListener('click', () => {
        if (del.classList.contains('confirm')) {
          // every member is rewritten to drop the collection, which on a big group is a
          // second or two, so say what is happening before the wait rather than after
          showToast('Ungrouping the notebooks...', 8000);
          app.deleteCollection(c.id).then((n) => showToast(`Collection deleted - ${n} notebook${n === 1 ? '' : 's'} kept`));
        } else {
          del.classList.add('confirm');
          showToast('Tap the bin again to delete the collection - the notebooks in it are kept');
          setTimeout(() => del.classList.remove('confirm'), 2500);
        }
      });
      if (isOpen) {
        const kidBox = html(`<div class="col-kids"></div>`);
        if (!kids.length) kidBox.appendChild(html(`<div class="col-empty">No notebooks yet</div>`));
        for (const d of kids) kidBox.appendChild(nbItem(d));
        row.appendChild(kidBox);
      }
      nbBox.appendChild(row);
    }

    for (const d of loose) nbBox.appendChild(nbItem(d));
    nbBox.scrollTop = app.sidebarScroll();
    renderPageThumbs();
  }

  sidebar.querySelector('#sb-newcol').addEventListener('click', (e) => openNewCollectionPop(e.currentTarget));

  // both this and the Settings row go through app.setPageList, so they cannot disagree
  sidebar.querySelectorAll('#sb-pgviews button').forEach((b) => {
    b.addEventListener('click', () => app.setPageList(b.dataset.v));
  });

  function openNewCollectionPop(anchor) {
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">New collection</div>
        <input class="pop-input" id="nc-name" type="text" placeholder="Collection name" maxlength="60">
        <div class="seg" style="margin-top:10px"><button id="nc-make">Create</button></div>
        <div class="ai-hint" style="margin-top:10px">A collection groups notebooks in this list. It holds no pages of its own.</div>
      </div>
    </div>`);
    const input = box.querySelector('#nc-name');
    const make = async () => {
      const name = input.value.trim();
      if (!name) return;
      closePopovers();
      const c = await app.createCollection(name);
      app.setOpenCollection(c.id);
      refreshSidebar();
      showToast('Collection created - move notebooks into it with the folder button');
    };
    box.querySelector('#nc-make').addEventListener('click', make);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
    openPopover(anchor, box);
    setTimeout(() => input.focus(), 30);
  }

  function openCollectionPop(anchor, c) {
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">Collection</div>
        <input class="pop-input" id="cl-name" type="text" value="${escapeHtml(c.name)}" maxlength="60">
        <div class="seg" style="margin-top:10px">
          <button id="cl-save">Rename</button>
          <button id="cl-del" style="color:var(--danger)">Delete</button>
        </div>
        <div class="ai-hint" style="margin-top:10px">Deleting a collection keeps every notebook in it. They move back to the top of this list.</div>
      </div>
    </div>`);
    const input = box.querySelector('#cl-name');
    const save = async () => {
      const name = input.value.trim();
      if (!name) return;
      closePopovers();
      await app.renameCollection(c.id, name);
      refreshSidebar();
    };
    box.querySelector('#cl-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    box.querySelector('#cl-del').addEventListener('click', async () => {
      closePopovers();
      showToast('Ungrouping the notebooks...', 8000);
      const n = await app.deleteCollection(c.id);
      showToast(`Collection deleted - ${n} notebook${n === 1 ? '' : 's'} kept`);
    });
    openPopover(anchor, box);
  }

  function openMovePop(anchor, d) {
    const cols = app.listCollections();
    const cur = cols.some((c) => c.id === d.collection) ? d.collection : '';
    const box = html(`<div>
      <div class="pop-section"><div class="pop-label">Move notebook</div>
        <div class="seg" style="flex-direction:column" id="mv-list"></div>
        <div class="ai-hint" style="margin-top:10px">Only where the notebook sits in this list changes. Its pages are untouched.</div>
      </div>
    </div>`);
    const list = box.querySelector('#mv-list');
    const add = (id, label) => {
      const b = html(`<button class="${id === cur ? 'sel' : ''}">${escapeHtml(label)}</button>`);
      b.addEventListener('click', async () => {
        closePopovers();
        await app.setDocCollection(d.id, id || null);
      });
      list.appendChild(b);
    };
    add('', 'No collection');
    for (const c of cols) add(c.id, c.name);
    if (!cols.length) {
      box.querySelector('.ai-hint').textContent = 'There are no collections yet. Make one with the folder button at the top of the sidebar.';
    }
    openPopover(anchor, box);
  }

  function renderPageThumbs() {
    const grid = sidebar.querySelector('#sb-pages');
    const mode = PAGE_LISTS.some((v) => v.id === app.settings.pageList) ? app.settings.pageList : 'big';
    grid.className = 'sb-pages ' + mode;
    grid.innerHTML = '';
    sidebar.querySelectorAll('#sb-pgviews button').forEach((b) => b.classList.toggle('active', b.dataset.v === mode));
    const cur = app.currentPageIndex();
    app.doc.pages.forEach((p, i) => {
      const name = app.pageLabel(i);
      // pages grow as you write, so a thumbnail is the top sheet; say how many there are
      const sheets = app.pageSheets(i);
      // every style is still a .pg-item in page order: the indicator picks the selected one
      // out by position, and the rename menu is wired the same way whichever style is on
      const t = mode === 'list'
        ? html(`<div class="pg-item${i === cur ? ' sel' : ''}" title="${escapeHtml(name)}">
            <span class="pg-idx">${i + 1}</span>
            <span class="pg-name">${escapeHtml(name)}</span>
            ${sheets > 1 ? `<span class="pg-tall">${sheets}×</span>` : ''}
          </div>`)
        : html(`<div class="pg-item${i === cur ? ' sel' : ''}" title="${escapeHtml(name)}">
            <div class="pg-thumb">
              ${p.thumb ? `<img src="${p.thumb}" alt="">` : ''}
              <span class="pg-num">${i + 1}</span>
              ${sheets > 1 ? `<span class="pg-tall">${sheets}×</span>` : ''}
            </div>
            <div class="pg-name">${escapeHtml(name)}</div>
          </div>`);
      if (!p.thumb && mode !== 'list') t.querySelector('.pg-thumb').style.background = '#fff';
      t.addEventListener('click', () => { app.goToPage(i); renderPageThumbs(); });
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const box = html(`<div>
          <div class="pop-section"><div class="pop-label">${escapeHtml(name)}</div>
            <input class="pop-input" id="pm-name" type="text" value="${escapeHtml(p.title || '')}"
                   placeholder="Page ${i + 1}" maxlength="80">
            <div class="ai-hint">Enter to rename, empty to go back to numbering.</div>
            <div class="seg" style="flex-direction:column">
              <button id="pm-dup">Duplicate page</button>
              <button id="pm-del" style="color:var(--danger)">Delete page</button>
            </div>
          </div>
        </div>`);
        const input = box.querySelector('#pm-name');
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { app.renamePage(i, input.value); closePopovers(); }
          ev.stopPropagation();
        });
        box.querySelector('#pm-dup').addEventListener('click', () => { app.duplicatePage(i); closePopovers(); });
        box.querySelector('#pm-del').addEventListener('click', () => { app.deletePage(i); closePopovers(); });
        openPopover(t, box);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      });
      grid.appendChild(t);
    });
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- toast & page indicator ---------- */

  let toastTimer = 0;
  function showToast(msg, ms = 1800) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  let pageIndTimer = 0;
  let lastCur = -1;
  function updatePageIndicator() {
    const cur = app.currentPageIndex();
    const name = app.pageLabel(cur);
    const counter = `${cur + 1} / ${app.pageCount()}`;
    const txt = name === `Page ${cur + 1}` ? counter : `${name}  ·  ${counter}`;
    if (pageInd.textContent !== txt) pageInd.textContent = txt;
    pageInd.classList.add('show');
    clearTimeout(pageIndTimer);
    pageIndTimer = setTimeout(() => pageInd.classList.remove('show'), 1400);
    if (cur !== lastCur && !sidebar.classList.contains('hidden')) {
      sidebar.querySelectorAll('.pg-item').forEach((t, i) => t.classList.toggle('sel', i === cur));
    }
    lastCur = cur;
  }

  buildToolbar();
  themeIcon();
  updateZoom();

  return {
    updateToolbar,
    updateUndo,
    updateZoom,
    updatePageIndicator,
    closePopovers,
    toast: showToast,
    rebuildToolbar: buildToolbar,
    setTitle,
    refreshSidebar,
    showSelbar,
    setDropActive,
  };
}
