'use client'

import { Card, Heading, Text, Badge, CoolButton, Icon } from '@toolcase/react-components'

type Demo = {
    icon: string
    title: string
    sub: string
    href: string
}

const demos: Demo[] = [
    {
        icon: 'chat-dots',
        title: 'Chat lobby',
        sub: 'Topic-based broadcasts, presence join/leave, typed actor data.',
        href: 'https://github.com/kalevski/rivalis/tree/main/demo'
    },
    {
        icon: 'plus-slash-minus',
        title: 'Shared counter',
        sub: 'Smallest possible room — one value, all actors see every change.',
        href: 'https://github.com/kalevski/rivalis/tree/main/demo'
    },
    {
        icon: 'controller',
        title: 'Pac-Man (2P)',
        sub: 'Two-player real-time, server-authoritative ticks, binary payloads.',
        href: 'https://github.com/kalevski/rivalis/tree/main/demo'
    }
]

export function DemoSection() {
    return (
        <section id="demos" className="py-5 bg-body-tertiary">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">DEMOS</Badge>
                    <Heading as="h2" gradient>
                        Three apps. Read the source.
                    </Heading>
                    <Text as="p" variant="muted">
                        Each demo is a few hundred lines — clone, run, hack.
                    </Text>
                </div>

                <div className="row g-4 justify-content-center">
                    {demos.map((d) => (
                        <div key={d.title} className="col-12 col-sm-6 col-lg-4">
                            <Card>
                                <div className="px-3 py-3 text-center h-100 d-flex flex-column">
                                    <div className="mb-3">
                                        <Icon name={d.icon as never} />
                                    </div>
                                    <Heading as="h3">{d.title}</Heading>
                                    <Text as="p" variant="muted" size="small">{d.sub}</Text>
                                    <div className="mt-auto">
                                        <a href={d.href} target="_blank" rel="noopener noreferrer">
                                            <CoolButton variant="primary">Open on GitHub</CoolButton>
                                        </a>
                                    </div>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}
