const sidebarsEl = document.getElementById('sidebars')
const bg = document.getElementById('bg')
const title = document.getElementById('title')
const badge = document.getElementById('badge')
const launchBtn = document.getElementById('launch')
const killBtn = document.getElementById('kill')
// const quitBtn = document.getElementById('quit')

const reseauEl = document.getElementById('reseau')
const batterieEl = document.getElementById('batterie')

const audio = new Audio()
audio.loop = true

/* ---------- Fond + musique différés avec fondu ---------- */

const START_DELAY = 3000
const FADE_MS = 200
const MUSIC_VOLUME = 0.1

bg.style.opacity = '0'
bg.style.transition = `opacity ${FADE_MS}ms ease`

let startTimer = null
let fadeRaf = null
let swapTimer = null

function fadeAudio(from, to, duration, done) {
  cancelAnimationFrame(fadeRaf)
  const t0 = performance.now()

  const step = (now) => {
    const k = Math.min(1, (now - t0) / duration)
    audio.volume = Math.max(0, Math.min(1, from + (to - from) * k))
    if (k < 1) {
      fadeRaf = requestAnimationFrame(step)
    } else if (done) {
      done()
    }
  }
  fadeRaf = requestAnimationFrame(step)
}

function fadeOutMedia(done) {
  if (!audio.paused && audio.src) {
    fadeAudio(audio.volume, 0, FADE_MS, () => {
      audio.pause()
      if (done) done()
    })
  } else if (done) {
    swapTimer = setTimeout(done, FADE_MS)
  }
}

function fadeInMedia(app) {
  bg.style.backgroundImage = app.background ? `url("${app.background}")` : 'none'
  void bg.offsetWidth

  if (app.music) {
    audio.src = app.music
    audio.volume = 0
    audio.play()
      .then(() => fadeAudio(0, MUSIC_VOLUME, FADE_MS))
      .catch(() => {})
  }
}

function scheduleMedia(app) {
  clearTimeout(startTimer)
  clearTimeout(swapTimer)

  // fadeOutMedia()
  bg.style.backgroundImage = app.background ? `url("${app.background}")` : 'none'

  startTimer = setTimeout(() => {
    const current = activeApp()
    if (current && current.id === app.id) {
      // fadeInMedia(app)
    }
  }, START_DELAY)
}

let apps = []
const status = {}
let groups = []
let activeGroup = 0

/* ---------- Helpers ---------- */

function activeApp() {
  const g = groups[activeGroup]
  if (!g) return null
  return g.apps.find(a => a.id === g.currentId) || null
}

/* ---------- Affichage ---------- */

function renderDetail() {
  const app = activeApp()
  if (!app) return

  const st = status[app.id] || 'stopped'
  // badge.className = 'badge ' + st
  // badge.textContent = st === 'running' ? 'En cours' : st === 'error' ? 'Erreur' : 'Arrêté'

  launchBtn.disabled = st === 'running'
  killBtn.disabled = st !== 'running'
}

function renderItems() {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    g.el.classList.toggle('active', i === activeGroup)

    for (const el of g.el.children) {
      el.classList.toggle('running', status[el.dataset.id] === 'running')
      el.classList.toggle('active', el.dataset.id === g.currentId)
    }
  }
}

/* ---------- Affichage de l'état système ---------- */

function formatBattery(b) {
  if (!b || b.hasBattery === false) return '🔋 N/A'
  if (b.percent == null) return '🔋 …'

  let icon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M160-240q-50 0-85-35t-35-85v-240q0-50 35-85t85-35h540q50 0 85 35t35 85v240q0 50-35 85t-85 35H160Zm700-140v-200h20q17 0 28.5 11.5T920-540v120q0 17-11.5 28.5T880-380h-20Z"/></svg>'

  if (b.percent <= 20) {
    icon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M160-240q-50 0-85-35t-35-85v-240q0-50 35-85t85-35h540q50 0 85 35t35 85v240q0 50-35 85t-85 35H160Zm0-80h540q17 0 28.5-11.5T740-360v-240q0-17-11.5-28.5T700-640H160q-17 0-28.5 11.5T120-600v240q0 17 11.5 28.5T160-320Zm700-60v-200h20q17 0 28.5 11.5T920-540v120q0 17-11.5 28.5T880-380h-20Zm-740 60v-320 320Z"/></svg>'
  } else if (b.isCharging) {
    icon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M160-240q-50 0-85-35t-35-85v-240q0-50 35-85t85-35h562l-64 80H160q-17 0-28.5 11.5T120-600v240q0 17 11.5 28.5T160-320h473l-15 80H160Zm547-40 28-160H600l192-240h21l-28 160h135L728-280h-21Zm-547-80v-240h466L434-360H160Z"/></svg>'
  }
  return `${icon}`
}

function formatNetwork(n, wifi) {
  if (!n || !n.connected) return '❌ Hors ligne'
  if (n.type === 'wired') return `🔌 Ethernet${n.speed ? ` · ${n.speed} Mbps` : ''}`

  if (n.type === 'wireless') {
    if (wifi && wifi.connected && wifi.signalLevel != null) {
      const s = wifi.signalLevel
      let bars = '▁'
      if (s >= -60) {
        bars = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M409-149q-29-29-29-71t29-71q29-29 71-29t71 29q29 29 29 71t-29 71q-29 29-71 29t-71-29ZM254-346l-84-86q59-59 138.5-93.5T480-560q92 0 171.5 35T790-430l-84 84q-44-44-102-69t-124-25q-66 0-124 25t-102 69ZM84-516 0-600q92-94 215-147t265-53q142 0 265 53t215 147l-84 84q-77-77-178.5-120.5T480-680q-116 0-217.5 43.5T84-516Z"/></svg>'
      } else if (s >= -70) {
        bars = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M409-149q-29-29-29-71t29-71q29-29 71-29t71 29q29 29 29 71t-29 71q-29 29-71 29t-71-29ZM254-346l-84-86q59-59 138.5-93.5T480-560q92 0 171.5 35T790-430l-84 84q-44-44-102-69t-124-25q-66 0-124 25t-102 69Z"/></svg>'
      } else {
        bars = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M409-149q-29-29-29-71t29-71q29-29 71-29t71 29q29 29 29 71t-29 71q-29 29-71 29t-71-29Z"/></svg>'
      }
      return `${bars}`
    }
    return '📶 Wi-Fi'
  }
  return '🌐 ' + (n.type || 'Réseau')
}

function renderSystemStatus(s) {
  if (!s) return
  if (batterieEl) {
    batterieEl.innerHTML = formatBattery(s.battery)
    batterieEl.dataset.level = s.battery?.percent == null ? 'unknown' : s.battery.percent <= 15 ? 'critical' : s.battery.percent <= 30 ? 'low' : 'ok'
  }
  if (reseauEl) {
    reseauEl.innerHTML = formatNetwork(s.network, s.wifi)
    reseauEl.dataset.type = s.network?.type || 'offline'
  }
}

/* ---------- Carrousels ---------- */

function updateCarousel(g) {
  if (!g || !g.currentId) return
  const el = g.el.querySelector(`[data-id="${CSS.escape(g.currentId)}"]`)
  const first = g.el.firstElementChild
  if (!el || !first) return

  const offset = Math.max(0, el.offsetLeft - first.offsetLeft)

  for (const item of g.el.children) {
    item.style.transform = `translateX(${-offset}px)`
  }
}

function updateVerticalCarousel() {
  if (!groups.length) return
  sidebarsEl.style.transform = 'translateY(0px)'
  void sidebarsEl.offsetHeight 

  const active = groups[activeGroup].el
  if (!active) return

  const targetBottom = sidebarsEl.getBoundingClientRect().bottom
  const activeBottom = active.getBoundingClientRect().bottom
  const offset = targetBottom - activeBottom

  sidebarsEl.style.transform = `translateY(${offset}px)`
}

function updateAllCarousels() {
  for (const g of groups) {
    updateCarousel(g)
  }
  updateVerticalCarousel()
}

/* ---------- Sélection ---------- */

function selectInGroup(groupIdx, appId) {
  const g = groups[groupIdx]
  if (!g) return

  const app = g.apps.find(a => a.id === appId)
  if (!app) return

  g.currentId = appId
  activeGroup = groupIdx
  title.textContent = app.titre

  scheduleMedia(app)
  renderItems()
  renderDetail()
  updateCarousel(g)
  updateVerticalCarousel()
}

function moveGroup(delta) {
  if (groups.length < 2) return
  const next = Math.max(0, Math.min(groups.length - 1, activeGroup + delta))
  const g = groups[next]
  if (!g.currentId) return
  selectInGroup(next, g.currentId)
}

function moveItem(delta) {
  const g = groups[activeGroup]
  if (!g || !g.apps.length) return

  const i = g.apps.findIndex(a => a.id === g.currentId)
  const next = Math.max(0, Math.min(g.apps.length - 1, i + delta))
  selectInGroup(activeGroup, g.apps[next].id)
}

function navUp() {
  groups.length > 1 // ? moveGroup(-1) : moveItem(-1)
}

function navDown() {
  groups.length > 1 // ? moveGroup(1) : moveItem(1)
}

/* ---------- Actions ---------- */

function launchCurrent() {
  const app = activeApp()
  if (app && status[app.id] !== 'running') {
    window.api.launch(app.id)
  }
}

const pending = {}

function confirmThen(key, button, confirmLabel, action) {
  action()
  return
  if (pending[key]) {
    clearTimeout(pending[key].timer)
    button.textContent = pending[key].original
    delete pending[key]
    action()
    return
  }

  const original = button.textContent
  button.textContent = confirmLabel

  pending[key] = {
    original,
    timer: setTimeout(() => {
      button.textContent = original
      delete pending[key]
    }, 2000)
  }
}

function killCurrent() {
  const app = activeApp()
  if (!app || status[app.id] !== 'running') return
  confirmThen('kill', killBtn, 'Confirmer ?', () => window.api.kill(app.id))
}

function quit() {
  confirmThen('quit', quitBtn, 'Confirmer ?', () => window.api.quit())
}

/* ---------- Clavier ---------- */

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); navUp(); break
    case 'ArrowDown': e.preventDefault(); navDown(); break
    case 'ArrowLeft': e.preventDefault(); moveItem(-1); break
    case 'ArrowRight': e.preventDefault(); moveItem(1); break
    case 'Enter':
    case 'a':
    case 'A':
    case ' ':
      e.preventDefault(); if (!e.repeat) launchCurrent(); break
    case 'Delete':
    case 'Backspace':
    case 'x':
    case 'X':
      e.preventDefault(); if (!e.repeat) killCurrent(); break
    case 'Escape':
    case 'q':
    case 'Q':
      e.preventDefault(); if (!e.repeat) quit(); break
  }
})

/* ---------- Manette & Indications de touches ---------- */

const REPEAT_DELAY = 400
const REPEAT_RATE = 120
const STICK_THRESHOLD = 0.6
const held = {}
const repeatState = {}

function pressedEdge(name, isDown) {
  const was = !!held[name]
  held[name] = isDown
  return isDown && !was
}

function directionRepeat(name, isDown, now, callback) {
  const st = repeatState[name]
  if (!isDown) {
    delete repeatState[name]
    return
  }
  if (!st) {
    repeatState[name] = { next: now + REPEAT_DELAY }
    callback()
  } else if (now >= st.next) {
    st.next = now + REPEAT_RATE
    callback()
  }
}

/* --- Détection et mise à jour des hints --- */
let currentPadType = null;

function updateHints(type) {
  if (currentPadType === type) return;
  currentPadType = type;

  const hints = {
    launch: document.getElementById('hint-launch'),
    kill: document.getElementById('hint-kill'),
    quit: document.getElementById('hint-quit'),
    rescan: document.getElementById('hint-rescan')
  };

  let svgs = {};

  if (type === 'xbox') {
    svgs = {
      launch: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#107C10"/><text x="12" y="16" font-size="14" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">A</text></svg>',
      kill: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#003791"/><text x="12" y="16" font-size="14" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">X</text></svg>',
      quit: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#E41B17"/><text x="12" y="16" font-size="14" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">B</text></svg>',
      rescan: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FFB900"/><text x="12" y="16" font-size="14" font-family="sans-serif" font-weight="bold" fill="#000" text-anchor="middle">Y</text></svg>'
    };
  } else if (type === 'playstation') {
    svgs = {
      launch: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><path d="M11 11l10 10m0-10L11 21" stroke="#000" stroke-width="2.5"/></svg>',
      kill: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><rect x="11.25" y="11.25" width="9.5" height="9.5" stroke="#000" stroke-width="2.5"/></svg>',
      quit: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><circle cx="16" cy="16" r="5.75" stroke="#000" stroke-width="2.5"/></svg>',
      rescan: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><path d="M16 10.5L21.5 20h-11z" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/></svg>',
    };
  } else {
    svgs = {
      launch: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><path d="M11 11l10 10m0-10L11 21" stroke="#000" stroke-width="2.5"/></svg>',
      kill: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><rect x="11.25" y="11.25" width="9.5" height="9.5" stroke="#000" stroke-width="2.5"/></svg>',
      quit: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><circle cx="16" cy="16" r="5.75" stroke="#000" stroke-width="2.5"/></svg>',
      rescan: '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle class="icon-bg" cx="16" cy="16" r="12" fill="currentColor"/><path d="M16 10.5L21.5 20h-11z" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/></svg>',
    };
  }

  if (hints.launch) hints.launch.innerHTML = svgs.launch;
  if (hints.kill) hints.kill.innerHTML = svgs.kill;
  if (hints.quit) hints.quit.innerHTML = svgs.quit;
  if (hints.rescan) hints.rescan.innerHTML = svgs.rescan;
}

function pollGamepads(now) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : []
  let connectedPad = null;

  for (const pad of pads) {
    if (!pad || !pad.connected) continue
    connectedPad = pad;

    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed)
    const ay = pad.axes[1] || 0
    const ax = pad.axes[0] || 0

    const left = b(14) || ax < -STICK_THRESHOLD
    const right = b(15) || ax > STICK_THRESHOLD
    const up = b(12) || ay < -STICK_THRESHOLD
    const down = b(13) || ay > STICK_THRESHOLD

    directionRepeat('left', left, now, () => moveItem(-1))
    directionRepeat('right', right, now, () => moveItem(1))
    directionRepeat('up', up, now, () => navUp())
    directionRepeat('down', down, now, () => navDown())

    if (pressedEdge('launch', b(0))) launchCurrent()
    if (pressedEdge('kill', b(2))) killCurrent()
    if (pressedEdge('quit', b(9) || b(8))) quit()
  }

  // Détection du type de manette
  if (connectedPad) {
    const id = connectedPad.id.toLowerCase();
    if (id.includes('xbox') || id.includes('xinput')) {
      updateHints('xbox');
    } else if (id.includes('playstation') || id.includes('dualshock') || id.includes('dualsense') || id.includes('054c')) {
      updateHints('playstation');
    } else {
      updateHints('keyboard');
    }
  } else {
    updateHints('keyboard');
  }

  requestAnimationFrame(pollGamepads)
}

window.addEventListener('gamepadconnected', (e) => {
  console.log('Manette connectée :', e.gamepad.id)
})

requestAnimationFrame(pollGamepads)

/* ---------- Construction de l'UI ---------- */

function createItem(app, groupIdx) {
  if (app.icon == '') app.icon = 'assets/icons/default.png'

  const item = document.createElement('div')
  item.className = 'item'
  item.dataset.id = app.id
  item.title = app.titre

  const icon = document.createElement('div')
  icon.className = 'icon'

  if (app.icon) {
    icon.style.backgroundImage = `url("${app.icon}")`
  } else {
    icon.classList.add('no-icon')
  }

  item.appendChild(icon)

  const dot = document.createElement('span')
  dot.className = 'dot'
  icon.appendChild(dot)

  item.addEventListener('click', () => {
    selectInGroup(groupIdx, app.id)
  })

  return item
}

function rebuild(list) {
  apps = list || []
  sidebarsEl.innerHTML = ''

  for (const k of Object.keys(status)) {
    delete status[k]
  }

  groups = []
  activeGroup = 0
  const map = new Map()

  for (const app of apps) {
    const gname = app.group || 'Applications'
    if (!map.has(gname)) map.set(gname, [])
    map.get(gname).push(app)
  }

  for (const [name, groupApps] of map) {
    const el = document.createElement('section')
    el.className = 'sidebar'
    el.dataset.group = name
    sidebarsEl.appendChild(el)

    const groupObj = {
      name,
      apps: groupApps,
      currentId: groupApps[1] ? groupApps[1].id : null,
      el,
    }

    const gi = groups.length
    groups.push(groupObj)

    for (const app of groupApps) {
      status[app.id] = app.running ? 'running' : 'stopped'
      el.appendChild(createItem(app, gi))
    }
  }

  if (groups.length && groups[0].currentId) {
    selectInGroup(0, groups[0].currentId)
  } else {
    title.textContent = ''
    clearTimeout(startTimer)
    fadeOutMedia()
    // badge.className = 'badge stopped'
    // badge.textContent = 'Arrêté'
    launchBtn.disabled = true
    killBtn.disabled = true
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(updateAllCarousels)
  })
}

/* ---------- Initialisation ---------- */

async function init() {
  bg.style.opacity = '1'
  window.api.onStatus(({ id, status: st }) => {
    status[id] = st
    renderItems()
    renderDetail()
  })

  window.api.onAppsUpdated((list) => {
    console.log('[scan] liste mise à jour :', list.length, 'app(s)')
    rebuild(list)
  })

  window.api.onSystemStatus((s) => {
    renderSystemStatus(s)
  })

  launchBtn.addEventListener('click', launchCurrent)
  killBtn.addEventListener('click', killCurrent)
  // quitBtn.addEventListener('click', quit)

  for (const btn of [launchBtn, killBtn]) {
    btn.addEventListener('mouseup', () => btn.blur())
  }

  window.addEventListener('resize', updateAllCarousels)
  window.addEventListener('load', updateAllCarousels)

  const [list, sys] = await Promise.all([
    window.api.getApps(),
    window.api.getSystemStatus()
  ])

  rebuild(list)
  renderSystemStatus(sys)

  // Initialisation de l'affichage des touches (clavier par défaut si pas de manette)
  updateHints('keyboard');
}

init()