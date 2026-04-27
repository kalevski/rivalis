'use client'

import { Heading, Text } from '@toolcase/react-components'

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

function Tile({ title, body }: UseCase) {
    return (
        <article className="usecase">
            <h3 className="usecase__title">{title}</h3>
            <p className="usecase__body">{body}</p>
        </article>
    )
}

export function UseCasesSection() {
    return (
        <section id="use-cases" className="section">
            <div className="section__head">
                <span className="section__eyebrow">/// USE CASES</span>
                <Heading as="h2" gradient>
                    What you can build.
                </Heading>
                <Text as="p" variant="muted">
                    Anywhere multiple humans (or bots) need to share state in real time.
                </Text>
            </div>

            <div className="section__head" style={{ marginBottom: 24, marginTop: 24 }}>
                <span className="section__eyebrow">/// MULTIPLAYER GAMES</span>
            </div>
            <div className="grid grid--4">
                {games.map((g) => (
                    <Tile key={g.title} {...g} />
                ))}
            </div>

            <div className="section__head" style={{ marginBottom: 24, marginTop: 64 }}>
                <span className="section__eyebrow">/// REAL-TIME APPLICATIONS</span>
            </div>
            <div className="grid grid--4">
                {apps.map((a) => (
                    <Tile key={a.title} {...a} />
                ))}
            </div>
        </section>
    )
}
