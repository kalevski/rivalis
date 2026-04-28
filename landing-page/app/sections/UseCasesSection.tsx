'use client'

import { FeatureCard, Heading, Text, Badge } from '@toolcase/react-components'

type UseCase = {
    eyebrow: string
    title: string
    body: string
}

const useCases: UseCase[] = [
    {
        eyebrow: 'Multiplayer',
        title: 'Game servers',
        body: 'Arena, .io, party, MMO zones, turn-based — rooms with presence and tick-rate broadcasts.'
    },
    {
        eyebrow: 'Collaborative',
        title: 'Live apps',
        body: 'Whiteboards, editors, dashboards, chat — every interaction is a topic frame.'
    },
    {
        eyebrow: 'Operational',
        title: 'Real-time ops',
        body: 'Auctions, IoT panels, dispatch, live polls — server-authoritative state with rate limiting.'
    }
]

export function UseCasesSection() {
    return (
        <section id="use-cases" className="py-5 bg-body-tertiary">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">USE CASES</Badge>
                    <Heading as="h2" gradient>
                        What you can build.
                    </Heading>
                    <Text as="p" variant="muted">
                        Anywhere multiple humans need to share state in real time.
                    </Text>
                </div>

                <div className="row g-4">
                    {useCases.map((u) => (
                        <div key={u.title} className="col-12 col-md-4">
                            <FeatureCard
                                eyebrow={u.eyebrow}
                                title={u.title}
                                description={u.body}
                            />
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}
