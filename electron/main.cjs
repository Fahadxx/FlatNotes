// FlatNotes desktop shell.
const { app, BrowserWindow, shell, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');

/* ---------- on-demand local OCR engines (llama.cpp) ---------- */

const OCR_PORT = 8090;
const OCR_IDLE_MS = 10 * 60 * 1000; // unload the model after 10 min without use

// Every model is served on the same port, so the renderer's ocrUrl never changes;
// only the spawn arguments and the prompt differ.
//
// -c 8192 --parallel 1 on every entry: llama.cpp otherwise allocates the model's
// full context (131k on GLM-OCR) across 4 slots, ~10 GB of KV cache. Textify sends
// one small image at a time, so 8k / 1 slot is plenty and keeps RAM at ~2.3 GB.
const CTX_ARGS = ['-c', '8192', '--parallel', '1'];

const VLM_PROMPT =
  'Transcribe all handwritten text in this image exactly as written. Output only the ' +
  'transcription, preserving the original line breaks. No commentary, no markdown, no code fences.';

const lmStudio = (...p) =>
  path.join(process.env.USERPROFILE || app.getPath('home'), '.cache', 'lm-studio', 'models', ...p);

/**
 * A local GGUF pair (weights + vision projector) served by llama-server.
 * `hf` entries download on first use; `files` entries must already exist on disk.
 */
const OCR_MODELS = [
  {
    id: 'glm-ocr',
    label: 'GLM-OCR 0.9B',
    note: 'Default. Purpose-built OCR, installs itself, ~2 GB.',
    hf: 'ggml-org/GLM-OCR-GGUF:Q8_0',
    prompt: 'OCR',
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    note: 'Strong all-rounder, slower, ~6 GB.',
    files: {
      model: lmStudio('lmstudio-community', 'gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'),
      mmproj: lmStudio('lmstudio-community', 'gemma-4-E4B-it-GGUF', 'mmproj-gemma-4-E4B-it-BF16.gguf'),
    },
    prompt: VLM_PROMPT,
  },
  {
    id: 'qwen35-4b',
    label: 'Qwen3.5 4B',
    note: 'Accurate but slow on CPU, ~6 GB.',
    files: {
      model: lmStudio('lmstudio-community', 'Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf'),
      mmproj: lmStudio('lmstudio-community', 'Qwen3.5-4B-GGUF', 'mmproj-Qwen3.5-4B-BF16.gguf'),
    },
    prompt: VLM_PROMPT,
  },
  {
    id: 'qwen35-08b',
    label: 'Qwen3.5 0.8B',
    note: 'Best accuracy per second in testing, ~2 GB.',
    files: {
      model: lmStudio('lmstudio-community', 'Qwen3.5-0.8B-GGUF', 'Qwen3.5-0.8B-Q8_0.gguf'),
      mmproj: lmStudio('lmstudio-community', 'Qwen3.5-0.8B-GGUF', 'mmproj-Qwen3.5-0.8B-BF16.gguf'),
    },
    prompt: VLM_PROMPT,
  },
];

const DEFAULT_OCR_MODEL = 'glm-ocr';
const findModel = (id) => OCR_MODELS.find((m) => m.id === id);
// `hf` models download themselves; local ones need both files present.
const modelAvailable = (m) => !!m.hf || (fs.existsSync(m.files.model) && fs.existsSync(m.files.mmproj));
const spawnArgsFor = (m) =>
  (m.hf ? ['-hf', m.hf] : ['-m', m.files.model, '--mmproj', m.files.mmproj])
    .concat(['--port', String(OCR_PORT), '--host', '127.0.0.1'], CTX_ARGS);

let ocrProc = null;
let ocrIdleTimer = null;
let ocrLoadedId = null; // which model the running process is serving

const ocrExe = () =>
  path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'FlatNotes', 'ocr', 'llama', 'llama-server.exe');

function ocrHealthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: OCR_PORT, path: '/health', timeout: 1200 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function bumpOcrIdle() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(stopOcr, OCR_IDLE_MS);
}

function stopOcr() {
  clearTimeout(ocrIdleTimer);
  if (ocrProc) {
    try { ocrProc.kill(); } catch { /* already gone */ }
    ocrProc = null;
  }
  ocrLoadedId = null;
}

/** Wait for the previous server to release the port before rebinding it. */
async function waitForPortFree(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await ocrHealthy())) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

ipcMain.handle('ocr-list-models', () =>
  OCR_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    prompt: m.prompt,
    available: modelAvailable(m),
    loaded: ocrLoadedId === m.id,
  })));

ipcMain.handle('ocr-start', async (_e, requestedId) => {
  const model = findModel(requestedId) || findModel(DEFAULT_OCR_MODEL);
  if (!modelAvailable(model)) return { ok: false, error: 'model-missing', model: model.id };

  // A server we didn't spawn (e.g. start-ocr-engine.ps1) counts as the default model.
  const up = await ocrHealthy();
  if (up && (ocrLoadedId === model.id || (!ocrProc && model.id === DEFAULT_OCR_MODEL))) {
    bumpOcrIdle();
    return { ok: true, model: model.id };
  }

  const exe = ocrExe();
  if (!fs.existsSync(exe)) return { ok: false, error: 'not-installed' };

  if (up || ocrProc) { // wrong model loaded -> swap it out
    stopOcr();
    await waitForPortFree();
  }

  const logPath = path.join(path.dirname(path.dirname(exe)), 'engine.log');
  const log = fs.openSync(logPath, 'a');
  try { fs.appendFileSync(logPath, `\n[flatnotes] starting ${model.id}\n`); } catch { /* ignore */ }
  ocrProc = spawn(exe, spawnArgsFor(model), {
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: path.dirname(exe),
  });
  ocrLoadedId = model.id;
  const started = ocrProc;
  started.on('exit', (code) => {
    try { fs.appendFileSync(logPath, `\n[flatnotes] engine exited code=${code}\n`); } catch { /* ignore */ }
    if (ocrProc === started) { ocrProc = null; ocrLoadedId = null; }
  });

  bumpOcrIdle();
  return { ok: true, starting: true, model: model.id }; // renderer polls /health (first run may also download)
});

ipcMain.on('ocr-used', bumpOcrIdle);
app.on('will-quit', stopOcr);

/* ---------- on-demand local speech recognition (sherpa-onnx + Parakeet) ---------- */

// Same lifecycle as the OCR engine above: spawn on first use, unload when idle,
// one fixed port so the renderer's asrUrl never changes.
//
// The engine is sherpa-onnx's offline websocket server, which is the only route
// that runs Parakeet TDT natively here: NeMo itself is CUDA and Linux oriented,
// but sherpa-onnx ships real win-arm64 CPU binaries and an ONNX export of the model.
const ASR_PORT = 8091;
const ASR_IDLE_MS = 10 * 60 * 1000;

// Leave a couple of cores for the UI; the model decodes at roughly 30x real time here.
const ASR_THREADS = Math.max(2, Math.min(6, (os.cpus().length || 4) - 2));

const asrDir = () =>
  path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'FlatNotes', 'asr');
const asrExe = () => path.join(asrDir(), 'bin', 'sherpa-onnx-offline-websocket-server.exe');
const asrModelDir = (m) => path.join(asrDir(), 'models', m.dir);

/** A sherpa-onnx transducer export on disk. Installed by asr\setup-asr.ps1. */
const ASR_MODELS = [
  {
    id: 'parakeet-tdt-0.6b-v2',
    label: 'Parakeet TDT 0.6B v2',
    note: 'Default. English, ~480 MB, decodes far faster than real time on CPU.',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet TDT 0.6B v3',
    note: 'Multilingual (25 European languages), ~670 MB. Around 7x real time here, slower than v2.',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  },
];

const DEFAULT_ASR_MODEL = 'parakeet-tdt-0.6b-v2';
const findAsrModel = (id) => ASR_MODELS.find((m) => m.id === id);
const asrModelAvailable = (m) => fs.existsSync(path.join(asrModelDir(m), 'encoder.int8.onnx'));

// sherpa-onnx parses only the --key=value form; a space separated value is read as empty.
const asrSpawnArgs = (m) => {
  const d = asrModelDir(m);
  return [
    `--port=${ASR_PORT}`,
    '--num-io-threads=1',
    // One utterance at a time: the renderer re-decodes its growing buffer, so batching
    // would only add latency to the request that is actually on screen.
    '--num-work-threads=2',
    '--max-batch-size=1',
    `--log-file=${path.join(asrDir(), 'server.log')}`,
    `--encoder=${path.join(d, 'encoder.int8.onnx')}`,
    `--decoder=${path.join(d, 'decoder.int8.onnx')}`,
    `--joiner=${path.join(d, 'joiner.int8.onnx')}`,
    `--tokens=${path.join(d, 'tokens.txt')}`,
    `--num-threads=${ASR_THREADS}`,
  ];
};

let asrProc = null;
let asrIdleTimer = null;
let asrLoadedId = null;

/**
 * The websocket server has no health endpoint, but it only binds the port after the
 * model is loaded, so accepting a connection is an accurate readiness signal.
 */
function asrHealthy(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: ASR_PORT });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

function bumpAsrIdle() {
  clearTimeout(asrIdleTimer);
  asrIdleTimer = setTimeout(stopAsr, ASR_IDLE_MS);
}

function stopAsr() {
  clearTimeout(asrIdleTimer);
  if (asrProc) {
    try { asrProc.kill(); } catch { /* already gone */ }
    asrProc = null;
  }
  asrLoadedId = null;
}

async function waitForAsrPortFree(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await asrHealthy())) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

ipcMain.handle('asr-list-models', () =>
  ASR_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    available: asrModelAvailable(m),
    loaded: asrLoadedId === m.id,
  })));

ipcMain.handle('asr-start', async (_e, requestedId) => {
  const model = findAsrModel(requestedId) || findAsrModel(DEFAULT_ASR_MODEL);
  const exe = asrExe();
  if (!fs.existsSync(exe)) return { ok: false, error: 'not-installed' };
  if (!asrModelAvailable(model)) return { ok: false, error: 'model-missing', model: model.id };

  // A server we did not spawn (asr\start-asr-engine.ps1) counts as the default model.
  const up = await asrHealthy();
  if (up && (asrLoadedId === model.id || (!asrProc && model.id === DEFAULT_ASR_MODEL))) {
    bumpAsrIdle();
    return { ok: true, model: model.id };
  }

  if (up || asrProc) { // wrong model loaded -> swap it out
    stopAsr();
    await waitForAsrPortFree();
  }

  const logPath = path.join(asrDir(), 'engine.log');
  const log = fs.openSync(logPath, 'a');
  try { fs.appendFileSync(logPath, `\n[flatnotes] starting ${model.id}\n`); } catch { /* ignore */ }
  asrProc = spawn(exe, asrSpawnArgs(model), {
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: path.dirname(exe),
  });
  asrLoadedId = model.id;
  const started = asrProc;
  started.on('exit', (code) => {
    try { fs.appendFileSync(logPath, `\n[flatnotes] asr engine exited code=${code}\n`); } catch { /* ignore */ }
    if (asrProc === started) { asrProc = null; asrLoadedId = null; }
  });

  bumpAsrIdle();
  return { ok: true, starting: true, model: model.id }; // renderer polls until the port answers
});

ipcMain.handle('asr-healthy', () => asrHealthy());
ipcMain.on('asr-used', bumpAsrIdle);
app.on('will-quit', stopAsr);

/* ---------- OneNote import (US-021) ---------- */

// The exporter is a compiled .NET helper, built once by onenote\setup-onenote.ps1, that
// talks to the locally installed OneNote over COM and writes one JSON file per OneNote
// section into a staging folder. Main runs it and streams its progress; the renderer reads
// the JSON files back one section at a time and creates the notebooks itself, so the
// document format stays entirely the renderer's business.

const onenoteDir = () =>
  path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'FlatNotes', 'onenote');

// installed location first, then the repo checkout so a dev build works without installing
const onenoteExe = () => {
  const candidates = [
    path.join(onenoteDir(), 'bin', 'FlatNotesOneNote.exe'),
    path.join(__dirname, '..', 'onenote', 'bin', 'FlatNotesOneNote.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
};

const onenoteStage = () => path.join(app.getPath('userData'), 'onenote-import');

let onenoteProc = null;

function runOnenote(args, onLine, timeoutMs) {
  return new Promise((resolve) => {
    const exe = onenoteExe();
    if (!fs.existsSync(exe)) { resolve({ ok: false, error: 'not-installed' }); return; }
    let out = '', err = '', tail = '';
    const proc = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
    onenoteProc = proc;
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      tail += chunk;
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) if (onLine) onLine(line);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      onenoteProc = null;
      resolve({ ok: false, error: 'spawn-failed', detail: String(e) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      onenoteProc = null;
      if (tail && onLine) onLine(tail);
      resolve({ ok: code === 0, code, stdout: out, stderr: err.trim() });
    });
  });
}

ipcMain.handle('onenote-available', () => ({
  ok: fs.existsSync(onenoteExe()),
  exe: onenoteExe(),
}));

// The section list is cheap (one COM call), so the UI can show what is about to come over.
ipcMain.handle('onenote-list', async () => {
  const r = await runOnenote(['list'], null, 120000);
  if (!r.ok) return { ok: false, error: r.error || 'failed', detail: r.stderr || r.detail || '' };
  try {
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('{'));
    return { ok: true, ...JSON.parse(line) };
  } catch (e) {
    return { ok: false, error: 'bad-output', detail: String(e) };
  }
});

// Runs the full export. Progress is pushed to the renderer as it arrives rather than
// batched at the end, because 225 pages take minutes.
ipcMain.handle('onenote-export', async (e, opts = {}) => {
  if (onenoteProc) return { ok: false, error: 'busy' };
  const dir = onenoteStage();
  fs.mkdirSync(dir, { recursive: true });
  const args = ['export', '--out', dir];
  if (opts.sections && opts.sections.length) args.push('--sections', opts.sections.join(','));
  if (opts.maxPages) args.push('--max-pages', String(opts.maxPages));

  const send = (payload) => { try { e.sender.send('onenote-progress', payload); } catch { /* window gone */ } };
  let summary = null, expectSummary = false;

  const r = await runOnenote(args, (line) => {
    if (expectSummary && line.startsWith('{')) {
      expectSummary = false;
      try { summary = JSON.parse(line); } catch { /* reported as missing below */ }
      return;
    }
    if (line.startsWith('P ')) {
      const [, done, total] = line.split(' ');
      send({ phase: 'export', done: Number(done), total: Number(total) });
    } else if (line.startsWith('S ')) {
      const p = line.split(' ');
      send({ phase: 'section', index: Number(p[1]), total: Number(p[2]), file: p.slice(3).join(' ') });
    } else if (line.startsWith('ERR ')) {
      send({ phase: 'warn', message: line.slice(4) });
    } else if (line === 'DONE') {
      expectSummary = true;
    }
  }, 60 * 60 * 1000);

  if (!r.ok) return { ok: false, error: r.error || 'failed', detail: r.stderr || r.detail || '' };
  return { ok: true, dir, ...(summary || {}) };
});

// The renderer has no filesystem access, so it asks for one staged section at a time
// instead of everything at once: a single section can be tens of megabytes.
ipcMain.handle('onenote-read', async (_e, file) => {
  const dir = onenoteStage();
  const full = path.resolve(dir, file);
  if (!full.startsWith(path.resolve(dir))) return { ok: false, error: 'bad-path' };
  try {
    return { ok: true, json: fs.readFileSync(full, 'utf8') };
  } catch (err) {
    return { ok: false, error: 'read-failed', detail: String(err) };
  }
});

// Staged JSON is a full copy of the notes, so it is cleared once the import has landed.
ipcMain.handle('onenote-clear', () => {
  try {
    fs.rmSync(onenoteStage(), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
});

app.on('will-quit', () => { if (onenoteProc) { try { onenoteProc.kill(); } catch { /* gone */ } } });

/* ---------- microphone permission ---------- */

// The Voice tool calls getUserMedia from our own file:// page. Chromium asks the embedder
// twice: once through the request handler (the prompt) and once through the check handler,
// which denies silently when it is missing and looks exactly like a broken microphone.
// Everything else stays denied; we never load remote content.
const ALLOWED_PERMISSIONS = new Set(['media', 'audioCapture']);

function wirePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'media') return details?.mediaType !== 'video';
    return ALLOWED_PERMISSIONS.has(permission);
  });
}

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function createWindow() {
  const s = loadState();
  const win = new BrowserWindow({
    width: s.width || 1360,
    height: s.height || 880,
    x: s.x,
    y: s.y,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#eef0f4',
    autoHideMenuBar: true,
    title: 'FlatNotes',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (s.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));

  // external links (if any ever appear) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const save = () => {
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch { /* non-fatal */ }
  };
  win.on('close', save);

  // Voice self-test: FLATNOTES_SELFTEST_ASR=<outfile> FLATNOTES_SELFTEST_WAV=<16k mono wav> npx electron .
  // The fake capture device replays the WAV through getUserMedia, so the whole path
  // (permission handler, worklet, websocket, commit, undo, mic release) runs for real.
  if (process.env.FLATNOTES_SELFTEST_ASR) {
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { bridge: false, models: null, steps: [] };
      try {
        out.bridge = await js('!!(window.flatnotes && window.flatnotes.startAsr)');
        out.models = await js('window.flatnotes.listAsrModels()');
        // boot() is async, so the document may not exist yet when the page finishes loading
        for (let i = 0; i < 60 && !(await js('!!(window.app && window.app.doc)')); i++) await wait(250);

        // The engine is still down at this point, so this is also the "is it really off"
        // check. Browser mode itself cannot be faked here: contextBridge properties are
        // non-configurable, so window.flatnotes cannot be hidden. Test that in a browser.
        out.steps.push({ step: 'engine-down-before-start', healthy: await js('app.asrHealthy()') });

        // 1. record, watch the live transcript, stop, commit, undo
        await js(`app.setTool('voice'); app.startVoice(0, 60, 140)`);
        await wait(6000);
        const live = await js('JSON.stringify(app.voiceState())');
        await wait(6000);
        const before = await js('app.doc.pages[0].items.length');
        await js('app.stopVoice()');
        for (let i = 0; i < 60 && (await js('app.isRecording()')); i++) await wait(500);
        await wait(1500);
        const items = await js('JSON.stringify(app.doc.pages[0].items.filter(i => i.type === "text"))');
        out.steps.push({
          step: 'record-stop-commit',
          live: JSON.parse(live),
          itemsBefore: before,
          items: JSON.parse(items),
          tracksAfterStop: await js('JSON.stringify(app.voiceTrackStates())'),
        });
        await js('app.undo()');
        out.steps.push({ step: 'undo', textItemsLeft: await js('app.doc.pages[0].items.filter(i => i.type === "text").length') });

        // the committed item must behave like any other text item: bring it back and edit it
        await js('app.redo()');
        await js(`(() => {
          const it = app.doc.pages[0].items.find(i => i.type === 'text');
          const v = app.view, z = v.zoom;
          const wx = -410 + it.x + 6, wy = it.y + it.size * 0.6;
          const sx = (wx - v.x) * z + innerWidth / 2, sy = (wy - v.y) * z + innerHeight / 2;
          app.setTool('text');
          const c = document.getElementById('overlay');
          c.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 1, pointerType: 'pen', clientX: sx, clientY: sy, bubbles: true, isPrimary: true, pressure: 0.5,
          }));
        })()`);
        await wait(400);
        out.steps.push({
          step: 'edit-committed-item',
          editorOpen: await js(`getComputedStyle(document.getElementById('textedit')).display !== 'none'`),
          editorText: await js(`document.getElementById('textedit').innerText`),
        });
        await js(`document.getElementById('textedit').blur()`);
        await wait(300);

        // 2. cancel, 3. Escape, 4. tool switch: each must release the microphone
        for (const [name, action] of [
          ['cancel', 'app.cancelVoice()'],
          ['escape', `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`],
          ['tool-switch', `app.setTool('pen')`],
        ]) {
          await js(`app.setTool('voice'); app.startVoice(0, 60, 300)`);
          await wait(3000);
          const during = await js('JSON.stringify(app.voiceState())');
          await js(action);
          await wait(600);
          out.steps.push({
            step: name,
            tracksDuring: JSON.parse(during)?.tracks,
            recordingAfter: await js('app.isRecording()'),
            tracksAfter: JSON.parse(await js('JSON.stringify(app.voiceTrackStates())')),
            itemsAfter: await js('app.doc.pages[0].items.filter(i => i.type === "text").length'),
          });
        }
        // 5. switch notebooks while the final decode is still running. Nothing may be
        // committed, because the document the recording belonged to is no longer open.
        const homeId = await js('app.doc.id');
        await js(`app.setTool('voice'); app.startVoice(0, 60, 500)`);
        await wait(7000);
        await js('app.stopVoice()');       // deliberately not awaited
        await js('app.createDoc()');       // swap the document out from under the decode
        await wait(6000);
        out.steps.push({
          step: 'notebook-switch-during-decode',
          switched: (await js('app.doc.id')) !== homeId,
          textItemsInNewDoc: await js('app.doc.pages[0].items.filter(i => i.type === "text").length'),
          undoStackInNewDoc: await js('app.undoStack.length'),
          recording: await js('app.isRecording()'),
          tracks: JSON.parse(await js('JSON.stringify(app.voiceTrackStates())')),
        });
        const strayId = await js('app.doc.id');
        await js(`app.switchDoc(${JSON.stringify(homeId)})`);
        await wait(800);
        await js(`app.removeDoc(${JSON.stringify(strayId)})`);
        await wait(500);
        out.steps.push({ step: 'back-home', onHome: (await js('app.doc.id')) === homeId });

        // leave the notebook exactly as we found it: undo alone cannot do this, because
        // closing the editor pushes an undo entry of its own
        await js(`app.doc.pages[0].items = app.doc.pages[0].items.filter(i => i.type !== 'text'); app.saveNow()`);
        await wait(500);
        out.steps.push({ step: 'cleanup', itemsLeft: await js('app.doc.pages[0].items.length') });
      } catch (e) { out.error = String(e); }
      fs.writeFileSync(process.env.FLATNOTES_SELFTEST_ASR, JSON.stringify(out, null, 2));
      app.quit();
    });
  }

  // Headless script runner: FLATNOTES_EVAL=<script.js> FLATNOTES_EVAL_OUT=<outfile>
  // Waits for the notebook to be open, evaluates the file in the page and writes whatever
  // it resolves to. One hook instead of one env var per maintenance job.
  if (process.env.FLATNOTES_EVAL) {
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const outFile = process.env.FLATNOTES_EVAL_OUT || (process.env.FLATNOTES_EVAL + '.out.json');
      const out = { userData: app.getPath('userData'), startedAt: new Date().toISOString() };
      try {
        for (let i = 0; i < 240 && !(await js('!!(window.app && window.app.doc)')); i++) await wait(250);
        const code = fs.readFileSync(process.env.FLATNOTES_EVAL, 'utf8');
        out.result = await js(`(async () => { ${code} })()`);
        if (process.env.FLATNOTES_EVAL_PNG) {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.FLATNOTES_EVAL_PNG, img.toPNG());
          out.png = process.env.FLATNOTES_EVAL_PNG;
        }
        out.finishedAt = new Date().toISOString();
      } catch (e) { out.error = String(e && e.stack || e); }
      try { fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
      app.quit();
    });
  }

  // Headless collections migration: FLATNOTES_MIGRATE_COLLECTIONS=<outfile> FlatNotes.exe
  // Splits legacy "Notebook / Section" names into collections. Idempotent, so re-running
  // is safe, and it never deletes a notebook.
  if (process.env.FLATNOTES_MIGRATE_COLLECTIONS) {
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { userData: app.getPath('userData'), startedAt: new Date().toISOString() };
      try {
        for (let i = 0; i < 120 && !(await js('!!(window.app && window.app.doc)')); i++) await wait(250);
        out.before = await js('window.app.listDocs().then((d) => d.map((x) => ({ name: x.name, collection: x.collection || null })))');
        out.result = await js('window.app.migrateOneNoteCollections()');
        out.collections = await js('JSON.parse(JSON.stringify(window.app.collections || []))');
        out.after = await js('window.app.listDocs().then((d) => d.map((x) => ({ name: x.name, collection: x.collection || null })))');
        out.finishedAt = new Date().toISOString();
      } catch (e) { out.error = String(e); }
      try { fs.writeFileSync(process.env.FLATNOTES_MIGRATE_COLLECTIONS, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
      app.quit();
    });
  }

  // Headless OneNote migration: FLATNOTES_IMPORT_ONENOTE=<outfile> FlatNotes.exe
  // Runs the real import against the real profile and quits, for migrating without
  // sitting in front of the window. It seeds nothing and, like the button in Settings,
  // only ever creates new notebooks.
  if (process.env.FLATNOTES_IMPORT_ONENOTE) {
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const outFile = process.env.FLATNOTES_IMPORT_ONENOTE;
      const write = (o) => { try { fs.writeFileSync(outFile, JSON.stringify(o, null, 2)); } catch { /* ignore */ } };
      const out = { userData: app.getPath('userData'), startedAt: new Date().toISOString() };
      try {
        for (let i = 0; i < 120 && !(await js('!!(window.app && window.app.doc)')); i++) await wait(250);
        out.before = await js('window.app.listDocs().then((d) => d.map((x) => x.name))');
        write(out); // so progress is visible while a long import runs

        const result = await js(`window.app.importOneNote({
          onProgress: (p) => { window.__importProgress = p; },
        })`);
        out.result = result;
        out.after = await js('window.app.listDocs().then((d) => d.map((x) => x.name))');
        out.finishedAt = new Date().toISOString();
      } catch (e) { out.error = String(e); }
      write(out);
      app.quit();
    });
  }

  // OneNote import self-test: FLATNOTES_SELFTEST_ONENOTE=<outfile> npx electron .
  // Optionally FLATNOTES_SELFTEST_SECTIONS=<id,id> to import a subset instead of everything,
  // and FLATNOTES_SELFTEST_PNG=<file> to dump the first imported page as an image.
  //
  // Run it against a throwaway profile (electron . --user-data-dir=<scratch>), because it
  // seeds documents of its own. It checks the seeded documents byte for byte afterwards,
  // which is the real proof that importing never touches notes that are already there.
  if (process.env.FLATNOTES_SELFTEST_ONENOTE) {
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { userData: app.getPath('userData'), steps: [] };
      try {
        for (let i = 0; i < 80 && !(await js('!!(window.app && window.app.doc)')); i++) await wait(250);
        out.bridge = await js('!!(window.flatnotes && window.flatnotes.onenoteExport)');
        out.available = await js('window.flatnotes.onenoteAvailable()');

        // the settings button is the only part of this the user actually touches, so the
        // look step is driven through the real DOM rather than the API behind it
        out.uiLook = await js(`(async () => {
          document.getElementById('btn-settings').click();
          await new Promise((r) => setTimeout(r, 150));
          const b = [...document.querySelectorAll('#settings .pill-btn')].find((x) => /Import from OneNote/.test(x.textContent));
          if (!b) return { found: false };
          b.click();
          for (let i = 0; i < 240 && b.disabled; i++) await new Promise((r) => setTimeout(r, 250));
          const out = { found: true, label: b.querySelector('span').textContent, status: b.parentElement.lastElementChild.textContent };
          document.getElementById('set-close').click();
          return out;
        })()`);

        // seed two documents so "non destructive" can be checked rather than assumed
        out.seeded = await js(`(async () => {
          const mk = async (name, n) => {
            await app.createDoc();
            app.renameDoc(name);
            const p = app.currentPage();
            for (let i = 0; i < n; i++) p.items.push({ id: 'seed' + i, type: 'text', x: 40, y: 40 + i * 30,
              text: name + ' line ' + i, size: 17, color: '#1d1d1f', bbox: { x: 40, y: 40 + i * 30, w: 120, h: 23 } });
            await app.saveNow();
            return app.doc.id;
          };
          return [await mk('SEED A', 3), await mk('SEED B', 5)];
        })()`);
        const hashCode = (ids) => `(async () => {
          const idb = await new Promise((res, rej) => { const r = indexedDB.open('flatnotes'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const get = (id) => new Promise((res) => { const r = idb.transaction('docs').objectStore('docs').get(id); r.onsuccess = () => res(r.result); });
          const h = (s) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0; return x; };
          const o = {};
          for (const id of ${JSON.stringify(ids)}) { const d = await get(id); o[id] = d ? h(JSON.stringify(d)) : null; }
          return o;
        })()`;
        out.seedHashBefore = await js(hashCode(out.seeded));
        out.docsBefore = await js('app.listDocs().then(l => l.map(d => d.id))');

        const sections = process.env.FLATNOTES_SELFTEST_SECTIONS
          ? process.env.FLATNOTES_SELFTEST_SECTIONS.split(',') : null;
        const started = Date.now();
        out.result = await js(`app.importOneNote(${JSON.stringify({ sections })})`);
        out.seconds = Math.round((Date.now() - started) / 1000);
        out.seedHashAfter = await js(hashCode(out.seeded));
        out.openDocUnchanged = (await js('app.doc.id')) === out.seeded[out.seeded.length - 1];

        // measure what actually landed in the database
        out.checks = await js(`(async () => {
          const idb = await new Promise((res, rej) => { const r = indexedDB.open('flatnotes'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const all = await new Promise((res) => { const r = idb.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => res(r.result); });
          const imported = all.filter((d) => d.origin === 'onenote');
          let strokes = 0, hi = 0, images = 0, texts = 0, outside = 0, badBbox = 0, pages = 0, titles = 0, ocr = 0;
          for (const d of imported) for (const p of d.pages) {
            pages++;
            if (p.title) titles++;
            if (p.ocrText) ocr++;
            for (const it of p.items) {
              if (it.type === 'stroke') {
                strokes++;
                if (it.tool === 'highlighter') hi++;
                if (!it.bbox || !isFinite(it.bbox.w)) badBbox++;
                for (const q of it.points) if (q.x < -40 || q.x > 860 || q.y < -40 || q.y > 1200) { outside++; break; }
              } else if (it.type === 'image') { images++; if (!/^data:image\\//.test(it.src || '')) badBbox++; }
              else if (it.type === 'text') texts++;
            }
          }
          return { notebooks: imported.length, pages, strokes, highlighter: hi, images, texts,
                   pointsOutsidePage: outside, badItems: badBbox, pagesWithTitle: titles, pagesWithOcr: ocr,
                   names: imported.map((d) => d.name), thumbs: imported.filter((d) => d.pages[0] && d.pages[0].thumb).length };
        })()`);

        // draw one imported page for a real visual check
        if (process.env.FLATNOTES_SELFTEST_PNG) {
          const dataUrl = await js(`(async () => {
            const idb = await new Promise((res, rej) => { const r = indexedDB.open('flatnotes'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const all = await new Promise((res) => { const r = idb.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => res(r.result); });
            const d = all.filter((x) => x.origin === 'onenote').sort((a, b) => b.pages.length - a.pages.length)[0];
            if (!d) return null;
            const page = d.pages.reduce((best, p) => (p.items.length > (best ? best.items.length : 0) ? p : best), null);
            const pending = app.ensureImagesReady([page]);
            if (pending) await pending;
            return app.renderPageToCanvas(page, 1.5).toDataURL('image/png');
          })()`);
          if (dataUrl) {
            fs.writeFileSync(process.env.FLATNOTES_SELFTEST_PNG, Buffer.from(dataUrl.split(',')[1], 'base64'));
            out.png = process.env.FLATNOTES_SELFTEST_PNG;
          }
        }
      } catch (e) { out.error = String(e); }
      fs.writeFileSync(process.env.FLATNOTES_SELFTEST_ONENOTE, JSON.stringify(out, null, 2));
      app.quit();
    });
  }

  // Headless plumbing self-test: FLATNOTES_SELFTEST_OCR=<outfile> npx electron .
  // Optionally FLATNOTES_SELFTEST_MODELS=id1,id2 to exercise switching between models.
  if (process.env.FLATNOTES_SELFTEST_OCR) {
    win.webContents.once('did-finish-load', async () => {
      const out = { bridge: false, models: null, runs: [] };
      const waitHealthy = async (tries = 90) => {
        for (let i = 0; i < tries; i++) {
          if (await ocrHealthy()) return true;
          await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
      };
      try {
        out.bridge = await win.webContents.executeJavaScript('!!(window.flatnotes && window.flatnotes.startOcr)');
        out.models = await win.webContents.executeJavaScript('window.flatnotes.listOcrModels()');
        const ids = (process.env.FLATNOTES_SELFTEST_MODELS || DEFAULT_OCR_MODEL).split(',');
        for (const id of ids) {
          const started = Date.now();
          const ipc = await win.webContents.executeJavaScript(`window.flatnotes.startOcr(${JSON.stringify(id)})`);
          const healthy = await waitHealthy();
          const served = await new Promise((resolve) => {
            http.get({ host: '127.0.0.1', port: OCR_PORT, path: '/props', timeout: 4000 }, (res) => {
              let b = '';
              res.on('data', (c) => { b += c; });
              res.on('end', () => { try { resolve(path.basename(JSON.parse(b).model_path || '')); } catch { resolve(null); } });
            }).on('error', () => resolve(null));
          });
          out.runs.push({ id, ipc, healthy, loadedId: ocrLoadedId, served, seconds: Math.round((Date.now() - started) / 1000) });
        }
      } catch (e) { out.error = String(e); }
      fs.writeFileSync(process.env.FLATNOTES_SELFTEST_OCR, JSON.stringify(out, null, 2));
      app.quit();
    });
  }
}

// Must match build.appId so Windows groups the window with the pinned shortcut
// instead of treating it as a separate, unpinnable app.
app.setAppUserModelId('com.fahad.flatnotes');

// Deterministic audio for the ASR self-test: no real microphone, known speech in, known text out.
if (process.env.FLATNOTES_SELFTEST_ASR) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  if (process.env.FLATNOTES_SELFTEST_WAV) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.FLATNOTES_SELFTEST_WAV);
  }
}

app.whenReady().then(() => { wirePermissions(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
