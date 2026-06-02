// Worker — stateless edge router. Allocates room codes, routes by code to the
// right GameRoom Durable Object, upgrades WebSockets, and handles CORS.
import type { Env } from './env'
import { genCode } from './codes'
import { parseCreateRoom, ValidationError } from './validate'
import type { RoomSummary } from './protocol'

export { GameRoom } from './room'

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }))

    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts[0] === 'health') return cors(env, json({ ok: true }))

    if (parts[0] === 'rooms') {
      // POST /rooms — create a room (config + uploaded question deck).
      if (parts.length === 1 && req.method === 'POST') {
        return cors(env, await createRoom(req, env, url))
      }

      const code = (parts[1] ?? '').toUpperCase()
      if (!code) return cors(env, json({ error: 'missing code' }, 400))
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code))

      // GET /rooms/:code — summary for the join screen.
      if (parts.length === 2 && req.method === 'GET') {
        const res = await stub.fetch('https://do/summary')
        return cors(env, new Response(res.body, res))
      }

      // GET /rooms/:code/ws — WebSocket upgrade (host or player).
      if (parts[2] === 'ws') {
        if (req.headers.get('Upgrade') !== 'websocket') {
          return cors(env, json({ error: 'expected websocket upgrade' }, 426))
        }
        return stub.fetch(req) // forwarded verbatim; DO returns the 101 + socket
      }
    }

    return cors(env, json({ error: 'not found' }, 404))
  },
}

async function createRoom(req: Request, env: Env, url: URL): Promise<Response> {
  let body
  try {
    body = parseCreateRoom(await req.json())
  } catch (e) {
    const message = e instanceof ValidationError ? e.message : 'invalid body'
    return json({ error: message }, 400)
  }

  // Allocate a code, avoiding the (rare) collision with a live room.
  let code = ''
  let stub: DurableObjectStub | null = null
  for (let i = 0; i < 6; i++) {
    code = genCode()
    stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code))
    const summary = (await stub.fetch('https://do/summary').then((r) => r.json())) as RoomSummary
    if (!summary.exists) break
    stub = null
  }
  if (!stub) return json({ error: 'could not allocate room code' }, 503)

  const initRes = await stub.fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({ code, ...body }),
  })
  if (!initRes.ok) {
    return json({ error: 'room init failed' }, 502)
  }
  const { roomId, hostToken } = (await initRes.json()) as { roomId: string; hostToken: string }

  const wsProto = url.protocol === 'http:' ? 'ws:' : 'wss:'
  return json({
    code,
    roomId,
    hostToken,
    joinUrl: `${env.JOIN_BASE_URL}/${code}`,
    wsUrl: `${wsProto}//${url.host}/rooms/${code}/ws`,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function cors(env: Env, res: Response): Response {
  const h = new Headers(res.headers)
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN)
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  h.set('Access-Control-Allow-Headers', 'content-type')
  h.set('Vary', 'Origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}
