const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const si = require('systeminformation')
const { scanAll } = require('./scanner')

const DATA_FILE = path.join(__dirname, 'data', 'apps.json')

function loadApps() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function saveApps(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf-8')
}

const running = new Map() // id -> { child, isBundle, startedAt }
let win

// ---------- Tri + état public ----------
function publicApps(list) {
  return list
    .slice()
    .sort((a, b) => (b.lastLaunchedAt || 0) - (a.lastLaunchedAt || 0))
    .map(({ path: _p, args: _a, ...pub }) => ({
      ...pub,
      running: running.has(pub.id)
    }))
}

function sendStatus(id, status, extra = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('app-status', { id, status, ...extra })
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findPids(appPath) {
  return new Promise((resolve) => {
    const pattern = '^' + escapeRegex(appPath) + '/Contents/'
    execFile('pgrep', ['-f', pattern], (err, stdout) => {
      if (err) return resolve([])
      resolve(stdout.split('\n').map(Number).filter(Boolean))
    })
  })
}

function killPids(pids) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

async function forceKill(id) {
  const entry = running.get(id)
  const def = loadApps().find(a => a.id === id)
  if (!entry || !def) return false

  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/T', '/F', '/PID', String(entry.child.pid)]) } catch {}
    return true
  }

  if (entry.isBundle) {
    const pids = await findPids(def.path)
    killPids(pids)
    if (pids.length === 0) entry.child.kill('SIGKILL')
  } else {
    try { process.kill(-entry.child.pid, 'SIGKILL') }
    catch { try { entry.child.kill('SIGKILL') } catch {} }
  }
  return true
}

// ---------- Scan automatique ----------
let scanInProgress = false

function mergeApps(existing, detected) {
  const byPath = new Map(existing.map(a => [a.path, a]))
  const result = existing.slice()

  for (const raw of detected) {
    const { _detected, ...g } = raw
    const found = byPath.get(g.path)

    if (found) {
      let updated = false
      for (const key of ['icon', 'background', 'music']) {
        if (!found[key] && g[key]) { found[key] = g[key]; updated = true }
      }
      if (
        (!found.description || /détecté automatiquement|description/i.test(found.description)) &&
        g.description &&
        !/détecté automatiquement/i.test(g.description)
      ) {
        found.description = g.description
        updated = true
      }
      if (updated && process.env.DEBUG_SCAN) {
        console.log('[merge] champs complétés :', found.titre, '→', {
          icon: found.icon, background: found.background
        })
      }
      continue
    }

    let id = g.id
    let n = 2
    while (result.some(a => a.id === id)) id = `${g.id}-${n++}`
    g.id = id
    result.push(g)
    byPath.set(g.path, g)
  }
  return result
}

async function refreshApps() {
  if (scanInProgress) return
  scanInProgress = true

  const existing = loadApps()
  const notify = (msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('scan-progress', msg)
  }

  try {
    notify('Démarrage du scan…')
    const detected = await scanAll({ onProgress: notify })
    const merged = mergeApps(existing, detected)
    saveApps(merged)
    notify(`Scan terminé — ${detected.length} jeu(x) trouvé(s)`)
    if (win && !win.isDestroyed()) {
      win.webContents.send('apps-updated', publicApps(merged))
    }
  } catch (e) {
    console.error('Scan error', e)
    notify('Erreur pendant le scan')
  } finally {
    scanInProgress = false
  }
}

// ---------- État système (batterie / réseau / Wi-Fi) ----------
const systemStatus = {
  battery: { hasBattery: null, percent: null, isCharging: null, acConnected: null, timeRemaining: null },
  network: { connected: false, type: null, iface: null, speed: null },
  wifi:    { connected: false, ssid: null, signalLevel: null, quality: null },
  updatedAt: null
}

// Sélectionne l'interface réseau active (celle qui a une IPv4 non-loopback et up)
function pickActiveInterface(interfaces) {
  return interfaces.find((i) => {
    if (i.internal) return false
    if (i.operstate && i.operstate !== 'up') return false
    if (!i.ip4 || i.ip4.startsWith('127.')) return false
    return true
  })
}

async function refreshSystemStatus() {
  try {
    const [battery, interfaces] = await Promise.all([
      si.battery().catch(() => ({})),
      si.networkInterfaces().catch(() => [])
    ])

    // Batterie
    systemStatus.battery = {
      hasBattery: battery.hasBattery ?? null,
      percent: battery.percent ?? null,
      isCharging: battery.isCharging ?? null,
      acConnected: battery.acConnected ?? null,
      timeRemaining: battery.timeRemaining ?? null
    }

    // Interface active (wired / wireless)
    const active = pickActiveInterface(interfaces)
    systemStatus.network = {
      connected: !!active,
      type: active ? active.type : null,   // 'wired' | 'wireless'
      iface: active ? active.iface : null,
      speed: active ? active.speed : null
    }

    // Wi-Fi uniquement si l'interface active est sans-fil
    if (active && active.type === 'wireless') {
      try {
        const wifiConns = await si.wifiConnections()
        const current = wifiConns.find((w) => w.ssid && w.ssid.length > 0)
        systemStatus.wifi = {
          connected: !!current,
          ssid: current ? current.ssid : null,
          signalLevel: current ? current.signalLevel : null, // dBm
          quality: current ? current.quality : null          // %
        }
      } catch {
        systemStatus.wifi = { connected: false, ssid: null, signalLevel: null, quality: null }
      }
    } else {
      systemStatus.wifi = { connected: false, ssid: null, signalLevel: null, quality: null }
    }

    systemStatus.updatedAt = Date.now()
  } catch (e) {
    console.error('refreshSystemStatus error:', e)
  }

  if (win && !win.isDestroyed()) {
    win.webContents.send('system-status', systemStatus)
  }
  return systemStatus
}

let statusInterval = null

// ---------- Fond d'écran du bureau ----------
const os = require('os')
const { promisify } = require('util')
const execFileP = promisify(execFile)

let wallpaperCache = null   // { file, mtimeMs, dataUrl }

async function getWallpaperDataUrl() {
  try {
    const { getWallpaper } = await import('wallpaper')   // paquet ESM
    const file = await getWallpaper()
    if (!file) return null

    const stat = await fs.promises.stat(file)
    if (wallpaperCache && wallpaperCache.file === file && wallpaperCache.mtimeMs === stat.mtimeMs) {
      return wallpaperCache.dataUrl
    }

    // sips (macOS) convertit HEIC/PNG/... en JPEG, limité à 2560 px
    const out = path.join(os.tmpdir(), 'launcher-wallpaper.jpg')
    await execFileP('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '85',
      '-Z', '2560',
      file,
      '--out', out
    ])

    const buf = await fs.promises.readFile(out)
    const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64')
    wallpaperCache = { file, mtimeMs: stat.mtimeMs, dataUrl }
    return dataUrl
  } catch (e) {
    console.warn('[wallpaper] indisponible :', e.message)
    return null
  }
}
// ---------- IPC ----------
ipcMain.handle('get-apps', () => publicApps(loadApps()))

ipcMain.handle('rescan-apps', async () => {
  await refreshApps()
  return { ok: true }
})

ipcMain.handle('launch-app', (_e, id) => {
  const list = loadApps()
  const def = list.find(a => a.id === id)
  if (!def) return { ok: false, error: 'Application inconnue' }
  if (running.has(id)) return { ok: false, error: 'Déjà en cours' }

  const isBundle = def.path.endsWith('.app')
  let child

  try {
    if (isBundle) {
      child = spawn('open', ['-W', '-a', def.path], { stdio: 'ignore' })
    } else {
      child = spawn(def.path, def.args || [], { stdio: 'ignore', detached: true })
    }
  } catch (err) {
    sendStatus(id, 'error', { message: err.message })
    return { ok: false, error: err.message }
  }

  def.launchCount = (def.launchCount || 0) + 1
  def.lastLaunchedAt = Date.now()
  saveApps(list)

  const entry = { child, isBundle, startedAt: Date.now() }
  running.set(id, entry)
  sendStatus(id, 'running')

  if (win && !win.isDestroyed()) {
    win.webContents.send('apps-updated', publicApps(list))
  }

  child.once('error', (err) => {
    running.delete(id)
    sendStatus(id, 'error', { message: err.message })
  })

  child.once('exit', (code) => {
    running.delete(id)
    const failedFast = code !== 0 && Date.now() - entry.startedAt < 2000
    sendStatus(id, failedFast ? 'error' : 'stopped')
  })

  return { ok: true }
})

ipcMain.handle('kill-app', async (_e, id) => {
  const ok = await forceKill(id)
  return ok ? { ok: true } : { ok: false, error: 'Pas en cours' }
})

ipcMain.handle('quit-app', () => app.quit())

// ✅ NOUVEAU : endpoint pour récupérer l'état système à la demande
ipcMain.handle('get-system-status', () => refreshSystemStatus())

ipcMain.handle('get-wallpaper', () => getWallpaperDataUrl())

// ---------- Fenêtre ----------
function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.loadFile('html/index.html')
}

app.whenReady().then(() => {
  createWindow()

  // Scan des jeux en arrière-plan
  refreshApps()

  // État système : calcul initial + polling toutes les 5 s
  refreshSystemStatus()
  statusInterval = setInterval(refreshSystemStatus, 5000)

  // Mises à jour immédiates lors des changements secteur/batterie
  powerMonitor.on('on-ac', () => refreshSystemStatus())
  powerMonitor.on('on-battery', () => refreshSystemStatus())
  powerMonitor.on('resume', () => refreshSystemStatus())
})

app.on('before-quit', () => {
  if (statusInterval) clearInterval(statusInterval)
  for (const id of running.keys()) forceKill(id)
})

app.on('window-all-closed', () => app.quit())