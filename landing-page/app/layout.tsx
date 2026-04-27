import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Script from 'next/script'
import '@toolcase/react-components/style.css'
import './globals.css'

const siteUrl = 'https://rivalis.io'
const title = 'Rivalis — Open-source real-time framework for Node.js'
const description =
    'Build multiplayer games and real-time apps on Node.js with Rivalis. Rooms, actors, and a typed binary wire protocol — structured WebSocket backend without the boilerplate. Free, MIT-licensed.'

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
        'real-time nodejs'
    ],
    authors: [{ name: 'kalevski', url: 'https://github.com/kalevski' }],
    creator: 'kalevski',
    robots: {
        index: true,
        follow: true,
        googleBot: { index: true, follow: true }
    },
    alternates: {
        canonical: siteUrl
    },
    openGraph: {
        type: 'website',
        url: siteUrl,
        siteName: 'Rivalis',
        title,
        description,
        locale: 'en_US'
    },
    twitter: {
        card: 'summary_large_image',
        title,
        description,
        creator: '@kalevski'
    },
    icons: { icon: '/favicon.svg' }
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
    keywords: 'multiplayer, real-time, websocket, nodejs, game server, rooms, actors'
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
            </body>
        </html>
    )
}
