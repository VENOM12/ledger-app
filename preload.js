const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  getStatus: () => ipcRenderer.invoke('license:getStatus'),
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', { licenseKey }),
  revalidate: () => ipcRenderer.invoke('license:revalidate')
});

contextBridge.exposeInMainWorld('shellAPI', {
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
});

contextBridge.exposeInMainWorld('emailAPI', {
  getAccountInfo: () => ipcRenderer.invoke('email:getAccountInfo'),
  testAndSave: (config) => ipcRenderer.invoke('email:testAndSave', config),
  updateCatchAll: (config) => ipcRenderer.invoke('email:updateCatchAll', config),
  resetTracking: () => ipcRenderer.invoke('email:resetTracking'),
  disconnect: () => ipcRenderer.invoke('email:disconnect'),
  resetTracking: () => ipcRenderer.invoke('email:resetTracking'),
  sync: (opts) => ipcRenderer.invoke('email:sync', opts)
});

contextBridge.exposeInMainWorld('updaterAPI', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  onStatus: (callback) => ipcRenderer.on('updater:status', (evt, payload) => callback(payload))
});
