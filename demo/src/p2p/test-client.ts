/**
 * Minimal P2P test client for Playwright end-to-end tests (p2p.md §10).
 *
 * Accepts URL search params:
 *   ?ticket=<roomId>|<name>|<color>   Player identity + room (default: ttt|player|#000000)
 *   ?port=<number>                    Signal server port        (default: 9000)
 *
 * Exposes on window:
 *   __gameState   — last received TttState (null until first event)
 *   __connected   — true once the data channel is open
 *   __error       — last error/kick reason, or null
 *   __place(i)    — send a `place` command to the game host
 *
 * Playwright uses waitForFunction() on __gameState and evaluate() on __place.
 */

import { RTCClient } from '@rivalis/browser'
import { decode, encode } from '../protocol'
import type { TttState, TttPlaceCommand } from '../protocol'
import type { ClientKickedEvent } from '@rivalis/core'
import { SIGNAL_PORT } from './protocol'

// ── URL params ────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search)
const ticket = params.get('ticket') ?? `ttt|player|#000000`
const port = Number(params.get('port') ?? String(SIGNAL_PORT))
const signalUrl = `ws://${location.hostname}:${port}`

// ── Window surface for Playwright ─────────────────────────────────────────────

// Augment Window so TypeScript is happy.
declare global {
    interface Window {
        __gameState: TttState | null
        __connected: boolean
        __error: string | null
        __place: (index: number) => void
    }
}

window.__gameState = null
window.__connected = false
window.__error = null

// ── DOM helpers ───────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status')!
const stateEl = document.getElementById('state')!

function setStatus(msg: string): void {
    statusEl.textContent = msg
}

function applyState(state: TttState): void {
    window.__gameState = state
    stateEl.textContent = JSON.stringify(state, null, 2)
    stateEl.setAttribute('data-status', state.status)
    stateEl.setAttribute('data-board', state.board.map((c) => c ?? '.').join(''))
}

// ── RTCClient ─────────────────────────────────────────────────────────────────

const client = new RTCClient(signalUrl)

window.__place = (index: number): void => {
    if (!window.__connected) return
    const cmd: TttPlaceCommand = { index }
    client.send('place', encode(cmd))
}

client.on('client:connect', () => {
    window.__connected = true
    setStatus('connected')
}, null)

client.on('client:disconnect', (payload) => {
    window.__connected = false
    const reason = new TextDecoder().decode(payload)
    window.__error = reason || 'disconnected'
    setStatus(`disconnected: ${reason}`)
}, null)

client.on('client:kicked', (info: ClientKickedEvent) => {
    window.__connected = false
    window.__error = info.reason
    setStatus(`kicked: ${info.reason}`)
}, null)

client.on('client:error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    window.__error = msg
    setStatus(`error: ${msg}`)
}, null)

client.on('ttt:state', (payload) => {
    applyState(decode<TttState>(payload))
}, null)

// Connect — the same ticket goes to the signal server (for signal-room auth)
// AND will be forwarded as the first binary DC message (§4.2 game-host auth).
client.connect(ticket)
