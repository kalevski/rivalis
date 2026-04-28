'use client'

import { Card, Heading, Text, Badge, CoolButton, Icon } from '@toolcase/react-components'

type Link = {
    icon: string
    label: string
    href: string
    helper: string
}

const links: Link[] = [
    {
        icon: 'github',
        label: 'GitHub',
        href: 'https://github.com/kalevski/rivalis',
        helper: 'Source code · star · fork'
    },
    {
        icon: 'bug',
        label: 'Issues',
        href: 'https://github.com/kalevski/rivalis/issues',
        helper: 'Bug reports & feature requests'
    },
    {
        icon: 'person',
        label: 'Author',
        href: 'https://github.com/kalevski',
        helper: 'Built by @kalevski'
    }
]

export function CommunitySection() {
    return (
        <section id="community" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">JOIN THE COMMUNITY</Badge>
                    <Heading as="h2" gradient>
                        Built in the open.
                    </Heading>
                    <Text as="p" variant="muted">
                        Rivalis is free and open source under the MIT license. Star the repo, file issues, or send a PR.
                    </Text>
                </div>

                <div className="row g-4 justify-content-center">
                    {links.map((l) => (
                        <div key={l.label} className="col-12 col-sm-6 col-lg-4">
                            <Card>
                                <div className="px-3 py-3 text-center">
                                    <div className="mb-3">
                                        <Icon name={l.icon as never} />
                                    </div>
                                    <Heading as="h3">{l.label}</Heading>
                                    <Text as="p" variant="muted" size="small">{l.helper}</Text>
                                    <a href={l.href} target="_blank" rel="noopener noreferrer">
                                        <CoolButton variant="primary" outline>Open</CoolButton>
                                    </a>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}
