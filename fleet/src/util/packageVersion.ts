/**
 * Single source of the installed `@rivalis/fleet` version (task 009). Resolves
 * `package.json` at runtime so the version is read from one place — the package
 * manifest — instead of being hand-maintained as a literal that silently drifts
 * on the first release bump (§6 rolling-upgrade visibility).
 *
 * Shared by the CLI (`--version`, `readVersion`) and the agent (`Snapshot`'s
 * `agentVersion`, reported in every `fleet/state`), so both report the same value.
 *
 * Resolution mirrors `loadCore`'s `import.meta.url` / `createRequire` dance and
 * works in both fleet builds: the ESM bundle derives a `require` from
 * `import.meta.url`; the CJS bundle uses the native `require` (esbuild empties
 * `import.meta` there). `../package.json` resolves from `lib/` → the package
 * manifest. Falls back to `0.0.0` if the manifest is unreadable.
 */

import { createRequire } from 'node:module'

export function packageVersion(): string {
    try {
        const metaUrl = import.meta.url
        const req = metaUrl ? createRequire(metaUrl) : require
        const pkg = req('../package.json') as { version?: string }
        return pkg.version ?? '0.0.0'
    } catch {
        return '0.0.0'
    }
}
