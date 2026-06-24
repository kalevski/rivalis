/**
 * WebSocket close codes used by `@rivalis/core` and `@rivalis/browser`.
 */
const CloseCode = Object.freeze({
    INVALID_TICKET: 4001,
    INVALID_FRAME: 4002,
    KICKED: 4003,
    ROOM_REJECTED: 4004,
    RATE_LIMITED: 4005
} as const)

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]

export default CloseCode
