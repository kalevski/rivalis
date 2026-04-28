'use client'

import { PinnedFeatureShowcase, Icon } from '@toolcase/react-components'

const features = [
    {
        eyebrow: 'Core model',
        icon: <Icon name={'door-open' as never} />,
        title: 'Rooms & Actors',
        description: 'Model your game as rooms full of actors with a clean lifecycle. Two concepts, one mental model.'
    },
    {
        eyebrow: 'Messaging',
        icon: <Icon name={'broadcast-pin' as never} />,
        title: 'Topic-based messaging',
        description: 'Bind a topic to a handler, broadcast or unicast — no manual switch statements.'
    },
    {
        eyebrow: 'Security',
        icon: <Icon name={'shield-lock' as never} />,
        title: 'Pluggable auth',
        description: 'Validate any ticket — JWT, session token, anything — and attach typed actor data.'
    },
    {
        eyebrow: 'Wire format',
        icon: <Icon name={'box-seam' as never} />,
        title: 'Binary wire protocol',
        description: 'A typed { topic, payload } format keeps clients and servers in lockstep.'
    },
    {
        eyebrow: 'Developer experience',
        icon: <Icon name={'code-square' as never} />,
        title: 'TypeScript-first',
        description: 'Strict types end-to-end. Actor data, room handlers, and the wire format share generics.'
    },
    {
        eyebrow: 'License',
        icon: <Icon name={'power' as never} />,
        title: 'Free & open source',
        description: 'MIT licensed. Free forever, even for commercial games. Your server, your rules.'
    }
]

export function FeaturesSection() {
    return (
        <section id="why-rivalis" className="py-5">
            <div className="container py-md-5">
                <PinnedFeatureShowcase
                    eyebrow="WHY RIVALIS"
                    title="Everything you need for multiplayer."
                    description="Rooms, actors, auth, and a binary protocol — out of the box. Heartbeats, rate limits, and reconnect come along for free."
                    items={features}
                />
            </div>
        </section>
    )
}
