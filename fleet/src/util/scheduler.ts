/**
 * Shared default timer scheduler (task 002). One definition of the `unref`-ing
 * `setTimeout`/`setInterval` wrapper that the orchestrator and the agent each
 * carried. `unref` so a lingering timer never pins the process.
 *
 * Typed as a structural superset — timeouts *and* intervals — so the single
 * value satisfies both the orchestrator's timeouts-only `OrchestratorScheduler`
 * seam and the agent's `AgentScheduler` (which also drives heartbeat/poll
 * intervals). The injectable scheduler seams in each consumer are unchanged;
 * tests still pass their own fakes.
 */

/**
 * Timeouts-only timer seam shared by the orchestrator and every collaborator it
 * injects ({@link CommandEngine}, {@link Poller}). One definition so the
 * decomposed pieces (and their unit tests) take the same fake clock the
 * Orchestrator does (§15).
 */
export interface TimerScheduler {
    setTimeout(fn: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

/** Timeouts + intervals, all `unref`ed — superset of both consumer scheduler seams. */
export interface DefaultScheduler extends TimerScheduler {
    setInterval(fn: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
}

export const defaultScheduler: DefaultScheduler = {
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t },
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}
