/**
 * Single lazy `@rivalis/core` loader (task 002) — one definition of the
 * `import.meta.url` / `createRequire` dance the orchestrator, agent and CLI each
 * carried.
 *
 * Load `@rivalis/core` via its CommonJS entry, lazily. Reason: consumers only
 * need a runtime when no client is injected, so importing `@rivalis/fleet`
 * should not drag core in unconditionally.
 * Works in both fleet builds: the CJS bundle has a native `require`; the ESM
 * bundle derives one from `import.meta.url`.
 *
 * Note: the F5 ESM hazard (broken `protobufjs/light` import in
 * `@toolcase/serializer`) was fixed in `@rivalis/core` 7.0.0 via the lazy
 * serializer loader in `@rivalis/handshake`. The CJS path is kept here for
 * the lazy-load benefit, not to work around a broken ESM entry.
 */

import { createRequire } from 'node:module'

export function loadCore(): typeof import('@rivalis/core') {
    // In the ESM bundle `import.meta.url` is a real file URL → derive a require
    // from it. In the CJS bundle esbuild empties `import.meta`, so the URL is
    // falsy and the native `require` is used directly.
    const metaUrl = import.meta.url
    const req = metaUrl ? createRequire(metaUrl) : require
    return req('@rivalis/core') as typeof import('@rivalis/core')
}
