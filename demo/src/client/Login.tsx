import { useState, type FormEvent } from 'react'
import type { ActorIdentity } from '../protocol'

type Props = {
    onLogin: (identity: ActorIdentity) => void
}

export default function Login({ onLogin }: Props) {
    const [name, setName] = useState('player')
    const [color, setColor] = useState('#4a7eff')

    const submit = (e: FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        onLogin({ name: trimmed, color })
    }

    return (
        <div className="login-shell">
            <form className="login-card" onSubmit={submit}>
                <h1>rivalis demo</h1>
                <p>realtime rooms built on <code>@rivalis/core</code> + <code>@rivalis/browser</code></p>
                <label>
                    name
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={20}
                        required
                    />
                </label>
                <label>
                    color
                    <input
                        type="color"
                        value={color}
                        onChange={(e) => setColor(e.target.value)}
                    />
                </label>
                <button type="submit" className="btn">enter</button>
            </form>
        </div>
    )
}
