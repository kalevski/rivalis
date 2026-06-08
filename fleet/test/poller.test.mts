import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Poller } from '../lib/Poller.js'

// ---------------------------------------------------------------------------
// Direct unit tests for the poll scheduler (task 011) — it replaces the pre-011
// LivenessTracker. The orchestrator drives the conversation: a poll on join +
// every interval, and liveness measured by MISSED poll replies (2 → stale,
// 3 → evict), reproducing the old 2×/3× heartbeat timing. Driven by a
// virtual-time, timeouts-only scheduler — no Orchestrator (§15).
// ---------------------------------------------------------------------------

function makeClock() {
    let now = 0
    let id = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    return {
        scheduler: {
            setTimeout: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn }); return t },
            clearTimeout: (h: unknown) => { timers.delete(h as number) }
        },
        advance: (ms: number) => {
            const target = now + ms
            for (;;) {
                let next: { id: number; at: number; fn: () => void } | null = null
                for (const [tid, t] of timers) {
                    if (t.at <= target && (next === null || t.at < next.at)) { next = { id: tid, at: t.at, fn: t.fn } }
                }
                if (next === null) { break }
                now = next.at
                timers.delete(next.id)
                next.fn()
            }
            now = target
        },
        pending: () => timers.size
    }
}

function makePoller(intervalMs = 5000) {
    const clock = makeClock()
    const polls: Array<{ id: string; reqId: string; forceFull: boolean }> = []
    const stales: string[] = []
    const evicts: string[] = []
    const poller = new Poller(clock.scheduler as any, intervalMs, {
        sendPoll: (id, reqId, forceFull) => polls.push({ id, reqId, forceFull }),
        onStale: (id) => stales.push(id),
        onEvict: (id) => evicts.push(id)
    })
    const lastReqId = () => polls[polls.length - 1].reqId
    return { clock, poller, polls, stales, evicts, lastReqId }
}

test('start sends the first poll immediately, then one per interval', () => {
    const { clock, poller, polls, lastReqId } = makePoller(5000)
    poller.start('i1')
    assert.equal(polls.length, 1, 'the first poll is sent immediately on start (follows fleet/hello)')
    assert.equal(polls[0].forceFull, true, 'the first poll forces a full reply (no prior state)')
    assert.equal(poller.has('i1'), true)

    // Reply, then one more poll per interval.
    poller.reply('i1', lastReqId())
    clock.advance(5000)
    assert.equal(polls.length, 2, 'a poll per interval')
    poller.reply('i1', lastReqId())
    clock.advance(5000)
    assert.equal(polls.length, 3)
})

test('2 missed poll replies → stale, 3 → evict (reproduces 2×/3× heartbeat timing)', () => {
    const { clock, poller, stales, evicts } = makePoller(5000)
    poller.start('i1') // poll#1 at t=0, never answered

    clock.advance(4999)
    assert.deepEqual(stales, [], 'no stale before the first tick')

    clock.advance(1) // t=5000: tick — poll#1 unanswered → missed=1
    assert.deepEqual(stales, [])

    clock.advance(5000) // t=10000: missed=2 → stale
    assert.deepEqual(stales, ['i1'], 'stale at 2 missed replies (2×heartbeat)')
    assert.deepEqual(evicts, [])

    clock.advance(5000) // t=15000: missed=3 → evict
    assert.deepEqual(evicts, ['i1'], 'evict at 3 missed replies (3×heartbeat)')
})

test('a continuously-replied instance never goes stale', () => {
    const { clock, poller, stales, lastReqId } = makePoller(5000)
    poller.start('i1')
    poller.reply('i1', lastReqId())
    for (let i = 0; i < 10; i++) {
        clock.advance(5000)
        poller.reply('i1', lastReqId()) // answer each poll before the next tick
    }
    assert.deepEqual(stales, [], 'an agent that answers every poll is never marked stale')
})

test('reply matches only the outstanding reqId; a duplicate / unknown reply does not (→ caller kicks)', () => {
    const { poller, polls } = makePoller()
    poller.start('i1')
    const reqId = polls[0].reqId
    assert.equal(poller.reply('i1', 'nope'), false, 'a non-matching reqId is unsolicited')
    assert.equal(poller.reply('i1', reqId), true, 'the outstanding poll reqId matches and is consumed')
    assert.equal(poller.reply('i1', reqId), false, 'a duplicate reply no longer matches (consumed)')
    assert.equal(poller.reply('ghost', reqId), false, 'an unknown instance never matches')
})

test('forget cancels the poll timer and stops polling; idempotent', () => {
    const { clock, poller, polls } = makePoller(5000)
    poller.start('i1')
    poller.forget('i1')
    assert.equal(poller.has('i1'), false)
    assert.equal(clock.pending(), 0, 'the poll timer is cleared on forget')
    clock.advance(100000)
    assert.equal(polls.length, 1, 'no further polls after forget')
    assert.doesNotThrow(() => poller.forget('i1'))
    assert.doesNotThrow(() => poller.forget('never-started'))
})

// ---------------------------------------------------------------------------
// task 002 — one outstanding poll at a time: a missed tick must NOT reissue the
// poll, so a slow agent's late reply still matches and resets liveness instead
// of being kicked for a manufactured "duplicate" frame.
// ---------------------------------------------------------------------------

test('a missed tick does not reissue the poll; a late reply to the outstanding poll still matches (task 002)', () => {
    const { clock, poller, polls, stales, evicts, lastReqId } = makePoller(5000)
    poller.start('i1')
    poller.reply('i1', lastReqId())     // poll#1 answered
    clock.advance(5000)                 // t=5000: poll#2 issued (prev answered)
    const pollTwo = lastReqId()
    assert.equal(polls.length, 2)

    // The agent is briefly busy: poll#2 goes unanswered for one interval.
    clock.advance(5000)                 // t=10000: tick — poll#2 unanswered → missed=1
    assert.equal(polls.length, 2, 'no new poll is issued while one is outstanding (one in-flight at a time)')
    assert.deepEqual(stales, [], 'one miss is not yet stale')

    // The late reply to poll#2 still matches → consumed, liveness resets, no kick.
    assert.equal(poller.reply('i1', pollTwo), true, 'the late reply matches the still-outstanding poll')

    // Polling resumes on the next tick after the consumed reply.
    clock.advance(5000)                 // t=15000: poll#3 issued
    assert.equal(polls.length, 3, 'polling resumes after the reply is consumed')
    assert.deepEqual(stales, [])
    assert.deepEqual(evicts, [])
})

test('a slow agent (reply delayed ~2.x intervals, < evict) goes stale then recovers — never evicted (task 002)', () => {
    const { clock, poller, polls, stales, evicts, lastReqId } = makePoller(5000)
    poller.start('i1')
    const pollOne = lastReqId()         // poll#1 — the agent will answer very late

    clock.advance(5000)                 // missed=1 (no reissue)
    clock.advance(5000)                 // missed=2 → stale
    assert.deepEqual(stales, ['i1'], 'stale at 2 missed replies')
    assert.deepEqual(evicts, [], 'not evicted yet')
    assert.equal(polls.length, 1, 'still the single outstanding poll — never reissued')

    // The long-delayed reply to poll#1 (≈2.x intervals, before the 3-miss evict) matches.
    assert.equal(poller.reply('i1', pollOne), true, 'the long-delayed reply still matches the outstanding poll')

    // Recovered: next tick polls again; eviction never happens.
    clock.advance(5000)
    assert.equal(polls.length, 2, 'polling resumes after recovery')
    clock.advance(5000)
    assert.deepEqual(evicts, [], 'a recovered agent is never evicted')
})

test('the periodic forced-full fires on the first poll and every 12th (§7 desync backstop)', () => {
    const { clock, poller, polls, lastReqId } = makePoller(5000)
    poller.start('i1')
    const flags = [polls[0].forceFull]
    for (let i = 0; i < 12; i++) {
        poller.reply('i1', lastReqId())
        clock.advance(5000)
        flags.push(polls[polls.length - 1].forceFull)
    }
    assert.equal(flags[0], true, 'first poll forces full')
    assert.equal(flags[1], false, 'subsequent polls dedup by knownHash')
    assert.equal(flags[12], true, 'every 12th poll forces a full reply')
})
