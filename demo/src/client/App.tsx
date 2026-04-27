import { useState } from 'react'
import '@toolcase/react-components/style.css'
import Login from './Login'
import Lobby from './Lobby'
import Counter from './Counter'
import TicTacToe from './TicTacToe'
import type { ActorIdentity, RoomId } from '../protocol'

type View = RoomId

const VIEWS: { id: View, label: string }[] = [
    { id: 'lobby', label: 'Lobby' },
    { id: 'counter', label: 'Counter' },
    { id: 'ttt', label: 'Tic-Tac-Toe' }
]

export default function App() {
    const [identity, setIdentity] = useState<ActorIdentity | null>(null)
    const [view, setView] = useState<View>('lobby')

    if (identity === null) {
        return <Login onLogin={setIdentity} />
    }

    return (
        <div className="app">
            <header className="topbar">
                <span className="brand">rivalis demo</span>
                <nav className="nav">
                    {VIEWS.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => setView(v.id)}
                            aria-pressed={view === v.id}
                        >
                            {v.label}
                        </button>
                    ))}
                </nav>
                <span className="me">
                    <span className="dot" style={{ background: identity.color }} />
                    <span>{identity.name}</span>
                </span>
                <button className="btn ghost" onClick={() => setIdentity(null)}>sign out</button>
            </header>

            <div className="content">
                {view === 'lobby' && <Lobby key="lobby" identity={identity} />}
                {view === 'counter' && <Counter key="counter" identity={identity} />}
                {view === 'ttt' && <TicTacToe key="ttt" identity={identity} />}
            </div>
        </div>
    )
}
