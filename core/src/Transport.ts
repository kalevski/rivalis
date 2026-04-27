import type TLayer from './TLayer'

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

    abstract onInitialize(transportLayer: TLayer<any>): void

    /**
     * Number of raw, currently-open transport connections (sockets that
     * have completed the handshake but may or may not have joined a room).
     */
    abstract get sockets(): number

    dispose(): void | Promise<void> {}

}

export default Transport
