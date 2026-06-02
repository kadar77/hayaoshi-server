export interface Env {
  /** Durable Object namespace — one GameRoom instance per room code. */
  GAME_ROOM: DurableObjectNamespace
  /** CORS allow-origin for the SPA ("*" in dev; lock to your origin in prod). */
  ALLOWED_ORIGIN: string
  /** Base URL for the player join link / QR (the SPA's join route). */
  JOIN_BASE_URL: string
  /** Server-enforced room capacity (string from [vars]; default 15). */
  MAX_PLAYERS?: string
}
