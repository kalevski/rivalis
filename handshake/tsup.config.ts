import { defineConfig } from 'tsup'

// Zero runtime dependencies — the binary codec is native (see src/binary.ts), so
// nothing is externalized and the bundle is platform-agnostic (node + browser).
export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'es2018',
        clean: true,
        sourcemap: false,
        dts: true,
        outExtension: () => ({ js: '.js' })
    },
    {
        entry: { module: 'src/main.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'es2018',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' })
    }
])
