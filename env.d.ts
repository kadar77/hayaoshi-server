import type { Env } from './src/env'

// Make the Worker's bindings available as the test environment's `env`.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
