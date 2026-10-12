import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts', desktop: 'src/desktop/main.ts', 'desktop-host': 'src/desktop/host-main.ts', 'desktop-topics': 'src/desktop/topics-main.ts', 'desktop-deploy': 'src/desktop/deployment-main.ts', 'desktop-supervisor': 'src/desktop/supervisor.ts', 'desktop-supervisor-windows': 'src/desktop/supervisor-windows.ts', 'desktop-ordinary-idle': 'src/desktop/ordinary-idle.ts', 'desktop-shared-idle': 'src/desktop/shared-idle.ts', 'desktop-shared-inspector': 'src/desktop/shared-inspector.ts', 'desktop-broker-lease': 'src/desktop/broker-lease.ts', 'desktop-standalone': 'src/desktop/standalone.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
]);
