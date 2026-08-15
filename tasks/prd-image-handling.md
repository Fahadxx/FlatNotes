# PRD - Images and direct manipulation

## Introduction

Pages can already hold images (`type: 'image'`, US-020 of the main PRD), and the plumbing around them is further along than it looks from the outside. `Ctrl+V` already pastes a clipboard image, files dropped on the window already land on the page under the pointer, corner grips already resize with the aspect ratio preserved, and move, undo and persistence all work. What is missing is the way in: **the only way to select an image today is to draw a lasso around it with the lasso tool.**

That is the whole problem. In a pen-first app a click is a stroke, so an image needs an entry point that no drawing gesture can be mistaken for. This PRD adds two: **right-click**, and **a finger**. The pen and the mouse keep drawing exactly as they do now.

It also promotes the existing move/resize behaviour from "only while the lasso tool is chosen" to "whenever something is selected", so that having picked an image up you can actually do something with it without changing tools.

**Read `app/js/main.js` before starting.** Every requirement below is a change to code that already exists, and the sections are marked with the line ranges they touch as of this writing.

## Goals

- Select a picture without switching tools and without any risk of drawing on it: right-click it, or touch it with a finger.
- Once anything is selected, drag inside the box to move it and drag a corner to resize it, whatever tool is active.
- A finger picks up whatever it lands on (ink, text, shapes, pictures) and pans the page when it lands on bare paper.
- Never store a picture as a link to a file that can move or be deleted. What is on the page is in the notebook.
- Change nothing about how the pen behaves. Every existing measurement, gesture and palm-rejection rule survives untouched.

## What already works - do not rebuild these

Verify each one early, and treat a failure here as a bug to fix rather than a feature to write.

| Behaviour | Where | Note |
|---|---|---|
| `Ctrl+V` pastes a clipboard image | `main.js` `window paste` listener (~2750) | Lands at the centre of the viewport via `imageDropPoint`'s fallback, which is what "wherever we are currently viewing" asks for |
| Dropping image files on the window | `main.js` `dragover` / `drop` (~2761-2775) | Lands under the pointer, on the page it was dropped on |
| Oversized images scaled to fit the page | `placeImage` (~2697) | `IMAGE_MARGIN`, aspect preserved |
| Corner grips, aspect-locked resize | `handleAt` / `startResize` / `updateResize` / `commitResize` (~1504-1607) | `MIN_IMAGE` floor, opposite corner pinned |
| Move a selection | `moveSel` mode, `commitSelMove` | |
| Undo, redo, persistence, thumbnails, export | existing item pipeline | An image is an ordinary item |

## User stories

### US-001: Right-click selects a picture

**Description:** As someone writing with a pen, I want to right-click a picture to pick it up, so that I never have to lasso it or switch tools to work with it.

**Acceptance criteria:**

- [ ] Right-clicking (`e.button === 2`) an image selects it: dashed box, four corner grips, and the existing selection bar with its duplicate/delete actions, exactly as a lasso selection shows today.
- [ ] The topmost image wins when two overlap - `page.items` is in paint order, so the hit test walks it backwards.
- [ ] Right-clicking anywhere that is not an image clears the selection.
- [ ] Works with **any** tool active, including pen and highlighter, and starts no stroke.
- [ ] **The pen's barrel button is not affected.** `isPenEraser` (~1084) reads `buttons & 2`, so the new branch must be guarded on `e.pointerType !== 'pen'` or the barrel-button eraser breaks. Verify by erasing with the barrel button after the change.
- [ ] The existing `contextmenu` preventDefault (~1077) still suppresses the browser menu; no new menu is added.
- [ ] No `capture(e)`, no `pin.mode` - selecting is instantaneous, like the `text` and `voice` tool branches.

### US-002: A selection is modal, so it can be moved and resized with any tool

**Description:** As someone who has just picked up a picture, I want to drag it and pull its corners straight away, so that selecting it was worth doing.

**Acceptance criteria:**

- [ ] While a selection exists, a drag that starts **inside the padded selection box** moves it, whatever tool is active.
- [ ] While a selection exists, a drag that starts **on a corner grip** resizes it, whatever tool is active. Grips are offered before the box, as they are today.
- [ ] A press that starts **outside** the box clears the selection and the active tool takes over in the same gesture - so a pen stroke started outside a selection still draws, from its first point, with no dropped stroke.
- [ ] The grip hover cursor (`nwse-resize` / `nesw-resize`, ~1216-1219) no longer requires the lasso tool.
- [ ] The lasso tool's own behaviour is unchanged: drag on bare paper still draws a lasso.
- [ ] `Esc` still clears the selection (existing `clearSel`).
- [ ] Move and resize still commit one undo step each, and still restore correctly on undo.

### US-003: A tap with the lasso tool picks up what it taps

**Description:** As someone using the lasso tool, I want a plain tap on an item to select it, so that I do not have to draw a loop around a single picture.

**Acceptance criteria:**

- [ ] With the lasso tool, a press-and-release with no meaningful drag (`finishLasso`'s existing `pts.length < 3` path, ~1609) selects the item under the tap instead of clearing the selection.
- [ ] A tap on bare paper still clears the selection.
- [ ] The textify lasso (`l.textify`) is untouched by this - it still runs recognition and never selects.

### US-004: A finger picks up whatever it lands on

**Description:** As someone holding the pen in one hand, I want to move things with my other hand, so that moving something never means putting the pen down or changing tools.

**Acceptance criteria:**

- [ ] A single finger landing on any item - stroke, text, shape or image - selects that item and starts moving it in the same gesture. Lift to commit, as one undo step.
- [ ] A single finger landing on **bare paper** pans the page, exactly as today.
- [ ] A single finger landing on an existing selection moves that whole selection; landing on a grip resizes.
- [ ] Two-finger pinch-zoom and two-finger pan still work unchanged. `movePinch` already anchors the pinch-start world midpoint under the fingers, so two fingers remain the way to pan across a page that is dense with ink.
- [ ] **A second finger arriving mid-drag turns the gesture into a pinch and must abandon the drag cleanly.** `startPinch` overwrites `pin.mode`, so without an explicit cancel the dragged item stays in `hiddenItems` and disappears from the page. Add a cancel that unhides the item, drops `selDelta` / `selResize`, and invalidates the page without committing - the same hazard `commitResize` already documents for a selection dropped mid-drag.
- [ ] **Palm rejection holds.** The existing guard is `penDown && pin.mode === 'draw'`, which does not cover a palm landing *before* the pen. Touch-to-grab must additionally require `!penDown`, so a resting palm can never drag a page's contents.
- [ ] Everything above lives inside the existing `!app.settings.touchDraw` guard, so users who have turned on "Draw with touch" are unaffected.
- [ ] The touch branches in `pointermove` (~1219) and `endPointer` (~1296) both return early before the generic move/resize handling, so each needs its own path for the new modes. The finger must stay in the `touches` map throughout, because pinch escape and end-of-gesture cleanup both depend on it.

### US-005: A picture on a page is stored in the notebook, never linked

**Description:** As someone pasting screenshots into notes, I want the picture to be part of my notebook, so that it is still there after the source file, temp folder or web page has gone.

**Acceptance criteria:**

- [ ] Every route that adds an image stores the **encoded bytes** on the item (the existing `src` data URL written by `fileToDataUrl`), never a `file://` path, a temp path, an `http(s)` URL or a `blob:` URL. Blob URLs in particular die with the session and would leave a page of broken pictures.
- [ ] Verified concretely: paste an image, drop a file, then reload the app with the source file deleted, and the page still renders it.
- [ ] Dragging an image out of a web browser is tested against the real behaviour. Chrome usually writes a temp file for a cross-application image drag, in which case the existing `drop` handler already works and the bytes are inlined by `fileToDataUrl` - **verify this rather than assuming it.**
- [ ] If a drag delivers only a URL and no file, the app must either inline the bytes or refuse the drop with a clear message. It must never store the URL. Note the app is loaded by `win.loadFile` (`electron/main.cjs:505`), so the renderer's origin is `file://` and it cannot fetch a remote URL itself; fetching would need a new main-process channel and would not work in browser mode at all. **Report this as a limitation rather than building it** unless the test shows it is the common case.

### US-006: Verify the whole thing in a real browser

**Description:** As the next person to touch this code, I want the interaction verified rather than asserted, because none of it is visible to a unit test.

**Acceptance criteria:**

- [ ] Serve `app/` (`python -m http.server 8765`) and drive it with **chrome-devtools-mcp** (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`). The `claude-in-chrome` MCP reports zero browsers on this machine and is not the one to use.
- [ ] Synthetic `PointerEvent`s with `pointerType: 'touch'` are a supported path - `capture` (~1080) already swallows the `setPointerCapture` failure that synthetic events cause, with a comment saying so.
- [ ] Checked in the browser, with a screenshot for each: right-click select with the pen tool active; drag to move; corner resize; pen stroke started outside a live selection still draws; barrel-button eraser still erases; one-finger drag on ink moves it; one-finger drag on bare paper pans; two-finger pinch zooms; a second finger arriving mid-drag leaves the item visible and where it was.
- [ ] Console clean throughout.

## Functional requirements

- FR-1: The system must select the topmost image under the pointer on right-click, with any tool active, and clear the selection when the right-click misses.
- FR-2: The system must not let the right-click path interfere with the pen barrel-button eraser.
- FR-3: While a selection exists, the system must treat a drag beginning inside its padded box as a move and a drag beginning on a corner grip as a resize, regardless of the active tool.
- FR-4: A press beginning outside a live selection must clear it and pass the gesture to the active tool without losing the first point of a stroke.
- FR-5: A tap with the lasso tool must select the item under it rather than clearing the selection.
- FR-6: A single finger must grab and move the item it lands on, and pan the page when it lands on bare paper.
- FR-7: A single finger must never grab anything while the pen is down or resting (`!penDown`), and must not change behaviour when "Draw with touch" is on.
- FR-8: A second pointer arriving during a move or resize must cancel that drag without committing it, leaving the item visible on its page and the selection intact.
- FR-9: Two-finger pinch-zoom and two-finger pan must be unchanged.
- FR-10: Move and resize must each commit exactly one undo step, from every entry point (lasso, right-click, touch).
- FR-11: Every image added by any route must be stored as encoded bytes on the item, never as a reference to anything outside the notebook.
- FR-12: A drop carrying no image file must be refused with a message rather than stored as a link.

## Non-goals

- No context menu on right-click. The existing selection bar already carries duplicate and delete.
- No rotation, no cropping, no flipping, no z-order controls, no free (non-aspect) resize. Corner grips preserve the aspect ratio, as they do today.
- No multi-select by tapping several items. A finger or a right-click selects one item; the lasso is still how a group is selected.
- No fetching images from remote URLs through the Electron main process.
- No change to paste or drop placement. The centre of the viewport and the drop point are already right.
- No change to `placeImage`, `IMAGE_MARGIN`, the resize maths or the image cache.

## Technical considerations

- **One file.** All of this is `app/js/main.js`. `ui.js` is only touched if the selection bar needs it, and it should not.
- **Reuse `eraseHits(it, x, y, r)`** (~1389) for the touch hit test. It already covers all four item types with a radius, which is exactly a fingertip, and it is what the eraser uses - so touch and erase agree about what "on an item" means, for free.
- **Reuse `handleAt`, `startResize`, `selBBox`, `positionSelbar` and `clearSel` as they are.** The selection machinery is complete; this work only adds ways to reach it.
- New selections must go through whatever `finishLasso` does to set `sel` and call `positionSelbar` - `clearSel` calls `ui.showSelbar(null)`, so a selection made any other way must hit its counterpart or the duplicate/delete bar will not appear.
- The pointer-down ordering that matters: `pin.mode` guard, then middle-mouse/space pan, then the new right-click branch, then the existing `e.button !== 0` bail, then `capture` and the tool dispatch. The right-click branch must sit before the bail, which is what currently swallows button 2.
- **Zero dependencies, no build step.** Same as the rest of the app.

## Success criteria

- A picture can be selected, moved and resized without ever changing tools, from a pen, a mouse or a finger.
- No existing gesture changes: pen draws, barrel button erases, one finger pans bare paper, two fingers pinch and pan.
- Nothing on a page can vanish, and nothing on a page can point outside the notebook.
- Every claim above confirmed by a screenshot in a real browser, console clean.

## Open questions

- A finger grabbing **any** item, not just pictures, is the user's explicit choice and is what US-004 specifies. The risk is that on a page dense with handwriting almost every finger-down lands on ink, so one-finger panning becomes rare and two fingers become the normal way to pan. Two-finger pan already works, so this is livable - but if it turns out to annoy in use, the fix is a settings toggle ("Move items with touch", default on) rather than a redesign. Leave the hit test behind one named helper so that toggle is a two-line change later.
- Should a finger on an item that is *already part of a multi-item lasso selection* move the whole selection or just that item? US-004 says the whole selection, which matches every other app; confirm it reads right in use.
