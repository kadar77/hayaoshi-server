import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        // Small cap so the capacity test can fill a room with a few joins.
        miniflare: { bindings: { MAX_PLAYERS: '2' } },
      },
    },
  },
})
