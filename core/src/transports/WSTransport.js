import { IncomingMessage } from 'http'
import { URL } from 'url'
import { WebSocketServer, WebSocket } from 'ws'
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
     * 
     * @param {import('ws').ServerOptions} options 
     */
    constructor(options, queryTicketParam = null) {
        super()
        if (typeof queryTicketParam === 'string') {
            this.QUERY_TICKET_PARAM = queryTicketParam
        }
        this.ws = new WebSocketServer(options)
        this.ws.on('connection', this.handleReject)
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

    /**
     * @private
     * @param {WebSocket} socket 
     * @param {IncomingMessage} request 
     */
    handleReject = (socket, request) => socket.close(4001)

    /**
     * @private
     * @param {WebSocket} socket 
     * @param {IncomingMessage} request 
     */
    handleConnect = async (socket, request) => {
        
        let ticket = this.extractTicket(request)
        if (ticket === null) {
            this.logger.debug('client disconected, invalid ticket', ticket)
            return socket.close(4001)
        }

        /** @type {string} */
        let actorId = null
        try {
            actorId = await this.transportLayer.grantAccess(ticket)
        } catch (error) {
            this.logger.debug(`grant access failure, ticket is not accepted, ticket=${ticket}, reason=${error.message}`)
            return socket.close(4001)
        }

        socket.on('message', (data, isBinary) => {
            if (!isBinary) {
                this.logger.debug(`actor id=(${actorId}) ticket=(${ticket}) sent non-binary data`)
                return socket.close(4002)
            }
            if (CustomLoggerFactory.Instance.level === 'verbose') {
                this.logger.verbose('message received', data)
            }
            this.transportLayer.handleMessage(actorId, data)
        })

        socket.once('close', () => this.transportLayer.handleClose(actorId))
        this.transportLayer.on('message', actorId, (_, message) => {
            socket.send(message)
        })
        this.transportLayer.on('kick', actorId, (_, message) => {
            socket.close(4003, message)
        })
    }

    /**
     * @private
     * @param {IncomingMessage} request 
     * @returns {string|null}
     */
    extractTicket(request) {
        let requestUrl = new URL('https://kalevski.dev' + request.url)
        return requestUrl.searchParams.get(this.QUERY_TICKET_PARAM) || null
    } 

}

export default WSTransport