import type { ConnectionState } from './useRoom'

type Props = {
    state: ConnectionState
    reason: string
}

const LABELS: Record<ConnectionState, string> = {
    connecting: 'connecting...',
    connected: 'connected',
    disconnected: 'disconnected',
    rejected: 'rejected'
}

export default function StatusBar({ state, reason }: Props) {
    const label = LABELS[state]
    const tail = state === 'rejected' || (state === 'disconnected' && reason) ? `: ${reason}` : ''
    return <div className={`status ${state}`}>{label}{tail}</div>
}
