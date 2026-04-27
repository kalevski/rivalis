import type TLayer from './TLayer'

class Transport {

    onInitialize(_transportLayer: TLayer<any>): void {}

    /**
     * Number of raw, currently-open transport connections (sockets that
     * have completed the handshake but may or may not have joined a room).
     * Subclasses should override.
     */
    get sockets(): number {
        return 0
    }

    dispose(): void | Promise<void> {}
}

export default Transport
