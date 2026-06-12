import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.franco.www',
  appName: 'Franco',
  webDir: 'dist',
  plugins: {
    // Capgo over-the-air live updates. autoUpdate downloads new web bundles in
    // the background and applies them on next launch. Takes effect only after
    // you install @capgo/capacitor-updater and rebuild once. See src/liveupdate.js.
    CapacitorUpdater: {
      autoUpdate: true,
      // The channel the app listens on. Upload bundles with:
      //   npx @capgo/cli bundle upload --channel production
      defaultChannel: 'production'
    }
  }
};

export default config;
