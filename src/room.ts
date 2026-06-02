// GameRoom — one Durable Object instance per room code. Single source of
// truth for a game: holds players + the uploaded question deck, runs the
// authoritative loop via storage alarms, and fans out to clients over
// hibernatable WebSockets.
import type { Env } from './env'
import { genId, genToken } from './codes'
import { points, QUESTION_TIME_MS } from './scoring'
import { parseClientMessage, ValidationError } from './validate'
import type {
  ClientMessage,
  CreateRoomBody,
  Profile,
  PublicPlayer,
  Question,
  RoomConfig,
  RoomState,
  RoomStatus,
  RoundPhase,
  ServerMessage,
} from './protocol'

interface Meta {
  code: string
  roomId: string
  createdAt: number
  config: RoomConfig
  status: RoomStatus
  hostToken: string
  hostPlayerId: string | null
}

interface PlayerRec {
  id: string
  name: string
  avatar: string
  color: string
  score: number
  isHost: boolean
  token: string
  connected: boolean
  lastGain?: number
  lastCorrect?: boolean
}

interface Round {
  qi: number
  phase: RoundPhase
  countN: number
  startedAt: number
  deadline: number
  answers: Record<string, { idx: number; atMs: number }>
}

interface Attachment {
  role: 'host' | 'player'
  playerId?: string
}

// Player color palette (mirrors the SPA's HAYAOSHI_COLORS) — used to keep every
// player's color distinct even if two of them picked the same one.
const PLAYER_COLORS = [
  '#e0596b', '#3a8fd0', '#e0a93a', '#3aa674', '#6f63a8', '#c45d86',
  '#3aa39a', '#a07b22', '#5d7fb0', '#c2503a', '#4a90c2', '#5a8f3c',
]

// Loop timing.
const COUNT_TICK_MS = 800
const REVEAL_HOLD_MS = 1600
const BOARD_MS = 3000
// TTLs that bound idle storage so abandoned rooms self-clean.
const LOBBY_TTL_MS = 2 * 60 * 60 * 1000
const FINAL_TTL_MS = 10 * 60 * 1000

export class GameRoom {
  private state: DurableObjectState
  private env: Env
  private meta: Meta | null = null
  private questions: Question[] = []
  private players: Record<string, PlayerRec> = {}
  private round: Round | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.state.blockConcurrencyWhile(async () => {
      this.meta = (await state.storage.get<Meta>('meta')) ?? null
      this.questions = (await state.storage.get<Question[]>('questions')) ?? []
      this.players = (await state.storage.get<Record<string, PlayerRec>>('players')) ?? {}
      this.round = (await state.storage.get<Round>('round')) ?? null
    })
  }

  // ─── HTTP entry (internal control + WS upgrade) ─────────────────────
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/ws')) return this.handleWsUpgrade(req)
    if (url.pathname.endsWith('/summary')) return this.handleSummary()
    if (url.pathname.endsWith('/init') && req.method === 'POST') {
      return this.handleInit(req)
    }
    return new Response('not found', { status: 404 })
  }

  private async handleSummary(): Promise<Response> {
    const body = {
      exists: !!this.meta,
      status: this.meta?.status ?? 'lobby',
      playerCount: Object.keys(this.players).length,
    }
    return json(body)
  }

  private async handleInit(req: Request): Promise<Response> {
    if (this.meta) return json({ error: 'room already exists' }, 409)
    const body = (await req.json()) as CreateRoomBody & { code: string }
    const roomId = 'r_' + genId()
    const hostToken = genToken()
    this.meta = {
      code: body.code,
      roomId,
      createdAt: Date.now(),
      config: body.config,
      status: 'lobby',
      hostToken,
      hostPlayerId: null,
    }
    this.questions = body.questions
    this.players = {}
    this.round = null

    if (body.config.hostPlays && body.host) {
      const host = this.addPlayer(body.host, true, hostToken)
      this.meta.hostPlayerId = host.id
    }

    await this.saveAll()
    // Self-clean if the host never starts the game.
    await this.state.storage.setAlarm(Date.now() + LOBBY_TTL_MS)
    return json({ roomId, hostToken })
  }

  private async handleWsUpgrade(req: Request): Promise<Response> {
    if (!this.meta) return new Response('no such room', { status: 404 })
    const url = new URL(req.url)
    const token = url.searchParams.get('token') ?? ''

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    let att: Attachment = { role: 'player' }
    if (token && token === this.meta.hostToken) {
      att = { role: 'host', playerId: this.meta.hostPlayerId ?? undefined }
    } else if (token) {
      const found = Object.values(this.players).find((p) => p.token === token)
      if (found) att = { role: found.isHost ? 'host' : 'player', playerId: found.id }
    }

    this.state.acceptWebSocket(server)
    server.serializeAttachment(att)

    if (att.playerId && this.players[att.playerId]) {
      this.players[att.playerId].connected = true
      await this.savePlayers()
      this.broadcastPlayers()
    }

    this.send(server, {
      t: 'welcome',
      you: {
        id: att.playerId ?? '',
        token: att.role === 'host' ? this.meta.hostToken : att.playerId ? this.players[att.playerId]?.token ?? '' : '',
        isHost: att.role === 'host',
      },
      room: this.roomState(),
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  // ─── WebSocket hibernation handlers ─────────────────────────────────
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { role: 'player' }
    let msg: ClientMessage
    try {
      msg = parseClientMessage(raw)
    } catch (e) {
      const message = e instanceof ValidationError ? e.message : 'bad message'
      this.send(ws, { t: 'error', code: 'bad_message', message })
      return
    }
    switch (msg.t) {
      case 'join':
        await this.onJoin(ws, att, msg)
        break
      case 'start':
        await this.onStart(att)
        break
      case 'answer':
        await this.onAnswer(att, msg)
        break
      case 'leave':
        try {
          ws.close(1000, 'left')
        } catch {
          /* already closing */
        }
        break
      case 'close':
        await this.onCloseRoom(att)
        break
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null
    if (!att?.playerId) return
    // Mark disconnected only if no other live socket maps to this player.
    const stillConnected = this.state
      .getWebSockets()
      .some((s) => s !== ws && (s.deserializeAttachment() as Attachment | null)?.playerId === att.playerId)
    if (!stillConnected && this.players[att.playerId]) {
      this.players[att.playerId].connected = false
      await this.savePlayers()
      this.broadcastPlayers()
      // A disconnect can complete "everyone answered".
      await this.maybeRevealEarly()
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }

  // ─── Client actions ─────────────────────────────────────────────────
  private async onJoin(ws: WebSocket, att: Attachment, msg: Profile): Promise<void> {
    if (!this.meta) return
    if (att.playerId && this.players[att.playerId]) return // already joined / reconnected
    if (this.meta.status !== 'lobby') {
      this.send(ws, { t: 'error', code: 'started', message: 'game already started' })
      return
    }
    if (Object.keys(this.players).length >= this.maxPlayers()) {
      this.send(ws, { t: 'error', code: 'full', message: 'room is full' })
      return
    }
    const p = this.addPlayer(msg, false, genToken())
    p.connected = true
    ws.serializeAttachment({ role: 'player', playerId: p.id } satisfies Attachment)
    await this.savePlayers()
    this.send(ws, {
      t: 'welcome',
      you: { id: p.id, token: p.token, isHost: false },
      room: this.roomState(),
    })
    this.broadcastPlayers()
  }

  private async onStart(att: Attachment): Promise<void> {
    if (!this.meta || att.role !== 'host') return
    if (this.meta.status !== 'lobby') return
    const guests = Object.values(this.players).filter((p) => !p.isHost)
    if (guests.length < 1) return // can't start alone — needs ≥1 joined player
    this.meta.status = 'playing'
    await this.saveMeta()
    // Tell every client the room moved to "playing" BEFORE the countdown, so
    // host + waiting players switch off the lobby/waiting screen. (Without this
    // they only ever saw round events and stayed stuck on the lobby.)
    this.broadcast({ t: 'snapshot', room: this.roomState() })
    await this.beginCountdown(0)
  }

  private async onAnswer(att: Attachment, msg: { qi: number; idx: number }): Promise<void> {
    const r = this.round
    if (!r || r.phase !== 'q') return
    if (!att.playerId || !this.players[att.playerId]) return
    if (msg.qi !== r.qi) return
    if (r.answers[att.playerId]) return // one answer per question
    r.answers[att.playerId] = { idx: msg.idx, atMs: Date.now() - r.startedAt }
    await this.saveRound()
    this.broadcast({ t: 'answered', qi: r.qi, count: Object.keys(r.answers).length })
    await this.maybeRevealEarly()
  }

  // Host-only: tear the room down now (instead of waiting for a TTL alarm).
  // Tell everyone first so players show a "room closed" message, not a generic
  // disconnect, then wipe all state.
  private async onCloseRoom(att: Attachment): Promise<void> {
    if (att.role !== 'host') return
    this.broadcast({ t: 'closed' })
    await this.destroy()
  }

  // ─── Authoritative loop (driven by storage alarms) ──────────────────
  async alarm(): Promise<void> {
    if (!this.meta) return
    if (this.meta.status === 'lobby' || this.meta.status === 'final') {
      await this.destroy()
      return
    }
    const r = this.round
    if (!r) return
    switch (r.phase) {
      case 'count':
        await this.tickCountdown()
        break
      case 'q':
        await this.reveal()
        break
      case 'reveal':
        await this.afterReveal()
        break
      case 'board':
        await this.goNext(false)
        break
    }
  }

  private async beginCountdown(qi: number): Promise<void> {
    this.round = { qi, phase: 'count', countN: 3, startedAt: 0, deadline: 0, answers: {} }
    await this.saveRound()
    this.broadcast({ t: 'countdown', qi, total: this.questions.length, n: 3 })
    await this.state.storage.setAlarm(Date.now() + COUNT_TICK_MS)
  }

  private async tickCountdown(): Promise<void> {
    const r = this.round!
    r.countN -= 1
    if (r.countN >= 1) {
      await this.saveRound()
      this.broadcast({ t: 'countdown', qi: r.qi, total: this.questions.length, n: r.countN })
      await this.state.storage.setAlarm(Date.now() + COUNT_TICK_MS)
    } else {
      await this.beginQuestion(r.qi)
    }
  }

  private async beginQuestion(qi: number): Promise<void> {
    const now = Date.now()
    const q = this.questions[qi]
    this.round = {
      qi,
      phase: 'q',
      countN: 0,
      startedAt: now,
      deadline: now + QUESTION_TIME_MS,
      answers: {},
    }
    await this.saveRound()
    this.broadcast({
      t: 'question',
      qi,
      total: this.questions.length,
      prompt: q.prompt,
      opts: q.opts.map((o) => ({ m: o.m, mn: o.mn, r: o.r })),
      deadline: this.round.deadline,
      serverNow: now,
    })
    await this.state.storage.setAlarm(this.round.deadline)
  }

  /** Reveal early once every connected participant has answered. */
  private async maybeRevealEarly(): Promise<void> {
    const r = this.round
    if (!r || r.phase !== 'q') return
    const participants = Object.values(this.players).filter((p) => p.connected)
    if (participants.length === 0) return
    const answered = participants.filter((p) => r.answers[p.id]).length
    if (answered >= participants.length) await this.reveal()
  }

  private async reveal(): Promise<void> {
    const r = this.round!
    if (r.phase !== 'q') return
    const q = this.questions[r.qi]
    const gains: Record<string, number> = {}
    for (const p of Object.values(this.players)) {
      const ans = r.answers[p.id]
      const correct = !!ans && ans.idx === q.correctIdx
      const gain = points(correct, ans ? ans.atMs : QUESTION_TIME_MS)
      p.score += gain
      p.lastGain = gain
      p.lastCorrect = correct
      gains[p.id] = gain
    }
    r.phase = 'reveal'
    await this.saveRound()
    await this.savePlayers()
    this.broadcast({
      t: 'reveal',
      qi: r.qi,
      correctIdx: q.correctIdx,
      gains,
      players: this.publicPlayers(),
    })
    await this.state.storage.setAlarm(Date.now() + REVEAL_HOLD_MS)
  }

  private async afterReveal(): Promise<void> {
    if (this.meta!.config.showBoard) await this.beginBoard()
    else await this.goNext(true)
  }

  private async beginBoard(): Promise<void> {
    this.round!.phase = 'board'
    await this.saveRound()
    this.broadcast({ t: 'leaderboard', players: this.publicPlayers(), nextInMs: BOARD_MS })
    await this.state.storage.setAlarm(Date.now() + BOARD_MS)
  }

  /**
   * Advance to the next question or finish.
   * @param withCountdown play the 3-2-1 first (true when there was no board).
   */
  private async goNext(withCountdown: boolean): Promise<void> {
    const next = this.round!.qi + 1
    if (next >= this.questions.length) {
      await this.final()
    } else if (withCountdown) {
      await this.beginCountdown(next)
    } else {
      await this.beginQuestion(next)
    }
  }

  private async final(): Promise<void> {
    this.meta!.status = 'final'
    this.round = null
    await this.saveMeta()
    await this.state.storage.delete('round')
    this.broadcast({ t: 'final', players: this.publicPlayers() })
    await this.state.storage.setAlarm(Date.now() + FINAL_TTL_MS)
  }

  private async destroy(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, 'room closed')
      } catch {
        /* ignore */
      }
    }
    await this.state.storage.deleteAll()
    this.meta = null
    this.questions = []
    this.players = {}
    this.round = null
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  private addPlayer(profile: Profile, isHost: boolean, token: string): PlayerRec {
    const id = genId()
    // Keep every player's color distinct: prefer their pick, else the first
    // free palette color, else a generated hue (so it scales past the palette
    // size up to MAX_PLAYERS — no duplicates even with >12 players).
    const used = new Set(Object.values(this.players).map((p) => p.color))
    const color = used.has(profile.color)
      ? PLAYER_COLORS.find((c) => !used.has(c)) ?? uniqueHueColor(used)
      : profile.color
    const rec: PlayerRec = {
      id,
      name: profile.name,
      avatar: profile.avatar,
      color,
      score: 0,
      isHost,
      token,
      connected: false,
    }
    this.players[id] = rec
    return rec
  }

  private publicPlayers(): PublicPlayer[] {
    return Object.values(this.players).map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      color: p.color,
      score: p.score,
      isHost: p.isHost,
      connected: p.connected,
      lastGain: p.lastGain,
      lastCorrect: p.lastCorrect,
    }))
  }

  /** Server-enforced capacity from MAX_PLAYERS (default 15), clamped sanely. */
  private maxPlayers(): number {
    const n = parseInt(this.env.MAX_PLAYERS ?? '', 10)
    return Number.isFinite(n) && n >= 2 ? Math.min(n, 200) : 15
  }

  private roomState(): RoomState {
    const m = this.meta!
    return {
      code: m.code,
      status: m.status,
      config: m.config,
      players: this.publicPlayers(),
      total: this.questions.length,
      maxPlayers: this.maxPlayers(),
      round: this.round
        ? { qi: this.round.qi, phase: this.round.phase, deadline: this.round.deadline || undefined }
        : undefined,
    }
  }

  private broadcastPlayers(): void {
    this.broadcast({ t: 'players', players: this.publicPlayers() })
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(data)
      } catch {
        /* socket closing */
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* socket closing */
    }
  }

  private async saveMeta() {
    await this.state.storage.put('meta', this.meta)
  }
  private async savePlayers() {
    await this.state.storage.put('players', this.players)
  }
  private async saveRound() {
    await this.state.storage.put('round', this.round)
  }
  private async saveAll() {
    await this.state.storage.put('meta', this.meta)
    await this.state.storage.put('questions', this.questions)
    await this.state.storage.put('players', this.players)
    if (this.round) await this.state.storage.put('round', this.round)
    else await this.state.storage.delete('round')
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Generate a distinct color once the fixed palette is exhausted. Walks hues by
// the golden angle (137.5°) so each new color is well separated, skipping any
// that somehow already exist.
function uniqueHueColor(used: Set<string>): string {
  for (let i = 0; i < 360; i++) {
    const hue = ((used.size + i) * 137.508) % 360
    const c = `oklch(0.66 0.17 ${hue.toFixed(1)})`
    if (!used.has(c)) return c
  }
  return `oklch(0.66 0.17 ${((used.size * 137.508) % 360).toFixed(1)})`
}
