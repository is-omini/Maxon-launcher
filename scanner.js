// scanner.js — Détection automatique des jeux (macOS / Windows / Linux)
// Ordre : Steam → Epic → Ubisoft → EA → scan disques
const fs = require('fs/promises')
const fss = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileP = promisify(execFile)

const IS_MAC   = process.platform === 'darwin'
const IS_WIN   = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'

// ---------- utilitaires ----------
async function safeReaddir(dir, opts) {
  try { return await fs.readdir(dir, opts) } catch { return [] }
}
async function safeRead(p) {
  try { return await fs.readFile(p, 'utf-8') } catch { return null }
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Parseur minimal de Valve KeyValues (.vdf / .acf)
function parseVDF(text) {
  const tokens = []
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g
  let m
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) tokens.push({ t: 'str', v: m[1].replace(/\\(.)/g, '$1') })
    else tokens.push({ t: m[2] })
  }
  let i = 0
  function parseObject() {
    const obj = {}
    while (i < tokens.length) {
      const tk = tokens[i]
      if (tk.t === '}') { i++; return obj }
      if (tk.t === 'str') {
        const key = tk.v; i++
        const nx = tokens[i]
        if (!nx) return obj
        if (nx.t === 'str') { obj[key] = nx.v; i++ }
        else if (nx.t === '{') { i++; obj[key] = parseObject() }
        else i++
      } else i++
    }
    return obj
  }
  if (tokens.length >= 2 && tokens[0].t === 'str' && tokens[1].t === '{') {
    const key = tokens[0].v
    i = 2
    return { [key]: parseObject() }
  }
  i = 0
  return parseObject()
}

function resolveLaunchPath(installPath, name) {
  try {
    if (IS_MAC) {
      const entries = fss.readdirSync(installPath)
      const apps = entries.filter(e => e.endsWith('.app'))
      if (apps.length) {
        const match = apps.find(a => slugify(a.replace(/\.app$/i, '')) === slugify(name))
        return path.join(installPath, match || apps[0])
      }
      return installPath
    }
    if (IS_WIN) {
      const entries = fss.readdirSync(installPath)
      const bad = /unins|setup|install|crash|report|helper|vcredist|dxsetup/i
      const exes = entries.filter(e => e.toLowerCase().endsWith('.exe') && !bad.test(e))
      if (exes.length) {
        const match = exes.find(a => slugify(a.replace(/\.exe$/i, '')) === slugify(name))
        return path.join(installPath, match || exes[0])
      }
      for (const e of entries) {
        try {
          const sub = path.join(installPath, e)
          if (!fss.statSync(sub).isDirectory()) continue
          const subExes = fss.readdirSync(sub).filter(f => f.toLowerCase().endsWith('.exe') && !bad.test(f))
          if (subExes.length) return path.join(sub, subExes[0])
        } catch {}
      }
      return installPath
    }
    if (IS_LINUX) {
      const entries = fss.readdirSync(installPath)
      const sh = entries.find(e => e.endsWith('.sh'))
      if (sh) return path.join(installPath, sh)
      try {
        const bin = path.join(installPath, 'bin')
        const binEntries = fss.readdirSync(bin).filter(e => !e.includes('.'))
        for (const e of binEntries) {
          const full = path.join(bin, e)
          try { fss.accessSync(full, fss.constants.X_OK); return full } catch {}
        }
      } catch {}
    }
  } catch {}
  return installPath
}

// ============================================================
// ENRICHISSEMENT : icônes locales, fonds Steam, descriptions
// ============================================================
const ICONS_DIR = path.join(__dirname, 'assets', 'icons', 'detected')
const DESCRIPTIONS_CACHE = path.join(__dirname, 'data', 'descriptions.json')

function ensureDir(d) { try { fss.mkdirSync(d, { recursive: true }) } catch {} }

// Lecture d'une clé d'un Info.plist (XML ou binaire) via plutil
async function readPlistValue(plistPath, key) {
  try {
    const { stdout } = await execFileP('plutil', [
      '-extract', key, 'raw', '-o', '-', plistPath
    ])
    return stdout.trim() || null
  } catch { return null }
}

// Cache des descriptions (appid → texte)
async function loadDescriptionCache() {
  try { return JSON.parse(fss.readFileSync(DESCRIPTIONS_CACHE, 'utf-8')) } catch { return {} }
}
async function saveDescriptionCache(cache) {
  ensureDir(path.dirname(DESCRIPTIONS_CACHE))
  try { fss.writeFileSync(DESCRIPTIONS_CACHE, JSON.stringify(cache, null, 2)) } catch {}
}

// Throttle pour respecter les rate limits de l'API Steam
let lastFetchTs = 0
async function throttledFetch(url) {
  const wait = Math.max(0, 200 - (Date.now() - lastFetchTs))
  if (wait) await new Promise(r => setTimeout(r, wait))
  lastFetchTs = Date.now()
  return fetch(url)
}

// Description courte via l'API publique du store Steam
async function fetchSteamDescription(appid, cache) {
  if (!appid) return null
  if (cache[appid]) return cache[appid]
  try {
    const res = await throttledFetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=french&filters=short_description`
    )
    const json = await res.json()
    const desc = json?.[appid]?.data?.short_description
    if (desc) { cache[appid] = desc; return desc }
  } catch {}
  return null
}

// URLs CDN Steam (pas de téléchargement : le renderer les charge directement)
function steamIcon(appid) {
  return appid ? `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/header.jpg` : ''
}
function steamBackground(appid) {
  return appid ? `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_hero.jpg` : ''
}

// Extraction de l'icône macOS (.icns → .png via sips)
async function extractMacIcon(appPath) {
  ensureDir(ICONS_DIR)
  const slug = slugify(path.basename(appPath, '.app'))
  const outPath = path.join(ICONS_DIR, `${slug}.png`)
  if (fss.existsSync(outPath)) return `assets/icons/detected/${slug}.png`

  const resDir = path.join(appPath, 'Contents', 'Resources')
  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  let icnsPath = null

  // 1. via CFBundleIconFile
  const iconName = await readPlistValue(plistPath, 'CFBundleIconFile')
  if (iconName) {
    const fn = iconName.endsWith('.icns') ? iconName : iconName + '.icns'
    const p = path.join(resDir, fn)
    if (fss.existsSync(p)) icnsPath = p
  }

  // 2. fallback : premier .icns du dossier Resources
  if (!icnsPath) {
    try {
      const e = fss.readdirSync(resDir).find(n => n.endsWith('.icns'))
      if (e) icnsPath = path.join(resDir, e)
    } catch {}
  }

  if (!icnsPath) return null

  // 3. conversion via sips (built-in macOS)
  try {
    await execFileP('sips', ['-s', 'format', 'png', '-Z', '256', icnsPath, '--out', outPath])
    if (fss.existsSync(outPath)) return `assets/icons/detected/${slug}.png`
  } catch {}
  return null
}

// Extraction de l'icône Windows (.exe → .png via PowerShell)
async function extractWinIcon(exePath) {
  ensureDir(ICONS_DIR)
  const slug = slugify(path.basename(exePath, '.exe'))
  const outPath = path.join(ICONS_DIR, `${slug}.png`)
  if (fss.existsSync(outPath)) return `assets/icons/detected/${slug}.png`

  const script = `
Add-Type -AssemblyName System.Drawing
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${JSON.stringify(exePath)})
  $bmp = $icon.ToBitmap()
  $bmp.Save(${JSON.stringify(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
} catch {}
`
  try {
    await execFileP('powershell', ['-NoProfile', '-Command', script])
    if (fss.existsSync(outPath)) return `assets/icons/detected/${slug}.png`
  } catch {}
  return null
}

async function extractLocalIcon(gamePath) {
  try {
    if (IS_MAC) return await extractMacIcon(gamePath)
    if (IS_WIN) return await extractWinIcon(gamePath)
    return null
  } catch { return null }
}
// ============================================================

// ---------- STEAM ----------
async function findSteamLibraries() {
  const candidates = []
  if (IS_MAC) {
    candidates.push(path.join(os.homedir(), 'Library/Application Support/Steam'))
  } else if (IS_WIN) {
    candidates.push('C:\\Program Files (x86)\\Steam')
    candidates.push('C:\\Program Files\\Steam')
  } else if (IS_LINUX) {
    candidates.push(path.join(os.homedir(), '.steam/steam'))
    candidates.push(path.join(os.homedir(), '.local/share/Steam'))
  }
  const libs = []
  for (const c of candidates) {
    const vdf = path.join(c, 'steamapps', 'libraryfolders.vdf')
    if (!fss.existsSync(vdf)) continue
    libs.push(c)
    const txt = await safeRead(vdf)
    if (!txt) continue
    const data = parseVDF(txt)
    const folders = data?.libraryfolders || data
    for (const k of Object.keys(folders)) {
      if (/^\d+$/.test(k)) {
        const v = folders[k]
        const p = typeof v === 'string' ? v : v?.path
        if (p && fss.existsSync(p)) libs.push(p)
      }
    }
  }
  return [...new Set(libs)]
}

async function scanSteam() {
  const games = []
  const descCache = await loadDescriptionCache()
  const libs = await findSteamLibraries()

  for (const lib of libs) {
    const appsDir = path.join(lib, 'steamapps')
    for (const f of await safeReaddir(appsDir)) {
      if (!f.startsWith('appmanifest_') || !f.endsWith('.acf')) continue
      const txt = await safeRead(path.join(appsDir, f))
      if (!txt) continue
      const st = parseVDF(txt)?.AppState
      if (!st?.name || !st?.installdir) continue
      const installPath = path.join(appsDir, 'common', st.installdir)
      if (!fss.existsSync(installPath)) continue

      const appid = st.appid
      const description = await fetchSteamDescription(appid, descCache)

      games.push({
        id: slugify(`steam-${appid || st.name}`),
        titre: st.name,
        description: description || 'Jeu Steam détecté automatiquement',
        icon: steamIcon(appid),
        background: steamBackground(appid),
        music: '',
        path: resolveLaunchPath(installPath, st.name),
        group: 'Steam'
      })
    }
  }

  await saveDescriptionCache(descCache)
  return games
}

async function scanDisk(onProgress) {
  const games = []
  const seen = new Set()
  const push = (g) => { if (!seen.has(g.path)) { seen.add(g.path); games.push(g) } }

  if (IS_MAC) {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')]
    for (const v of await safeReaddir('/Volumes')) roots.push(path.join('/Volumes', v, 'Applications'))

    for (const r of roots) {
      for (const e of await safeReaddir(r, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.endsWith('.app')) continue
        const full = path.join(r, e.name)
        if (await isGameMacApp(full)) {
          const name = e.name.replace(/\.app$/i, '')
          const icon = await extractMacIcon(full)
          push({
            id: slugify(`disk-${name}`),
            titre: name,
            description: 'Jeu détecté automatiquement',
            icon: icon || '',
            background: '',
            music: '',
            path: full,
            group: 'Détecté'
          })
        }
      }
    }
  } else if (IS_WIN) {
    const drives = []
    for (let i = 67; i <= 90; i++) {
      const d = String.fromCharCode(i) + ':\\'
      if (fss.existsSync(d)) drives.push(d)
    }
    const subFolders = ['Games', 'Jeux', 'GOG Games']
    for (const d of drives) {
      for (const sn of subFolders) {
        const root = path.join(d, sn)
        if (!fss.existsSync(root)) continue
        onProgress?.(`Scan disque : ${root}`)
        await walkWinForExes(root, 4, async (exePath, name) => {
          const icon = await extractWinIcon(exePath)
          push({
            id: slugify(`disk-${name}`),
            titre: name,
            description: 'Jeu détecté automatiquement',
            icon: icon || '',
            background: '',
            music: '',
            path: exePath,
            group: 'Détecté'
          })
        })
      }
    }
  } else if (IS_LINUX) {
    const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')]
    for (const d of dirs) {
      for (const f of await safeReaddir(d)) {
        if (!f.endsWith('.desktop')) continue
        const txt = await safeRead(path.join(d, f))
        if (!txt || !/Categories=.*Game/.test(txt)) continue
        const nameM = txt.match(/^Name=(.+)$/m)
        const execM = txt.match(/^Exec=(.+)$/m)
        if (!nameM || !execM) continue
        const exec = execM[1].split(/\s+/)[0].replace(/%[a-zA-Z]/g, '').trim()
        push({
          id: slugify(`disk-${nameM[1]}`),
          titre: nameM[1],
          description: 'Jeu détecté automatiquement',
          icon: '',
          background: '',
          music: '',
          path: exec,
          group: 'Détecté'
        })
      }
    }
  }
  return games
// (ferme scanDisk si ce n'est pas déjà fait — sinon ignore ces 2 lignes)
}

// ---------- SCAN DISQUE (suite) ----------
const MAC_SYSTEM_APPS = new Set([
  'finder','safari','mail','messages','maps','photos','music','tv','podcasts',
  'calendar','contacts','notes','reminders','preview','calculator','terminal',
  'activity monitor','system preferences','system settings','app store','launchpad',
  'mission control','keynote','numbers','pages','imovie','garageband','xcode',
  'utilities','time machine','voice memos','stickies','font book','screenshot',
  'photo booth','quicktime player','facetime','books','news','stocks','home',
  'shortcuts','siri','find my','passwords','freeform','weather','clock',
  'disk utility','color meter','digital color meter','grapher','keychain access',
  'migration assistant','script editor','system information','wireless diagnostics',
  'audio midi setup','airport utility','ticket viewer','boot camp assistant',
  'screen sharing','remote login','print center','bluetooth file exchange',
  'accessibility','voiceover'
])

const KNOWN_GAME_BUNDLE_IDS = [
  /^com\.mojang\.minecraft/i,
  /^com\.mojang\./i,
  /^unity\./i,
  /^com\.unity3d\./i,
  /^com\.epicgames\./i,
  /^com\.valvesoftware\./i,
  /^com\.blizzard\./i,
  /^com\.ubisoft\./i,
  /^com\.ea\./i,
  /^com\.rockstargames\./i,
  /^com\.bethesda\./i,
  /^com\.steampowered\./i,
  /^com\.roblox\./i,
]

const GAME_NAME_HINTS = /(game|jeu|minecraft|roblox|devil|quest|adventure|platformer|shooter|rpg|puzzle|racing|sports?|fighting|strategy|simulator|sim\b|sandbox|arcade|runner)/i

async function isGameMacApp(appPath) {
  const name = path.basename(appPath, '.app')
  const lower = name.toLowerCase()

  if (MAC_SYSTEM_APPS.has(lower)) return false
  if (process.env.DEBUG_SCAN) console.log('[scan] app testée :', name)

  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  if (!fss.existsSync(plistPath)) return false

  const category = await readPlistValue(plistPath, 'LSApplicationCategoryType')
  if (category && /public\.app-category\.(.+games?)/i.test(category)) return true

  const bundleId = await readPlistValue(plistPath, 'CFBundleIdentifier')
  if (bundleId && KNOWN_GAME_BUNDLE_IDS.some(re => re.test(bundleId))) return true

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks')
  if (fss.existsSync(frameworksDir)) {
    try {
      const entries = fss.readdirSync(frameworksDir)
      if (entries.some(e =>
        /^(UnityPlayer|Unreal|GameMaker|Godot|Cocos|libmono|libil2cpp|_CodeSignature_unity)/i.test(e)
      )) return true
    } catch {}
  }

  try {
    const { stdout } = await execFileP('du', ['-sm', appPath])
    const sizeMb = parseInt(stdout.split(/\s+/)[0], 10)
    if (sizeMb > 500) return true
  } catch {}

  if (GAME_NAME_HINTS.test(name)) return true

  return false
}

const WIN_SKIP = /^(Windows|System32|SysWOW64|WinSxS|node_modules|\.git|AppData|ProgramData|Microsoft|Common Files|WindowsApps|Installer|Temp|Cache|Logs)$/i

async function walkWinForExes(dir, depth, onGame) {
  if (depth <= 0) return
  const entries = await safeReaddir(dir, { withFileTypes: true })
  if (!entries.length) return
  const bad = /unins|setup|install|crash|report|helper|vcredist|dxsetup|readme/i
  const exes = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !bad.test(e.name))
  if (exes.length) {
    const folder = path.basename(dir)
    const match = exes.find(e => slugify(e.name.replace(/\.exe$/i, '')) === slugify(folder))
    await onGame(path.join(dir, (match || exes[0]).name), folder)
  }
  for (const e of entries) {
    if (!e.isDirectory() || WIN_SKIP.test(e.name)) continue
    await walkWinForExes(path.join(dir, e.name), depth - 1, onGame)
  }
}

// ---------- EPIC ----------
async function scanEpic() {
  const games = []
  const dirs = []
  if (IS_WIN) dirs.push('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests')
  else if (IS_MAC) dirs.push(path.join(os.homedir(), 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'))
  else if (IS_LINUX) dirs.push(path.join(os.homedir(), '.local/share/Epic/EpicGamesLauncher/Data/Manifests'))
  for (const dir of dirs) {
    for (const f of await safeReaddir(dir)) {
      if (!f.endsWith('.item')) continue
      const txt = await safeRead(path.join(dir, f))
      if (!txt) continue
      let j
      try { j = JSON.parse(txt) } catch { continue }
      if (!j?.DisplayName || !j?.InstallLocation) continue
      if (!fss.existsSync(j.InstallLocation)) continue
      const icon = await extractLocalIcon(j.InstallLocation)
      games.push({
        id: slugify(`epic-${j.CatalogItemId || j.DisplayName}`),
        titre: j.DisplayName,
        description: 'Jeu Epic Games détecté automatiquement',
        icon: icon || '',
        background: '',
        music: '',
        path: resolveLaunchPath(j.InstallLocation, j.DisplayName),
        group: 'Epic Games'
      })
    }
  }
  return games
}

// ---------- UBISOFT ----------
async function scanUbisoft() {
  const games = []
  if (IS_WIN) {
    const regs = [
      'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
      'HKCU\\Software\\Ubisoft\\Launcher\\Installs'
    ]
    for (const rp of regs) {
      try {
        const { stdout } = await execFileP('reg', ['query', rp, '/s'])
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/InstallDir\s+REG_SZ\s+(.+)$/i)
          if (!m) continue
          const loc = m[1].trim()
          if (!fss.existsSync(loc)) continue
          const name = path.basename(loc)
          const icon = await extractLocalIcon(loc)
          games.push({
            id: slugify(`ubisoft-${name}`),
            titre: name,
            description: 'Jeu Ubisoft détecté automatiquement',
            icon: icon || '',
            background: '',
            music: '',
            path: resolveLaunchPath(loc, name),
            group: 'Ubisoft'
          })
        }
      } catch {}
    }
  }
  if (IS_MAC) {
    const known = /assassin|far.?cry|rainbow.?six|ghost.?recon|watch.?dogs|the.?division|prince.?of.?persia|splinter.?cell|rayman|trackmania|anno|the.?crew|for.?honor|ubisoft|child.?of.?light|valiant.?hearts|mario.?\+\s?rabbids/i
    for (const a of await safeReaddir('/Applications')) {
      if (!a.endsWith('.app') || !known.test(a)) continue
      const name = a.replace(/\.app$/i, '')
      const full = path.join('/Applications', a)
      const icon = await extractMacIcon(full)
      games.push({
        id: slugify(`ubisoft-${name}`),
        titre: name,
        description: 'Jeu Ubisoft détecté automatiquement',
        icon: icon || '',
        background: '',
        music: '',
        path: full,
        group: 'Ubisoft'
      })
    }
  }
  return games
}

// ---------- EA ----------
async function scanEA() {
  const games = []
  if (IS_WIN) {
    const dirs = [
      'C:\\Program Files\\EA Games',
      'C:\\Program Files (x86)\\EA Games',
      'C:\\Program Files\\Electronic Arts',
      'C:\\Program Files (x86)\\Electronic Arts',
      'C:\\Program Files\\Origin Games',
      'C:\\Program Files (x86)\\Origin Games'
    ]
    for (const d of dirs) {
      for (const e of await safeReaddir(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const loc = path.join(d, e.name)
        const icon = await extractLocalIcon(loc)
        games.push({
          id: slugify(`ea-${e.name}`),
          titre: e.name,
          description: 'Jeu EA détecté automatiquement',
          icon: icon || '',
          background: '',
          music: '',
          path: resolveLaunchPath(loc, e.name),
          group: 'EA'
        })
      }
    }
  }
  if (IS_MAC) {
    const known = /the.?sims|battlefield|need.?for.?speed|\bfc\s?\d|fifa|madden|apex|it.?takes.?two|a.?way.?out|star.?wars.?squadrons|titanfall|origin|ea.?app|electronic.?arts|dead.?space|mass.?effect|dragon.?age|anthem|plants.?vs.?zombies/i
    for (const a of await safeReaddir('/Applications')) {
      if (!a.endsWith('.app') || !known.test(a)) continue
      const name = a.replace(/\.app$/i, '')
      const full = path.join('/Applications', a)
      const icon = await extractMacIcon(full)
      games.push({
        id: slugify(`ea-${name}`),
        titre: name,
        description: 'Jeu EA détecté automatiquement',
        icon: icon || '',
        background: '',
        music: '',
        path: full,
        group: 'EA'
      })
    }
  }
  return games
}

// ---------- Orchestrateur ----------
async function scanAll({ onProgress } = {}) {
  const detected = []
  const seen = new Set()
  const add = (games) => {
    for (const g of games) {
      if (seen.has(g.path)) continue
      seen.add(g.path)
      detected.push(g)
    }
  }

  onProgress?.('Recherche Steam…')
  try { add(await scanSteam()) } catch (e) { console.error('[scan] Steam', e) }

  onProgress?.('Recherche Epic Games…')
  try { add(await scanEpic()) } catch (e) { console.error('[scan] Epic', e) }

  onProgress?.('Recherche Ubisoft…')
  try { add(await scanUbisoft()) } catch (e) { console.error('[scan] Ubisoft', e) }

  onProgress?.('Recherche EA…')
  try { add(await scanEA()) } catch (e) { console.error('[scan] EA', e) }

  onProgress?.('Scan des disques…')
  try { add(await scanDisk(onProgress)) } catch (e) { console.error('[scan] Disk', e) }

  return detected
}

module.exports = { scanAll }