import AuthMiddleware from './AuthMiddleware'
import Transport from './Transport'

class Config {

    /**
     * @type {Array<Transport>}
     */
    transports = null

    /**
     * @type {AuthMiddleware}
     */
    authMiddleware = null

    /**
     * 
     * @param {Config} config 
     */
    constructor(config = {}) {

        if (typeof config !== 'object') {
            throw new Error('config error: provided config is not an object')
        }

        if (!Array.isArray(config.transports)) {
            throw new Error('config error: transports must be an array')
        }

        for (let [index, transport] of config.transports.entries()) {
            if (!(transport instanceof Transport)) {
                throw new Error(`config error: transports[${index}] must be an instance of Transport`)
            }
        }

        if (!(config.authMiddleware instanceof AuthMiddleware)) {
            throw new Error(`config error: authMiddleware must be an instance of AuthMiddleware`)
        }

        this.transports = config.transports
        this.authMiddleware = config.authMiddleware
    }

}

export default Config