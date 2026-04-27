import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '@toolcase/react-components/style.css'
import './globals.css'

export const metadata: Metadata = {
    title: 'Rivalis — open-source framework for multiplayer games & real-time apps',
    description:
        'Rivalis is a free, open-source framework for building real-time applications and multiplayer game servers on Node.js. Rooms, actors, and a typed binary wire protocol — out of the box.',
    icons: { icon: '/favicon.svg' }
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
                    href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800;900&family=Ubuntu+Mono:wght@400;700&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>
                <div className="theme theme--neon theme--neon--scanlines">{children}</div>
            </body>
        </html>
    )
}
