import { defineConfig } from 'vite'

export default defineConfig({
    root: 'src/client',
    build: {
        outDir: '../../build',
        emptyOutDir: true
    },
    server: {
        port: 5173
    }
})
