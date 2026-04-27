import { WSClient } from '@rivalis/browser'
import {
    encode,
    decode,
    type Player,
    type MoveCommand,
    type ChatCommand,
    type StateSnapshot,
    type PlayerJoinEvent,
    type PlayerLeaveEvent,
    type PlayerMoveEvent,
    type ChatEvent
} from '../protocol'

const SERVER_URL = `ws://${location.hostname}:2334`

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const loginEl = $<HTMLElement>('login')
const gameEl = $<HTMLElement>('game')
const loginForm = $<HTMLFormElement>('login-form')
const nameInput = $<HTMLInputElement>('name')
const colorInput = $<HTMLInputElement>('color')
const meEl = $<HTMLElement>('me')
const connStatusEl = $<HTMLElement>('conn-status')
const leaveBtn = $<HTMLButtonElement>('leave')
const canvas = $<HTMLCanvasElement>('canvas')
const ctx = canvas.getContext('2d')!
const presenceList = $<HTMLElement>('presence-list')
const presenceCount = $<HTMLElement>('presence-count')
const chatLog = $<HTMLElement>('chat-log')
const chatForm = $<HTMLFormElement>('chat-form')
const chatInput = $<HTMLInputElement>('chat-input')

let client: WSClient | null = null
let myId: string | null = null

// Authoritative target positions from the server.
const players = new Map<string, Player>()
// Smoothed positions used for rendering; lerp toward `players` each frame.
const renderPositions = new Map<string, { x: number, y: number }>()

loginForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = nameInput.value.trim()
    const color = colorInput.value
    if (!name) return

    const ticket = `${name}|${color}`
    client = new WSClient(SERVER_URL)

    client.on('client:connect', () => {
        connStatusEl.textContent = 'connected'
        connStatusEl.style.color = '#7eff7e'
        loginEl.hidden = true
        gameEl.hidden = false
        meEl.innerHTML = ''
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.style.background = color
        meEl.append(dot, document.createTextNode(name))
        startRenderLoop()
    }, null)

    client.on('client:disconnect', (payload) => {
        const reason = new TextDecoder().decode(payload as Uint8Array)
        connStatusEl.textContent = `disconnected${reason ? `: ${reason}` : ''}`
        connStatusEl.style.color = '#ff7e7e'
    }, null)

    client.on('state', (payload) => {
        const snapshot = decode<StateSnapshot>(payload as Uint8Array)
        myId = snapshot.youId
        players.clear()
        renderPositions.clear()
        for (const p of snapshot.players) {
            players.set(p.id, p)
            renderPositions.set(p.id, { x: p.x, y: p.y })
        }
        updatePresence()
    }, null)

    client.on('player:join', (payload) => {
        const p = decode<PlayerJoinEvent>(payload as Uint8Array)
        players.set(p.id, p)
        renderPositions.set(p.id, { x: p.x, y: p.y })
        updatePresence()
        appendSystemChat(`${p.name} joined`)
    }, null)

    client.on('player:leave', (payload) => {
        const { id } = decode<PlayerLeaveEvent>(payload as Uint8Array)
        const p = players.get(id)
        players.delete(id)
        renderPositions.delete(id)
        updatePresence()
        if (p) appendSystemChat(`${p.name} left`)
    }, null)

    client.on('player:move', (payload) => {
        const { id, x, y } = decode<PlayerMoveEvent>(payload as Uint8Array)
        const player = players.get(id)
        if (player) { player.x = x; player.y = y }
    }, null)

    client.on('chat', (payload) => {
        appendChat(decode<ChatEvent>(payload as Uint8Array))
    }, null)

    client.connect(ticket)
})

leaveBtn.addEventListener('click', () => {
    client?.disconnect()
    location.reload()
})

canvas.addEventListener('click', (e) => {
    if (!client) return
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (canvas.width / rect.width)
    const y = (e.clientY - rect.top) * (canvas.height / rect.height)
    const cmd: MoveCommand = { x, y }
    client.send('move', encode(cmd))
})

chatForm.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!client) return
    const text = chatInput.value.trim()
    if (!text) return
    const cmd: ChatCommand = { text }
    client.send('chat', encode(cmd))
    chatInput.value = ''
})

function updatePresence() {
    presenceCount.textContent = String(players.size)
    presenceList.innerHTML = ''
    for (const p of players.values()) {
        const li = document.createElement('li')
        if (p.id === myId) li.classList.add('me')
        const dot = document.createElement('span')
        dot.className = 'dot'
        dot.style.background = p.color
        const name = document.createElement('span')
        name.textContent = p.name
        li.append(dot, name)
        presenceList.append(li)
    }
}

function appendChat(event: ChatEvent) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'name'
    name.style.color = event.color
    name.textContent = event.name + ':'
    const text = document.createTextNode(' ' + event.text)
    const ts = document.createElement('span')
    ts.className = 'ts'
    ts.textContent = new Date(event.t).toLocaleTimeString()
    li.append(name, text, ts)
    chatLog.append(li)
    chatLog.scrollTop = chatLog.scrollHeight
}

function appendSystemChat(text: string) {
    const li = document.createElement('li')
    li.className = 'system'
    li.textContent = text
    chatLog.append(li)
    chatLog.scrollTop = chatLog.scrollHeight
}

function startRenderLoop() {
    const draw = () => {
        // Lerp render positions toward authoritative targets.
        for (const [id, target] of players) {
            const current = renderPositions.get(id)
            if (!current) {
                renderPositions.set(id, { x: target.x, y: target.y })
                continue
            }
            current.x += (target.x - current.x) * 0.15
            current.y += (target.y - current.y) * 0.15
        }

        ctx.fillStyle = '#16161e'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        ctx.strokeStyle = '#22222e'
        ctx.lineWidth = 1
        for (let x = 0; x <= canvas.width; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
        }
        for (let y = 0; y <= canvas.height; y += 40) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
        }

        for (const player of players.values()) {
            const pos = renderPositions.get(player.id) ?? player
            ctx.fillStyle = player.color
            ctx.beginPath()
            ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2)
            ctx.fill()
            ctx.strokeStyle = player.id === myId ? '#fff' : 'rgba(255,255,255,0.4)'
            ctx.lineWidth = player.id === myId ? 2.5 : 1
            ctx.stroke()

            ctx.fillStyle = '#fff'
            ctx.font = '12px system-ui, sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText(player.name, pos.x, pos.y - 22)
        }

        requestAnimationFrame(draw)
    }
    draw()
}
