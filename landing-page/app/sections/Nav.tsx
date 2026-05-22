'use client'

import { CoolNav, Brand } from '@toolcase/react-components'
import type { CoolNavItem } from '@toolcase/react-components'

const items: CoolNavItem[] = [
    { label: 'Features', href: '#why-rivalis' },
    { label: 'Use cases', href: '#use-cases' },
    { label: 'Demos', href: '#demos' },
    { label: 'AI skill', href: '#ai-skill' },
    { label: 'Docs', href: 'https://github.com/kalevski/rivalis#readme', target: '_blank' }
]

const brandContent = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <img
            src="/logo.png"
            alt="Rivalis logo"
            width={28}
            height={28}
            style={{ display: 'block' }}
        />
        RIVALIS
    </span>
)

export function Nav() {
    return (
        <CoolNav
            theme="light"
            brand={<Brand primaryText={brandContent} secondaryText="" color="#7c3aed" label="MIT" />}
            items={items}
            loginLabel="GitHub"
            loginHref="https://github.com/kalevski/rivalis"
            loginVariant="primary"
        />
    )
}
