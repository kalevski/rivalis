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

    dispose() {}
}

export default Transport