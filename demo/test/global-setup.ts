/**
 * Playwright globalSetup — builds workspace packages before webServers start.
 *
 * Runs once before any test file. Builds handshake → core → browser → signal
 * → node in dependency order so ts-node (P2P server) and Vite (test client)
 * can resolve the compiled lib/ outputs.
 *
 * Skip the build with RIVALIS_SKIP_BUILD=1 (useful when re-running tests
 * after a successful build in the same CI run).
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import type { FullConfig } from '@playwright/test'

export default async function globalSetup(_config: FullConfig): Promise<void> {
    if (process.env['RIVALIS_SKIP_BUILD'] === '1') {
        console.log('[global-setup] RIVALIS_SKIP_BUILD=1 — skipping workspace build')
        return
    }

    // demo/test/ → demo/ → repo/
    const repoRoot = path.resolve(__dirname, '../..')

    const build = (workspace: string): void => {
        console.log(`[global-setup] building ${workspace}…`)
        execSync(`npm run build -w ${workspace}`, {
            cwd: repoRoot,
            stdio: 'inherit',
        })
    }

    // Build in dependency order: handshake first (core/browser depend on it).
    build('@rivalis/handshake')
    build('@rivalis/core')
    build('@rivalis/browser')
    build('@rivalis/signal')
    build('@rivalis/node')

    console.log('[global-setup] all packages built')
}
