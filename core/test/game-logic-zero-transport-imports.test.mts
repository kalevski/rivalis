/**
 * CI guard: game-logic files (Room/Actor subclasses) must never import
 * transport-specific packages (p2p.md §5, §11, task 093).
 *
 * The central guarantee of the framework redesign: the same Room/Actor code
 * runs unchanged over WebSocket, WebRTC, or any future transport. Any import
 * of a transport-specific package in a game-logic file is a design regression
 * and must fail CI immediately.
 *
 * Positive-case evidence that already exists:
 *   - demo/src/p2p/index.ts imports TttRoom directly from demo/src/server/TttRoom.ts
 *     and mounts it behind an RTCTransport — the file is byte-for-byte the same as
 *     the one used by the WSTransport server (demo/src/server/index.ts).
 *   - node/test/rtc-loopback.test.mts carries an inline copy of TttRoom logic and
 *     verifies it works end-to-end over a real WebRTC data channel.
 *   - node/test/ws-rtc-multi-transport.test.mts proves both transports feed the
 *     same room simultaneously with no Room changes.
 *
 * This test is the continuous-assertion layer: it reads the source of every
 * game-logic file in demo/src/server/ (all files except index.ts, the server
 * bootstrap which IS expected to reference transport code) and verifies none of
 * them import a transport-specific package. Adding a new Room file to that
 * directory automatically brings it under this guard.
 *
 * Forbidden packages — transport-specific, must never appear in game logic:
 *   ws                           WebSocket runtime
 *   node-datachannel             WebRTC native runtime
 *   @rivalis/node                Node P2P transport package
 *   @rivalis/browser             Browser P2P transport package
 *   @rivalis/signal              Signaling server package
 *   @rivalis/core/transports/ws  WS transport subpath (node-only)
 *   @rivalis/core/clients/ws     Node WS client subpath (node-only)
 *
 * Allowed packages — transport-agnostic, fine in game logic:
 *   @rivalis/core                Isomorphic kernel (Room, Actor, AuthMiddleware, …)
 *   @rivalis/handshake           Wire/frame codec (isomorphic)
 *   Relative imports             Protocol types, ActorData — all transport-agnostic
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// core/test/ → repo root → demo/src/server/
const GAME_LOGIC_DIR = path.resolve(__dirname, '../../demo/src/server')

// index.ts is the server bootstrap — it is expected to reference transport
// code by design. Everything else in the directory is game logic.
const EXCLUDED_FILES = new Set(['index.ts'])

// Transport-specific packages: each entry is the full package name (or subpath).
// A violation is detected when a file imports exactly this string, or a
// sub-path of it (e.g. '@rivalis/node/internal' also triggers @rivalis/node).
const FORBIDDEN_PACKAGES: readonly string[] = [
    'ws',
    'node-datachannel',
    '@rivalis/node',
    '@rivalis/browser',
    '@rivalis/signal',
    '@rivalis/core/transports/ws',
    '@rivalis/core/clients/ws',
]

/**
 * Extract all package-name import specifiers from a TypeScript source string.
 * Skips relative imports (starting with '.' or '/') — those are intra-project
 * and already covered by the package boundary.
 */
function extractPackageImports(source: string): string[] {
    const pkgs = new Set<string>()
    // Match: `from 'some-pkg'` or `from "some-pkg"` (handles import/import type)
    const importFromRe = /\bfrom\s+['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = importFromRe.exec(source)) !== null) {
        const spec = match[1]!
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
            pkgs.add(spec)
        }
    }
    // Also catch bare side-effect imports: `import 'some-pkg'`
    const bareImportRe = /\bimport\s+['"]([^'"]+)['"]/g
    while ((match = bareImportRe.exec(source)) !== null) {
        const spec = match[1]!
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
            pkgs.add(spec)
        }
    }
    return [...pkgs]
}

function isForbidden(pkg: string): boolean {
    return FORBIDDEN_PACKAGES.some(
        (forbidden) => pkg === forbidden || pkg.startsWith(forbidden + '/')
    )
}

// ── Load game-logic files ─────────────────────────────────────────────────────

const gameLogicFiles: Array<{ name: string; source: string }> = fs
    .readdirSync(GAME_LOGIC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !EXCLUDED_FILES.has(f))
    .map((f) => ({
        name: f,
        source: fs.readFileSync(path.join(GAME_LOGIC_DIR, f), 'utf8'),
    }))

// ── Test: the directory contains the expected Room files ──────────────────────

test('game-logic directory exists and contains expected Room subclasses', () => {
    assert.ok(
        gameLogicFiles.length > 0,
        `Expected game-logic source files in ${GAME_LOGIC_DIR}`
    )
    const names = new Set(gameLogicFiles.map((f) => f.name))
    const required = ['TttRoom.ts', 'LobbyRoom.ts', 'CounterRoom.ts', 'ArenaRoom.ts']
    for (const r of required) {
        assert.ok(names.has(r), `${r} must be present in demo/src/server/`)
    }
})

// ── Per-file tests: assert zero transport-specific imports ────────────────────

for (const file of gameLogicFiles) {
    test(`${file.name}: no transport-specific imports (p2p.md §5, §11)`, () => {
        const pkgImports = extractPackageImports(file.source)
        const violations = pkgImports.filter(isForbidden)

        assert.deepEqual(
            violations,
            [],
            [
                `DESIGN REGRESSION: ${file.name} imports transport-specific package(s): ${violations.join(', ')}`,
                '',
                'Game logic (Room/Actor subclasses) must be transport-agnostic so the same',
                'code runs unchanged over WS, WebRTC, or any future transport (p2p.md §5, §11).',
                'Any change to a Room/Actor file required by transport work is a design regression.',
                '',
                `All imports in ${file.name}:`,
                ...pkgImports.map((p) => `  ${isForbidden(p) ? '✗' : '✓'} ${p}`),
            ].join('\n')
        )
    })
}

// ── Summary test: all checked files together ──────────────────────────────────

test('all game-logic files are import-clean (zero transport deps)', () => {
    const allViolations: string[] = []

    for (const file of gameLogicFiles) {
        const pkgImports = extractPackageImports(file.source)
        for (const pkg of pkgImports) {
            if (isForbidden(pkg)) {
                allViolations.push(`${file.name} → ${pkg}`)
            }
        }
    }

    assert.deepEqual(
        allViolations,
        [],
        [
            `DESIGN REGRESSION: transport-specific imports found in game-logic files:`,
            ...allViolations.map((v) => `  ${v}`),
        ].join('\n')
    )
})
