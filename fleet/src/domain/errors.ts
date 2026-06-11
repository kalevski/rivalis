/**
 * The fleet's coded error hierarchy (task 004) — `FleetError extends
 * EndpointError`, with the HTTP status carried **on the error class** instead of
 * a side table in the REST router. The node-service blueprint puts domain errors
 * here in `src/domain/errors.ts` and maps them with `errorMeta(e)`, so the router
 * no longer owns a parallel `code → status` table that could drift from the throw
 * sites (spec §10 codes are unchanged; only the mapping *mechanism* moves).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * `@toolcase/node` adoption (task 006)
 *
 * `EndpointError`, `errorMeta`, and `isLibError` now come from **`@toolcase/node`**
 * (the local port that stood in until task 006 — while `@toolcase/node` was not
 * loadable here — is deleted). The package is listed in `tsup.config.ts`'s
 * `external`, so the one `EndpointError` class identity is shared across every
 * bundle: a {@link FleetError} thrown in the `FleetState`/`Orchestrator` bundle is
 * recognized by the router bundle's `errorMeta` via `instanceof EndpointError`
 * (the *base* is externalized; `FleetError` itself is still bundled per-entry, but
 * the mapping checks the shared base, never `FleetError`). That is exactly the
 * cross-bundle correctness the earlier structural port was working around.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { EndpointError } from '@toolcase/node'

import type { FleetErrorCode } from './types'

// Re-export `@toolcase/node`'s `EndpointError` so the fleet keeps a single base for
// every coded error (and the domain barrel stays the one place errors come from).
// The HTTP mapping uses `errorMeta` from `@toolcase/node` directly at the router
// (`src/routers/shared.ts`); it recognizes any `FleetError` via `instanceof
// EndpointError` because the base is externalized (one class identity, all bundles).
export { EndpointError }

/**
 * Stable `FleetErrorCode` → HTTP status, exactly per the §10 error table. Single
 * source of truth, resolved at {@link FleetError} construction so the status lives
 * on the error and the router needs no parallel table.
 */
const CODE_TO_STATUS: Record<FleetErrorCode, number> = {
    VALIDATION: 400,
    UNAUTHORIZED: 401,
    INSTANCE_NOT_FOUND: 404,
    ROOM_NOT_FOUND: 404,
    NO_CANDIDATE: 409,
    ROOM_EXISTS: 409,
    INSTANCE_DRAINING: 409,
    PAYLOAD_TOO_LARGE: 413,
    INSTANCE_BUSY: 429,
    AUTH_THROTTLED: 429,
    SSE_LIMIT: 429,
    COMMAND_FAILED: 502,
    INSTANCE_DISCONNECTED: 502,
    COMMAND_TIMEOUT: 504
}

/**
 * Coded error surfaced by placement, the command engine, and REST validation
 * (§9/§10). Extends `@toolcase/node`'s {@link EndpointError}, resolving its HTTP
 * `statusCode` from the §10 table at construction — so `errorMeta` maps it (via
 * `instanceof EndpointError`) without the router knowing the table. The public
 * `code` contract (a {@link FleetErrorCode}) is the documented REST envelope `cause`
 * (spec §10) and is unchanged.
 */
export class FleetError extends EndpointError {
    declare readonly code: FleetErrorCode

    constructor(code: FleetErrorCode, message: string) {
        super(CODE_TO_STATUS[code], code, message)
        this.name = 'FleetError'
    }
}
