import { LoggerFactory } from '@toolcase/logging'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import Transport from './Transport'

export type ConfigOptions<TActorData = Record<string, unknown>> = {
    transports: Array<Transport>
    authMiddleware: AuthMiddleware<TActorData>
    rateLimiter?: RateLimiter | null
    logging?: LoggerFactory
}

class Config<TActorData = Record<string, unknown>> {

    transports: Array<Transport>

    authMiddleware: AuthMiddleware<TActorData>

    rateLimiter: RateLimiter | null

    logging: LoggerFactory

    constructor(config: ConfigOptions<TActorData>) {

        if (typeof config !== 'object' || config === null) {
            throw new Error('config error: provided config is not an object')
        }

        if (!Array.isArray(config.transports)) {
            throw new Error('config error: transports must be an array')
        }

        for (const [index, transport] of config.transports.entries()) {
            if (!(transport instanceof Transport)) {
                throw new Error(`config error: transports[${index}] must be an instance of Transport`)
            }
        }

        if (!(config.authMiddleware instanceof AuthMiddleware)) {
            throw new Error('config error: authMiddleware must be an instance of AuthMiddleware')
        }

        if (config.rateLimiter !== undefined && config.rateLimiter !== null && !(config.rateLimiter instanceof RateLimiter)) {
            throw new Error('config error: rateLimiter must be an instance of RateLimiter')
        }

        if (config.logging !== undefined && !(config.logging instanceof LoggerFactory)) {
            throw new Error('config error: logging must be an instance of LoggerFactory')
        }

        this.transports = config.transports
        this.authMiddleware = config.authMiddleware
        this.rateLimiter = config.rateLimiter ?? null
        this.logging = config.logging ?? CustomLoggerFactory.Instance
    }

}

export default Config
