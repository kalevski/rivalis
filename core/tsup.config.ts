import { defineConfig } from 'tsup'

const external = ['ws', '@toolcase/base', '@toolcase/logging', '@toolcase/serializer']

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
        external
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
        external
    },
    {
        entry: { ws: 'src/transports/ws.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: true,
        outExtension: () => ({ js: '.js' }),
        external
    },
    {
        entry: { ws: 'src/transports/ws.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.module.js' }),
        external
    },
    {
        entry: { wsclient: 'src/clients/ws.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: true,
        outExtension: () => ({ js: '.js' }),
        external
    },
    {
        entry: { wsclient: 'src/clients/ws.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.module.js' }),
        external
    }
])
