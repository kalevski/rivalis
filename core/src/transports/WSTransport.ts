import type { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket, type ServerOptions } from 'ws'
import { CloseCode } from '@rivalis/handshake'
import CustomLoggerFactory from '../CustomLoggerFactory'
import type TLayer from '../TLayer'
import Transport from '../Transport'

type HeartbeatOptions = { intervalMs?: number; missThreshold?: number }

export type WSTransportOptions = {
    heartbeat?: false | HeartbeatOptions
    maxBufferedBytes?: number
}

type SocketWithHeartbeat = WebSocket & { missedPings?: number }

class WSTransport extends Transport {

    private logger = CustomLoggerFactory.Instance.getLogger('transport:websocket')

    private loggerFactory = CustomLoggerFactory.Instance

    private readonly QUERY_TICKET_PARAM: string = 'ticket'

    private ws: WebSocketServer | null = null

    private transportLayer: TLayer<any> | null = null

    private heartbeat: { intervalMs: number; missThreshold: number } | null = null

    private heartbeatTimer: NodeJS.Timeout | null = null

    private maxBufferedBytes: number = 1024 * 1024

    constructor(options: ServerOptions, queryTicketParam: string | null = null, transportOptions: WSTransportOptions = {}) {
        super()
        if (typeof queryTicketParam === 'string') {
            this.QUERY_TICKET_PARAM = queryTicketParam
        }
        this.ws = new WebSocketServer(options)
        this.ws.on('connection', this.handleReject)

        if (typeof transportOptions?.maxBufferedBytes === 'number' && transportOptions.maxBufferedBytes > 0) {
            this.maxBufferedBytes = transportOptions.maxBufferedBytes
        }

        const heartbeatConfig = transportOptions?.heartbeat
        if (heartbeatConfig !== false) {
            this.heartbeat = {
                intervalMs: heartbeatConfig?.intervalMs ?? 30000,
                missThreshold: heartbeatConfig?.missThreshold ?? 2
            }
            this.heartbeatTimer = setInterval(this.runHeartbeat, this.heartbeat.intervalMs)
            this.heartbeatTimer.unref?.()
        }
    }

    override onInitialize(transportLayer: TLayer<any>): void {
        this.transportLayer = transportLayer
        this.loggerFactory = transportLayer.logging
        this.logger = transportLayer.logging.getLogger('transport:websocket')
        this.ws?.off('connection', this.handleReject)
        this.ws?.on('connection', this.handleConnect)
        this.logger.info('initialized')
    }

    override get sockets(): number {
        return this.ws !== null ? this.ws.clients.size : 0
    }

    private handleReject = (socket: WebSocket, _request: IncomingMessage): void => {
        socket.close(CloseCode.INVALID_TICKET)
    }

    private handleConnect = async (socket: WebSocket, request: IncomingMessage): Promise<void> => {
        const ticket = this.extractTicket(request)
        if (ticket === null) {
            this.logger.debug('client disconected, invalid ticket', ticket)
            return socket.close(CloseCode.INVALID_TICKET)
        }

        if (this.transportLayer === null) {
            return socket.close(CloseCode.INVALID_TICKET)
        }

        let actorId: string
        try {
            actorId = await this.transportLayer.grantAccess(ticket)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.debug(`grant access failure, ticket is not accepted, ticket=${ticket}, reason=${reason}`)
            if (reason === 'room_full' || reason === 'room_not_joinable') {
                return socket.close(CloseCode.ROOM_REJECTED, reason)
            }
            return socket.close(CloseCode.INVALID_TICKET)
        }

        const heartbeatSocket = socket as SocketWithHeartbeat
        if (this.heartbeat !== null) {
            heartbeatSocket.missedPings = 0
            socket.on('pong', () => { heartbeatSocket.missedPings = 0 })
        }

        socket.on('message', (data, isBinary) => {
            if (!isBinary) {
                this.logger.debug(`actor id=(${actorId}) ticket=(${ticket}) sent non-binary data`)
                return socket.close(CloseCode.INVALID_FRAME)
            }
            if (this.loggerFactory.level === 'verbose') {
                this.logger.verbose('message received', data)
            }
            this.transportLayer?.handleMessage(actorId, data as Uint8Array)
        })

        socket.once('close', () => this.transportLayer?.handleClose(actorId))
        this.transportLayer.on('message', actorId, (_, message) => {
            if (socket.readyState !== WebSocket.OPEN) {
                return
            }
            if (socket.bufferedAmount > this.maxBufferedBytes) {
                this.logger.warning(`backpressure: dropping message for actor=${actorId}, buffered=${socket.bufferedAmount} bytes (limit=${this.maxBufferedBytes})`)
                return
            }
            socket.send(message)
        })
        this.transportLayer.on('kick', actorId, (_, message) => {
            socket.close(CloseCode.KICKED, Buffer.from(message))
        })
    }

    private extractTicket(request: IncomingMessage): string | null {
        const queryString = request.url?.split('?')[1] ?? ''
        const params = new URLSearchParams(queryString)
        return params.get(this.QUERY_TICKET_PARAM)
    }

    private runHeartbeat = (): void => {
        if (this.ws === null || this.heartbeat === null) {
            return
        }
        for (const socket of this.ws.clients) {
            const heartbeatSocket = socket as SocketWithHeartbeat
            if ((heartbeatSocket.missedPings ?? 0) >= this.heartbeat.missThreshold) {
                this.logger.debug('terminating idle socket: missed pong threshold reached')
                socket.terminate()
                continue
            }
            heartbeatSocket.missedPings = (heartbeatSocket.missedPings ?? 0) + 1
            try {
                socket.ping()
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`heartbeat ping failed: ${reason}`)
            }
        }
    }

    /**
     * Stop accepting new connections, terminate live sockets, and shut
     * down the underlying WebSocketServer. Idempotent.
     */
    override dispose(): Promise<void> {
        if (this.ws === null) {
            return Promise.resolve()
        }
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        const server = this.ws
        this.ws = null
        server.off('connection', this.handleConnect)
        server.off('connection', this.handleReject)
        server.on('connection', this.handleReject)
        for (const client of server.clients) {
            try {
                client.close(CloseCode.KICKED, 'server_shutdown')
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`failed to close client during dispose: ${reason}`)
            }
        }
        return new Promise((resolve) => {
            server.close((error) => {
                if (error) {
                    this.logger.warning(`server close reported error: ${error.message}`)
                }
                this.logger.info('disposed')
                resolve()
            })
        })
    }

}

export default WSTransport
