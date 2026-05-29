import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Capacitor's iOS WKWebView fails to load lazy / cross-chunk JavaScript chunks
// (they hang forever — this is what stopped the RevenueCat SDK from ever
// initializing). Inlining all dynamic imports into a single bundle means
// everything loads at app startup, with no lazy chunk fetches.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
