import { Broadcast } from '@toolcase/base'
import { WebSocket } from 'ws'
import CustomLoggerFactory from '../CustomLoggerFactory'
import { decode, encode } from '@rivalis/handshake'

const EMPTY_PAYLOAD = new Uint8Array()

export type ClientEventListener = (payload: Uint8Array, topic?: string) => void

class WSClient extends Broadcast {

    private baseURL: string

    private logger = CustomLoggerFactory.Instance.getLogger('ws client')

    private ws: WebSocket | null = null

    constructor(baseURL: string) {
        super()
        this.baseURL = baseURL
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
        const url = new URL(this.baseURL)
        url.searchParams.append('ticket', ticket)
        this.ws = new WebSocket(url.toString())
        this.ws.once('open', () => this.onOpen())
        this.ws.once('close', (code, reason) => this.onClose(code, reason))
    }

    disconnect(): void {
        if (!this.connected || this.ws === null) {
            return
        }
        this.ws.close()
        this.ws.removeAllListeners()
        this.ws = null
        this.emit('client:disconnect', Buffer.from('terminated'))
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
            return this.ws.send(encode(topic, Buffer.from(payload, 'utf-8')))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    private onOpen(): void {
        this.ws?.on('message', (data, isBinary) => this.onMessage(data as Uint8Array, isBinary))
        this.emit('client:connect')
    }

    private onMessage(data: Uint8Array, _isBinary: boolean): void {
        const { topic, payload } = decode(data)
        this.emit(topic, payload)
    }

    private onClose(_code: number, reason: Uint8Array): void {
        this.emit('client:disconnect', reason)
        this.ws?.removeAllListeners()
        this.ws = null
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
