/**
 * Playwright two-tab P2P browser test (p2p.md §10).
 *
 * Acceptance criteria:
 *   1. Two browser tabs connect to a Node RTCTransport host via RTCClient.
 *   2. When both tabs have joined, TttRoom starts the game (status → 'playing').
 *   3. Player X (tab 1) places at board index 0.
 *   4. BOTH tabs receive the updated board showing X at index 0.
 *
 * Infrastructure (managed by playwright.config.ts webServer):
 *   - Port 9000: demo/src/p2p/index.ts   (@rivalis/signal + RTCTransport + TttRoom)
 *   - Port 5174: vite.p2p-test.config.ts  (serves demo/src/p2p/test-client.html)
 *
 * The test is automatically skipped when the node-datachannel native binary
 * is absent (e.g. CI without native-build support) or when the webServers
 * could not start.
 */

import { test, expect, type BrowserContext } from '@playwright/test'

// ── Availability guard ────────────────────────────────────────────────────────
// Use require() — Playwright transforms test files to CommonJS by default.

let ndcAvailable = false
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node-datachannel')
    ndcAvailable = true
} catch {
    // native binary absent — tests will self-skip below
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** URL-encode a ticket for use as a query parameter value. */
function toUrl(ticket: string): string {
    return `/test-client.html?ticket=${encodeURIComponent(ticket)}`
}

// Two distinct players. PlayerX gets symbol 'X' (first joiner), PlayerO gets 'O'.
const URL_X = toUrl('ttt|PlayerX|#ff0000')
const URL_O = toUrl('ttt|PlayerO|#0000ff')

// Timeouts — generous to account for WebRTC ICE negotiation on loopback.
const CONNECT_TIMEOUT = 30_000
const MOVE_TIMEOUT    = 10_000

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('P2P browser two-tab ttt', () => {

    let ctx1: BrowserContext
    let ctx2: BrowserContext

    test.beforeEach(async ({ browser }) => {
        ctx1 = await browser.newContext()
        ctx2 = await browser.newContext()
    })

    test.afterEach(async () => {
        await ctx1?.close().catch(() => undefined)
        await ctx2?.close().catch(() => undefined)
    })

    test('both boards update after a move over WebRTC', async () => {
        test.skip(!ndcAvailable, 'node-datachannel native binary not available — skipping P2P browser test')

        const page1 = await ctx1.newPage()
        const page2 = await ctx2.newPage()

        // ── Connect both tabs ─────────────────────────────────────────────────

        // Navigate both tabs simultaneously (parallel goto).
        await Promise.all([
            page1.goto(URL_X),
            page2.goto(URL_O),
        ])

        // Wait until both tabs have an open data channel and the TttRoom has
        // started the game (both players joined → status 'playing').
        // window.__gameState is null until the first ttt:state event arrives.
        const waitForPlaying =
            'window.__gameState !== null && window.__gameState.status === "playing"'

        await Promise.all([
            page1.waitForFunction(waitForPlaying, undefined, { timeout: CONNECT_TIMEOUT }),
            page2.waitForFunction(waitForPlaying, undefined, { timeout: CONNECT_TIMEOUT }),
        ])

        // Sanity-check: page1 is PlayerX (first joiner → symbol 'X').
        const state1Before = await page1.evaluate<{ youSymbol: string | null }>(
            'window.__gameState',
        )
        expect(state1Before.youSymbol).toBe('X')

        // ── Play a move ───────────────────────────────────────────────────────

        // Player X places at board index 0.
        await page1.evaluate('window.__place(0)')

        // ── Assert both boards show the move ──────────────────────────────────

        // Both boards must reflect board[0] === 'X'.
        const boardHasX =
            'window.__gameState !== null && window.__gameState.board[0] === "X"'

        await Promise.all([
            page1.waitForFunction(boardHasX, undefined, { timeout: MOVE_TIMEOUT }),
            page2.waitForFunction(boardHasX, undefined, { timeout: MOVE_TIMEOUT }),
        ])

        // Deep-check the final state on both tabs.
        const [s1, s2] = await Promise.all([
            page1.evaluate<{
                status: string
                board: (string | null)[]
                turn: string | null
                youSymbol: string | null
            }>('window.__gameState'),
            page2.evaluate<{
                status: string
                board: (string | null)[]
                turn: string | null
            }>('window.__gameState'),
        ])

        // Both tabs see the same board with X at index 0.
        expect(s1.board[0]).toBe('X')
        expect(s2.board[0]).toBe('X')

        // Game is still in progress (one move does not finish a game).
        expect(s1.status).toBe('playing')
        expect(s2.status).toBe('playing')

        // Turn has advanced to 'O'.
        expect(s1.turn).toBe('O')
        expect(s2.turn).toBe('O')
    })
})
