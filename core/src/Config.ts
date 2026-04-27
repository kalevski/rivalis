import { LoggerFactory } from '@toolcase/logging'
import AuthMiddleware from './AuthMiddleware'
import CustomLoggerFactory from './CustomLoggerFactory'
import RateLimiter from './RateLimiter'
import TokenBucketRateLimiter from './TokenBucketRateLimiter'
import Transport from './Transport'

export type ConfigOptions<TActorData = Record<string, unknown>> = {
    transports: Array<Transport>
    authMiddleware: AuthMiddleware<TActorData>
    rateLimiter?: RateLimiter | null
    logging?: LoggerFactory
    maxTopicLength?: number
}

class Config<TActorData = Record<string, unknown>> {

    transports: Array<Transport>

    authMiddleware: AuthMiddleware<TActorData>

    rateLimiter: RateLimiter | null

    logging: LoggerFactory

    maxTopicLength: number

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

        if (config.maxTopicLength !== undefined) {
            if (typeof config.maxTopicLength !== 'number' || !Number.isInteger(config.maxTopicLength) || config.maxTopicLength <= 0) {
                throw new Error('config error: maxTopicLength must be a positive integer')
            }
        }

        this.transports = config.transports
        this.authMiddleware = config.authMiddleware
        // Opt-out semantics: omitting `rateLimiter` (undefined) gets a
        // sensible default; passing `null` explicitly opts out; passing
        // an instance uses it as-is. This keeps deployments safe by
        // default while preserving an escape hatch for real-time games
        // that genuinely produce >30 frames/sec of legitimate traffic.
        if (config.rateLimiter === null) {
            this.rateLimiter = null
        } else if (config.rateLimiter === undefined) {
            this.rateLimiter = new TokenBucketRateLimiter()
        } else {
            this.rateLimiter = config.rateLimiter
        }
        this.logging = config.logging ?? CustomLoggerFactory.Instance
        this.maxTopicLength = config.maxTopicLength ?? 256
    }

}

export default Config
