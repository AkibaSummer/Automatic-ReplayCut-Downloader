import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { startDesktopBackend } from './backend'

// Prevent crashes from uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason)
})

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
      preload: isDev
        ? path.join(__dirname, '..', '..', 'electron-dist', 'preload.js')
        : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Intercept window.open() calls from the renderer —
  // open external URLs (e.g. Feishu OAuth) in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
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
  ipcMain.handle('desktop:pick-folder', async (_event, defaultPath?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined,
      title: 'Select Output Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  await createMainWindow()
}

app.whenReady().then(() => {
  void boot()
})

app.on('window-all-closed', () => {
  app.quit()
})

let isQuitting = false

app.on('before-quit', (e) => {
  if (backendStop && !isQuitting) {
    e.preventDefault()
    isQuitting = true
    backendStop().finally(() => {
      backendStop = null
      app.quit()
    })
  }
})
