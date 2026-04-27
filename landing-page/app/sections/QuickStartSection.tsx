'use client'

import { useState } from 'react'
import { Heading, Text, Stepper } from '@toolcase/react-components'
import { CodeBlock } from './CodeBlock'

/* ── code samples ─────────────────────────────────────────────────────── */

const installCode = `# server
npm install @rivalis/core ws @toolcase/base @toolcase/logging @toolcase/serializer

# browser / client
npm install @rivalis/browser`

const roomCode = `import { Room, type Actor } from '@rivalis/core'

// 1. Define the shape of data attached to every connected actor.
type PlayerData = { name: string; score: number }

// 2. Extend Room<T> — T is your actor data type.
export class GameRoom extends Room<PlayerData> {

    // Enable built-in join/leave presence events sent to all actors.
    protected override presence = true

    // onCreate runs once when the room is first created.
    protected override onCreate() {
        // Bind a topic string to a handler method.
        // Every inbound frame with topic 'move' calls onMove.
        this.bind('move', this.onMove)
        this.bind('score', this.onScore)
    }

    // onJoin / onLeave run for each actor.
    protected override onJoin(actor: Actor<PlayerData>) {
        // Send initial state only to the joining actor.
        this.send(actor, 'state', new TextEncoder().encode(
            JSON.stringify({ scores: this.getScores() })
        ))
    }

    private onMove(actor: Actor<PlayerData>, payload: Uint8Array) {
        // Broadcast a frame to every actor in this room.
        this.broadcast('move', payload)
    }

    private onScore(actor: Actor<PlayerData>, payload: Uint8Array) {
        actor.data.score += 1
        // Broadcast updated scores to everyone.
        this.broadcast('score', new TextEncoder().encode(
            JSON.stringify({ player: actor.data.name, score: actor.data.score })
        ))
    }

    private getScores() {
        return [...this.actors.values()].map(a => ({ name: a.data.name, score: a.data.score }))
    }
}`

const authCode = `import { AuthMiddleware, type AuthResult } from '@rivalis/core'

// AuthMiddleware<T> validates the ticket sent by the client on connect.
// Return { data, roomId } to allow, or null to reject.
export class Auth extends AuthMiddleware<PlayerData> {

    override async authenticate(ticket: string): Promise<AuthResult<PlayerData> | null> {
        // ticket can be a JWT, an API key, a session token — anything you choose.
        // Here we keep it simple: the ticket IS the player name.
        const name = ticket.trim()
        if (!name || name.length > 24) return null

        return {
            // data is attached to Actor.data — typed as PlayerData everywhere.
            data: { name, score: 0 },
            // roomId tells the framework which room to join the actor into.
            roomId: 'arena'
        }
    }
}`

const serverCode = `import http from 'http'
import { Rivalis, Transports } from '@rivalis/core'
import { GameRoom } from './GameRoom'
import { Auth } from './Auth'

const server = http.createServer()

const rivalis = new Rivalis<PlayerData>({
    // Swap in any Transport — WebSocket ships out of the box.
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new Auth(),
    config: {
        // Kick actors that exceed 60 frames / second.
        rateLimiter: { tokensPerSecond: 60, maxTokens: 120 },
        // Drop connections after 3 missed heartbeats.
        heartbeatIntervalMs: 10_000
    }
})

// Register the room type — identical to a route in Express.
rivalis.rooms.define('game', GameRoom)

// Create a persistent room instance (you can create many).
rivalis.rooms.create('game', 'arena')

server.listen(8080, () => console.log('rivalis listening on :8080'))

// Graceful shutdown — drains rooms before the process exits.
process.on('SIGINT', async () => {
    await rivalis.shutdown({ timeoutMs: 5_000 })
    process.exit(0)
})`

const clientCode = `import { WSClient } from '@rivalis/browser'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// WSClient auto-reconnects with exponential backoff by default.
const ws = new WSClient('ws://localhost:8080', { reconnect: true })

// Lifecycle events
ws.on('client:connect', () => console.log('connected'))
ws.on('client:kicked', ({ code, reason }) => console.log('kicked', code, reason))

// Topic handlers — mirror the topics bound on the server Room.
ws.on('state', (payload) => {
    const state = JSON.parse(decoder.decode(payload))
    console.log('initial state:', state.scores)
})

ws.on('move', (payload) => renderMove(payload))
ws.on('score', (payload) => renderScore(JSON.parse(decoder.decode(payload))))

// The string passed to connect() becomes the ticket in AuthMiddleware.authenticate().
ws.connect('alice')

// Send a move frame — payload is raw bytes, encode however you like.
ws.send('move', encoder.encode(JSON.stringify({ x: 12, y: 34 })))

function renderMove(_payload: Uint8Array) { /* update canvas */ }
function renderScore(_data: unknown) { /* update scoreboard */ }`

/* ── tabs ─────────────────────────────────────────────────────────────── */

type Tab = { key: string; label: string; code: string; language?: 'typescript' | 'bash' }
const tabs: Tab[] = [
    { key: 'install', label: 'Install', code: installCode, language: 'bash' },
    { key: 'room', label: 'Room', code: roomCode },
    { key: 'auth', label: 'Auth', code: authCode },
    { key: 'server', label: 'Server', code: serverCode },
    { key: 'client', label: 'Browser', code: clientCode }
]

/* ── concept steps ────────────────────────────────────────────────────── */

const steps = [
    {
        key: 'room',
        title: 'Define a Room',
        description: 'Extend Room<T>, bind topics to handlers, react to onCreate / onJoin / onLeave / onDestroy.'
    },
    {
        key: 'auth',
        title: 'Authenticate actors',
        description: 'Implement AuthMiddleware — validate a ticket, return typed actor data and roomId, or null to reject.'
    },
    {
        key: 'server',
        title: 'Wire up the server',
        description: 'Pass Transport, auth, and config to Rivalis. Register room types, create instances, listen on any Node.js http.Server.'
    },
    {
        key: 'client',
        title: 'Connect from the browser',
        description: 'WSClient auto-reconnects with backoff. Send a ticket on connect — everything else flows through topic/payload frames.'
    }
]

export function QuickStartSection() {
    const [active, setActive] = useState('room')
    const current = tabs.find((t) => t.key === active) ?? tabs[0]

    return (
        <section id="quick-start" className="section">
            <div className="section__head">
                <span className="section__eyebrow">QUICK START</span>
                <Heading as="h2" gradient>
                    How Rivalis works.
                </Heading>
                <Text as="p" variant="muted">
                    Four building blocks. One coherent mental model. From install to a running multiplayer server in minutes.
                </Text>
            </div>

            {/* Stepper */}
            <Stepper
                steps={steps}
                activeStep="room"
                style={{ marginBottom: 48 }}
            />

            {/* Code tabs */}
            <div className="code-wrap">
                <div className="code-tabs">
                    {tabs.map((t) => (
                        <button
                            key={t.key}
                            className={`code-tabs__btn${active === t.key ? ' code-tabs__btn--active' : ''}`}
                            onClick={() => setActive(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <CodeBlock code={current.code} language={current.language ?? 'typescript'} />
            </div>
        </section>
    )
}
