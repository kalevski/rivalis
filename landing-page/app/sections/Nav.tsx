'use client'

import { CoolNav, Brand } from '@toolcase/react-components'
import type { CoolNavItem } from '@toolcase/react-components'

const items: CoolNavItem[] = [
    { label: 'Features', href: '#why-rivalis' },
    { label: 'Use cases', href: '#use-cases' },
    { label: 'Docs', href: 'https://github.com/kalevski/rivalis#readme', target: '_blank' }
]

export function Nav() {
    return (
        <CoolNav
            theme="light"
            brand={<Brand primaryText="RIVALIS" secondaryText="" color="#7c3aed" label="MIT" />}
            items={items}
            loginLabel="GitHub"
            loginHref="https://github.com/kalevski/rivalis"
            loginVariant="primary"
        />
    )
}
