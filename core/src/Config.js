import AuthMiddleware from './AuthMiddleware'
import RateLimiter from './RateLimiter'
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
     * @type {RateLimiter|null}
     */
    rateLimiter = null

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

        if (config.rateLimiter !== undefined && config.rateLimiter !== null && !(config.rateLimiter instanceof RateLimiter)) {
            throw new Error('config error: rateLimiter must be an instance of RateLimiter')
        }

        this.transports = config.transports
        this.authMiddleware = config.authMiddleware
        this.rateLimiter = config.rateLimiter ?? null
    }

}

export default Config