'use client'

import { Card, Heading, Text, CoolButton, Badge } from '@toolcase/react-components'

export function CTASection() {
    return (
        <section className="py-5">
            <div className="container py-md-4">
                <div className="row justify-content-center">
                    <div className="col-12 col-lg-10">
                        <Card>
                            <div className="text-center px-3 py-4">
                                <div className="d-flex justify-content-center gap-2 flex-wrap mb-3">
                                    <Badge variant="info" pill>OPEN SOURCE</Badge>
                                    <Badge variant="success" pill>MIT</Badge>
                                    <Badge variant="warning" pill>NODE.JS</Badge>
                                </div>
                                <Heading as="h2" gradient>
                                    Build something that talks back.
                                </Heading>
                                <Text as="p" variant="muted">
                                    Star the repo, ship a prototype, file an issue.
                                </Text>
                                <div className="d-flex justify-content-center gap-2 flex-wrap mt-4">
                                    <a href="https://github.com/kalevski/rivalis" target="_blank" rel="noopener noreferrer">
                                        <CoolButton variant="primary" size="large">Star on GitHub</CoolButton>
                                    </a>
                                    <a href="https://github.com/kalevski/rivalis#readme" target="_blank" rel="noopener noreferrer">
                                        <CoolButton variant="primary" outline size="large">Read the docs</CoolButton>
                                    </a>
                                </div>
                            </div>
                        </Card>
                    </div>
                </div>
            </div>
        </section>
    )
}
