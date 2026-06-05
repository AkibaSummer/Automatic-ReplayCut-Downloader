import path from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import { startDesktopBackend } from './backend'

let mainWindow: BrowserWindow | null = null
let backendStop: (() => Promise<void>) | null = null
let backendBaseURL = ''

const isDev = !app.isPackaged

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  const distIndex = path.join(__dirname, '..', 'frontend', 'dist', 'index.html')
  if (isDev) {
    try {
      await mainWindow.loadURL('http://127.0.0.1:5173')
      mainWindow.webContents.openDevTools({ mode: 'detach' })
      return
    } catch {
      await mainWindow.loadFile(distIndex)
      return
    }
  }
  await mainWindow.loadFile(distIndex)
}

async function boot() {
  const backend = await startDesktopBackend({ baseDir: process.cwd() })
  backendBaseURL = backend.baseURL
  backendStop = backend.stop

  ipcMain.handle('desktop:get-backend-base-url', () => backendBaseURL)
  ipcMain.handle('desktop:quit-app', () => {
    app.quit()
  })

  await createMainWindow()
}

app.whenReady().then(() => {
  void boot()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (backendStop) {
    void backendStop()
    backendStop = null
  }
})
