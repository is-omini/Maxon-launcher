const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // ... ce que tu as déjà ...
  getApps: () => ipcRenderer.invoke('get-apps'),
  launch:  (id) => ipcRenderer.invoke('launch-app', id),
  kill:    (id) => ipcRenderer.invoke('kill-app', id),
  quit:    () => ipcRenderer.invoke('quit-app'),
  onStatus: (cb) => ipcRenderer.on('app-status', (_e, data) => cb(data)),

  // ➕ nouveaux
  rescan:        () => ipcRenderer.invoke('rescan-apps'),
  onAppsUpdated: (cb) => ipcRenderer.on('apps-updated',   (_e, list) => cb(list)),
  onScanProgress:(cb) => ipcRenderer.on('scan-progress', (_e, msg)  => cb(msg)),

  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),
  onSystemStatus: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('system-status', handler)
    return () => ipcRenderer.removeListener('system-status', handler)
  },

  getWallpaper: () => ipcRenderer.invoke('get-wallpaper'),
})