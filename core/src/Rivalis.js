import Config from './Config'
import CustomLoggerFactory from './CustomLoggerFactory'
import RoomManager from './RoomManager'
import TLayer from './TLayer'

class Rivalis {

    logging = CustomLoggerFactory.Instance

    /**
     * @private
     * @type {Config}
     */
    config = null

    /**
     * @private
     * @type {TLayer}
     */
    transportLayer = null

    /** @private */
    getRoomByID = (roomId) => this.rooms.get(roomId)

    /** @type {RoomManager} */
    rooms = null

    /** @private */
    shuttingDown = false

    /**
     *
     * @param {Config} config
     */
    constructor(config) {
        this.config = new Config(config)

        this.transportLayer = new TLayer(this.config.authMiddleware, this.getRoomByID, this.config.rateLimiter)
        this.rooms = new RoomManager(this.transportLayer)

        for (let transport of this.config.transports) {
            transport.onInitialize(this.transportLayer)
        }
    }

    get connections() {
        return this.transportLayer.connections
    }

    /**
     * Number of raw open transport sockets across all configured transports.
     * Includes sockets that have not yet joined a room, so this is always
     * `>= connections`.
     *
     * @returns {number}
     */
    get sockets() {
        let total = 0
        for (let transport of this.config.transports) {
            total += transport.sockets
        }
        return total
    }

    /**
     * Gracefully terminate the server: destroy all rooms (firing `onDestroy`
     * and kicking remaining actors), then dispose every transport. Safe to
     * call from a `SIGINT`/`SIGTERM` handler.
     *
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<void>}
     */
    async shutdown({ timeoutMs = 5000 } = {}) {
        if (this.shuttingDown) {
            return
        }
        this.shuttingDown = true
        let logger = this.logging.getLogger('rivalis')
        logger.info('shutdown initiated')

        for (let roomId of [...this.rooms.keys()]) {
            try {
                this.rooms.destroy(roomId)
            } catch (error) {
                logger.error(`failed to destroy room id=${roomId} during shutdown: ${error.message}`)
            }
        }

        let disposals = this.config.transports.map((transport) => {
            try {
                return Promise.resolve(transport.dispose())
            } catch (error) {
                return Promise.reject(error)
            }
        })

        let timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('shutdown_timeout')), timeoutMs).unref?.()
        })

        try {
            await Promise.race([Promise.allSettled(disposals), timeout])
            logger.info('shutdown complete')
        } catch (error) {
            logger.warning(`shutdown finished with error: ${error.message}`)
        }
    }

}

export default Rivalis