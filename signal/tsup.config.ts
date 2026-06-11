import { defineConfig } from 'tsup'

const external = [
    '@rivalis/core',
    '@rivalis/core/transports/ws',
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
        dts: true,
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
