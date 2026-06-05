import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopAPI', {
  getBackendBaseURL: () => ipcRenderer.invoke('desktop:get-backend-base-url') as Promise<string>,
  quitApp: () => ipcRenderer.invoke('desktop:quit-app') as Promise<void>,
})
