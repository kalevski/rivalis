import type { LoggerFactory } from '@toolcase/logging'
import Config, { type ConfigOptions } from './Config'
import RoomManager from './RoomManager'
import TLayer from './TLayer'

class Rivalis<TActorData = Record<string, unknown>> {

    logging: LoggerFactory

    private config: Config<TActorData>

    private transportLayer: TLayer<TActorData>

    private getRoomByID = (roomId: string) => this.rooms.get(roomId)

    rooms: RoomManager<TActorData>

    private shuttingDown = false

    constructor(config: ConfigOptions<TActorData>) {
        this.config = new Config<TActorData>(config)
        this.logging = this.config.logging

        this.transportLayer = new TLayer<TActorData>(
            this.config.authMiddleware,
            this.getRoomByID,
            this.config.rateLimiter,
            this.logging,
            this.config.maxTopicLength,
            this.config.maxPayloadBytes
        )
        this.rooms = new RoomManager<TActorData>(this.transportLayer, this.logging)

        for (const transport of this.config.transports) {
            transport.onInitialize(this.transportLayer)
        }
    }

    get connections(): number {
        return this.transportLayer.connections
    }

    /**
     * Number of raw open transport sockets across all configured transports.
     * Includes sockets that have not yet joined a room, so this is always
     * `>= connections`.
     */
    get sockets(): number {
        let total = 0
        for (const transport of this.config.transports) {
            total += transport.sockets
        }
        return total
    }

    /**
     * Gracefully terminate the server: destroy all rooms (firing `onDestroy`
     * and kicking remaining actors), then dispose every transport. Safe to
     * call from a `SIGINT`/`SIGTERM` handler.
     */
    async shutdown({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<void> {
        if (this.shuttingDown) {
            return
        }
        this.shuttingDown = true
        const logger = this.logging.getLogger('rivalis')
        logger.info('shutdown initiated')

        for (const roomId of [...this.rooms.keys()]) {
            try {
                this.rooms.destroy(roomId)
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                logger.error(`failed to destroy room id=${roomId} during shutdown: ${reason}`)
            }
        }

        const transports = this.config.transports
        // Transports carry no explicit id, so identify them by class name +
        // configured position — enough to tell which one hung or failed.
        const labels = transports.map((transport, index) => `${transport.constructor.name}[${index}]`)

        // Track which disposals have settled so the timeout path can report
        // exactly which transports were still hanging when the clock ran out.
        const settled: boolean[] = transports.map(() => false)
        const disposals = transports.map((transport, index) =>
            (async () => {
                try {
                    await transport.dispose()
                } finally {
                    settled[index] = true
                }
            })()
        )

        // B-9: hoist the timer id so the success path can clear it.
        // Without this, a successful disposal still leaves a timer
        // pending for `timeoutMs` ms that fires a rejected promise into
        // the void. `unref` keeps the process from being held alive,
        // but the work is wasted and the rejection is dropped.
        let timeoutTimer: NodeJS.Timeout | null = null
        const timeout = new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('shutdown_timeout')), timeoutMs)
            timeoutTimer.unref?.()
        })

        try {
            const results = await Promise.race([Promise.allSettled(disposals), timeout])
            for (const [index, result] of results.entries()) {
                if (result.status === 'rejected') {
                    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
                    logger.error(`transport ${labels[index]} failed to dispose during shutdown: ${reason}`)
                }
            }
            logger.info('shutdown complete')
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            const pending = labels.filter((_, index) => !settled[index])
            if (pending.length > 0) {
                logger.warning(`shutdown finished with error: ${reason}; transports still disposing: ${pending.join(', ')}`)
            } else {
                logger.warning(`shutdown finished with error: ${reason}`)
            }
        } finally {
            if (timeoutTimer !== null) {
                clearTimeout(timeoutTimer)
            }
        }
    }

}

export default Rivalis
