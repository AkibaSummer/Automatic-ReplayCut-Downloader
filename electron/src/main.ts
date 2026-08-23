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
const hasSingleInstanceLock = app.requestSingleInstanceLock()

async function createMainWindowShell() {
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

  // Keep the window alive while the final database checkpoint runs. If saving
  // fails, the user can resolve the filesystem issue and retry quitting instead
  // of being left with a headless process and no way to trigger another attempt.
  mainWindow.on('close', event => {
    if (backendStop && !isQuitting) {
      event.preventDefault()
      app.quit()
    }
  })

  // Intercept window.open() calls from the renderer —
  // open external URLs (e.g. Feishu OAuth) in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const startupHTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html,body{height:100%;margin:0;background:#f1f5f9;color:#0f172a;font-family:"Microsoft YaHei UI",system-ui,sans-serif}
      body{display:grid;place-items:center}.card{display:flex;align-items:center;gap:18px;padding:28px 34px;background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 18px 50px #0f172a18}
      .spinner{width:30px;height:30px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:spin .9s linear infinite}
      h1{font-size:18px;margin:0 0 6px}p{font-size:13px;color:#64748b;margin:0}@keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><div class="card"><div class="spinner"></div><div><h1>随缘公会工作台正在启动</h1><p>正在加载存量数据库，请稍候…</p></div></div></body></html>`
  await mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(startupHTML)}`)
}

async function loadMainApplication() {
  if (!mainWindow) throw new Error('Main window was not created')
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
  // Packaged builds are portable: keep config/database resolution anchored to
  // the executable instead of the caller's current working directory.
  const baseDir = isDev ? process.cwd() : path.dirname(process.execPath)
  // Paint a real startup surface before reading/parsing a potentially very
  // large portable database. Users should never stare at a blank window while
  // old M3U8 payloads or a slow disk are being loaded.
  await createMainWindowShell()
  const backend = await startDesktopBackend({ baseDir })
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

  await loadMainApplication()
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    void boot().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[main] Failed to start:', error)
      dialog.showErrorBox('Application failed to start', message)
      app.quit()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

let isQuitting = false

app.on('before-quit', (e) => {
  if (backendStop && !isQuitting) {
    e.preventDefault()
    isQuitting = true
    backendStop().then(() => {
      backendStop = null
      app.quit()
    }).catch(error => {
      isQuitting = false
      const message = error instanceof Error ? error.message : String(error)
      console.error('[main] Failed to persist data while quitting:', error)
      dialog.showErrorBox('Unable to save application data', `${message}\n\nPlease free disk space or close programs locking the database, then quit again.`)
    })
  }
})
