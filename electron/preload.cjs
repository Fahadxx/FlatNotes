// Minimal native bridge: on-demand local OCR and speech recognition engine control,
// plus the OneNote importer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flatnotes', {
  listOcrModels: () => ipcRenderer.invoke('ocr-list-models'),
  startOcr: (modelId) => ipcRenderer.invoke('ocr-start', modelId),
  ocrUsed: () => ipcRenderer.send('ocr-used'),
  listAsrModels: () => ipcRenderer.invoke('asr-list-models'),
  startAsr: (modelId) => ipcRenderer.invoke('asr-start', modelId),
  asrHealthy: () => ipcRenderer.invoke('asr-healthy'),
  asrUsed: () => ipcRenderer.send('asr-used'),
  onenoteAvailable: () => ipcRenderer.invoke('onenote-available'),
  onenoteList: () => ipcRenderer.invoke('onenote-list'),
  onenoteExport: (opts) => ipcRenderer.invoke('onenote-export', opts),
  onenoteRead: (file) => ipcRenderer.invoke('onenote-read', file),
  onenoteClear: () => ipcRenderer.invoke('onenote-clear'),
  onOnenoteProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('onenote-progress', handler);
    return () => ipcRenderer.removeListener('onenote-progress', handler);
  },
});
