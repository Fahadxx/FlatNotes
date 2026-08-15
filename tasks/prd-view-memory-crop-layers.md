# PRD: View memory, image crop/rotate, and layer ordering

## Introduction

Three independent gaps in FlatNotes, all of them about the app forgetting or refusing to do
something the user already expects of a notes app.

1. **The app forgets where you were.** Close FlatNotes while zoomed into the middle of page 4
   and it reopens at the top of page 1 at fit-width. The notebook is remembered (`lastDoc`
   already round-trips through IndexedDB); the camera is not.
2. **A placed image cannot be cropped or turned.** Once an image is on the page the only thing
   you can do to it is move it and scale it. There is no way to trim the edges off a screenshot
   or to fix a picture that came in sideways.
3. **There is no z-order control.** `page.items` is paint order and the only way an item ever
   enters it is `push`, so everything lands on top of everything drawn before it, for ever. An
   image pasted over a diagram permanently hides the diagram.

## Goals

- Reopening the app lands the camera exactly where it was left: same notebook, same page, same
  scroll offset within that page, same zoom.
- The camera is remembered per notebook, so switching back to a notebook returns to where that
  notebook was left rather than to its top.
- A selected image can be cropped from its four edges and rotated in 90 degree steps, both
  non-destructively: the original bytes are never re-encoded and any crop can be dragged back
  out to the full picture.
- While an image is selected the cropped-away part is visible as a faint ghost, so the user can
  see what they are dragging back into view.
- Any item of any type can be moved forward, backward, to the front, or to the back of its page.
- Every one of these is undoable and survives a save/reload.

## User Stories

### US-001: Remember the camera per notebook
**Description:** As someone who closes the app mid-thought, I want it to reopen exactly where I
was, so I do not have to find my place again.

**Acceptance Criteria:**
- [ ] A camera anchor is written to IndexedDB KV under the key `views`, as an object keyed by
      document id: `{ [docId]: { page, oy, x, zoom } }` where `page` is the page index the
      viewport centre is on, `oy` is `app.view.y` minus that page's top (world units), `x` is
      `app.view.x`, and `zoom` is `app.view.zoom`.
- [ ] The anchor is page-relative, not an absolute world `y`. Page heights are content-derived
      and re-settled on every load, so an absolute `y` is not a stable address.
- [ ] Writes are debounced (about 400 ms) exactly like the `sbScrollTimer` idiom at main.js:3488.
      Panning must not issue one IndexedDB write per frame.
- [ ] The anchor is also flushed on `beforeunload` and immediately before `setDoc` swaps to a
      different notebook, so closing the window or switching notebooks does not lose the last
      few hundred milliseconds of movement.
- [ ] `boot()` restores the anchor for the document it loads, applied **after** `setDoc()`, which
      unconditionally clobbers the camera via `fitWidth()` and then overwrites `app.view.y`.
- [ ] `switchDoc()` restores the target notebook's anchor the same way.
- [ ] Restore is defensive: a `page` index past the end of the notebook clamps to the last page,
      a missing or malformed anchor falls back to today's behaviour with no error, `zoom` is
      clamped to the existing 0.2 to 6 range, and `clampView()` runs afterwards.
- [ ] The anchor for a deleted notebook is dropped from the `views` map rather than accumulating
      for ever.
- [ ] Verified in the **installed Windows app**: zoom into a spot, close FlatNotes, reopen, land
      on the same spot. A browser reload alone does not prove this story.

### US-002: Non-destructive crop and 90 degree rotation on the image model
**Description:** As a user, I want an image to carry a crop window and a rotation so that trimming
or turning it never touches the original picture and can always be undone.

**Acceptance Criteria:**
- [ ] An image item gains two optional fields: `rot` (0 | 90 | 180 | 270, default 0, clockwise)
      and `crop` (`{ x, y, w, h }` in **rotated-natural pixel** coordinates, default the whole
      rotated image). `src`, `nw` and `nh` are never modified; the bytes are never re-encoded.
- [ ] An item with neither field behaves exactly as it does today, so every notebook already on
      disk keeps rendering unchanged.
- [ ] `drawImageItem` (main.js:515) honours both. This is the **only** image draw path in the
      app: the page raster cache, the overlay resize preview (main.js:939), the sidebar
      thumbnails (main.js:3160) and the export renderer (main.js:3821) all funnel through it.
      Implementing crop anywhere else silently leaves thumbnails and exports uncropped.
- [ ] The drawn rect (`it.x, it.y, it.w, it.h`) is the crop window, not the whole picture. Scale
      is `it.w / crop.w`, uniform on both axes.
- [ ] Two functions `rotateImageLeft(it)` / `rotateImageRight(it)` step `rot` by 90, rotate the
      `crop` rect into the new frame so the same pixels stay visible, and swap `it.w` / `it.h`
      about the rect's centre so the image turns in place rather than jumping.
- [ ] Both are undoable through the existing `pushUndo({undo, redo})` contract and call
      `invalidatePage`.
- [ ] `it.bbox` is rewritten to mirror the new rect on every crop and every rotation.
      `commitResize` (main.js:1750) already maintains `bbox` as a mirror and persistence and hit
      testing both read it.
- [ ] Existing aspect-preserving corner resize still works on a cropped and/or rotated image: it
      scales the crop window, it does not change `crop` or `rot`.

### US-003: Edge crop handles and the ghost of what was cropped away
**Description:** As a user, I want to drag the sides of a selected image to crop it and see the
part I cropped away in faint outline, so I can drag it back.

**Acceptance Criteria:**
- [ ] A selected lone image shows four edge-midpoint handles (n, e, s, w) in addition to today's
      four corner handles. Corners scale (unchanged). Edges crop.
- [ ] `handleAt` (main.js:1689) tests the four corners **first** and returns before considering
      edge midpoints. With `HANDLE_HIT = 13` and `SEL_PAD = 8` the two overlap on a small image,
      and corner-first is what keeps resize reachable.
- [ ] Dragging an edge inward shrinks the crop window: the visible content does not move or
      rescale, the window over it just gets smaller. Dragging outward grows it back, hard-stopped
      at the full rotated image bounds so a crop can never exceed the original.
- [ ] A minimum crop window is enforced, reusing the existing `MIN_IMAGE` constant.
- [ ] While an image is selected, the cropped-away region is drawn at low opacity (about 0.25)
      so the user can see what is outside the window. This ghost is drawn **only in the overlay**,
      from the `if (sel)` block at main.js:923-954. It must never be drawn from `drawImageItem`,
      which bakes into the page raster cache and would leave the ghost on the page after
      deselecting.
- [ ] The ghost is live during a crop drag: dragging the west edge right reveals more ghost on
      the left in real time.
- [ ] A crop drag is committed like a resize: one undo entry per drag, nothing pushed when the
      drag did not move.
- [ ] A crop drag is abandoned safely by `cancelSelDrag` (main.js:1636) the same way a move and a
      resize are, so a second finger mid-crop cannot strand the item in `hiddenItems`.
- [ ] Edge handles are grabbable by pen, mouse and finger, matching how corner grips already work.

### US-004: Layer ordering for every item type
**Description:** As a user, I want to send any item forward or backward through the stack, so a
pasted image stops permanently covering what I drew underneath it.

**Acceptance Criteria:**
- [ ] Four operations on the current selection: bring forward (one step), send backward (one
      step), bring to front, send to back. All four work on strokes, text, shapes and images
      alike, and on a multi-item selection.
- [ ] A multi-item selection keeps its members' relative order after any of the four.
- [ ] Each operation is one undo entry, using `deleteSelection`'s idiom verbatim
      (main.js:1848-1854): snapshot `page.items.slice()` before and after and restore by
      assignment.
- [ ] Every reorder calls `invalidatePage` and never `cacheDrawItem`. The incremental path only
      appends to the raster cache and cannot express a reorder.
- [ ] The selection survives the operation, so the user can press the shortcut repeatedly.
- [ ] Keyboard shortcuts, registered in the existing `window keydown` handler (main.js:3067):
      `Ctrl+]` forward, `Ctrl+[` backward, `Ctrl+Shift+]` to front, `Ctrl+Shift+[` to back. Each
      is a no-op with no selection and does not swallow the key.
- [ ] Ordering is inherently persisted, since it is the order of `page.items` itself.

### US-005: Selection bar controls
**Description:** As a user, I want buttons on the selection bar for rotating and for layer order,
so the features are discoverable without knowing a shortcut.

**Acceptance Criteria:**
- [ ] The selection bar (`#selbar`, ui.js:102-114) gains rotate-left and rotate-right buttons and
      four layer-order buttons, following the existing `icon-btn small` + `ICONS.*` + `tb-sep`
      pattern already in that block.
- [ ] Rotate buttons appear **only** when the selection is a single image; layer buttons appear
      for any selection.
- [ ] `showSelbar(rect)` in ui.js:116 currently ignores a second argument, while main.js:1802
      already passes `sel.items.length`. That channel is what carries the context: extend it to
      also carry whether the selection is a lone image, and use it to show and hide the two
      groups.
- [ ] Buttons call through `app.*` methods exposed from main.js, matching how `sel-dup` and
      `sel-del` already call `app.duplicateSelection()` / `app.deleteSelection()`.
- [ ] The bar repositions correctly after a rotation changes the item's bounding box.
- [ ] Verify in the browser.

### US-006: Verify end to end and rebuild the installed app
**Description:** As the user, I want the feature actually working in the Windows app I open every
day, not only in a dev server tab.

**Acceptance Criteria:**
- [ ] All of the above exercised in a real browser against `app/index.html`, with the console
      clean: paste an image, crop each of the four edges, drag one back out, rotate both ways,
      resize a cropped and rotated image, reorder items of mixed types, undo and redo every one
      of those, save and reload and confirm crop, rotation and order all survived.
- [ ] Camera restore confirmed across a reload.
- [ ] `scripts\update-app.ps1` run to repack `resources\app.asar`. `FlatNotes.exe` is not
      replaced: replacing it destroys the user's Start menu and taskbar pins.
- [ ] The packed asar is verified to contain the new code, byte-compared against the working tree
      rather than trusted.
- [ ] The installed app is launched and the camera restore is confirmed **there**, by closing and
      reopening the real app. This is the only test that covers what US-001 is actually for.

## Functional Requirements

- FR-1: Persist `{page, oy, x, zoom}` per document id in the IndexedDB KV store under `views`.
- FR-2: Debounce camera writes at about 400 ms; flush on `beforeunload` and before a notebook swap.
- FR-3: Restore the camera after `setDoc` in both `boot()` and `switchDoc()`, clamped and
  defensive against a stale or malformed anchor.
- FR-4: Drop a deleted notebook's anchor from the map.
- FR-5: Add optional `rot` and `crop` to the image item; leave `src`, `nw`, `nh` untouched.
- FR-6: Honour `rot` and `crop` inside `drawImageItem`, so the page cache, overlay preview,
  thumbnails and exports all agree.
- FR-7: Provide rotate-left and rotate-right, each one undoable, each keeping the item centred.
- FR-8: Provide four edge crop handles, corner-first in hit priority, clamped to the original
  image bounds and to `MIN_IMAGE`.
- FR-9: Draw the cropped-away region as a faint ghost in the overlay only, while selected, live
  during the drag.
- FR-10: Provide forward / backward / to-front / to-back on any selection, each one undo entry,
  each calling `invalidatePage`.
- FR-11: Bind `Ctrl+]`, `Ctrl+[`, `Ctrl+Shift+]`, `Ctrl+Shift+[` to the four layer operations.
- FR-12: Surface rotate (lone image only) and layer order (any selection) on the selection bar.
- FR-13: Keep `it.bbox` a faithful mirror of the drawn rect after every crop, rotate and resize.
- FR-14: Repack the installed app's `app.asar` without touching `FlatNotes.exe`.

## Non-Goals (Out of Scope)

- **Mirror flip.** "Flipping to the left or to the right" in the request is a 90 degree turn, and
  a mirror is not a degree operation. Horizontal and vertical mirroring are not built.
- **Free rotation.** 90 degree steps only. No arbitrary angle, no rotation handle.
- **Non-rectangular crop.** No lasso crop, no rounded corners, no masks.
- **Re-encoding.** The crop is a window over the original bytes. Nothing is ever re-encoded, and
  a cropped image is not smaller on disk. That is the price of being able to un-crop.
- **Cropping or rotating anything other than an image.** Strokes, text and shapes get layer order
  only.
- **Cross-page reordering.** Layer operations move an item within its own page.
- **Rotating or cropping a multi-item selection.** Lone image only.
- **Remembering the camera per page** rather than per notebook, and remembering scroll position of
  anything other than the main canvas.
- **Regenerating `dist\FlatNotes.exe`.** The portable build is a separate artifact from the
  installed app and is not part of this work.

## Design Considerations

- Corner handles keep today's appearance and behaviour exactly. Edge handles should be visually
  distinguishable from corners (a short bar rather than a square is the obvious choice) so the
  user can tell scale from crop before dragging.
- The ghost should read as "this is still here, you can get it back", not as a rendering bug:
  low opacity, and it disappears the moment the image is deselected.
- The selection bar already separates groups with `tb-sep`; rotate and layer are two new groups.

## Technical Considerations

- FlatNotes is zero-dependency vanilla ES modules with no build step. No new dependency, no
  bundler, no new file unless a story genuinely needs one.
- `drawImageItem`'s `rect` parameter exists so the live resize preview can draw the cached decode
  at a different size without cloning the item. Crop and rotation must not break that: the
  preview passes a rect, not an item.
- A rotated draw needs a canvas transform. The crop is a clip. Both must be balanced by a
  `restore()` on every path, including the early-return placeholder branch for an image that has
  not decoded yet.
- Camera state belongs in KV, not on the document record. `listDocs` sorts the sidebar by
  `doc.modified`; writing the camera onto the doc would bump `modified` on every pan and make the
  sidebar reshuffle itself while the user scrolls.
- `pageTops()` calls `settleHeights()` itself, so page positions are settled by the time a restore
  asks for them. The restore must go through `pageTops()` and not cache an earlier value.

## Success Metrics

- Closing and reopening the installed app returns to the same page, offset and zoom, every time.
- A screenshot can be trimmed to the region of interest and untrimmed again, with no loss of
  quality and no growth in file size.
- An image pasted over a drawing can be pushed behind it in one click.

## Open Questions

None. Scope decisions taken from the request: 90 degree rotation rather than mirror flip, corners
scale and edges crop, camera remembered per notebook.
