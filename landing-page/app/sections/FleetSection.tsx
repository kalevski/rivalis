'use client'

import { useState } from 'react'
import { Pipeline, Heading, Text, Badge, Card, Icon, CodeSnippet } from '@toolcase/react-components'
import type { CodeSnippetLanguage } from '@toolcase/react-components'

const steps = [
    {
        num: '01',
        icon: <Icon name={'broadcast-pin' as never} />,
        title: 'Every server checks in',
        sub: 'A tiny FleetAgent embeds in each Rivalis server and reports its rooms, players, and free capacity.',
        state: 'complete' as const
    },
    {
        num: '02',
        icon: <Icon name={'diagram-3' as never} />,
        title: 'The orchestrator keeps the map',
        sub: 'One live view of every server and room across the cluster — rebuilt from check-ins, no database to run.',
        state: 'live' as const
    },
    {
        num: '03',
        icon: <Icon name={'geo-alt' as never} />,
        title: 'Rooms land where they fit',
        sub: 'Ask for a "match room" and the orchestrator picks the least-loaded server, then hands your client the URL to connect to.',
        state: 'default' as const
    }
]

const pieces = [
    {
        icon: <Icon name={'hdd-stack' as never} />,
        title: 'A fleet',
        body: 'Your group of game servers and all the rooms running on them — one logical cluster instead of a pile of separate processes.'
    },
    {
        icon: <Icon name={'diagram-3' as never} />,
        title: 'The Orchestrator',
        body: 'The brain. It knows which servers are alive, what rooms run where, and creates or destroys rooms on any of them — embed it in your own code or run the bundled binary.'
    },
    {
        icon: <Icon name={'robot' as never} />,
        title: 'The FleetAgent',
        body: 'The little reporter inside each server. It tells the orchestrator what it is running and quietly carries out create/destroy commands sent back to it.'
    }
]

const agentCode = `// fleet-agent.ts — embeds in each game server
import { Rivalis } from '@rivalis/core'
import { FleetAgent } from '@rivalis/fleet'
import { MatchRoom } from './MatchRoom'

const rivalis = new Rivalis({ /* transports, authMiddleware */ })
rivalis.rooms.define('match', MatchRoom)

const agent = new FleetAgent(rivalis, {
    url: 'ws://orchestrator.internal:7350',     // where the orchestrator listens
    key: process.env.FLEET_AGENT_KEY!,          // agent key (sent via WS subprotocol)
    endpointUrl: 'wss://eu1.game.example.com',  // URL handed to game clients
    name: 'eu1',
    labels: { region: 'eu' },
    capacity: { maxConnections: 2000, maxRooms: 100 }
})

// reports rooms + capacity, then runs create/destroy commands pushed back to it
await agent.connect()

// SIGTERM → drain → wait until empty → disconnect → rivalis.shutdown()
agent.enableGracefulShutdown({ emptyTimeoutMs: 60_000 })`

const orchestratorCode = `// orchestrator.ts — the brain (embed it, or run the rivalis-fleet binary)
import { Orchestrator } from '@rivalis/fleet'

const orchestrator = new Orchestrator({
    port: 7350,
    agentKey: process.env.FLEET_AGENT_KEY!,   // authenticates game servers
    adminKey: process.env.FLEET_ADMIN_KEY!,   // authenticates the REST /v1 API
    api: true                                 // serve REST /v1 for ops + dashboards
})

await orchestrator.listen()

orchestrator.on('instance:join', (instance) => console.log('server up', instance.name))
orchestrator.on('room:create',   (room) => console.log('room placed', room.roomId))

// live cluster view — rebuilt from agent check-ins, no database
console.log(orchestrator.fleet.stats)
console.log(orchestrator.fleet.instances)`

const matchmakerCode = `// matchmaker.ts — place a room, hand the client a URL
import type { Orchestrator } from '@rivalis/fleet'

async function findMatch(orchestrator: Orchestrator, player: string) {
    // pick the least-loaded EU server and create the room there
    const room = await orchestrator.fleet.createRoom({
        type: 'match',
        roomId: 'match-42',                                       // explicit id → safe to retry
        placement: { strategy: 'least-loaded', labels: { region: 'eu' } }
    })

    // hand the client the endpoint + a join ticket
    return {
        url: room.endpointUrl,                                    // wss://eu1.game.example.com
        ticket: \`\${room.roomId}|\${player}\`
    }
    // client: new WSClient(url, { reconnect: true }).connect(ticket)
}`

type Tab = { key: string; label: string; code: string; language: CodeSnippetLanguage }
const tabs: Tab[] = [
    { key: 'agent', label: 'fleet-agent.ts', code: agentCode, language: 'typescript' },
    { key: 'orchestrator', label: 'orchestrator.ts', code: orchestratorCode, language: 'typescript' },
    { key: 'matchmaker', label: 'matchmaker.ts', code: matchmakerCode, language: 'typescript' }
]

export function FleetSection() {
    const [activeKey, setActiveKey] = useState<string>(tabs[0].key)
    const active = tabs.find((t) => t.key === activeKey) ?? tabs[0]

    return (
        <section id="fleet" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">SCALE BEYOND ONE SERVER</Badge>
                    <Heading as="h2" gradient>
                        Many servers, one fleet.
                    </Heading>
                    <Text as="p" variant="muted">
                        One Rivalis server is plenty to start. When you outgrow it — more players, more regions, more rooms than a single process should hold — <code>@rivalis/fleet</code> ties many servers together so clients always find the right one.
                    </Text>
                </div>

                <Pipeline steps={steps} />

                <div className="row g-4 justify-content-center mt-2">
                    {pieces.map((p) => (
                        <div key={p.title} className="col-12 col-lg-4">
                            <Card>
                                <div className="px-3 py-3 h-100 d-flex flex-column">
                                    <div className="mb-2">{p.icon}</div>
                                    <Heading as="h3">{p.title}</Heading>
                                    <Text as="p" variant="muted" size="small">{p.body}</Text>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>

                <div className="text-center mx-auto mt-5 mb-4" style={{ maxWidth: 760 }}>
                    <Heading as="h3">The three pieces in code.</Heading>
                    <Text as="p" variant="muted">
                        Embed an agent in every server, run one orchestrator, then ask it to place rooms.
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

                <div className="text-center mx-auto mt-4" style={{ maxWidth: 760 }}>
                    <Text as="p" variant="muted" size="small">
                        It only places rooms inside servers you are already running — spinning machines up and down stays with your platform (k8s, Agones, autoscalers), and matchmaking is something you build on top. In-memory, restart-safe, MIT.
                    </Text>
                </div>
            </div>
        </section>
    )
}
