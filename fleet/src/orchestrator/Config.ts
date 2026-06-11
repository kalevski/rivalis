/**
 * Orchestrator configuration normalization and defaults (§9). Consumed by the
 * Orchestrator (§9) and the CLI (§12).
 *
 * Scope note: this resolves option shapes and defaults and normalizes the
 * `string | string[]` key surface for rotation (§13). The §13 *security* checks
 * — key-strength enforcement, agent/admin audience separation, the production
 * refuse-to-start rules — live in {@link enforceSecurityPolicy} below, called by
 * the Orchestrator constructor: structural normalization and security hardening
 * stay separate, but both have their home in this module.
 */

import type { Logger } from '@toolcase/logging'

import { NOOP_LOGGER } from '../util/logger'

/**
 * Public orchestrator option surface (§9). Lives next to its primary consumer
 * (config resolution) rather than in the pure data model — it is consumer
 * configuration, not a read-model type. Re-exported from `main.ts`.
 */
export interface OrchestratorOptions {
    /** Bind address (default 0.0.0.0). */
    host?: string
    port: number
    /** Agent auth key(s) — agents connect with any listed key. */
    agentKey: string | string[]
    /** REST admin key(s) — required when `api: true`. */
    adminKey?: string | string[]
    /** Serve REST /v1 (default true). */
    api?: boolean
    heartbeatMs?: number
    commandTimeoutMs?: number
    /** CORS allow-origins, or false (default) for same-origin only. */
    cors?: false | { origins: string[] }
    /** Allow `?key=` auth on /v1/events for browser EventSource (§10, §13). */
    sseQueryAuth?: boolean
    /**
     * Trust `X-Forwarded-For` from a front proxy (default `false`, §13). When a
     * TLS-terminating reverse proxy / service mesh sits in front, enable this so the
     * per-IP failed-auth throttle and audit logs key on the real client IP (`req.ip`,
     * resolved from the forwarded header) instead of collapsing every client into the
     * proxy's single socket address. Leave off for direct exposure — a spoofable
     * header must not be trusted from an untrusted network.
     */
    trustProxy?: boolean
}

/** Defaults applied when an option is omitted (§9, §12). */
export const DEFAULT_HOST = '0.0.0.0'
export const DEFAULT_HEARTBEAT_MS = 5000
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000

/**
 * Key-strength thresholds enforced at startup in production (§13). A key shorter
 * than {@link MIN_KEY_LENGTH} is *refused*; one shorter than {@link WEAK_KEY_LENGTH}
 * is *warned*. "It's a private network" does not justify a guessable key — the
 * private-network assumption covers transport, not authentication.
 */
export const MIN_KEY_LENGTH = 16
export const WEAK_KEY_LENGTH = 32

/** Context for {@link enforceSecurityPolicy}; both fields injectable for tests. */
export interface SecurityContext {
    /**
     * `NODE_ENV`; `'production'` triggers the refuse-to-start rules (§13). The
     * caller supplies it (the Orchestrator sources it from `src/env.ts`); this
     * module never reads the environment directly.
     */
    env?: string
    /** Where warnings go (`fleet` logger in production); default a no-op. */
    logger?: Logger
}

/** Fully-resolved, internally-consistent orchestrator configuration. */
export interface ResolvedConfig {
    host: string
    port: number
    /** Every accepted agent key (normalized from `string | string[]`). */
    agentKeys: string[]
    /** Every accepted admin key (normalized; empty when REST is disabled). */
    adminKeys: string[]
    api: boolean
    heartbeatMs: number
    commandTimeoutMs: number
    cors: false | { origins: string[] }
    sseQueryAuth: boolean
    /** Trust `X-Forwarded-For` for per-client IP attribution behind a proxy (§13). */
    trustProxy: boolean
}

/** Normalize a `string | string[]` key option into a de-duplicated list. */
function normalizeKeys(value: string | string[] | undefined): string[] {
    if (value === undefined) {
        return []
    }
    const list = Array.isArray(value) ? value : [value]
    const seen = new Set<string>()
    for (const key of list) {
        if (typeof key === 'string' && key.length > 0) {
            seen.add(key)
        }
    }
    return [...seen]
}

/**
 * Resolve raw {@link OrchestratorOptions} into a {@link ResolvedConfig}, applying
 * defaults and basic structural validation. Throws on structurally invalid input
 * (missing port, no agent key, REST enabled without an admin key); credential
 * *strength* and *audience* validation is task 011.
 */
export function resolveConfig(options: OrchestratorOptions): ResolvedConfig {
    if (typeof options !== 'object' || options === null) {
        throw new Error('orchestrator config error: options must be an object')
    }
    if (typeof options.port !== 'number' || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error(`orchestrator config error: port must be an integer in [0, 65535], got ${String(options.port)}`)
    }

    const agentKeys = normalizeKeys(options.agentKey)
    if (agentKeys.length === 0) {
        throw new Error('orchestrator config error: at least one agentKey is required')
    }

    const api = options.api ?? true
    const adminKeys = normalizeKeys(options.adminKey)
    if (api && adminKeys.length === 0) {
        throw new Error('orchestrator config error: adminKey is required when api is enabled')
    }

    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (typeof heartbeatMs !== 'number' || heartbeatMs <= 0) {
        throw new Error('orchestrator config error: heartbeatMs must be a positive number')
    }
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    if (typeof commandTimeoutMs !== 'number' || commandTimeoutMs <= 0) {
        throw new Error('orchestrator config error: commandTimeoutMs must be a positive number')
    }

    let cors: false | { origins: string[] } = false
    if (options.cors !== undefined && options.cors !== false) {
        if (!Array.isArray(options.cors.origins)) {
            throw new Error('orchestrator config error: cors.origins must be an array of strings')
        }
        cors = { origins: [...options.cors.origins] }
    }

    return {
        host: options.host ?? DEFAULT_HOST,
        port: options.port,
        agentKeys,
        adminKeys,
        api,
        heartbeatMs,
        commandTimeoutMs,
        cors,
        sseQueryAuth: options.sseQueryAuth ?? false,
        trustProxy: options.trustProxy ?? false
    }
}

/**
 * Enforce the §13 credential policy on a resolved config. Called by the
 * Orchestrator constructor so violations surface at `new Orchestrator(...)`, not
 * at runtime. Two rules *refuse to start* in production (throw); the rest *warn*:
 *
 *  - **Audience separation** — intersecting `agentKey`/`adminKey` lists let one
 *    key serve both audiences, silently re-opening the exact legacy single-token
 *    hole the two-key design closed. Refused in production, warned otherwise.
 *  - **Key strength** (production only) — a key shorter than {@link MIN_KEY_LENGTH}
 *    is refused; shorter than {@link WEAK_KEY_LENGTH} is warned.
 *
 * Messages never include key material (§13). `NODE_ENV` is taken **only** from
 * `context.env`; the caller sources it from `src/env.ts` (no env read lives here).
 */
export function enforceSecurityPolicy(config: ResolvedConfig, context: SecurityContext = {}): void {
    const env = context.env
    const isProduction = env === 'production'
    const logger = context.logger ?? NOOP_LOGGER

    // Audience separation: any key valid for both audiences is the legacy hole.
    const adminSet = new Set(config.adminKeys)
    const intersects = config.agentKeys.some((key) => adminSet.has(key))
    if (intersects) {
        const message =
            'orchestrator security: agentKey and adminKey lists intersect — one key serving both ' +
            'audiences re-opens the legacy single-token hole (§13)'
        if (isProduction) {
            throw new Error(`${message}; refusing to start when NODE_ENV=production`)
        }
        logger.warning(message)
    }

    // Key strength is enforced only in production; the dev convenience key (§12)
    // is always strong, and a non-production operator may use short keys for tests.
    if (!isProduction) {
        return
    }
    const allKeys = [...config.agentKeys, ...config.adminKeys]
    for (const key of allKeys) {
        if (key.length < MIN_KEY_LENGTH) {
            throw new Error(
                `orchestrator security: a configured key is shorter than ${MIN_KEY_LENGTH} characters — ` +
                'refusing to start when NODE_ENV=production (§13)'
            )
        }
    }
    for (const key of allKeys) {
        if (key.length < WEAK_KEY_LENGTH) {
            logger.warning(
                `orchestrator security: a configured key is shorter than ${WEAK_KEY_LENGTH} characters — ` +
                'weak; prefer 32+ (§13)'
            )
        }
    }
}
