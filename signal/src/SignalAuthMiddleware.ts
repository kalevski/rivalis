/**
 * Auth middleware for the @rivalis/signal WS leg (p2p.md §4.3, §8).
 *
 * Ticket format: `<roomId>:<secret>`
 *   - roomId   — the signal room to join (identifies the WebRTC session)
 *   - secret   — validated constant-time against the configured secrets
 *
 * Returns { data: null, roomId } on success; null rejects the connection
 * with CloseCode.INVALID_TICKET.
 *
 * Constant-time compare: SHA-256 both sides, then `timingSafeEqual` on the
 * fixed-length digests — raw timingSafeEqual throws on unequal lengths, which
 * both leaks length and crashes. The loop always runs over every configured
 * secret so timing never reveals which secret (if any) matched.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import AuthMiddleware from '@rivalis/core'
import type { AuthResult, ConnectionContext } from '@rivalis/core'

export type SignalAuthOptions = {
    /**
     * One or more valid secrets. Any listed secret is accepted, enabling
     * zero-downtime rotation: issue the new secret, wait a TTL, revoke the old one.
     */
    secrets: string[]
}

class SignalAuthMiddleware extends AuthMiddleware<null> {
    private readonly secrets: readonly string[]

    constructor(options: SignalAuthOptions) {
        super()
        if (options.secrets.length === 0) {
            throw new Error('SignalAuthMiddleware: at least one secret is required')
        }
        this.secrets = options.secrets
    }

    override async authenticate(ticket: string, _context?: ConnectionContext): Promise<AuthResult<null> | null> {
        const sep = ticket.indexOf(':')
        if (sep <= 0) return null
        const roomId = ticket.slice(0, sep)
        const presented = ticket.slice(sep + 1)
        if (!roomId || !presented) return null
        if (!this.matchSecret(presented)) return null
        return { data: null, roomId }
    }

    private matchSecret(presented: string): boolean {
        if (typeof presented !== 'string' || presented.length === 0 || this.secrets.length === 0) {
            return false
        }
        const presentedDigest = createHash('sha256').update(presented).digest()
        let matched = false
        for (const secret of this.secrets) {
            const candidate = createHash('sha256').update(secret).digest()
            // Always iterate all secrets — never break early to avoid timing leaks.
            if (timingSafeEqual(presentedDigest, candidate)) matched = true
        }
        return matched
    }
}

export default SignalAuthMiddleware
