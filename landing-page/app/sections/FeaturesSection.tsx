'use client'

import { FeatureCard, Icon, Heading, Badge } from '@toolcase/react-components'

type Feature = {
    icon: string
    title: string
    body: string
}

const features: Feature[] = [
    {
        icon: 'door-open',
        title: 'Rooms & Actors',
        body: 'Model your game as rooms full of actors with a clean lifecycle. Two concepts, one mental model.'
    },
    {
        icon: 'broadcast-pin',
        title: 'Topic-based messaging',
        body: 'Bind a topic to a handler, broadcast or unicast — no manual switch statements.'
    },
    {
        icon: 'shield-lock',
        title: 'Pluggable auth',
        body: 'Validate any ticket — JWT, session token, anything — and attach typed actor data.'
    },
    {
        icon: 'box-seam',
        title: 'Binary wire protocol',
        body: 'A typed { topic, payload } format keeps clients and servers in lockstep.'
    },
    {
        icon: 'code-square',
        title: 'TypeScript-first',
        body: 'Strict types end-to-end. Actor data, room handlers, and the wire format share generics.'
    },
    {
        icon: 'power',
        title: 'Free & open source',
        body: 'MIT licensed. Free forever, even for commercial games. Your server, your rules.'
    }
]

export function FeaturesSection() {
    return (
        <section id="why-rivalis" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">WHY RIVALIS</Badge>
                    <Heading as="h2" gradient>
                        Everything you need for multiplayer.
                    </Heading>
                </div>

                <div className="row g-4">
                    {features.map((f) => (
                        <div key={f.title} className="col-12 col-sm-6 col-lg-4">
                            <FeatureCard
                                icon={<Icon name={f.icon as never} />}
                                title={f.title}
                                description={f.body}
                            />
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}
