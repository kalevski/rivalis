import { defineConfig } from 'vite'

// Plain TS + canvas client — no framework plugin needed. The client is served
// by Vite on :5173 in dev, or built to ../../build and served by the game
// server's static handler in production.
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
