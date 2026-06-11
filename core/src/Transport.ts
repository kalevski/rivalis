import type AuthMiddleware from './AuthMiddleware'
import type RateLimiter from './RateLimiter'
import type TLayer from './TLayer'
import type { TransportCapability } from './types'

export type { TransportCapability }

/**
 * Base class for all wire transports. A transport translates between
 * its native socket protocol and the four `TLayer` entry points
 * (`grantAccess`, `handleMessage`, `handleClose`, plus subscribing to
 * `'message'` / `'kick'` per-actor for outbound traffic).
 *
 * `onInitialize` and `sockets` are required: the framework calls
 * `onInitialize` on every configured transport and aggregates `sockets`
 * for the `Rivalis.sockets` total. `dispose` is optional — override
 * only if the transport owns resources that need teardown.
 */
abstract class Transport {

    /**
     * Per-transport auth middleware override. When set, `TLayer.grantAccess`
     * uses this instead of the global `Config.authMiddleware` for connections
     * arriving on this transport. Leave `undefined` to fall back to the global.
     */
    authMiddleware?: AuthMiddleware<any>

    /**
     * Per-transport rate-limiter override. When set, `TLayer.handleMessage`
     * uses this instead of the global `Config.rateLimiter`.
     * `undefined` → use global; `null` → disable rate limiting for this transport.
     */
    rateLimiter?: RateLimiter | null

    abstract onInitialize(transportLayer: TLayer<any>): void

    /**
     * Number of raw, currently-open transport connections (sockets that
     * have completed the handshake but may or may not have joined a room).
     */
    abstract get sockets(): number

    /**
     * Maximum number of bytes this transport can deliver in a single frame.
     * `null` means no enforced ceiling at the transport layer.
     *
     * Rooms that broadcast large payloads (e.g. full-arena snapshots) can
     * query this value and split their frames accordingly, or rely on the
     * transport's own chunk/reassemble logic. RTCTransport returns 16 KiB
     * (the safe cross-implementation SCTP ceiling). WSTransport returns its
     * configured `maxPayload` (default 64 KiB).
     */
    get maxFrameBytes(): number | null {
        return null
    }

    /**
     * Full capability descriptor for this transport (p2p.md §7, §12 Phase 4).
     *
     * The default implementation derives `maxFrameBytes` from `this.maxFrameBytes`
     * and assumes ordered + reliable delivery — correct for WS (TCP) and the RTC
     * primary channel (`{ ordered: true }`, no `maxRetransmits`). Override when a
     * transport provides different guarantees.
     *
     * Rooms can read the merged capability via `this.transportCapabilities`.
     */
    get capabilities(): TransportCapability {
        return { ordered: true, reliable: true, maxFrameBytes: this.maxFrameBytes }
    }

    dispose(): void | Promise<void> {}

}

export default Transport
