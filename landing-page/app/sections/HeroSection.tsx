'use client'

import { Hero } from '@toolcase/react-components'

const goTo = (href: string, external = false) => () => {
    if (typeof window === 'undefined') return
    if (external) {
        window.open(href, '_blank', 'noopener,noreferrer')
    } else if (href.startsWith('#')) {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' })
    } else {
        window.location.href = href
    }
}

export function HeroSection() {
    return (
        <Hero
            eyebrow="OPEN SOURCE · MIT · NODE.JS"
            title="Multiplayer & real-time, without the boilerplate."
            description="Rivalis is a free, open-source framework that gives you rooms, actors, and a typed binary wire protocol out of the box — so you can build the interesting parts of your game or real-time app instead of plumbing WebSockets."
            primaryAction={{
                label: 'Get started',
                variant: 'primary',
                onClick: goTo('#quick-start')
            }}
            secondaryAction={{
                label: 'View on GitHub',
                outline: true,
                onClick: goTo('https://github.com/kalevski/rivalis', true)
            }}
            statCards={[
                { label: 'Server', value: '@rivalis/core', helper: 'Node.js framework' },
                { label: 'Client', value: '@rivalis/browser', helper: 'auto-reconnect' },
                { label: 'Wire format', value: 'binary', helper: 'topic + payload' },
                { label: 'License', value: 'MIT', helper: 'free forever' }
            ]}
            bgIcons={[
                'controller',
                'lightning-charge',
                'people',
                'broadcast',
                'shield-check',
                'rocket-takeoff',
                'diagram-3',
                'plugin'
            ]}
        />
    )
}
