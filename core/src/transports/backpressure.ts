/**
 * Shared drop-or-escalate backpressure helper used by all transports (p2p.md §7).
 *
 * Both WSTransport (socket.bufferedAmount) and RTCTransport
 * (RTCDataChannel.bufferedAmount) call checkBackpressure with their
 * transport-native buffered-byte count so the policy and the
 * onBackpressureDrop hook signature are identical across transports.
 */

/** Called when a frame is dropped due to backpressure. */
export type BackpressureDropFn = (actorId: string, bufferedAmount: number) => void

/** 1 MiB — shared default for both WSTransport and RTCTransport. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * Returns true when the frame should be dropped, false when it is safe to
 * send. Logs the drop and invokes the hook before returning true.
 */
export function checkBackpressure(
    actorId: string,
    bufferedAmount: number,
    maxBufferedBytes: number,
    onDrop: BackpressureDropFn | null,
    log: (msg: string) => void,
): boolean {
    if (bufferedAmount <= maxBufferedBytes) return false
    log(`backpressure: dropping message for actor=${actorId}, buffered=${bufferedAmount} bytes (limit=${maxBufferedBytes})`)
    if (onDrop !== null) onDrop(actorId, bufferedAmount)
    return true
}
