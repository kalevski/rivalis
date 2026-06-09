import { defineConfig } from 'tsup'

// node-datachannel and werift are production/optional deps — externalize so
// consumers' installs supply the correct native binary for their platform.
// @rivalis/core (>=7) and ws are peer deps; externalize to share one instance.
const external = [
    'node-datachannel',
    'werift',
    '@rivalis/core',
    '@rivalis/core/transports/ws',
    '@rivalis/core/clients/ws',
    '@rivalis/handshake',
    '@toolcase/base',
    '@toolcase/logging',
    '@toolcase/serializer',
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
        dts: { entry: { main: 'src/main.ts' } },
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
