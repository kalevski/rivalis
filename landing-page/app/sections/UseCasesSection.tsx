'use client'

import { PinnedFeatureShowcase, FeatureCard, Heading, Text, CdnMap } from '@toolcase/react-components'

type UseCase = {
    title: string
    body: string
}

const games: UseCase[] = [
    { title: 'Turn-based strategy', body: 'Chess, Catan, Hearthstone-style card games — one room per match, server-authoritative state.' },
    { title: 'Arena & .io games', body: 'Top-down shooters, agar-style, fast-paced PvP rooms with presence and broadcast tick-rate.' },
    { title: 'Lobby & matchmaking', body: 'A hub room queues players, then spawns a match-room with explicit IDs.' },
    { title: 'Party games', body: 'Jackbox-style trivia, drawing, and prompt games where one screen is the host.' },
    { title: 'MMO zones', body: 'Spatially partition a world into zone-rooms; actors hop between them as they move.' },
    { title: 'Co-op puzzle rooms', body: 'Among-Us / Keep-Talking style games with private and shared per-actor storage.' },
    { title: 'Tournament brackets', body: 'Persistent bracket rooms broadcast updates while sub-rooms run individual matches.' },
    { title: 'Game spectators', body: 'Read-only actors join an existing match-room to watch the broadcast in real time.' }
]

const apps: UseCase[] = [
    { title: 'Realtime chat', body: 'Channels are rooms, presence is a flag — typing indicators, reactions, and threaded replies on top.' },
    { title: 'Collaborative editors', body: 'Google-Docs-style cursors and CRDT updates fan out through topic broadcasts.' },
    { title: 'Whiteboards & canvases', body: 'Excalidraw / Figma-jam style boards where every stroke is a tiny binary frame.' },
    { title: 'Live dashboards', body: 'Push metrics, alerts, and KPIs to thousands of viewers without polling endpoints.' },
    { title: 'Auction & trading floors', body: 'Bidding rooms with rate limiting, server-authoritative price, and per-IP fairness.' },
    { title: 'Live polls & Q&A', body: 'Conferences and town-halls — vote, react, and surface questions in milliseconds.' },
    { title: 'Multiplayer quizzes', body: 'Kahoot-style classroom games with fast scoreboards and leaderboard broadcasts.' },
    { title: 'Watch parties', body: 'Synced video timelines, reactions, and chat over a single binary protocol.' },
    { title: 'IoT command panels', body: 'Push device telemetry and accept commands from authenticated operator rooms.' },
    { title: 'Live sports & scores', body: 'Fan-out match events to millions of clients with backpressure-safe delivery.' },
    { title: 'Pair programming', body: 'Shared terminals, code review rooms, debugger sessions — every keystroke is a topic frame.' },
    { title: 'Customer support copilot', body: 'Agents and customers join a ticket-room; bots can join too and broadcast suggestions.' },
    { title: 'Notification fan-out', body: 'A single push room per user broadcasts cross-device toasts, badges, and presence.' },
    { title: 'Live coding & teaching', body: 'Stream code as it is typed, run shared REPL sessions, broadcast cell outputs.' },
    { title: 'Order-tracking & dispatch', body: 'Couriers, drivers, and customers join a delivery-room and see updates as they happen.' },
    { title: 'Multiplayer simulations', body: 'Training, telepresence, and digital twins where multiple operators share state.' }
]

const gameItems = [
    { eyebrow: 'Competitive', title: 'Arena & PvP', description: 'Rooms with presence and tick-rate broadcasting for shooters, battle-royale, and .io games.' },
    { eyebrow: 'Casual', title: 'Party & board games', description: 'Turn-based and party games — one room per match, server-authoritative state, no client trust needed.' },
    { eyebrow: 'Scale', title: 'MMO zones', description: 'Partition a world into zone-rooms; actors hop between them as they move through the world.' },
    { eyebrow: 'Esports', title: 'Tournament brackets', description: 'Persistent bracket rooms broadcast updates while sub-rooms run individual matches simultaneously.' }
]

const cdnMapMedia = (
    <CdnMap
        nodes={[
            { top: '18%', left: '12%', variant: 'primary', label: 'US West' },
            { top: '22%', left: '30%', variant: 'accent', label: 'US East' },
            { top: '28%', left: '48%', variant: 'primary', label: 'EU West' },
            { top: '20%', left: '60%', variant: 'accent', label: 'EU Central' },
            { top: '25%', left: '75%', variant: 'primary', label: 'SE Asia' },
            { top: '40%', left: '68%', variant: 'accent', label: 'AP South' },
            { top: '60%', left: '32%', variant: 'primary', label: 'SA East' },
            { top: '65%', left: '52%', variant: 'accent', label: 'Africa' },
        ]}
        height={260}
    />
)

export function UseCasesSection() {
    return (
        <div className="section--alt">
            <section id="use-cases" className="section--alt">
                <div className="section-inner">
                    <div className="section__head">
                        <span className="section__eyebrow">USE CASES</span>
                        <Heading as="h2" gradient>
                            What you can build.
                        </Heading>
                        <Text as="p" variant="muted">
                            Anywhere multiple humans (or bots) need to share state in real time.
                        </Text>
                    </div>

                    <PinnedFeatureShowcase
                        eyebrow="MULTIPLAYER GAMES"
                        title="Game servers, without the framework tax."
                        description="Deploy rivalis anywhere Node.js runs. One server process handles hundreds of concurrent rooms — no sidecar, no managed cloud, no CCU bill."
                        items={gameItems}
                        media={cdnMapMedia}
                    />

                    <p className="use-cases__label">Real-time applications</p>
                    <div className="grid grid--4" style={{ marginTop: 20 }}>
                        {apps.map((a) => (
                            <FeatureCard key={a.title} title={a.title} description={a.body} inline />
                        ))}
                    </div>
                </div>
            </section>
        </div>
    )
}
