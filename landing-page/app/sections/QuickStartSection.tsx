'use client'

import { useState } from 'react'
import { Badge, Heading, Text, CodeSnippet } from '@toolcase/react-components'
import type { CodeSnippetLanguage } from '@toolcase/react-components'

const serverCode = `// GameRoom.ts
import { Room, type Actor } from '@rivalis/core'

type PlayerData = { name: string; score: number }

export class GameRoom extends Room<PlayerData> {

    protected override presence = true

    protected override onCreate() {
        this.bind('move', this.onMove)
    }

    private onMove(actor: Actor<PlayerData>, payload: Uint8Array) {
        this.broadcast('move', payload)
    }
}`

const clientCode = `// client.ts
import { WSClient } from '@rivalis/browser'

const ws = new WSClient('wss://your-server.com', { reconnect: true })

ws.on('client:connect', () => console.log('connected'))
ws.on('move', (payload) => renderMove(payload))

ws.connect('game-1|alice')
ws.send('move', JSON.stringify({ x: 12, y: 34 }))`

const authCode = `// GameAuthMiddleware.ts
import { AuthMiddleware, type AuthResult } from '@rivalis/core'

type PlayerData = { name: string; score: number }

export class GameAuthMiddleware extends AuthMiddleware<PlayerData> {

    override async authenticate(ticket: string): Promise<AuthResult<PlayerData> | null> {
        const [roomId, name] = ticket.split('|')
        if (!roomId || !name || name.length > 20) {
            return null
        }
        return {
            data: { name, score: 0 },
            roomId
        }
    }
}`

const serverInitCode = `// index.ts
import http from 'http'
import { Rivalis, Transports } from '@rivalis/core'
import { GameAuthMiddleware } from './GameAuthMiddleware'
import { GameRoom } from './GameRoom'

const server = http.createServer()

const rivalis = new Rivalis({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new GameAuthMiddleware()
})

rivalis.rooms.define('game', GameRoom)
rivalis.rooms.create('game', 'game-1')

server.listen(2334, () => console.log('ws → ws://localhost:2334'))

process.on('SIGINT', async () => {
    await rivalis.shutdown()
    process.exit(0)
})`

type Tab = { key: string; label: string; code: string; language: CodeSnippetLanguage }
const tabs: Tab[] = [
    { key: 'server', label: 'GameRoom.ts', code: serverCode, language: 'typescript' },
    { key: 'auth', label: 'GameAuthMiddleware.ts', code: authCode, language: 'typescript' },
    { key: 'init', label: 'index.ts', code: serverInitCode, language: 'typescript' },
    { key: 'client', label: 'client.ts', code: clientCode, language: 'typescript' }
]

export function QuickStartSection() {
    const [activeKey, setActiveKey] = useState<string>(tabs[0].key)
    const active = tabs.find((t) => t.key === activeKey) ?? tabs[0]

    return (
        <section id="code-preview" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">SEE IT IN ACTION</Badge>
                    <Heading as="h2" gradient>
                        Real-time rooms in minutes.
                    </Heading>
                    <Text as="p" variant="muted">
                        Define your room on the server. The client subscribes to topics. Frames flow in both directions over a single binary protocol.
                    </Text>
                </div>

                <div className="row justify-content-center">
                    <div className="col-12 col-lg-10">
                        <div className="component component-tab-sections">
                            <div className="component-tab-sections__header">
                                <div className="component-tab-sections__tabs" role="tablist">
                                    {tabs.map((t) => {
                                        const isActive = t.key === activeKey
                                        return (
                                            <button
                                                key={t.key}
                                                type="button"
                                                role="tab"
                                                aria-selected={isActive}
                                                className={`component-tab-sections__tab${isActive ? ' component-tab-sections__tab--active' : ''}`}
                                                onClick={() => setActiveKey(t.key)}
                                            >
                                                <span className="component-tab-sections__tab-label">{t.label}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                            <div className="component-tab-sections__body" role="tabpanel">
                                <CodeSnippet code={active.code} language={active.language} />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    )
}
