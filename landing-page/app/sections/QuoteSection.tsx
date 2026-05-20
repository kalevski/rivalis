'use client'

import { Card, Heading, Text, Icon } from '@toolcase/react-components'

export function QuoteSection() {
    return (
        <section id="quote" className="py-5">
            <div className="container py-md-4">
                <div className="row justify-content-center">
                    <div className="col-12 col-lg-10">
                        <Card>
                            <div className="px-3 py-4 text-center">
                                <div className="mb-3">
                                    <Icon name={'chat-quote' as never} />
                                </div>
                                <Heading as="h2" gradient>
                                    “Core idea is rooms, actors, and typed messages — so you write game logic instead of plumbing.”
                                </Heading>
                                <Text as="p" variant="muted" size="small" className="mt-3 mb-0">
                                    — Daniel Kalevski, creator of Rivalis
                                </Text>
                            </div>
                        </Card>
                    </div>
                </div>
            </div>
        </section>
    )
}
