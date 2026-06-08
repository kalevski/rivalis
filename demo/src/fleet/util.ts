import type { Orchestrator } from '@rivalis/fleet'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `predicate` until it returns true or the deadline passes. Used to wait
 * for orchestrator read-model convergence (the read model catches up on the
 * next poll, up to one heartbeatMs after a change — §7).
 */
export async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 5000, intervalMs = 50, label = 'condition' }: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
        }
        await sleep(intervalMs)
    }
}

/** Print a compact snapshot of the orchestrator's live read model (§9). */
export function printFleet(orchestrator: Orchestrator, title: string): void {
    const stats = orchestrator.fleet.stats
    console.log(`\n── ${title} ──  instances=${stats.instances} rooms=${stats.rooms} connections=${stats.connections}`)
    for (const inst of orchestrator.fleet.instances) {
        const region = inst.labels.region ?? '-'
        const max = inst.capacity.maxConnections ?? '∞'
        console.log(
            `   ${inst.name.padEnd(5)} region=${region.padEnd(3)} ` +
            `status=${inst.status.padEnd(8)} rooms=${String(inst.rooms.length).padEnd(2)} ` +
            `conns=${inst.connections}/${max}`
        )
    }
}
