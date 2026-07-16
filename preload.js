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
  getAccounts: () => ipcRenderer.invoke('email:getAccounts'),
  addAccount: (config) => ipcRenderer.invoke('email:addAccount', config),
  updateAccountCatchAll: (id, catchAllDomains) => ipcRenderer.invoke('email:updateAccountCatchAll', { id, catchAllDomains }),
  removeAccount: (id) => ipcRenderer.invoke('email:removeAccount', { id }),
  resetTracking: (id) => ipcRenderer.invoke('email:resetTracking', { id }),
  sync: (opts) => ipcRenderer.invoke('email:sync', opts)
});

contextBridge.exposeInMainWorld('updaterAPI', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  onStatus: (callback) => ipcRenderer.on('updater:status', (evt, payload) => callback(payload))
});
