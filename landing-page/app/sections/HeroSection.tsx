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
            title="Ship multiplayer faster."
            description="Build real-time multiplayer experiences with Rivalis. Open-source framework for Node.js with rooms, actors, and a typed binary wire protocol — built-in."
            primaryAction={{
                label: 'Get started',
                variant: 'primary',
                onClick: goTo('#code-preview')
            }}
            secondaryAction={{
                label: 'View on GitHub',
                outline: true,
                onClick: goTo('https://github.com/kalevski/rivalis', true)
            }}
            metrics={[
                { label: 'frame cap', value: '64 KiB', helper: 'per inbound message, tunable' },
                { label: 'rate limit', value: '30 / s', helper: 'token bucket per actor' },
                { label: 'heartbeat', value: '30 s', helper: 'two-miss disconnect' }
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
