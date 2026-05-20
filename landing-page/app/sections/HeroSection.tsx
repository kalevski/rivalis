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
            eyebrow="v0.x · OPEN SOURCE · MIT · NODE.JS"
            title="Stop writing WebSocket plumbing."
            description="Build real-time multiplayer for Phaser, PixiJS, Three.js, or any browser game. Open-source Node.js framework — rooms, actors, typed binary protocol. Free for commercial use, forever."
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
                { label: 'core', value: 'Rooms + Actors', helper: '2 concepts, 1 mental model' },
                { label: 'reconnect', value: 'exp-backoff', helper: 'browser client, automatic' },
                { label: 'origin', value: 'allow-list', helper: 'CSWSH protection on by default' }
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
