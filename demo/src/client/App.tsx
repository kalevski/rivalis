import { useState } from 'react'
import {
    Avatar,
    Brand,
    Chip,
    IconButton,
    Spacer,
    Text,
    Tooltip
} from '@toolcase/react-components'
import '@toolcase/react-components/style.css'
import Login from './Login'
import Lobby from './Lobby'
import Counter from './Counter'
import TicTacToe from './TicTacToe'
import Arena from './Arena'
import type { ActorIdentity, RoomId } from '../protocol'

type View = RoomId

const VIEWS: { id: View, label: string, icon: string }[] = [
    { id: 'lobby', label: 'Lobby', icon: 'chat-dots' },
    { id: 'counter', label: 'Counter', icon: 'hash' },
    { id: 'ttt', label: 'Tic-Tac-Toe', icon: 'grid-3x3' },
    { id: 'arena', label: 'Arena', icon: 'dpad' }
]

const initialOf = (name: string): string => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return '?'
    return trimmed.slice(0, 2).toUpperCase()
}

export default function App() {
    const [identity, setIdentity] = useState<ActorIdentity | null>(null)
    const [view, setView] = useState<View>('lobby')

    if (identity === null) {
        return <Login onLogin={setIdentity} />
    }

    return (
        <div className="app">
            <header className="topbar">
                <Brand primaryText="rivalis" secondaryText="demo" color="#4a7eff" />
                <Spacer size={32} axis="horizontal" />
                <nav className="topbar-nav">
                    {VIEWS.map((v) => (
                        <Chip
                            key={v.id}
                            variant="primary"
                            icon={v.icon}
                            selected={view === v.id}
                            onClick={() => setView(v.id)}
                        >
                            {v.label}
                        </Chip>
                    ))}
                </nav>
                <Spacer />
                <div className="topbar-identity">
                    <Avatar
                        size="small"
                        style={{ background: identity.color, color: '#fff' }}
                    >
                        {initialOf(identity.name)}
                    </Avatar>
                    <Text>{identity.name}</Text>
                </div>
                <Tooltip content="Sign out" position="bottom">
                    <IconButton
                        icon="box-arrow-right"
                        variant="secondary"
                        outline
                        label="Sign out"
                        onClick={() => setIdentity(null)}
                    />
                </Tooltip>
            </header>

            <div className="content">
                {view === 'lobby' && <Lobby key="lobby" identity={identity} />}
                {view === 'counter' && <Counter key="counter" identity={identity} />}
                {view === 'ttt' && <TicTacToe key="ttt" identity={identity} />}
                {view === 'arena' && <Arena key="arena" identity={identity} />}
            </div>
        </div>
    )
}
