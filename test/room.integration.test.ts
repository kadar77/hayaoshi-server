import { describe, it, expect } from 'vitest'
import { SELF, env, runDurableObjectAlarm } from 'cloudflare:test'
import type { ServerMessage } from '../src/protocol'

const ORIGIN = 'https://example.com'

type Msg = ServerMessage & Record<string, unknown>

async function openWs(path: string) {
  const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { Upgrade: 'websocket' } })
  const ws = res.webSocket
  if (!ws) throw new Error(`no websocket (status ${res.status})`)
  ws.accept()
  const msgs: Msg[] = []
  ws.addEventListener('message', (e: MessageEvent) => {
    msgs.push(JSON.parse(e.data as string))
  })
  return { ws, msgs }
}

async function waitFor<T>(fn: () => T | undefined, label = 'condition'): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const config = {
  system: 'jlpt',
  level: 'N5',
  count: 1,
  showBoard: false,
  hostPlays: false,
  showMn: false,
  showFurigana: false,
}
const questions = [
  {
    prompt: '日',
    opts: [
      { id: 'k1', m: 'moon', mn: '', r: 'つき' },
      { id: 'k2', m: 'tree', mn: '', r: 'き' },
      { id: 'k3', m: 'sun', mn: '', r: 'ひ' },
      { id: 'k4', m: 'water', mn: '', r: 'みず' },
    ],
    correctIdx: 2,
  },
]

describe('Hayaoshi room flow', () => {
  it('rejects a malformed create', async () => {
    const res = await SELF.fetch(`${ORIGIN}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ config, questions: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('runs create → join → start → answer → reveal → final', async () => {
    // 1. Host creates the room (uploads the question deck).
    const create = await SELF.fetch(`${ORIGIN}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ config, questions }),
    })
    expect(create.status).toBe(200)
    const { code, hostToken } = (await create.json()) as { code: string; hostToken: string }
    expect(code).toHaveLength(5)

    // 2. Host + one player connect.
    const host = await openWs(`/rooms/${code}/ws?token=${hostToken}`)
    const player = await openWs(`/rooms/${code}/ws`)
    player.ws.send(JSON.stringify({ t: 'join', name: 'Tomo', avatar: 'star', color: '#3aa674' }))
    const welcome = await waitFor(
      () => player.msgs.find((m) => m.t === 'welcome' && m.you && (m.you as { id: string }).id),
      'player welcome',
    )
    const pid = (welcome.you as { id: string }).id

    // 3. Host starts; drive the 3-2-1 countdown via alarms.
    host.ws.send(JSON.stringify({ t: 'start' }))
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code))
    // Clients must learn the room moved to "playing" so they leave the lobby.
    const snap = await waitFor(
      () => player.msgs.find((m) => m.t === 'snapshot' && m.room.status === 'playing'),
      'playing snapshot',
    )
    expect(snap).toBeDefined()
    await waitFor(() => player.msgs.find((m) => m.t === 'countdown' && m.n === 3), 'countdown 3')
    await runDurableObjectAlarm(stub) // → 2
    await runDurableObjectAlarm(stub) // → 1
    await runDurableObjectAlarm(stub) // → question

    // 4. Question is broadcast without the correct answer.
    const q = await waitFor(() => player.msgs.find((m) => m.t === 'question'), 'question')
    expect(q.prompt).toBe('日')
    expect(q).not.toHaveProperty('correctIdx')
    expect((q.opts as unknown[]).length).toBe(4)

    // 5. Player answers correctly → reveal fires early (everyone answered).
    player.ws.send(JSON.stringify({ t: 'answer', qi: 0, idx: 2 }))
    const reveal = await waitFor(() => player.msgs.find((m) => m.t === 'reveal'), 'reveal')
    expect(reveal.correctIdx).toBe(2)
    expect((reveal.gains as Record<string, number>)[pid]).toBeGreaterThan(0)

    // 6. After the reveal hold, the single-question game ends.
    await runDurableObjectAlarm(stub)
    const final = await waitFor(() => player.msgs.find((m) => m.t === 'final'), 'final')
    const me = (final.players as Array<{ id: string; score: number }>).find((p) => p.id === pid)
    expect(me?.score).toBeGreaterThan(0)
  })

  // The test runtime sets MAX_PLAYERS=2 (see vitest.config.ts).
  it('rejects joins once the room hits the server cap', async () => {
    const create = await SELF.fetch(`${ORIGIN}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ config, questions }),
    })
    const { code } = (await create.json()) as { code: string }

    const join = async (name: string) => {
      const c = await openWs(`/rooms/${code}/ws`)
      c.ws.send(JSON.stringify({ t: 'join', name, avatar: 'star', color: '#3aa674' }))
      return c
    }
    const a = await join('A')
    await waitFor(() => a.msgs.find((m) => m.t === 'welcome' && (m.you as { id: string }).id), 'A joined')
    const b = await join('B')
    await waitFor(() => b.msgs.find((m) => m.t === 'welcome' && (m.you as { id: string }).id), 'B joined')
    const c = await join('C')
    const full = await waitFor(
      () => c.msgs.find((m) => m.t === 'error' && (m as { code: string }).code === 'full'),
      'room full error',
    )
    expect(full).toBeDefined()
  })

  it('lets the host close the room, notifying players and deleting state', async () => {
    const create = await SELF.fetch(`${ORIGIN}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ config, questions }),
    })
    const { code, hostToken } = (await create.json()) as { code: string; hostToken: string }

    const host = await openWs(`/rooms/${code}/ws?token=${hostToken}`)
    const player = await openWs(`/rooms/${code}/ws`)
    player.ws.send(JSON.stringify({ t: 'join', name: 'Tomo', avatar: 'star', color: '#3aa674' }))
    await waitFor(() => player.msgs.find((m) => m.t === 'welcome' && (m.you as { id: string }).id), 'joined')

    host.ws.send(JSON.stringify({ t: 'close' }))
    const closed = await waitFor(() => player.msgs.find((m) => m.t === 'closed'), 'closed')
    expect(closed).toBeDefined()

    // State is gone: the room now reports as not existing.
    await new Promise((r) => setTimeout(r, 50))
    const summary = (await (await SELF.fetch(`${ORIGIN}/rooms/${code}`)).json()) as { exists: boolean }
    expect(summary.exists).toBe(false)
  })

  it('reports an unknown room as not existing', async () => {
    const res = await SELF.fetch(`${ORIGIN}/rooms/ZZZZZ`)
    expect(res.status).toBe(200)
    const summary = (await res.json()) as { exists: boolean }
    expect(summary.exists).toBe(false)
  })
})
