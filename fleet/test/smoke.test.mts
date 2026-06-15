import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// ---------------------------------------------------------------------------
// task 012 — load smoke test for the unused `redis` runtime dependency.
//
// `@rivalis/fleet` lists `redis` in its `dependencies` although it never opens a
// Redis connection: `@toolcase/node@4` is a monolithic bundle that eager-`require`s
// `redis` at module top (it is an *optional* peer of `@toolcase/node`, but the eager
// require makes it mandatory in practice). The fleet's orchestrator entry imports
// `@toolcase/node` (Router/RouteHandler/EndpointError), so without `redis` installed
// `require('@rivalis/fleet')` throws `MODULE_NOT_FOUND: redis`.
//
// These tests pin that contract: both package entries must load in a clean install,
// and the `redis` / `@toolcase/node` eager-load precondition must hold. The point is
// to FAIL LOUDLY if someone drops `redis` from package.json while the upstream
// eager-load still persists — see the README "Install" note and the §5 spec
// paragraph (new_service.md) for why the line is kept.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

test('require("@rivalis/fleet") (CJS entry) loads with the eager-required redis present', () => {
    // Loads lib/main.js, which transitively requires @toolcase/node -> require("redis").
    // If `redis` were missing this throws before reaching the assertions below.
    const cjs = require('../lib/main.js') as typeof import('../lib/module.js')
    assert.equal(typeof cjs.Orchestrator, 'function')
    assert.equal(typeof cjs.FleetAgent, 'function')
    assert.equal(typeof cjs.FleetError, 'function')
    assert.equal(typeof cjs.PROTOCOL_VERSION, 'number')
})

test('import("@rivalis/fleet") (ESM entry) loads', async () => {
    const esm = await import('../lib/module.js')
    assert.equal(typeof esm.Orchestrator, 'function')
    assert.equal(typeof esm.FleetAgent, 'function')
    assert.equal(typeof esm.FleetError, 'function')
    assert.equal(typeof esm.PROTOCOL_VERSION, 'number')
})

test('the eager-load precondition holds: redis and @toolcase/node both resolve', () => {
    // The reason `redis` cannot be dropped: @toolcase/node requires it at module top.
    assert.doesNotThrow(() => require.resolve('redis'), 'redis must stay installed to satisfy @toolcase/node@4 eager require')
    assert.doesNotThrow(() => require.resolve('@toolcase/node'))
    // Proves the eager `require("redis")` inside @toolcase/node actually succeeds.
    assert.doesNotThrow(() => require('@toolcase/node'))
})
