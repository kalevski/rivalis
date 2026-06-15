import { WSClient } from '@rivalis/browser'
import './style.css'
import {
    encode,
    decode,
    MAZE,
    COLS,
    ROWS,
    TILE,
    allPelletIndices,
    type Dir,
    type InputCommand,
    type GameState,
    type PlayerState,
    type GhostState,
    type WelcomeEvent,
    type PelletEvent,
    type DeathEvent
} from '../protocol'

// ---- dom ---------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const loginForm = $<HTMLFormElement>('login')
const nameInput = $<HTMLInputElement>('name')
const gameEl = $<HTMLDivElement>('game')
const statusEl = $<HTMLSpanElement>('status')
const scoresEl = $<HTMLOListElement>('scores')
const canvas = $<HTMLCanvasElement>('board')
const ctx = canvas.getContext('2d')!

canvas.width = COLS * TILE
canvas.height = ROWS * TILE

// ---- local mirror of the authoritative state ---------------------------

let youId = ''
let players: PlayerState[] = []
let ghosts: GhostState[] = []
let pellets = new Set<number>(allPelletIndices())

// Eased render positions so 30 Hz server updates look smooth at 60 fps.
// Ghosts are keyed by `g<id>`, players by their actor id.
type RenderPos = { x: number; y: number }
const renderPos = new Map<string, RenderPos>()
const ghostKey = (id: number): string => `g${id}`

// Brief red flash on a Pac-Man that was just caught.
const deathFlash = new Map<string, number>()

// ---- networking --------------------------------------------------------

// The WebSocket server always listens on :2335 (the game server), whether the
// page itself is served by Vite on :5173 (dev) or by the game server (built).
const WS_URL = `ws://${location.hostname}:2335`

let client: WSClient | null = null
let sentDir: Dir = 'none'

const setStatus = (text: string): void => { statusEl.textContent = text }

function join(name: string, color: string): void {
    const ws = new WSClient(WS_URL)
    client = ws

    ws.on('client:connect', () => setStatus('connected — go!'), null)

    ws.on('client:disconnect', (payload: Uint8Array) => {
        const reason = new TextDecoder().decode(payload)
        setStatus(`disconnected${reason ? `: ${reason}` : ''}`)
    }, null)

    ws.on('welcome', (payload: Uint8Array) => {
        const welcome = decode<WelcomeEvent>(payload)
        youId = welcome.youId
        // Reconcile our freshly-built full board with pellets already eaten.
        pellets = new Set<number>(allPelletIndices())
        for (const index of welcome.eaten) pellets.delete(index)
    }, null)

    ws.on('state', (payload: Uint8Array) => {
        const state = decode<GameState>(payload)
        players = state.players
        ghosts = state.ghosts
        syncRenderTargets()
        renderScores()
    }, null)

    ws.on('pellet', (payload: Uint8Array) => {
        const event = decode<PelletEvent>(payload)
        pellets.delete(event.index)
    }, null)

    ws.on('reset', () => {
        pellets = new Set<number>(allPelletIndices())
    }, null)

    ws.on('death', (payload: Uint8Array) => {
        const event = decode<DeathEvent>(payload)
        deathFlash.set(event.id, performance.now())
    }, null)

    // Ticket is `name|color` — see PacmanAuthMiddleware.
    ws.connect(`${name}|${color}`)
}

/** Drop render-position entries for entities that have left. */
function syncRenderTargets(): void {
    const live = new Set<string>()
    for (const p of players) live.add(p.id)
    for (const g of ghosts) live.add(ghostKey(g.id))
    for (const key of renderPos.keys()) {
        if (!live.has(key)) renderPos.delete(key)
    }
}

// ---- input -------------------------------------------------------------

const KEY_DIRS: Record<string, Dir> = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
}

window.addEventListener('keydown', (e) => {
    const dir: Dir | undefined = KEY_DIRS[e.code]
    if (dir === undefined) return
    e.preventDefault()
    if (dir === sentDir) return // only send intent on change — keeps traffic tiny
    sentDir = dir
    const cmd: InputCommand = { dir }
    client?.send('input', encode(cmd))
})

// ---- rendering ---------------------------------------------------------

const WALL = '#2121de'
const WALL_EDGE = '#4a4aff'
const PELLET = '#ffd9a0'

/** Move a render position a fraction of the way toward its target, snapping
 *  on big jumps (tunnel wrap) so entities don't streak across the board. */
function ease(key: string, tx: number, ty: number): RenderPos {
    let pos = renderPos.get(key)
    if (pos === undefined) {
        pos = { x: tx, y: ty }
        renderPos.set(key, pos)
        return pos
    }
    if (Math.hypot(tx - pos.x, ty - pos.y) > 2) {
        pos.x = tx
        pos.y = ty
    } else {
        pos.x += (tx - pos.x) * 0.35
        pos.y += (ty - pos.y) * 0.35
    }
    return pos
}

function drawMaze(): void {
    for (let y = 0; y < ROWS; y++) {
        const row = MAZE[y]!
        for (let x = 0; x < COLS; x++) {
            if (row[x] !== '#') continue
            const px = x * TILE
            const py = y * TILE
            ctx.fillStyle = WALL
            ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4)
            ctx.strokeStyle = WALL_EDGE
            ctx.lineWidth = 2
            ctx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4)
        }
    }
}

function drawPellets(): void {
    ctx.fillStyle = PELLET
    for (const index of pellets) {
        const x = index % COLS
        const y = Math.floor(index / COLS)
        const cx = (x + 0.5) * TILE
        const cy = (y + 0.5) * TILE
        const isPower = MAZE[y]![x] === 'o'
        ctx.beginPath()
        ctx.arc(cx, cy, isPower ? 6 : 2.5, 0, Math.PI * 2)
        ctx.fill()
    }
}

function drawPac(p: PlayerState, t: number): void {
    const pos = ease(p.id, p.x, p.y)
    const cx = (pos.x + 0.5) * TILE
    const cy = (pos.y + 0.5) * TILE
    const r = TILE * 0.42

    // Animated mouth; angle of opening keyed to direction.
    const open = (Math.sin(t / 90) * 0.5 + 0.5) * 0.32 + 0.04
    const base: Record<Dir, number> = {
        right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2, none: 0
    }
    const facing = base[p.dir]

    const flashed = (deathFlash.get(p.id) ?? 0) > t - 600
    ctx.fillStyle = flashed ? '#ff5555' : p.color
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r, facing + open * Math.PI, facing - open * Math.PI + Math.PI * 2)
    ctx.closePath()
    ctx.fill()

    // Name tag + "you" marker.
    ctx.fillStyle = p.id === youId ? '#ffffff' : '#c7ccdd'
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(p.id === youId ? `${p.name} (you)` : p.name, cx, cy - r - 4)
}

function drawGhost(g: GhostState): void {
    const pos = ease(ghostKey(g.id), g.x, g.y)
    const cx = (pos.x + 0.5) * TILE
    const cy = (pos.y + 0.5) * TILE
    const r = TILE * 0.42

    ctx.fillStyle = g.color
    ctx.beginPath()
    ctx.arc(cx, cy - r * 0.1, r, Math.PI, 0)
    // Wavy skirt.
    const bottom = cy + r * 0.9
    ctx.lineTo(cx + r, bottom)
    const feet = 3
    for (let i = 0; i < feet; i++) {
        const x1 = cx + r - ((i * 2 + 1) * r) / feet
        const x2 = cx + r - ((i * 2 + 2) * r) / feet
        ctx.lineTo(x1, bottom - r * 0.28)
        ctx.lineTo(x2, bottom)
    }
    ctx.closePath()
    ctx.fill()

    // Eyes, looking in the travel direction.
    const look: Record<Dir, { x: number; y: number }> = {
        up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
        left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, none: { x: 0, y: 0 }
    }
    const dir = look[g.dir]
    for (const dx of [-0.42, 0.42]) {
        const ex = cx + dx * r
        const ey = cy - r * 0.25
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(ex, ey, r * 0.26, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#1414aa'
        ctx.beginPath()
        ctx.arc(ex + dir.x * r * 0.12, ey + dir.y * r * 0.12, r * 0.13, 0, Math.PI * 2)
        ctx.fill()
    }
}

function renderScores(): void {
    const sorted = [...players].sort((a, b) => b.score - a.score)
    scoresEl.replaceChildren(...sorted.map((p) => {
        const li = document.createElement('li')
        if (p.id === youId) li.className = 'me'
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.style.background = p.color
        li.append(dot, document.createTextNode(`${p.name}: ${p.score}`))
        return li
    }))
}

function frame(t: number): void {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    drawMaze()
    drawPellets()
    for (const g of ghosts) drawGhost(g)
    for (const p of players) drawPac(p, t)
    requestAnimationFrame(frame)
}

requestAnimationFrame(frame)

// ---- bootstrap ---------------------------------------------------------

const PALETTE = ['#ffe14d', '#7cf6a0', '#7cc4ff', '#ff9ad5', '#ffae5c', '#c79bff']

loginForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = nameInput.value.trim() || `player-${Math.floor(Math.random() * 900 + 100)}`
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]!
    loginForm.hidden = true
    gameEl.hidden = false
    canvas.focus()
    join(name, color)
})
