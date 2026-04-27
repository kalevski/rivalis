import { useState, type FormEvent } from 'react'
import {
    Brand,
    Button,
    Card,
    ColorPicker,
    Input,
    Text
} from '@toolcase/react-components'
import type { ActorIdentity } from '../protocol'

type Props = {
    onLogin: (identity: ActorIdentity) => void
}

const PALETTE = [
    '#4a7eff', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'
]

export default function Login({ onLogin }: Props) {
    const [name, setName] = useState('player')
    const [color, setColor] = useState('#4a7eff')

    const submit = (e: FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        onLogin({ name: trimmed, color })
    }

    const disabled = name.trim().length === 0

    return (
        <div className="login-shell">
            <Card className="login-card">
                <form onSubmit={submit}>
                    <div className="login-brand">
                        <Brand primaryText="rivalis" secondaryText="demo" color="#4a7eff" />
                    </div>
                    <Text as="p" variant="muted">
                        Realtime rooms built on @rivalis/core + @rivalis/browser.
                    </Text>
                    <div className="login-fields">
                        <Input
                            label="Name"
                            placeholder="Your display name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={20}
                            required
                        />
                        <ColorPicker
                            label="Color"
                            colors={PALETTE}
                            value={color}
                            onChange={setColor}
                            columns={4}
                        />
                    </div>
                    <Button type="submit" variant="primary" disabled={disabled}>
                        Enter
                    </Button>
                </form>
            </Card>
        </div>
    )
}
