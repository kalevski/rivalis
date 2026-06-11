/**
 * Playwright configuration for the P2P browser two-tab test (p2p.md §10).
 *
 * Manages two webServer processes:
 *   1. P2P server  — @rivalis/signal + RTCTransport + TttRoom on port 9000
 *   2. Test client — Vite serving demo/src/p2p/ on port 5174
 *
 * The entire test suite is skipped when node-datachannel's native binary is
 * absent (CI without a native-build environment). Each individual test also
 * calls test.skip(!ndcAvailable, …) as a belt-and-suspenders guard.
 *
 * The globalSetup (test/global-setup.ts) builds all required workspace
 * packages before webServers start.
 */

import { defineConfig, devices } from '@playwright/test'

// ── Availability check ────────────────────────────────────────────────────────
// require() works in the CommonJS context Playwright uses to load the config.

let ndcAvailable = false
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node-datachannel')
    ndcAvailable = true
} catch {
    // native binary not present — skip webServers and let tests skip themselves
}

// ── Config ────────────────────────────────────────────────────────────────────

export default defineConfig({
    testDir: 'test',
    testMatch: '**/*.test.ts',

    globalSetup: './test/global-setup.ts',

    /* Headless Chromium by default; headed only when PWDEBUG=1. */
    use: {
        ...devices['Desktop Chrome'],
        headless: !process.env['PWDEBUG'],
        /* Relative page.goto() calls resolve against this. */
        baseURL: 'http://localhost:5174',
    },

    /* Serial workers: ensures both webServers are fully up before the second
     * browser tab tries to connect. */
    workers: 1,

    /* webServers are only started when node-datachannel is available. */
    webServer: ndcAvailable
        ? [
              {
                  /* P2P server: @rivalis/signal + RTCTransport + TttRoom */
                  command: 'ts-node --project tsconfig.json src/p2p/index.ts',
                  port: 9000,
                  timeout: 60_000,
                  reuseExistingServer: process.env['CI'] !== '1',
              },
              {
                  /* Test client: Vite dev server at localhost:5174 */
                  command: 'vite --config vite.p2p-test.config.ts',
                  port: 5174,
                  timeout: 60_000,
                  reuseExistingServer: process.env['CI'] !== '1',
              },
          ]
        : undefined,

    reporter: process.env['CI'] ? 'github' : 'list',
})
