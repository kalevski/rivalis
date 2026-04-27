'use client'

import { CoolNav, Brand } from '@toolcase/react-components'
import type { CoolNavItem } from '@toolcase/react-components'

const items: CoolNavItem[] = [
    { label: 'Features', href: '#features' },
    { label: 'Use cases', href: '#use-cases' },
    { label: 'Quick start', href: '#quick-start' },
    { label: 'Docs', href: 'https://github.com/kalevski/rivalis#readme', target: '_blank' }
]

export function Nav() {
    return (
        <CoolNav
            theme="light"
            brand={<Brand primaryText="RIVALIS" secondaryText="" color="#f44336" label="MIT" />}
            items={items}
            loginLabel="GitHub"
            loginHref="https://github.com/kalevski/rivalis"
            loginVariant="primary"
        />
    )
}
