import { defineConfig } from 'tsup'

const external = ['@toolcase/base', '@toolcase/logging']

export default defineConfig([
    {
        entry: { main: 'src/main.js' },
        format: 'cjs',
        outDir: 'lib',
        target: 'es2018',
        platform: 'browser',
        clean: true,
        sourcemap: false,
        dts: true,
        outExtension: () => ({ js: '.js' }),
        external
    },
    {
        entry: { module: 'src/main.js' },
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
