'use client'

import { CodeSnippet, Heading, Text, TabSections } from '@toolcase/react-components'
import type { TabSectionItem } from '@toolcase/react-components'

const installCode = `npm install @rivalis/core ws @toolcase/base @toolcase/logging @toolcase/serializer
npm install @rivalis/browser   # in your client app`

const serverCode = `import http from 'http'
import {
    Rivalis, Transports, Room, AuthMiddleware,
    type AuthResult, type Actor
} from '@rivalis/core'

type ActorData = { name: string }

class ChatRoom extends Room<ActorData> {
    protected override presence = true

    protected override onCreate() {
        this.bind('chat', this.onChat)
    }

    private onChat(actor: Actor<ActorData>, payload: Uint8Array) {
        this.broadcast('chat', payload)
    }
}

class Auth extends AuthMiddleware<ActorData> {
    override async authenticate(ticket: string): Promise<AuthResult<ActorData> | null> {
        const name = ticket.trim()
        if (!name || name.length > 20) return null
        return { data: { name }, roomId: 'global' }
    }
}

const server = http.createServer()
const rivalis = new Rivalis<ActorData>({
    transports: [new Transports.WSTransport({ server })],
    authMiddleware: new Auth()
})
rivalis.rooms.define('chat', ChatRoom)
rivalis.rooms.create('chat', 'global')

server.listen(8080)
process.on('SIGINT', async () => { await rivalis.shutdown(); process.exit(0) })`

const clientCode = `import { WSClient } from '@rivalis/browser'

const ws = new WSClient('ws://localhost:8080', { reconnect: true })
const encoder = new TextEncoder()
const decoder = new TextDecoder()

ws.on('client:connect', () => console.log('connected'))
ws.on('client:kicked', ({ code, reason }) => console.log('kicked', code, reason))
ws.on('chat', (payload) => console.log('chat:', decoder.decode(payload)))

ws.connect('alice')
ws.send('chat', encoder.encode('hello world'))`

const tabs: TabSectionItem[] = [
    {
        key: 'install',
        label: 'Install',
        content: <CodeSnippet language="bash" code={installCode} />
    },
    {
        key: 'server',
        label: 'Server (Node.js)',
        content: <CodeSnippet language="typescript" code={serverCode} />
    },
    {
        key: 'client',
        label: 'Browser client',
        content: <CodeSnippet language="typescript" code={clientCode} />
    }
]

export function QuickStartSection() {
    return (
        <section id="quick-start" className="section">
            <div className="section__head">
                <span className="section__eyebrow">/// QUICK START</span>
                <Heading as="h2" gradient>
                    A chat server in 30 lines.
                </Heading>
                <Text as="p" variant="muted">
                    Bind topics. Broadcast bytes. Ship a multiplayer feature this afternoon.
                </Text>
            </div>
            <div className="code-wrap">
                <TabSections items={tabs} defaultActiveKey="server" />
            </div>
        </section>
    )
}
