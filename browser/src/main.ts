import { CloseCode } from '@rivalis/handshake'
import WSClient from './WSClient'

export type { Message } from '@rivalis/handshake'
export type {
    ClientEventListener,
    ClientKickedEvent,
    GetTicketFn,
    TicketSource,
    WSClientOptions,
    WSClientReconnectOptions
} from './WSClient'

export {
    CloseCode,
    WSClient
}
