import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Resolve the repo root so the spawned process inherits the workspace
// node_modules — walking up two levels from test/ → core/ → repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function smokeImport(packageName: string): { ok: boolean; stderr: string } {
    const result = spawnSync(
        process.execPath,
        ['--input-type=module'],
        {
            input: `import '${packageName}'`,
            encoding: 'utf8',
            cwd: repoRoot,
        }
    )
    return { ok: result.status === 0, stderr: result.stderr ?? '' }
}

// §10 / F5: importing either package under Node strict ESM must not throw.
// A top-level broken import (e.g. `import … from "protobufjs/light"` without .js)
// causes Node to exit non-zero — that failure surfaces here.

test('Node strict-ESM smoke: @rivalis/handshake imports without error', () => {
    const { ok, stderr } = smokeImport('@rivalis/handshake')
    assert.ok(ok, `@rivalis/handshake failed under Node strict ESM:\n${stderr}`)
})

test('Node strict-ESM smoke: @rivalis/core imports without error', () => {
    const { ok, stderr } = smokeImport('@rivalis/core')
    assert.ok(ok, `@rivalis/core failed under Node strict ESM:\n${stderr}`)
})
