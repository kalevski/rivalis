/**
 * WebSocket close codes used by `@rivalis/core` and `@rivalis/browser`.
 * Mirrors the enum exported from `@rivalis/core` so client code can map
 * `CloseEvent.code` to a human-readable reason.
 *
 * @readonly
 * @enum {number}
 */
const CloseCode = Object.freeze({
    INVALID_TICKET: 4001,
    INVALID_FRAME: 4002,
    KICKED: 4003
})

export default CloseCode
