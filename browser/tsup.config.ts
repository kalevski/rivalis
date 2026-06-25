import { defineConfig } from 'tsup'

const external = ['@rivalis/core', '@toolcase/base', '@toolcase/logging']

export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'es2018',
        platform: 'browser',
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
        target: 'es2018',
        platform: 'browser',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external
    }
])
