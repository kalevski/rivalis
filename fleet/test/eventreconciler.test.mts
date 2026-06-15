import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EventReconciler } from '../lib/EventReconciler.js'

// ---------------------------------------------------------------------------
// Direct unit tests for the event reconciler (task 008 decomposition). It diffs a
// read model and emits events through the injected emit callback — fed a fake,
// mutable read model here (no FleetState, no Orchestrator) (§15).
// ---------------------------------------------------------------------------

/** A mutable fake read model: set `.instances`/`.hash`, then call reconcile(). */
function makeReadModel() {
    return {
        instances: [] as any[],
        hash: 'h0',
        get stats() { return { stateHash: this.hash } as any }
    }
}

const room = (id: string) => ({ id, type: 'match', connections: 0, instanceId: 'i1', endpointUrl: 'wss://x', local: false })
const instance = (id: string, rooms: any[] = []) => ({ id, rooms })

function makeReconciler() {
    const events: Array<{ type: string; data: any }> = []
    const model = makeReadModel()
    const reconciler = new EventReconciler(model as any, (type, data) => events.push({ type, data }))
    return { reconciler, model, events, of: (t: string) => events.filter((e) => e.type === t) }
}

test('first reconcile emits instance:join, room:create and a sync', () => {
    const { reconciler, model, events, of } = makeReconciler()
    model.instances = [instance('i1', [room('r1')])]
    model.hash = 'h1'
    reconciler.reconcile()

    assert.equal(of('instance:join').length, 1)
    assert.equal(of('instance:join')[0]!.data.id, 'i1')
    assert.equal(of('room:create').length, 1)
    assert.equal(of('room:create')[0]!.data.id, 'r1')
    assert.equal(of('sync').length, 1, 'sync on the hash change')
    void events
})

test('a new room emits room:create; a removed room emits room:destroy; sync fires only on hash change', () => {
    const { reconciler, model, of } = makeReconciler()
    model.instances = [instance('i1', [room('r1')])]
    model.hash = 'h1'
    reconciler.reconcile()

    // Add r2.
    model.instances = [instance('i1', [room('r1'), room('r2')])]
    model.hash = 'h2'
    reconciler.reconcile()
    assert.equal(of('room:create').length, 2, 'room:create for r2')

    // Reconcile with no semantic change → no extra sync, no room events.
    reconciler.reconcile()
    assert.equal(of('sync').length, 2, 'no sync when the hash is unchanged')

    // Remove r1.
    model.instances = [instance('i1', [room('r2')])]
    model.hash = 'h3'
    reconciler.reconcile()
    assert.equal(of('room:destroy').length, 1, 'room:destroy for r1')
    assert.equal(of('room:destroy')[0]!.data.id, 'r1')
    assert.equal(of('sync').length, 3)
})

test('instanceRemoved emits instance:leave and a following reconcile destroys its rooms', () => {
    const { reconciler, model, of } = makeReconciler()
    const i1 = instance('i1', [room('r1')])
    model.instances = [i1]
    model.hash = 'h1'
    reconciler.reconcile()

    // Teardown sequence: instance gone from the read model, then leave + reconcile.
    model.instances = []
    model.hash = 'h2'
    reconciler.instanceRemoved(i1 as any)
    reconciler.reconcile()

    assert.equal(of('instance:leave').length, 1)
    assert.equal(of('instance:leave')[0]!.data.id, 'i1')
    assert.equal(of('room:destroy').length, 1, 'the vanished instance\'s room is destroyed on reconcile')

    // A re-join of the same id fires instance:join again (knownInstanceIds was cleared).
    model.instances = [instance('i1', [])]
    model.hash = 'h3'
    reconciler.reconcile()
    assert.equal(of('instance:join').length, 2, 'a re-join after leave emits instance:join again')
})
