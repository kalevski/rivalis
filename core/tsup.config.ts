import { defineConfig } from 'tsup'

// @rivalis/handshake is an internal (unpublished) package — inline it so the
// wire codec ships inside this bundle rather than as an unresolvable runtime dep.
// It has zero runtime deps (native binary codec), so nothing else is pulled in.
const external = ['@toolcase/base', '@toolcase/logging']

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
