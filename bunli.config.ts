import { defineConfig } from '@bunli/core'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  name: 'mirb',
  version: pkg.version,
  description: pkg.description,
  plugins: [],
  build: {
    entry: './mirb.ts',
    outdir: './dist',
    targets: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'],
    // MUST stay false: bunli-releaser expects per-target output dirs after `bunli build`.
    compress: false,
    minify: true,
    sourcemap: false
  }
})
