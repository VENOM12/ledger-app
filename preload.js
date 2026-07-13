const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('emailAPI', {
  getAccountInfo: () => ipcRenderer.invoke('email:getAccountInfo'),
  testAndSave: (config) => ipcRenderer.invoke('email:testAndSave', config),
  updateCatchAll: (config) => ipcRenderer.invoke('email:updateCatchAll', config),
  disconnect: () => ipcRenderer.invoke('email:disconnect'),
  sync: (opts) => ipcRenderer.invoke('email:sync', opts)
});

contextBridge.exposeInMainWorld('updaterAPI', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  onStatus: (callback) => ipcRenderer.on('updater:status', (evt, payload) => callback(payload))
});
