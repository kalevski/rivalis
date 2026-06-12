'use client'

import { Heading, Text, Badge, Card, Icon, CodeSnippet } from '@toolcase/react-components'

const signalCode = `// signal.ts — stand up a signaling server in a few lines.
import { SignalServer } from '@rivalis/signal'

// Constructing with a port starts listening immediately — no extra step.
const server = new SignalServer({
    port: 9000,
    secrets: [process.env.SIGNAL_SECRET!], // ticket secret(s); rotate freely
})

// Shut down cleanly on exit.
process.on('SIGTERM', () => server.shutdown({ timeoutMs: 10_000 }))

// In production you also run a coturn sidecar; the signal server just mints
// short-lived TURN credentials for it (ICE_TURN_URLS / ICE_TURN_SECRET).`

const steps = [
    {
        icon: <Icon name={'telephone-outbound' as never} />,
        title: 'Signaling: the switchboard',
        body: 'Two browsers can only connect directly after they swap connection details (SDP/ICE). @rivalis/signal relays that handshake and nothing else — like a switchboard operator who connects the call, then hangs up. Gameplay traffic never passes through it.'
    },
    {
        icon: <Icon name={'people' as never} />,
        title: 'It also picks the host',
        body: 'Peers join the signaling room in order, and the first one in becomes the host. If that host leaves, the next-oldest peer is elected automatically — so there is always exactly one peer in charge, with no extra coordination on your side.'
    },
    {
        icon: <Icon name={'shield-lock' as never} />,
        title: 'TURN: the fallback relay',
        body: 'Some networks block direct connections. When that happens a TURN relay (coturn) forwards the traffic instead. The signal server is not the relay — it only mints short-lived TURN credentials so peers can use coturn when they need it.'
    }
]

export function SignalSection() {
    return (
        <section id="signaling" className="py-5">
            <div className="container py-md-5">
                <div className="text-center mx-auto mb-5" style={{ maxWidth: 760 }}>
                    <Badge variant="danger" pill size="sm">SIGNALING &amp; TURN</Badge>
                    <Heading as="h2" gradient>
                        Peer-to-peer still needs a tiny introducer.
                    </Heading>
                    <Text as="p" variant="muted">
                        &ldquo;Peer-to-peer&rdquo; sounds like there is no server at all — but two browsers can&rsquo;t find each other on their own. They need a quick introduction first. That introduction is <strong>signaling</strong>, and it&rsquo;s the one small piece of Rivalis that still runs as a server. The good news: it&rsquo;s tiny, and it steps out of the way the moment players are connected.
                    </Text>
                </div>

                <div className="row g-4 justify-content-center mt-2">
                    {steps.map((s) => (
                        <div key={s.title} className="col-12 col-lg-4">
                            <Card>
                                <div className="px-3 py-3 h-100 d-flex flex-column">
                                    <div className="mb-2">{s.icon}</div>
                                    <Heading as="h3">{s.title}</Heading>
                                    <Text as="p" variant="muted" size="small">{s.body}</Text>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>

                <div className="row justify-content-center mt-5">
                    <div className="col-12 col-lg-10">
                        <div className="text-center mx-auto mb-4" style={{ maxWidth: 760 }}>
                            <Heading as="h3">A signal server is a few lines.</Heading>
                            <Text as="p" variant="muted">
                                It&rsquo;s just a small Rivalis app. Give it a port and a ticket secret and it&rsquo;s relaying handshakes — point your <code>RTCClient</code> at it and players take it from there.
                            </Text>
                        </div>
                        <CodeSnippet code={signalCode} language="typescript" />
                    </div>
                </div>

                <div className="text-center mx-auto mt-4" style={{ maxWidth: 760 }}>
                    <Text as="p" variant="muted" size="small">
                        That&rsquo;s the whole server side of P2P: relay the handshake, pick a host, hand out TURN credentials. For production you add a <code>coturn</code> sidecar next to it as the actual relay. MIT, same wire protocol as the rest of Rivalis.
                    </Text>
                </div>
            </div>
        </section>
    )
}
