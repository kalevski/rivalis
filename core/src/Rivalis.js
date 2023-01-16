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

    /**
     * 
     * @param {Config} config 
     */
    constructor(config) {
        this.config = new Config(config)

        this.transportLayer = new TLayer(config.authMiddleware, this.getRoomByID)
        this.rooms = new RoomManager(this.transportLayer)

        for (let transport of this.config.transports) {
            transport.onInitialize(this.transportLayer)
        }
    }

    get connections() {
        return this.transportLayer.connections
    }

}

export default Rivalis