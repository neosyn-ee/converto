const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('converto', {
  start: (config) => ipcRenderer.send('engine:start', config),
  stop: () => ipcRenderer.send('engine:stop'),
  setOverlay: (on) => ipcRenderer.send('window:overlay', on),
  openTranscripts: () => ipcRenderer.send('open:transcripts'),
  openSettings: (pane) => ipcRenderer.send('open:settings', pane),
  onEngine: (callback) => ipcRenderer.on('engine', (_event, message) => callback(message)),
  onOverlay: (callback) => ipcRenderer.on('overlay', (_event, on) => callback(on)),
});
