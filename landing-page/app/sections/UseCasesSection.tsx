'use client'

import { Pipeline, Heading, Text, Badge, Icon } from '@toolcase/react-components'

const steps = [
    {
        num: '01',
        icon: <Icon name={'controller' as never} />,
        title: 'Game servers',
        sub: 'Phaser, PixiJS, Three.js, Babylon.js — arena, .io, party, MMO zones, turn-based with presence and tick-rate broadcasts.',
        state: 'complete' as const
    },
    {
        num: '02',
        icon: <Icon name={'people' as never} />,
        title: 'Live apps',
        sub: 'Whiteboards, editors, dashboards, chat — every interaction is a topic frame.',
        state: 'live' as const
    },
    {
        num: '03',
        icon: <Icon name={'broadcast' as never} />,
        title: 'Real-time ops',
        sub: 'Auctions, IoT panels, dispatch, live polls — server-authoritative state with rate limiting.',
        state: 'default' as const
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

                <Pipeline steps={steps} />
            </div>
        </section>
    )
}
