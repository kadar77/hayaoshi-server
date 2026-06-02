import type { Env as WorkerEnv } from './src/env'

// vitest-pool-workers v4 types the `cloudflare:test` `env` export as the
// global `Cloudflare.Env`, so expose the Worker's bindings there.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
