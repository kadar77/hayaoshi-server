import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Small cap so the capacity test can fill a room with a few joins.
      miniflare: { bindings: { MAX_PLAYERS: '2' } },
    }),
  ],
})
