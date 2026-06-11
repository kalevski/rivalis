import { useEffect, useState } from 'react'
import { RTCClient } from '@rivalis/browser'
import type { Client } from '@rivalis/core'
import type { ActorIdentity, RoomId } from '../protocol'
import { SIGNAL_PORT } from './protocol'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'rejected'

const decoder = new TextDecoder()

export type RoomConnection = {
    client: Client | null
    state: ConnectionState
    reason: string
}

const PERSISTENT_REJECTIONS = new Set(['room_full', 'room_not_joinable'])

/**
 * Connects to a room over WebRTC via @rivalis/signal.
 *
 * Drop-in replacement for `useRoom` (demo/src/client/useRoom.ts): the ticket
 * format is identical (`<roomId>|<name>|<color>`), so existing game components
 * such as TicTacToe.tsx need no changes — only the import changes.
 *
 * The same ticket is sent to both the signal server (for signal-room auth) and
 * the game host (as the first binary data-channel message for game auth — §4.2
 * ticket protocol). DemoP2PSignalAuth on the signal server and ArenaAuthMiddleware
 * on the game host both accept this format.
 *
 * RTCClient connects to the signal server at ws://<hostname>:SIGNAL_PORT. For
 * the local dev demo, the signal server and game host run in the same process
 * (demo/src/p2p/index.ts); in production they would be separate services.
 */
export function useRoomRTC(roomId: RoomId, identity: ActorIdentity): RoomConnection {
    const [client, setClient] = useState<Client | null>(null)
    const [state, setState] = useState<ConnectionState>('connecting')
    const [reason, setReason] = useState<string>('')

    useEffect(() => {
        const url = `ws://${location.hostname}:${SIGNAL_PORT}`
        const rtc = new RTCClient(url, { reconnect: true })
        let mounted = true

        rtc.on('client:connect', () => {
            if (!mounted) return
            setState('connected')
            setReason('')
        }, null)

        rtc.on('client:disconnect', (payload) => {
            if (!mounted) return
            const r = decoder.decode(payload as Uint8Array)
            setReason(r)
            setState(PERSISTENT_REJECTIONS.has(r) ? 'rejected' : 'disconnected')
        }, null)

        const ticket = `${roomId}|${identity.name}|${identity.color}`
        rtc.connect(ticket)
        setClient(rtc)
        setState('connecting')

        return () => {
            mounted = false
            rtc.disconnect()
            setClient(null)
        }
    }, [roomId, identity.name, identity.color])

    return { client, state, reason }
}
