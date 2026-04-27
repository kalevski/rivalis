import { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import CloseCode from '../CloseCode'
import CustomLoggerFactory from '../CustomLoggerFactory'
import TLayer from '../TLayer'
import Transport from '../Transport'

class WSTransport extends Transport {

    /** @private */
    logger = CustomLoggerFactory.Instance.getLogger('transport:websocket')

    /**
     * @readonly
     * @private
     */
    QUERY_TICKET_PARAM = 'ticket'

    /**
     * @private
     * @type {WebSocketServer}
     */
    ws = null

    /**
     * @private
     * @type {TLayer}
     */
    transportLayer = null

    /**
     * @private
     * @type {{ intervalMs: number, missThreshold: number } | null}
     */
    heartbeat = null

    /**
     * @private
     * @type {NodeJS.Timeout | null}
     */
    heartbeatTimer = null

    /**
     * @private
     * @type {number}
     */
    maxBufferedBytes = 1024 * 1024

    /**
     *
     * @param {import('ws').ServerOptions} options
     * @param {string|null} [queryTicketParam]
     * @param {{ heartbeat?: false | { intervalMs?: number, missThreshold?: number }, maxBufferedBytes?: number }} [transportOptions]
     */
    constructor(options, queryTicketParam = null, transportOptions = {}) {
        super()
        if (typeof queryTicketParam === 'string') {
            this.QUERY_TICKET_PARAM = queryTicketParam
        }
        this.ws = new WebSocketServer(options)
        this.ws.on('connection', this.handleReject)

        if (typeof transportOptions?.maxBufferedBytes === 'number' && transportOptions.maxBufferedBytes > 0) {
            this.maxBufferedBytes = transportOptions.maxBufferedBytes
        }

        let heartbeatConfig = transportOptions?.heartbeat
        if (heartbeatConfig !== false) {
            this.heartbeat = {
                intervalMs: heartbeatConfig?.intervalMs ?? 30000,
                missThreshold: heartbeatConfig?.missThreshold ?? 2
            }
            this.heartbeatTimer = setInterval(this.runHeartbeat, this.heartbeat.intervalMs)
            this.heartbeatTimer.unref?.()
        }
    }

    /**
     * 
     * @param {TLayer} transportLayer 
     */
    onInitialize(transportLayer) {
        this.transportLayer = transportLayer
        this.ws.off('connection', this.handleReject)
        this.ws.on('connection', this.handleConnect)
        this.logger.info('initialized')
    }

    /** @override */
    get sockets() {
        return this.ws !== null ? this.ws.clients.size : 0
    }

    /**
     * @private
     * @param {WebSocket} socket 
     * @param {IncomingMessage} request 
     */
    handleReject = (socket, request) => socket.close(CloseCode.INVALID_TICKET)

    /**
     * @private
     * @param {WebSocket} socket 
     * @param {IncomingMessage} request 
     */
    handleConnect = async (socket, request) => {
        
        let ticket = this.extractTicket(request)
        if (ticket === null) {
            this.logger.debug('client disconected, invalid ticket', ticket)
            return socket.close(CloseCode.INVALID_TICKET)
        }

        /** @type {string} */
        let actorId = null
        try {
            actorId = await this.transportLayer.grantAccess(ticket)
        } catch (error) {
            this.logger.debug(`grant access failure, ticket is not accepted, ticket=${ticket}, reason=${error.message}`)
            return socket.close(CloseCode.INVALID_TICKET)
        }

        if (this.heartbeat !== null) {
            socket.missedPings = 0
            socket.on('pong', () => { socket.missedPings = 0 })
        }

        socket.on('message', (data, isBinary) => {
            if (!isBinary) {
                this.logger.debug(`actor id=(${actorId}) ticket=(${ticket}) sent non-binary data`)
                return socket.close(CloseCode.INVALID_FRAME)
            }
            if (CustomLoggerFactory.Instance.level === 'verbose') {
                this.logger.verbose('message received', data)
            }
            this.transportLayer.handleMessage(actorId, data)
        })

        socket.once('close', () => this.transportLayer.handleClose(actorId))
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
            socket.close(CloseCode.KICKED, message)
        })
    }

    /**
     * @private
     * @param {IncomingMessage} request 
     * @returns {string|null}
     */
    extractTicket(request) {
        let queryString = request.url.split('?')[1] || ''
        let params = new URLSearchParams(queryString)
        return params.get(this.QUERY_TICKET_PARAM) || null
    }

    /**
     * @private
     */
    runHeartbeat = () => {
        if (this.ws === null || this.heartbeat === null) {
            return
        }
        for (let socket of this.ws.clients) {
            if ((socket.missedPings ?? 0) >= this.heartbeat.missThreshold) {
                this.logger.debug('terminating idle socket: missed pong threshold reached')
                socket.terminate()
                continue
            }
            socket.missedPings = (socket.missedPings ?? 0) + 1
            try {
                socket.ping()
            } catch (error) {
                this.logger.warning(`heartbeat ping failed: ${error.message}`)
            }
        }
    }

    /**
     * Stop accepting new connections, terminate live sockets, and shut
     * down the underlying WebSocketServer. Idempotent.
     *
     * @returns {Promise<void>}
     */
    dispose() {
        if (this.ws === null) {
            return Promise.resolve()
        }
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        let server = this.ws
        this.ws = null
        server.off('connection', this.handleConnect)
        server.off('connection', this.handleReject)
        server.on('connection', this.handleReject)
        for (let client of server.clients) {
            try {
                client.close(CloseCode.KICKED, 'server_shutdown')
            } catch (error) {
                this.logger.warning(`failed to close client during dispose: ${error.message}`)
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