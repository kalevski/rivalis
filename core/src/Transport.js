import TLayer from './TLayer'

class Transport {

    /**
     * @private
     * @type {TLayer}
     */
    transportLayer = null

    /**
     *
     * @param {TLayer} transportLayer
     */
    onInitialize(transportLayer) {}

    /**
     * Number of raw, currently-open transport connections (sockets that
     * have completed the handshake but may or may not have joined a room).
     * Subclasses should override.
     *
     * @returns {number}
     */
    get sockets() {
        return 0
    }

    dispose() {}
}

export default Transport