/**
 * Poll scheduler & liveness (§7, task 011) — the orchestrator drives the
 * conversation. Replaces the pre-011 push model's `LivenessTracker` (the 2×/3×
 * heartbeat timers fed by *any* inbound traffic): under strict request/reply the
 * agent never proves liveness spontaneously, so the orchestrator polls each agent
 * every `intervalMs` (`fleet/poll`) and counts **missed poll replies**.
 *
 * - On {@link start}: send the first poll immediately, then a poll every interval —
 *   but only ONE poll is outstanding at a time (§7 Enforcement). The next poll is
 *   issued on the tick after the previous reply was consumed, never while one is
 *   still in flight.
 * - {@link reply} consumes the outstanding poll's `reqId` (the orchestrator's
 *   outstanding-request table for `fleet/state`); a reply that does not match the
 *   outstanding `reqId` returns `false` so the caller can kick (unsolicited /
 *   duplicate frame, §7 enforcement).
 * - Each tick where the previous poll went unanswered counts as a missed reply:
 *   2 consecutive misses → stale (excluded from placement), 3 → evict. This
 *   reproduces the old stale-at-2×heartbeat / evict-at-3×heartbeat timing. Because
 *   the outstanding `reqId` is retained across missed ticks, a *slow* agent (delayed
 *   reply, not silent) follows the stale→recover path on its late reply instead of
 *   being kicked — the bug this scheduler discipline fixes (task 002).
 *
 * Owns only its timers and the per-instance poll bookkeeping; it never touches the
 * read model or the command engine. Driven by the injected timeouts-only
 * {@link TimerScheduler}, so it is unit-tested directly with a fake clock (§15).
 */

import type { TimerScheduler } from '../util/scheduler'

/** Orchestrator hooks the poller calls — sending the poll and the stale/evict deadlines. */
export interface PollerCallbacks {
    /**
     * Build and send a `fleet/poll` to the instance with this `reqId`. `forceFull`
     * asks the orchestrator to poll with `knownHash: null` (a forced full reply) —
     * the periodic belt-and-braces against a silent hash-collision desync (§7).
     */
    sendPoll(instanceId: string, reqId: string, forceFull: boolean): void
    /** Two consecutive missed poll replies — exclude from placement (the orchestrator marks stale). */
    onStale(instanceId: string): void
    /** Three consecutive missed poll replies — evict (the orchestrator tears down + kicks the socket). */
    onEvict(instanceId: string): void
}

/** Force a full reply every N polls even when the hash is unchanged (§7 desync backstop). */
const FORCE_FULL_EVERY_POLLS = 12

interface PollEntry {
    timer: unknown
    /** The `reqId` of the in-flight poll awaiting a `fleet/state`; `null` once answered. */
    outstandingReqId: string | null
    /** Consecutive missed poll replies. */
    missed: number
    /** Polls sent on this connection — drives the periodic forced-full. */
    pollCount: number
}

export class Poller {

    private readonly entries = new Map<string, PollEntry>()
    private reqSeq = 0

    constructor(
        private readonly scheduler: TimerScheduler,
        private readonly intervalMs: number,
        private readonly callbacks: PollerCallbacks
    ) {}

    /** True while the instance is being polled (started and not yet forgotten). */
    has(instanceId: string): boolean {
        return this.entries.has(instanceId)
    }

    /** Begin polling an instance: send the first poll now, then one every `intervalMs`. */
    start(instanceId: string): void {
        this.entries.set(instanceId, { timer: null, outstandingReqId: null, missed: 0, pollCount: 0 })
        this.poll(instanceId)
        this.schedule(instanceId)
    }

    /**
     * Consume the outstanding poll's reply (§7 enforcement). Returns `true` when
     * `reqId` matches the in-flight poll (resets the missed counter); `false` when it
     * matches no outstanding poll — an unsolicited / duplicate / post-settle
     * `fleet/state`, which the caller turns into a kick.
     */
    reply(instanceId: string, reqId: string): boolean {
        const entry = this.entries.get(instanceId)
        if (entry === undefined || entry.outstandingReqId === null || entry.outstandingReqId !== reqId) {
            return false
        }
        entry.outstandingReqId = null
        entry.missed = 0
        return true
    }

    /** Stop polling an instance and cancel its timer (teardown). Idempotent. */
    forget(instanceId: string): void {
        const entry = this.entries.get(instanceId)
        if (entry !== undefined) {
            this.scheduler.clearTimeout(entry.timer)
            this.entries.delete(instanceId)
        }
    }

    private schedule(instanceId: string): void {
        const entry = this.entries.get(instanceId)
        if (entry === undefined) {
            return
        }
        entry.timer = this.scheduler.setTimeout(() => this.tick(instanceId), this.intervalMs)
    }

    private tick(instanceId: string): void {
        const entry = this.entries.get(instanceId)
        if (entry === undefined) {
            return
        }
        if (entry.outstandingReqId !== null) {
            // The previous poll went unanswered within one interval — a missed reply.
            // Keep the SAME outstanding reqId (one in-flight poll at a time, §7
            // Enforcement) and do NOT issue a new poll: a merely slow agent's eventual
            // late reply still matches the outstanding poll, resets the miss counter,
            // and recovers — instead of being kicked for a "duplicate" frame. A new poll
            // goes out only on the next tick after a reply is consumed (the branch below).
            entry.missed += 1
            if (entry.missed === 2) {
                this.callbacks.onStale(instanceId)
            }
            if (entry.missed >= 3) {
                // Evicted: the orchestrator's onEvict tears down and calls forget(); do
                // not reschedule — this entry is about to be removed.
                this.callbacks.onEvict(instanceId)
                return
            }
            this.schedule(instanceId)
            return
        }
        // The previous poll was answered — issue the next poll for this interval.
        this.poll(instanceId)
        this.schedule(instanceId)
    }

    private poll(instanceId: string): void {
        const entry = this.entries.get(instanceId)
        if (entry === undefined) {
            return
        }
        const reqId = `poll_${++this.reqSeq}`
        const forceFull = entry.pollCount % FORCE_FULL_EVERY_POLLS === 0
        entry.pollCount += 1
        entry.outstandingReqId = reqId
        this.callbacks.sendPoll(instanceId, reqId, forceFull)
    }
}
