import { defineConfig } from 'tsup'

const external = ['ws', '@toolcase/base', '@toolcase/logging']

export default defineConfig([
    {
        entry: { main: 'src/main.js' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
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
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external
    }
])
