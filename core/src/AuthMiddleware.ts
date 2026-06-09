import type { ConnectionContext } from './types'

/**
 * Result of a successful `authenticate` call: the actor-data payload to
 * stamp on the connection, plus the room id the actor should be routed
 * to. Both fields come from the same parse of the ticket, so they
 * cannot drift relative to each other.
 */
export type AuthResult<TActorData> = {
    data: TActorData | null
    roomId: string
    /** Stable actor id to request. Honored when the id is free; falls back to CSPRNG allocation when absent or taken. */
    actorId?: string
}

/**
 * Validates a per-connection ticket and projects it into `{ data, roomId }`.
 * Implementations are invoked once per inbound socket from
 * `TLayer.grantAccess`, before the actor is added to any room.
 *
 * Return `null` to reject the connection — the transport will close it
 * with `CloseCode.INVALID_TICKET`. Return an `AuthResult` to accept.
 *
 * **Timing-oracle hazard.** If your implementation compares a ticket
 * (or any embedded secret like an HMAC, signature, or session token)
 * against a server-side value, use a constant-time comparator —
 * Node's `crypto.timingSafeEqual` or equivalent. A naïve `===` /
 * `Buffer.compare` short-circuits at the first mismatching byte and
 * leaks the prefix length to a network attacker over enough samples.
 *
 * **Don't trust the input shape.** `ticket` is whatever string the
 * transport extracts from the connection — query param, subprotocol,
 * or first-frame header. Validate length, charset, and structure
 * before hashing or parsing it.
 */
abstract class AuthMiddleware<TActorData = Record<string, unknown>> {

    abstract authenticate(ticket: string, context?: ConnectionContext): Promise<AuthResult<TActorData> | null>

    /**
     * @deprecated Implement `authenticate` directly. This method is
     * preserved only so the type of `AuthMiddleware` remains a
     * supertype of `LegacyAuthMiddleware`; it is never called when
     * `authenticate` is overridden, and throws if it is called.
     */
    validateTicket(_ticket: string): Promise<boolean> {
        throw new Error('AuthMiddleware.validateTicket is deprecated — implement authenticate() instead')
    }

    /** @deprecated Implement `authenticate` directly. */
    extractPayload(_ticket: string): Promise<TActorData | null> {
        throw new Error('AuthMiddleware.extractPayload is deprecated — implement authenticate() instead')
    }

    /** @deprecated Implement `authenticate` directly. */
    getRoomId(_ticket: string): Promise<string> {
        throw new Error('AuthMiddleware.getRoomId is deprecated — implement authenticate() instead')
    }

}

/**
 * Bridge for code written against the pre-`authenticate` shape of
 * `AuthMiddleware` (three separate methods: `validateTicket`,
 * `extractPayload`, `getRoomId`). Provides a default `authenticate`
 * that calls them in sequence so existing subclasses keep working
 * without changes.
 *
 * **Deprecated.** Will be removed in the next major version. Migrate
 * to `extends AuthMiddleware` and implement `authenticate` directly —
 * a single parse of the ticket is faster and rules out the bug class
 * where the three methods drift out of sync (e.g. `getRoomId` returns
 * a room implied by a different identity than `extractPayload`).
 *
 * @deprecated Extend `AuthMiddleware` and implement `authenticate` directly.
 */
abstract class LegacyAuthMiddleware<TActorData = Record<string, unknown>> extends AuthMiddleware<TActorData> {

    abstract override validateTicket(ticket: string): Promise<boolean>

    abstract override extractPayload(ticket: string): Promise<TActorData | null>

    abstract override getRoomId(ticket: string): Promise<string>

    override async authenticate(ticket: string, _context?: ConnectionContext): Promise<AuthResult<TActorData> | null> {
        const isValid = await this.validateTicket(ticket)
        if (isValid !== true) {
            return null
        }
        const data = await this.extractPayload(ticket)
        const roomId = await this.getRoomId(ticket)
        return { data, roomId }
    }

}

export { LegacyAuthMiddleware }
export default AuthMiddleware
