import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// ---------------------------------------------------------------------------
// task 010 — `FleetError` must be a *value* export from the supported public
// entry (§5), so an embedding matchmaker can `instanceof FleetError` / narrow
// `.code` on the errors that `orchestrator.fleet.*` reject with (§9/§10) WITHOUT
// a deep `lib/*` import that bypasses the package `exports` map.
//
// Cross-bundle identity is the documented hazard (src/domain/errors.ts): tsup
// bundles `FleetError` per-entry, so the class from `lib/main.js` (CJS) and the
// one from `lib/module.js` (ESM) are distinct identities. The contract that must
// hold is *within* an entry: the Orchestrator imported from an entry rejects with
// the same `FleetError` that entry exports. Each case below therefore pairs the
// Orchestrator and the FleetError from the same build.
// ---------------------------------------------------------------------------

// ESM build — clean named exports.
import { FleetError as FleetErrorESM, Orchestrator as OrchestratorESM } from '../lib/module.js'

// CJS build — `require('@rivalis/fleet')` shape.
const require = createRequire(import.meta.url)
const cjs = require('../lib/main.js') as typeof import('../lib/module.js')

// api:false so config resolution needs no adminKey; no listen() → no core load,
// no timers. createRoom on an empty read model rejects NO_CANDIDATE synchronously
// (placement fails before any reservation/timeout), so the case stays self-contained.
const BASE_OPTS = { port: 0, agentKey: 'agent-key', api: false as const }

test('import { FleetError } from "@rivalis/fleet" works in the CJS build', () => {
    assert.equal(typeof cjs.FleetError, 'function')
    const e = new cjs.FleetError('NO_CANDIDATE', 'x')
    assert.ok(e instanceof Error)
    assert.equal(e.code, 'NO_CANDIDATE')
})

test('import { FleetError } from "@rivalis/fleet" works in the ESM build', () => {
    assert.equal(typeof FleetErrorESM, 'function')
    const e = new FleetErrorESM('NO_CANDIDATE', 'x')
    assert.ok(e instanceof Error)
    assert.equal(e.code, 'NO_CANDIDATE')
})

test('an error thrown by orchestrator.fleet.createRoom is instanceof the public FleetError (CJS)', async () => {
    const orch = new cjs.Orchestrator(BASE_OPTS)
    await assert.rejects(
        orch.fleet.createRoom({ type: 'match' }),
        (e: unknown) => e instanceof cjs.FleetError && e.code === 'NO_CANDIDATE'
    )
})

test('an error thrown by orchestrator.fleet.createRoom is instanceof the public FleetError (ESM)', async () => {
    const orch = new OrchestratorESM(BASE_OPTS)
    await assert.rejects(
        orch.fleet.createRoom({ type: 'match' }),
        (e: unknown) => e instanceof FleetErrorESM && e.code === 'NO_CANDIDATE'
    )
})
