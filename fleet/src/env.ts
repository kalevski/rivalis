/**
 * The single typed home for every environment variable the fleet reads (task 003).
 *
 * The node-service blueprint mandates one module that owns the full env surface —
 * no `process.env.X` read may live anywhere else in `src/` — so an operator can
 * learn every knob from one file and there is exactly **one** parsing behavior
 * instead of the three hand-rolled parsers (`envInt`, `envBool`, bare string
 * reads) this replaces.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * `@toolcase/node` deferral (spec §5 dependency rule)
 *
 * The blueprint's loader is `@toolcase/node`'s `env(name, default, type)`. The
 * published `@toolcase/node` (3.x/4.x) is, however, a monolithic backend bundle:
 * importing it **eager-loads `fastify`/`@fastify/cors`/`redis`** at module top
 * (verified: a bare `require('@toolcase/node')` throws `MODULE_NOT_FOUND: fastify`,
 * and esbuild cannot bundle it for an env-only import either), and it peers on
 * `@toolcase/base@^3` while `@rivalis/core` (and fleet) pin `@toolcase/base@2.x`.
 * `fastify` only enters the fleet in **task 006** (the `@toolcase/node` HTTP
 * server task); that — together with the `@toolcase/base` 2→3 bump — is the point
 * at which `@toolcase/node` becomes loadable here.
 *
 * Until then, {@link env} below is a **faithful, byte-for-byte port of
 * `@toolcase/node@4`'s `env()`** (identical overloads and fallback semantics), so
 * task 006 replaces the local definition with `import env from '@toolcase/node'`
 * in a single line, with **zero** call-site changes. {@link readEnv} is unaffected.
 *
 * NOTE (task 012): of that eager-loaded set, `redis` is dead weight here — the
 * fleet never opens a Redis connection. It is kept as a direct dependency **only**
 * to satisfy `@toolcase/node@4`'s eager `require('redis')` (it is an optional peer
 * of `@toolcase/node`, but the bundle requires it at module top regardless), so
 * `require('@rivalis/fleet')` does not throw `MODULE_NOT_FOUND: redis`. Documented
 * at the declaration site (README "Install") and guarded by a smoke test; it drops
 * once `@toolcase/node` lazy-loads `redis` upstream.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Default port when neither `-p/--port` nor `FLEET_PORT` is set (§12). */
export const DEFAULT_PORT = 7350
/** Default agent heartbeat interval (§12). */
export const DEFAULT_HEARTBEAT_MS = 5000
/** Default command ack timeout (§12). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000
/** Default §12 log level when neither `--log-level` nor `FLEET_LOG_LEVEL` is set. */
export const DEFAULT_LOG_LEVEL = 'info'

/**
 * Typed environment loader — a faithful port of `@toolcase/node@4`'s `env()`
 * (see the deferral note above). Reads `process.env[key]` and coerces by `type`,
 * falling back to `defaultValue` when the variable is unset or fails a round-trip
 * parse (`parseInt(v).toString() !== v` for numbers, anything but `true`/`false`
 * for booleans). This lenient-fallback behavior is intentional and is the single
 * env-parsing semantic across the CLI — unlike the old `envInt`, which *threw* on
 * a malformed integer.
 */
function env(key: string): string | null
function env(key: string, defaultValue: string, type?: 'string'): string
function env(key: string, defaultValue: number, type: 'number'): number
function env(key: string, defaultValue: boolean, type: 'boolean'): boolean
function env(key: string, defaultValue: null, type: 'number'): number | null
function env(key: string, defaultValue: null, type: 'boolean'): boolean | null
function env(
    key: string,
    defaultValue: string | number | boolean | null = null,
    type: 'string' | 'number' | 'boolean' = 'string'
): string | number | boolean | null {
    if (typeof process === 'undefined') {
        throw new Error('env works only with NodeJS')
    }
    const value = process.env[key]
    if (type === 'number') {
        if (value === undefined) {
            return defaultValue
        }
        const numberValue = parseInt(value, 10)
        return numberValue.toString() === value ? numberValue : defaultValue
    }
    if (type === 'boolean') {
        const boolValue = `${value}`.toLowerCase()
        if (boolValue === 'true') {
            return true
        }
        if (boolValue === 'false') {
            return false
        }
        return defaultValue
    }
    return value !== undefined ? value : defaultValue
}

/**
 * Split a comma-separated env value into a trimmed, non-empty list — used for the
 * key-rotation lists `FLEET_AGENT_KEY` / `FLEET_ADMIN_KEY` and `FLEET_CORS_ORIGINS`
 * (§13). Kept next to the consts as the one documented place csv lists are parsed.
 */
export function splitCsv(raw: string | null | undefined): string[] {
    if (raw === undefined || raw === null) {
        return []
    }
    return raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
}

/** Every environment variable the fleet reads, typed and defaulted in one place. */
export interface FleetEnv {
    /** `NODE_ENV`; `'production'` triggers the §12/§13 refuse-to-start rules. */
    NODE_ENV: string | null

    // ── Networking (§12) ──────────────────────────────────────────────────────
    /** Bind address; `null` leaves the Orchestrator default (`0.0.0.0`) to apply. */
    FLEET_HOST: string | null
    /** HTTP/WS port. */
    FLEET_PORT: number
    /** Trust `X-Forwarded-For` from a front proxy for per-client IP attribution (§13). */
    FLEET_TRUST_PROXY: boolean

    // ── Credentials (§13) — comma-separated lists for key rotation ─────────────
    /** Agent auth key(s); split with {@link splitCsv}. */
    FLEET_AGENT_KEY: string | null
    /** REST admin key(s); split with {@link splitCsv}. */
    FLEET_ADMIN_KEY: string | null

    // ── Tunables (§12) ─────────────────────────────────────────────────────────
    /** Agent heartbeat interval (ms). */
    FLEET_HEARTBEAT_MS: number
    /** Command ack timeout (ms). */
    FLEET_COMMAND_TIMEOUT_MS: number
    /** CORS allow-origins, comma-separated; split with {@link splitCsv}. */
    FLEET_CORS_ORIGINS: string | null
    /** Allow `?key=` auth on `/v1/events` for browser `EventSource` (§10, §13). */
    FLEET_SSE_QUERY_AUTH: boolean
    /** §12 log level token (`trace|debug|info|warn|error`); validated in `cli.ts`. */
    FLEET_LOG_LEVEL: string
}

/**
 * Read the full env surface, with defaults applied, from `source` (default
 * `process.env`). The `source` seam keeps `resolveCliConfig`'s injectable-env test
 * contract: {@link env} reads `process.env` directly (matching `@toolcase/node`'s
 * loader, which has no source parameter), so `source` is bound by temporarily
 * swapping `process.env` for the duration of this synchronous read — the only way
 * a per-call source can drive `env()` and the form that keeps working unchanged
 * once the local {@link env} is swapped for the real `@toolcase/node` import (§006).
 *
 * Env *defaults* live here; the flag → env → default *precedence* stays in `cli.ts`.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): FleetEnv {
    const previous = process.env
    process.env = source
    try {
        return {
            NODE_ENV: env('NODE_ENV'),
            FLEET_HOST: env('FLEET_HOST'),
            FLEET_PORT: env('FLEET_PORT', DEFAULT_PORT, 'number'),
            FLEET_TRUST_PROXY: env('FLEET_TRUST_PROXY', false, 'boolean'),
            FLEET_AGENT_KEY: env('FLEET_AGENT_KEY'),
            FLEET_ADMIN_KEY: env('FLEET_ADMIN_KEY'),
            FLEET_HEARTBEAT_MS: env('FLEET_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS, 'number'),
            FLEET_COMMAND_TIMEOUT_MS: env('FLEET_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS, 'number'),
            FLEET_CORS_ORIGINS: env('FLEET_CORS_ORIGINS'),
            FLEET_SSE_QUERY_AUTH: env('FLEET_SSE_QUERY_AUTH', false, 'boolean'),
            FLEET_LOG_LEVEL: env('FLEET_LOG_LEVEL', DEFAULT_LOG_LEVEL, 'string')
        }
    } finally {
        process.env = previous
    }
}

/** `NODE_ENV` only — the security-policy call sites need just this (Config/Orchestrator). */
export function nodeEnv(): string | null {
    return env('NODE_ENV')
}
