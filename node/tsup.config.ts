import { defineConfig } from 'tsup'

// node-datachannel is a production dep — externalize so consumers' installs
// supply the correct native binary for their platform.
// @rivalis/core (>=8) and ws are peer deps; externalize to share one instance.
// @rivalis/handshake is internal (unpublished) — inline it; it has zero runtime
// deps (native binary codec), so nothing else is pulled in.
const external = [
    'node-datachannel',
    '@rivalis/core',
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
        dts: { entry: { main: 'src/main.ts' }, resolve: ['@rivalis/handshake'] },
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
