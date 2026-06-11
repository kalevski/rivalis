/**
 * Vite config for the Playwright P2P test client fixture.
 *
 * Serves demo/src/p2p/ as the document root on port 5174, so Playwright
 * can navigate to http://localhost:5174/test-client.html.
 *
 * Package resolution relies on the workspace packages being built first
 * (npm run build --workspaces --if-present from the repo root).
 */
import { defineConfig } from 'vite'

export default defineConfig({
    root: 'src/p2p',
    server: {
        port: 5174,
        strictPort: true,
    },
    build: {
        outDir: '../../dist-p2p-test',
        emptyOutDir: true,
    },
})
