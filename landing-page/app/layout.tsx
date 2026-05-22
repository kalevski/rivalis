import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Script from 'next/script'
import '@toolcase/react-components/style.css'
import './globals.css'

const siteUrl = 'https://rivalis.io'
const title = 'Rivalis — Open-source real-time framework for Node.js'
const description =
    'Build multiplayer games and real-time apps on Node.js. Rooms, actors, and a typed binary protocol — no boilerplate. Free, MIT-licensed.'

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title,
    description,
    keywords: [
        'rivalis',
        'real-time framework',
        'multiplayer game server',
        'nodejs websocket',
        'open source game server',
        'websocket rooms',
        'actor model',
        'binary protocol',
        'game networking',
        'real-time nodejs',
        'phaser multiplayer',
        'phaser server',
        'phaser websocket',
        'colyseus alternative',
        'multiplayer game framework',
        'pixijs multiplayer',
        'three.js multiplayer'
    ],
    authors: [{ name: 'kalevski', url: 'https://kalevski.dev' }],
    creator: 'kalevski',
    robots: {
        index: true,
        follow: true,
        googleBot: { index: true, follow: true }
    },
    alternates: {
        canonical: siteUrl
    },
    manifest: '/site.webmanifest',
    openGraph: {
        type: 'website',
        url: siteUrl,
        siteName: 'Rivalis',
        title,
        description,
        locale: 'en_US',
        images: [
            {
                url: '/og.png',
                width: 1200,
                height: 630,
                alt: 'Rivalis — real-time multiplayer for Node.js'
            }
        ]
    },
    twitter: {
        card: 'summary_large_image',
        title,
        description,
        creator: '@kalevski',
        images: ['/og.png']
    },
    icons: {
        icon: [
            { url: '/favicon.svg', type: 'image/svg+xml' },
            { url: '/favicon.ico', sizes: 'any' },
            { url: '/favicon-96x96.png', type: 'image/png', sizes: '96x96' }
        ],
        apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
    }
}

const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Rivalis',
    url: siteUrl,
    description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Node.js',
    offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD'
    },
    license: 'https://opensource.org/licenses/MIT',
    author: {
        '@type': 'Person',
        name: 'kalevski',
        url: 'https://github.com/kalevski'
    },
    codeRepository: 'https://github.com/kalevski/rivalis',
    programmingLanguage: ['TypeScript', 'JavaScript'],
    keywords: 'multiplayer, real-time, websocket, nodejs, game server, rooms, actors, phaser, colyseus alternative'
}

const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
        {
            '@type': 'Question',
            name: 'What is Rivalis?',
            acceptedAnswer: {
                '@type': 'Answer',
                text: 'Rivalis is an open-source real-time framework for Node.js. The core idea is rooms, actors, and typed messages — so you write game logic instead of plumbing like WebSocket state, auth, rate limiting, reconnect, or heartbeats.'
            }
        },
        {
            '@type': 'Question',
            name: 'How does Rivalis compare to Colyseus?',
            acceptedAnswer: {
                '@type': 'Answer',
                text: 'Colyseus focuses on automatic state synchronization via Schema classes — great when you want the framework to own state. Rivalis takes a lower-level approach with raw binary frames — great when you want full control over the wire. Both are MIT, both are Node.js. Neither is wrong.'
            }
        },
        {
            '@type': 'Question',
            name: 'Can I use Rivalis with Phaser?',
            acceptedAnswer: {
                '@type': 'Answer',
                text: 'Yes. Rivalis is client-agnostic — the @rivalis/browser client drops into Phaser, PixiJS, Three.js, Babylon.js, or plain Canvas. The server has no opinion about your renderer.'
            }
        },
        {
            '@type': 'Question',
            name: 'Is Rivalis free for commercial games?',
            acceptedAnswer: {
                '@type': 'Answer',
                text: 'Yes. Rivalis is MIT licensed — free forever, even for commercial games. No per-seat, no per-CCU, no telemetry callbacks. Your server, your rules.'
            }
        },
        {
            '@type': 'Question',
            name: 'What is included out of the box?',
            acceptedAnswer: {
                '@type': 'Answer',
                text: 'Rooms and actors, topic-based binary messaging, pluggable auth middleware, heartbeats, token-bucket rate limiting, exponential-backoff reconnect on the browser client, and origin allow-lists for CSWSH protection.'
            }
        }
    ]
}

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <head>
                <link
                    rel="stylesheet"
                    href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"
                />
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link
                    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>
                {children}
                <Script
                    id="json-ld"
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
                    strategy="afterInteractive"
                />
                <Script
                    id="json-ld-faq"
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
                    strategy="afterInteractive"
                />
                <Script
                    src="https://www.googletagmanager.com/gtag/js?id=G-RMH58ZPF7J"
                    strategy="afterInteractive"
                />
                <Script id="google-analytics" strategy="afterInteractive">
                    {`
                        window.dataLayer = window.dataLayer || [];
                        function gtag(){dataLayer.push(arguments);}
                        gtag('js', new Date());
                        gtag('config', 'G-RMH58ZPF7J');
                    `}
                </Script>
            </body>
        </html>
    )
}
