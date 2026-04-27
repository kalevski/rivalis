'use client'

import { Heading, Text, PinnedFeatureShowcase, Icon, Badge, Pipeline } from '@toolcase/react-components'

const vsItems = [
    {
        eyebrow: 'Wire format',
        icon: <Icon name={'code-slash' as never} />,
        title: 'Free-form binary payload',
        description: 'Design your own encoding — zero annotation overhead. Colyseus requires @type-decorated Schema classes on every synced state field.'
    },
    {
        eyebrow: 'Server integration',
        icon: <Icon name={'plug' as never} />,
        title: 'Drop-in Node.js library',
        description: 'Works with Express, Fastify, or bare http.Server in one line. Colyseus ships its own HTTP server and matchmaker you must route around.'
    },
    {
        eyebrow: 'API surface',
        icon: <Icon name={'diagram-3' as never} />,
        title: 'Two concepts only',
        description: 'Rooms and Actors. Learn the full API in an afternoon. Colyseus adds Presence, Monitor, matchmake(), and Schemas on top.'
    },
    {
        eyebrow: 'Roadmap',
        icon: <Icon name={'shield-check' as never} />,
        title: 'MIT, community-driven',
        description: 'No commercial product shapes open-source priorities. Colyseus Cloud and Arena directly influence the OSS roadmap.'
    }
]

const pipelineMedia = (
    <Pipeline
        steps={[
            { num: '01', title: 'http.Server', sub: 'any Node.js HTTP server', state: 'complete' },
            { num: '02', title: 'Transport', sub: 'WSTransport (or custom)', state: 'complete' },
            { num: '03', title: 'AuthMiddleware', sub: 'validate ticket → actor data', state: 'live' },
            { num: '04', title: 'Room', sub: 'onCreate / onJoin / onLeave', state: 'default' },
            { num: '05', title: 'Actor', sub: 'typed data, rate-limited', state: 'default' },
        ]}
    />
)

export function ComparisonSection() {
    return (
        <div className="section--alt">
            <section id="comparison" className="section--alt">
                <div className="section-inner">
                    <div className="section__head">
                        <span className="section__eyebrow">ALTERNATIVES</span>
                        <Heading as="h2" gradient>
                            How rivalis compares.
                        </Heading>
                        <Text as="p" variant="muted">
                            Direct framework alternatives — you write game logic, the framework handles netcode.
                            rivalis targets the Node.js tier: lightweight, TypeScript-first, zero hidden runtime dependencies.
                        </Text>
                    </div>

                    {/* rivalis vs Colyseus spotlight */}
                    <div className="vs-section">
                        <div className="vs-header">
                            <Badge variant="danger">rivalis</Badge>
                            <span className="vs-separator">vs</span>
                            <Badge variant="secondary">Colyseus</Badge>
                            <p className="vs-header__sub">The closest Node.js alternative — here&apos;s what sets them apart</p>
                        </div>
                        <PinnedFeatureShowcase
                            eyebrow="RIVALIS ADVANTAGE"
                            title="Less to learn. More to own."
                            description="Colyseus is a capable framework — but it ships opinions about matchmaking, schema serialization, and server infrastructure that you may not want. Rivalis gives you the primitive layer and stays out of the way."
                            items={vsItems}
                            media={pipelineMedia}
                        />
                    </div>
                </div>
            </section>
        </div>
    )
}
