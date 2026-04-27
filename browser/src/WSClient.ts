import { Broadcast } from '@toolcase/base'
import logging from '@toolcase/logging'
import { CloseCode, encode, decode } from '@rivalis/handshake'

const encoder = new window.TextEncoder()
const EMPTY_PAYLOAD = new Uint8Array()

export type ClientEventListener = (payload: Uint8Array, topic?: string) => void

export type WSClientReconnectOptions = {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
}

export type WSClientOptions = {
    reconnect?: boolean | WSClientReconnectOptions
}

type ReconnectConfig = {
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
}

const RECONNECT_DEFAULTS: ReconnectConfig = {
    maxAttempts: Infinity,
    baseDelayMs: 500,
    maxDelayMs: 10000
}

const NO_RECONNECT_CODES: ReadonlySet<number> = new Set([CloseCode.INVALID_TICKET, CloseCode.KICKED, CloseCode.ROOM_REJECTED])

class WSClient extends Broadcast {

    private logger = logging.getLogger('ws client')

    private baseURL: string

    private ws: WebSocket | null = null

    private reconnectConfig: ReconnectConfig | null = null

    private lastTicket: string | null = null

    private reconnectAttempts: number = 0

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null

    private userDisconnected: boolean = false

    constructor(baseURL: string, options: WSClientOptions = {}) {
        super()
        this.baseURL = baseURL
        this.reconnectConfig = this.resolveReconnect(options.reconnect)
    }

    get connected(): boolean {
        return this.ws !== null
    }

    connect(ticket: string = ''): void {
        if (this.connected) {
            this.logger.warning('the client is already connected')
            return
        }
        if (typeof ticket !== 'string') {
            throw new Error(`ticket must be a sting, ${ticket} provided`)
        }
        this.cancelReconnect()
        this.userDisconnected = false
        this.reconnectAttempts = 0
        this.lastTicket = ticket
        this.openSocket(ticket)
    }

    disconnect(): void {
        this.userDisconnected = true
        this.cancelReconnect()
        if (!this.connected || this.ws === null) {
            return
        }
        this.ws.close()
        this.ws = null
        this.emit('client:disconnect', encoder.encode('terminated'))
    }

    send(topic: string, payload: Uint8Array | string = EMPTY_PAYLOAD): void {
        if (!this.connected || this.ws === null) {
            this.logger.warning('send fail: connection is not established yet')
            return
        }

        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }

        if (payload instanceof Uint8Array) {
            return this.ws.send(encode(topic, payload))
        }

        if (typeof payload === 'string') {
            return this.ws.send(encode(topic, encoder.encode(payload)))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    private openSocket(ticket: string): void {
        const url = new window.URL(this.baseURL)
        url.searchParams.append('ticket', ticket)
        this.ws = new window.WebSocket(url.toString())
        this.ws.onopen = this.onOpen
        this.ws.onclose = this.onClose
        this.ws.binaryType = 'arraybuffer'
    }

    private onOpen = (): void => {
        if (this.ws !== null) {
            this.ws.onmessage = this.onMessage
        }
        this.reconnectAttempts = 0
        this.emit('client:connect')
    }

    private onMessage = (message: MessageEvent): void => {
        const { topic, payload } = decode(new Uint8Array(message.data as ArrayBuffer))
        this.emit(topic, payload)
    }

    private onClose = (event: CloseEvent): void => {
        this.ws = null
        this.emit('client:disconnect', encoder.encode(event.reason))
        if (this.shouldReconnect(event.code)) {
            this.scheduleReconnect()
        }
    }

    private shouldReconnect(code: number): boolean {
        if (this.userDisconnected) return false
        if (this.reconnectConfig === null) return false
        if (this.lastTicket === null) return false
        if (NO_RECONNECT_CODES.has(code)) return false
        if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) return false
        return true
    }

    private scheduleReconnect(): void {
        if (this.reconnectConfig === null) return
        const delay = this.computeBackoff(this.reconnectAttempts)
        this.reconnectAttempts += 1
        this.emit('client:reconnecting', encoder.encode(String(this.reconnectAttempts)))
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (this.userDisconnected || this.lastTicket === null) return
            this.openSocket(this.lastTicket)
        }, delay)
    }

    private computeBackoff(attempt: number): number {
        if (this.reconnectConfig === null) return 0
        const { baseDelayMs, maxDelayMs } = this.reconnectConfig
        const exp = baseDelayMs * Math.pow(2, attempt)
        const jitter = Math.random() * baseDelayMs
        return Math.min(exp + jitter, maxDelayMs)
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private resolveReconnect(option: WSClientOptions['reconnect']): ReconnectConfig | null {
        if (option === undefined || option === false) return null
        if (option === true) return { ...RECONNECT_DEFAULTS }
        return {
            maxAttempts: option.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts,
            baseDelayMs: option.baseDelayMs ?? RECONNECT_DEFAULTS.baseDelayMs,
            maxDelayMs: option.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
        }
    }

    protected override emit(eventName: string | symbol, ...messages: unknown[]): boolean {
        if (this.listenerCount(eventName) === 0) {
            this.logger.warning(`event=${String(eventName)} emitted, register listener to handle the event`)
            return false
        }
        return super.emit(eventName, ...messages)
    }

}

export default WSClient
