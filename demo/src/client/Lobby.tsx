import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
    Avatar,
    Badge,
    EmptyState,
    Heading,
    IconButton,
    Input,
    SectionCard,
    Text
} from '@toolcase/react-components'
import {
    decode,
    encode,
    type ActorIdentity,
    type LobbyChatCommand,
    type LobbyChatEvent,
    type LobbyState
} from '../protocol'
import { useRoom } from './useRoom'
import StatusBar from './StatusBar'

type Member = { id: string, name: string, color: string }

type SystemEntry = { kind: 'system', text: string, t: number }
type ChatEntry = { kind: 'chat', event: LobbyChatEvent }
type Entry = SystemEntry | ChatEntry

type Props = { identity: ActorIdentity }

const decoder = new TextDecoder()

const initialOf = (name: string): string => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return '?'
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2) {
        return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
    }
    return trimmed.slice(0, 2).toUpperCase()
}

export default function Lobby({ identity }: Props) {
    const { client, state, reason } = useRoom('lobby', identity)
    const [meId, setMeId] = useState<string>('')
    const [members, setMembers] = useState<Map<string, Member>>(new Map())
    const [entries, setEntries] = useState<Entry[]>([])
    const [draft, setDraft] = useState('')
    const logRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!client) return

        client.on('lobby:state', (payload) => {
            const snapshot = decode<LobbyState>(payload as Uint8Array)
            setMeId(snapshot.youId)
            setEntries(snapshot.history.map((event) => ({ kind: 'chat', event })))
        }, null)

        client.on('chat', (payload) => {
            const event = decode<LobbyChatEvent>(payload as Uint8Array)
            setEntries((prev) => [...prev, { kind: 'chat', event }])
        }, null)

        client.on('__presence:join', (payload) => {
            const text = decoder.decode(payload as Uint8Array)
            const { id, data } = JSON.parse(text) as { id: string, data: ActorIdentity | null }
            if (!data) return
            setMembers((prev) => {
                const next = new Map(prev)
                next.set(id, { id, ...data })
                return next
            })
            setEntries((prev) => [...prev, { kind: 'system', text: `${data.name} joined`, t: Date.now() }])
        }, null)

        client.on('__presence:leave', (payload) => {
            const text = decoder.decode(payload as Uint8Array)
            const { id, data } = JSON.parse(text) as { id: string, data: ActorIdentity | null }
            setMembers((prev) => {
                const next = new Map(prev)
                next.delete(id)
                return next
            })
            if (data) {
                setEntries((prev) => [...prev, { kind: 'system', text: `${data.name} left`, t: Date.now() }])
            }
        }, null)
    }, [client])

    useEffect(() => {
        const log = logRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [entries])

    const send = (e: FormEvent) => {
        e.preventDefault()
        const text = draft.trim()
        if (!text || !client) return
        const cmd: LobbyChatCommand = { text }
        client.send('chat', encode(cmd))
        setDraft('')
    }

    const memberList = useMemo(() => {
        const all = [...members.values()]
        const me = all.find((m) => m.id === meId)
        const others = all.filter((m) => m.id !== meId)
        return me ? [me, ...others] : others
    }, [members, meId])

    return (
        <div className="room">
            <Heading as="h1">Lobby</Heading>
            <Text as="p" variant="muted">
                Open chat with auto-presence — uses presence: true on the server-side Room.
            </Text>
            <StatusBar state={state} reason={reason} />

            <div className="room-grid">
                <SectionCard
                    title="Online"
                    icon="people"
                    action={<Badge variant="secondary" pill>{members.size}</Badge>}
                >
                    {memberList.length === 0 ? (
                        <Text as="p" variant="muted">No one here yet.</Text>
                    ) : (
                        <ul className="presence-list">
                            {memberList.map((m) => (
                                <li key={m.id}>
                                    <Avatar
                                        name={m.name}
                                        size="default"
                                        status="online"
                                        style={{ background: m.color, color: '#fff' }}
                                    >
                                        {initialOf(m.name)}
                                    </Avatar>
                                    <div className="presence-meta">
                                        <Text>{m.name}</Text>
                                        {m.id === meId && (
                                            <Text as="span" variant="muted" size="small"> (you)</Text>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </SectionCard>

                <SectionCard title="Chat" icon="chat-dots">
                    <div className="chat-log" ref={logRef}>
                        {entries.length === 0 ? (
                            <EmptyState icon="chat-square-text">
                                <Text as="p" variant="muted">No messages yet — say hi!</Text>
                            </EmptyState>
                        ) : (
                            entries.map((entry, i) => {
                                if (entry.kind === 'system') {
                                    return (
                                        <div key={i} className="chat-system">
                                            <Text as="span" variant="muted" size="small">
                                                {entry.text}
                                            </Text>
                                        </div>
                                    )
                                }
                                const ev = entry.event
                                return (
                                    <div key={i} className="chat-message">
                                        <span className="chat-name" style={{ color: ev.color }}>{ev.name}</span>
                                        <Text as="span">{ev.text}</Text>
                                    </div>
                                )
                            })
                        )}
                    </div>
                    <form className="chat-form" onSubmit={send}>
                        <Input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            maxLength={200}
                            placeholder="Say something…"
                            disabled={state !== 'connected'}
                            autoComplete="off"
                            className="chat-input"
                        />
                        <IconButton
                            icon="send"
                            type="submit"
                            variant="primary"
                            label="Send"
                            disabled={state !== 'connected' || !draft.trim()}
                        />
                    </form>
                </SectionCard>
            </div>
        </div>
    )
}
