'use client'

import { PageFooter, Brand } from '@toolcase/react-components'

export function Footer() {
    return (
        <PageFooter
            brand={<Brand primaryText="RIVALIS" secondaryText="" color="#f44336" label="MIT" />}
            tagline="The framework for real-time multiplayer on Node.js."
            menus={[
                {
                    heading: 'Framework',
                    links: [
                        { label: '@rivalis/core', href: 'https://github.com/kalevski/rivalis', external: true },
                        { label: '@rivalis/browser', href: 'https://github.com/kalevski/rivalis', external: true },
                        { label: 'Changelog', href: 'https://github.com/kalevski/rivalis/releases', external: true }
                    ]
                },
                {
                    heading: 'Resources',
                    links: [
                        { label: 'Documentation', href: 'https://github.com/kalevski/rivalis#readme', external: true },
                        { label: 'Examples', href: 'https://github.com/kalevski/rivalis/tree/main/demo', external: true }
                    ]
                },
                {
                    heading: 'Community',
                    links: [
                        { label: 'GitHub', href: 'https://github.com/kalevski/rivalis', external: true },
                        { label: 'Issues', href: 'https://github.com/kalevski/rivalis/issues', external: true },
                        { label: 'Author', href: 'https://github.com/kalevski', external: true }
                    ]
                }
            ]}
            legalText="© 2026 rivalis. Released under the MIT License."
        />
    )
}
