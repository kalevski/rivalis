'use client'

import { Heading, Text, Badge, Card, Icon, CodeSnippet } from '@toolcase/react-components'

const topologies = [
    {
        icon: <Icon name={'diagram-3' as never} />,
        title: 'Full mesh',
        body: 'Every peer connects to every other peer directly, and Rivalis is used only for discovery. No node is in charge.',
        useWhen: 'Use it when you are building a small chat or co-op game with up to 10 peers.'
    },
    {
        icon: <Icon name={'broadcast-pin' as never} />,
        title: 'Host star',
        body: 'One peer becomes the host and everyone else connects only to it. The host relays messages out to the rest — no per-pair links.',
        useWhen: 'Use it when one peer should relay for everyone instead of every pair wiring up.'
    },
    {
        icon: <Icon name={'cpu' as never} />,
        title: 'Host authoritative',
        body: 'One peer runs the actual game: it owns the shared state, applies inputs on a fixed tick, and broadcasts snapshots — including a catch-up sync for late joiners.',
        useWhen: 'Use it when one peer should run the simulation with a tick loop and late-join sync.'
    }
]

const swapCode = `// game.ts — the room code is identical; only the client class changes.
import { WSClient, RTCClient } from '@rivalis/browser'

// Before — classic client/server: every frame is routed through your server.
const client = new WSClient('wss://eu1.game.example.com', { reconnect: true })

// After — peer-to-peer: your server only helps peers find each other,
// then frames travel directly between players.
const client = new RTCClient('wss://signal.game.example.com', { reconnect: true })

// Everything below stays exactly the same — same ticket, same topics.
await client.connect(ticket)                     // ticket: "roomId|playerName"
client.on('chat', (payload) => render(decode(payload)))
client.send('chat', encode({ text: 'gg!' }))`

export function P2pSection() {
    return (
        <section id="p2p" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">PEER-TO-PEER</Badge>
                    <Heading as="h2" gradient>
                        Let players talk directly.
                    </Heading>
                    <Text as="p" variant="muted">
                        With WebRTC peer-to-peer, players connect straight to each other instead of routing every frame through your server. Your server only helps peers find each other once — after that the game traffic skips it entirely. That means <strong>near-zero hosting cost</strong> and <strong>lower latency</strong>, which is exactly what casual and co-op games want.
                    </Text>
                </div>

                <div className="row justify-content-center">
                    <div className="col-12 col-lg-10">
                        <div className="text-center mx-auto mb-4" style={{ maxWidth: 760 }}>
                            <Heading as="h3">Same room, one-line switch.</Heading>
                            <Text as="p" variant="muted">
                                The room code does not change. Swap <code>WSClient</code> for <code>RTCClient</code> and point it at a <code>@rivalis/signal</code> server — the ticket and topics stay identical.
                            </Text>
                        </div>
                        <CodeSnippet code={swapCode} language="typescript" />
                    </div>
                </div>

                <div className="text-center mx-auto mt-5 mb-4" style={{ maxWidth: 760 }}>
                    <Heading as="h3">Three ways to wire peers together.</Heading>
                    <Text as="p" variant="muted">
                        Pick the topology that fits your game — from a simple mesh to a single peer running the whole simulation.
                    </Text>
                </div>

                <div className="row g-4 justify-content-center mt-2">
                    {topologies.map((t) => (
                        <div key={t.title} className="col-12 col-lg-4">
                            <Card>
                                <div className="px-3 py-3 h-100 d-flex flex-column">
                                    <div className="mb-2">{t.icon}</div>
                                    <Heading as="h3">{t.title}</Heading>
                                    <Text as="p" variant="muted" size="small">{t.body}</Text>
                                    <div className="mt-auto">
                                        <Text as="p" size="small">
                                            <strong>{t.useWhen}</strong>
                                        </Text>
                                    </div>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>

                <div className="text-center mx-auto mt-4" style={{ maxWidth: 760 }}>
                    <Text as="p" variant="muted" size="small">
                        A browser host is great for casual and co-op play. For competitive games you still want an authoritative server — keep those rooms on <code>@rivalis/core</code>. MIT, same wire protocol either way.
                    </Text>
                </div>
            </div>
        </section>
    )
}
