/**
 * Single lazy `@rivalis/core` loader (task 002) — one definition of the
 * `import.meta.url` / `createRequire` dance the orchestrator, agent and CLI each
 * carried.
 *
 * Load `@rivalis/core` via its CommonJS entry, lazily. Two reasons:
 *  - eagerly importing core would pull its ESM build, which transitively imports
 *    a broken `@toolcase/serializer` ESM (`protobufjs/light` without `.js`) that
 *    Node's strict ESM resolver rejects — the CJS entry resolves cleanly;
 *  - consumers only need a transport / runtime when no client is injected, so
 *    importing `@rivalis/fleet` should not drag core in.
 * Works in both fleet builds: the CJS bundle has a native `require`; the ESM
 * bundle derives one from `import.meta.url`.
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
