import { defineConfig } from 'tsup'

const external = ['@rivalis/handshake', '@toolcase/base', '@toolcase/logging', '@toolcase/serializer']

export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'neutral',
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
        platform: 'neutral',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external
    }
])
