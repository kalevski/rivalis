import { CloseCode } from '@rivalis/handshake'
import WSClient from './WSClient'
import RTCClient from './RTCClient'

export type { Message } from '@rivalis/handshake'
export type {
    ClientEventListener,
    ClientKickedEvent,
    GetTicketFn,
    TicketSource,
    WSClientOptions,
    WSClientReconnectOptions
} from './WSClient'
export type {
    RTCClientOptions,
    RTCClientReconnectOptions,
} from './RTCClient'

export {
    CloseCode,
    WSClient,
    RTCClient
}
