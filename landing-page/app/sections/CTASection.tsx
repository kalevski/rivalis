'use client'

import { Card, Heading, Text, CoolButton, Badge } from '@toolcase/react-components'

export function CTASection() {
    return (
        <section className="section section--tight" style={{ background: '#f1f5f9' }}>
            <Card>
                <div style={{ textAlign: 'center', padding: '24px 8px' }}>
                    <div style={{ marginBottom: 12 }}>
                        <Badge variant="info" pill>OPEN SOURCE</Badge>{' '}
                        <Badge variant="success" pill>MIT</Badge>{' '}
                        <Badge variant="warning" pill>NODE.JS</Badge>
                    </div>
                    <Heading as="h2" gradient>
                        Build something that talks back.
                    </Heading>
                    <Text as="p" variant="muted">
                        Star the repo, ship a prototype, file an issue — the framework is genuinely free and built in the open.
                    </Text>
                    <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <a href="https://github.com/kalevski/rivalis" target="_blank" rel="noopener noreferrer">
                            <CoolButton variant="primary" size="large">Star on GitHub</CoolButton>
                        </a>
                        <a href="https://github.com/kalevski/rivalis#readme" target="_blank" rel="noopener noreferrer">
                            <CoolButton variant="primary" outline size="large">Read the docs</CoolButton>
                        </a>
                    </div>
                </div>
            </Card>
        </section>
    )
}
