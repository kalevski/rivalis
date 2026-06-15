'use client'

import { Heading, Text, Card, Badge, Icon } from '@toolcase/react-components'

type Comparison = {
    versus: string
    bullets: string[]
}

const comparisons: Comparison[] = [
    {
        versus: 'vs Colyseus',
        bullets: [
            'Colyseus auto-syncs state via Schema classes — great when you want the framework to own state.',
            'Rivalis gives you raw binary frames — great when you want full control over the wire.',
            'Two concepts (Rooms + Actors), zero schema decorators, drops into any http.Server.'
        ]
    },
    {
        versus: 'vs From scratch',
        bullets: [
            'Heartbeats, token-bucket rate limits, backpressure, exponential-backoff reconnect — built in',
            'Origin allow-lists for CSWSH protection on by default',
            'TypeScript-native, zero hidden runtime dependencies — ship in days, not months'
        ]
    },
    {
        versus: 'Which setup do I pick?',
        bullets: [
            'P2P (WebRTC): cheapest, lowest latency for casual/co-op — your server only does discovery, but a peer host can’t be trusted for competitive play.',
            'One dedicated server: server-authoritative and simple — the right default until you outgrow a single process.',
            'Fleet: many servers in one cluster, each room placed on the least-loaded box — for more players, regions, or rooms than one server should hold.'
        ]
    }
]

export function ComparisonSection() {
    return (
        <section id="comparison" className="py-5 bg-body-tertiary">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">HOW RIVALIS COMPARES</Badge>
                    <Heading as="h2" gradient>
                        Lightweight by design.
                    </Heading>
                    <Text as="p" variant="muted">
                        Both work. Pick by philosophy — not features.
                    </Text>
                </div>

                <div className="row g-4 justify-content-center">
                    {comparisons.map((c) => (
                        <div key={c.versus} className="col-12 col-md-6 col-lg-5">
                            <Card>
                                <div className="px-3 py-3">
                                    <Heading as="h3">{c.versus}</Heading>
                                    <ul className="list-unstyled mt-3 mb-0">
                                        {c.bullets.map((b) => (
                                            <li key={b} className="d-flex gap-2 align-items-start mb-2">
                                                <Icon name={'check2-circle' as never} />
                                                <Text as="span" variant="muted" size="small">{b}</Text>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>

                <div className="text-center mx-auto mt-4" style={{ maxWidth: 760 }}>
                    <Text as="p" variant="muted" size="small">
                        Both are MIT. Both are Node.js. Try both — neither is wrong.
                    </Text>
                </div>
            </div>
        </section>
    )
}
