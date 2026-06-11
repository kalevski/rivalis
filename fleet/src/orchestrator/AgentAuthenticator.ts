/**
 * Agent-key authentication (§13) — the **one** definition of the constant-time
 * key-match the control plane needs, shared by the WS auth middleware (this
 * module) and the REST auth hook (`routers/shared.ts` imports {@link matchKey}).
 * Before the decomposition the SHA-256 + `timingSafeEqual` pattern was duplicated
 * in `Orchestrator.matchesAgentKey` and `httpApi.matchedKey`; it now lives here once.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time key match (§13): SHA-256 both sides, then `timingSafeEqual` on the
 * fixed-length digests — raw `timingSafeEqual` throws on unequal length, which both
 * leaks length and crashes the handler. Returns the configured key that matched, or
 * `null`. The loop always runs over **every** key so timing never leaks which key
 * (if any) matched.
 */
export function matchKey(presented: string | null, keys: readonly string[]): string | null {
    if (typeof presented !== 'string' || presented.length === 0 || keys.length === 0) {
        return null
    }
    const presentedDigest = createHash('sha256').update(presented).digest()
    let matched: string | null = null
    for (const key of keys) {
        const candidate = createHash('sha256').update(key).digest()
        if (timingSafeEqual(presentedDigest, candidate)) {
            matched = key
        }
    }
    return matched
}

/**
 * Validates an agent's connection ticket against the configured agent keys. The WS
 * `AuthMiddleware` in {@link Orchestrator.listen} delegates here; rotation works
 * because any listed key is accepted (§13). Throttling / audience-separation /
 * fingerprint hardening live in the REST hook (task 011).
 */
export class AgentAuthenticator {
    constructor(private readonly agentKeys: readonly string[]) {}

    /** True when `ticket` is one of the configured agent keys (constant-time, §13). */
    matches(ticket: string): boolean {
        return matchKey(ticket, this.agentKeys) !== null
    }
}
