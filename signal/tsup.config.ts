import { defineConfig } from 'tsup'

// @rivalis/handshake is internal (unpublished) — inline it; it has zero runtime
// deps (native binary codec), so nothing else is pulled in.
const external = [
    '@rivalis/core',
    '@rivalis/node',
    '@toolcase/base',
    '@toolcase/logging',
    'ws',
]

export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: true,
        sourcemap: false,
        dts: { resolve: ['@rivalis/handshake'] },
        outExtension: () => ({ js: '.js' }),
        external,
    },
    {
        entry: { module: 'src/main.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external,
    },
])
