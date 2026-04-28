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
            'Free-form binary payloads — no @type-decorated Schema classes',
            'Drop-in to any Node.js http.Server — Express, Fastify, bare HTTP',
            'Two concepts only — Rooms and Actors, learn the API in an afternoon'
        ]
    },
    {
        versus: 'vs From scratch',
        bullets: [
            'Heartbeats, rate limiting, backpressure, and reconnect — built in',
            'TypeScript-native, zero hidden runtime dependencies',
            'Ship in days, not months'
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
            </div>
        </section>
    )
}
