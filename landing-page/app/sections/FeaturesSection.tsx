'use client'

import { Card, Icon, Heading, Text } from '@toolcase/react-components'

type Feature = {
    icon: string
    title: string
    body: string
}

const features: Feature[] = [
    {
        icon: 'door-open',
        title: 'Rooms & Actors',
        body: 'Model your game or app as rooms full of actors with a clean onCreate / onJoin / onLeave / onDestroy lifecycle.'
    },
    {
        icon: 'broadcast-pin',
        title: 'Topic-based messaging',
        body: 'Bind a topic to a handler, broadcast to all actors, or unicast to one — no manual switch statements required.'
    },
    {
        icon: 'shield-lock',
        title: 'Pluggable auth middleware',
        body: 'Validate a ticket (JWT, session token, anything) and attach typed actor data that flows everywhere.'
    },
    {
        icon: 'plug',
        title: 'Transport abstraction',
        body: 'Ships with a WebSocket transport and a four-method base class so you can add WebTransport, TCP, or anything else.'
    },
    {
        icon: 'box-seam',
        title: 'Binary wire protocol',
        body: 'A tiny shared { topic, payload } format means clients and servers stay in lockstep without ad-hoc JSON envelopes.'
    },
    {
        icon: 'speedometer2',
        title: 'Per-actor rate limiting',
        body: 'Token-bucket limiter caps inbound frames per actor and kicks abusers automatically — opt out if you do not need it.'
    },
    {
        icon: 'people',
        title: 'Per-IP connection limits',
        body: 'Block connection floods at the door before a single ticket is even validated.'
    },
    {
        icon: 'rulers',
        title: 'Frame & topic size caps',
        body: 'Sensible defaults keep rogue clients from blowing memory; every cap is tunable from one config object.'
    },
    {
        icon: 'heart-pulse',
        title: 'Heartbeat & dead-peer detection',
        body: 'Ping every 30 s and terminate sockets that miss pongs — zombie connections die instead of leaking memory.'
    },
    {
        icon: 'eye',
        title: 'Built-in presence',
        body: 'Flip one flag per room and clients receive __presence:join / __presence:leave events for free.'
    },
    {
        icon: 'arrow-repeat',
        title: 'Auto-reconnect client',
        body: 'The browser client does exponential backoff with jitter, refuses terminal close codes, and emits structured events.'
    },
    {
        icon: 'send',
        title: 'Send-during-join, safely',
        body: 'Frames emitted from onJoin are buffered until the client subscribes — no setImmediate dance needed.'
    },
    {
        icon: 'globe2',
        title: 'CSWSH protection',
        body: 'Enable an origin allow-list to block cross-site WebSocket hijacking with a single config option.'
    },
    {
        icon: 'water',
        title: 'Backpressure-aware delivery',
        body: 'Outbound frames are dropped per-actor when buffered bytes exceed a configurable threshold — slow clients can not stall the server.'
    },
    {
        icon: 'power',
        title: 'Graceful shutdown',
        body: 'shutdown({ timeoutMs }) destroys rooms, disposes transports, and races a deadline so deploys stay clean.'
    },
    {
        icon: 'database',
        title: 'Per-actor scratch storage',
        body: 'Each actor carries a Map for stashing room-local state without leaking it into your domain types.'
    },
    {
        icon: 'eyeglasses',
        title: 'Structured logging',
        body: 'Singleton @toolcase/logging factory wired into the framework — set rivalis.logging.level and you are done.'
    },
    {
        icon: 'fingerprint',
        title: 'Privacy-aware ticket logs',
        body: 'Only an 8-character SHA-256 fingerprint of each ticket is logged — never the raw secret.'
    },
    {
        icon: 'code-square',
        title: 'TypeScript-first',
        body: 'Strict types end-to-end: actor data is generic, room handlers are typed, and the wire format is shared between server and browser.'
    },
    {
        icon: 'box',
        title: 'Zero hidden runtime deps',
        body: 'The shared handshake package is bundled into both core and browser at build time — your consumers install one thing.'
    }
]

export function FeaturesSection() {
    return (
        <section id="features" className="section">
            <div className="section__head">
                <span className="section__eyebrow">/// FEATURES</span>
                <Heading as="h2" gradient>
                    Everything a multiplayer server needs.
                </Heading>
                <Text as="p" variant="muted">
                    Twenty production concerns Rivalis solves so you do not have to.
                </Text>
            </div>
            <div className="grid grid--4">
                {features.map((f) => (
                    <Card key={f.title} className="feature-card">
                        <div className="feature-card__icon">
                            <Icon name={f.icon} />
                        </div>
                        <h3 className="feature-card__title">{f.title}</h3>
                        <p className="feature-card__body">{f.body}</p>
                    </Card>
                ))}
            </div>
        </section>
    )
}
