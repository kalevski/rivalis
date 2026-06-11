/**
 * @rivalis/fleet demo — the orchestrator (control plane) + a simple matchmaker.
 *
 * This process runs ONLY the control plane:
 *   · an Orchestrator — instance discovery, room placement, remote room
 *                       create/destroy, drain, and REST /v1.
 *   · a Matchmaker    — built on `orchestrator.fleet`; pairs queued players and
 *                       asks the fleet to place a match room for each.
 *
 * Game-server instances are NOT started here. Run the demo server with its
 * FleetAgent enabled and it self-registers as an instance the orchestrator can
 * place matches on:
 *
 *   FLEET=1 npm run dev:server -w @rivalis/demo
 *   FLEET=1 FLEET_INSTANCE_NAME=eu1 FLEET_REGION=eu npm run dev:server -w @rivalis/demo
 *
 * Run the orchestrator:  npm run fleet -w @rivalis/demo   (from repo root)
 *                        npm run fleet                     (from demo/)
 */

import { logging } from '@rivalis/core'
import { Orchestrator } from '@rivalis/fleet'

import { Matchmaker, type QueuedPlayer } from './Matchmaker'
import { printFleet, sleep, waitFor } from './util'
import { ADMIN_KEY, AGENT_KEY, MATCH_ROOM_TYPE, ORCH_PORT } from './protocol'

// Keep core's own logs quiet so the demo narration is readable; flip to 'info'
// to watch the orchestrator/agent protocol chatter.
logging.level = 'error'

const HEARTBEAT_MS = 1000

async function main(): Promise<void> {
    const orchestrator = new Orchestrator({
        port: ORCH_PORT,
        agentKey: AGENT_KEY,
        adminKey: ADMIN_KEY,
        api: true,
        heartbeatMs: HEARTBEAT_MS
    })

    const nameOf = (instanceId: string): string => orchestrator.fleet.getInstance(instanceId)?.name ?? instanceId

    // The event stream a dashboard would consume. Room events are filtered to
    // fleet-placed rooms so the narration is about matches, not the instance's
    // own local rooms (lobby/counter/ttt/arena) that surface on join.
    orchestrator.on('instance:join', (i: any) => console.log(`   [event] instance:join  ${i.name}`))
    orchestrator.on('instance:leave', (i: any) => console.log(`   [event] instance:leave ${i.name}`))
    orchestrator.on('instance:stale', (i: any) => console.log(`   [event] instance:stale ${i.name}`))
    orchestrator.on('room:create', (r: any) => { if (!r.local) console.log(`   [event] room:create    ${r.id} on ${nameOf(r.instanceId)}`) })
    orchestrator.on('room:destroy', (r: any) => { if (!r.local) console.log(`   [event] room:destroy   ${r.id}`) })

    console.log('starting orchestrator (control plane + REST) on port', ORCH_PORT)
    await orchestrator.listen()

    // ---- Discovery: wait for a game-server instance to self-register --------
    console.log('\nwaiting for a game-server instance to register...')
    console.log('   start one with:  FLEET=1 npm run dev:server -w @rivalis/demo')
    await waitFor(() => orchestrator.fleet.instances.length >= 1, { timeoutMs: 120_000, label: 'at least one instance to register' })
    printFleet(orchestrator, 'fleet after discovery')

    // ---- Simple matchmaking -------------------------------------------------
    // Pair queued players and ask the fleet to place a match room per pair
    // (least-loaded by default). No simulated players connect — the rooms are
    // placement targets that show where the fleet put each match.
    const matchmaker = new Matchmaker(orchestrator.fleet)
    console.log('\nmatchmaker pairs players; fleet places a match room per pair')
    matchmaker.enqueue(...named(['ava', 'ben', 'cleo', 'dan']))
    const assignments = await matchmaker.formMatches()
    for (const a of assignments) {
        console.log(`   match ${a.room.id} → ${nameOf(a.room.instanceId)} (${a.players.map((p) => p.name).join(' vs ')})`)
    }
    await waitFor(
        () => orchestrator.fleet.findRooms({ type: MATCH_ROOM_TYPE }).length >= assignments.length,
        { timeoutMs: 6000, label: 'placed match rooms to sync into the read model' }
    )
    printFleet(orchestrator, 'fleet after placement')

    // ---- Stay alive as a control plane --------------------------------------
    console.log('\norchestrator running. poke the REST control plane:')
    console.log(`   curl -H "Authorization: Bearer ${ADMIN_KEY}" http://localhost:${ORCH_PORT}/v1/instances`)
    console.log('   (Ctrl-C to stop)')
    await waitForSignal()

    console.log('\nshutting down... destroying placed match rooms')
    for (const a of assignments) {
        await orchestrator.fleet.destroyRoom(a.room.id).catch(() => {})
    }
    await sleep(100)
    await orchestrator.shutdown()
}

// ---- helpers -------------------------------------------------------------

function named(names: string[], region?: string): QueuedPlayer[] {
    return names.map((name) => (region === undefined ? { name } : { name, region }))
}

/** Resolve on the first SIGINT/SIGTERM so the control plane lingers until stopped. */
function waitForSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve())
        process.once('SIGTERM', () => resolve())
    })
}

main().catch((error) => {
    console.error('fleet demo failed:', error)
    process.exit(1)
})
