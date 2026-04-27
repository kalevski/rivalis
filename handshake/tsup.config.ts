import { defineConfig } from 'tsup'

const external = ['@toolcase/serializer']

export default defineConfig([
    {
        entry: { main: 'src/main.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'es2018',
        clean: true,
        sourcemap: false,
        dts: true,
        outExtension: () => ({ js: '.js' }),
        external
    },
    {
        entry: { module: 'src/main.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'es2018',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external
    }
])
