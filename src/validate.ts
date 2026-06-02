// Hand-rolled validation (no runtime deps). Each parser returns the typed
// value or throws ValidationError, which the Worker/DO turn into 400s / error
// frames.
import type {
  ClientMessage,
  CreateRoomBody,
  Profile,
  Question,
  RoomConfig,
} from './protocol'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export const LIMITS = {
  MAX_PLAYERS: 60,
  MIN_QUESTIONS: 1,
  MAX_QUESTIONS: 50,
  MIN_OPTS: 2,
  MAX_OPTS: 6,
  NAME_MAX: 14,
  STR_MAX: 120,
} as const

function fail(msg: string): never {
  throw new ValidationError(msg)
}

function str(v: unknown, field: string, max: number = LIMITS.STR_MAX): string {
  if (typeof v !== 'string') fail(`${field} must be a string`)
  if ((v as string).length > max) fail(`${field} too long`)
  return v as string
}

function nonEmpty(v: unknown, field: string, max: number = LIMITS.STR_MAX): string {
  const s = str(v, field, max).trim()
  if (!s) fail(`${field} is required`)
  return s
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') fail(`${field} must be a boolean`)
  return v
}

function int(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${field} must be an integer`)
  return v
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${field} must be an object`)
  return v as Record<string, unknown>
}

function parseConfig(raw: unknown): RoomConfig {
  const o = obj(raw, 'config')
  return {
    system: nonEmpty(o.system, 'config.system', 24),
    level: nonEmpty(o.level, 'config.level', 24),
    count: int(o.count, 'config.count'),
    showBoard: bool(o.showBoard, 'config.showBoard'),
    hostPlays: bool(o.hostPlays, 'config.hostPlays'),
    showMn: bool(o.showMn, 'config.showMn'),
    showFurigana: bool(o.showFurigana, 'config.showFurigana'),
  }
}

export function parseProfile(raw: unknown, field = 'profile'): Profile {
  const o = obj(raw, field)
  return {
    name: nonEmpty(o.name, `${field}.name`, LIMITS.NAME_MAX),
    avatar: nonEmpty(o.avatar, `${field}.avatar`, 32),
    color: nonEmpty(o.color, `${field}.color`, 32),
  }
}

function parseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) fail('questions must be an array')
  if (raw.length < LIMITS.MIN_QUESTIONS) fail('questions is empty')
  if (raw.length > LIMITS.MAX_QUESTIONS) fail('too many questions')
  return raw.map((q, i) => {
    const o = obj(q, `questions[${i}]`)
    const prompt = nonEmpty(o.prompt, `questions[${i}].prompt`, 16)
    if (!Array.isArray(o.opts)) fail(`questions[${i}].opts must be an array`)
    if (o.opts.length < LIMITS.MIN_OPTS || o.opts.length > LIMITS.MAX_OPTS) {
      fail(`questions[${i}].opts must have ${LIMITS.MIN_OPTS}-${LIMITS.MAX_OPTS} items`)
    }
    const opts = o.opts.map((opt, j) => {
      const oo = obj(opt, `questions[${i}].opts[${j}]`)
      return {
        id: nonEmpty(oo.id, `questions[${i}].opts[${j}].id`, 64),
        m: str(oo.m, `questions[${i}].opts[${j}].m`),
        mn: typeof oo.mn === 'string' ? str(oo.mn, `questions[${i}].opts[${j}].mn`) : '',
        r: typeof oo.r === 'string' ? str(oo.r, `questions[${i}].opts[${j}].r`, 32) : '',
      }
    })
    const correctIdx = int(o.correctIdx, `questions[${i}].correctIdx`)
    if (correctIdx < 0 || correctIdx >= opts.length) {
      fail(`questions[${i}].correctIdx out of range`)
    }
    return { prompt, opts, correctIdx }
  })
}

export function parseCreateRoom(raw: unknown): CreateRoomBody {
  const o = obj(raw, 'body')
  const config = parseConfig(o.config)
  const questions = parseQuestions(o.questions)
  if (config.count !== questions.length) {
    fail('config.count must equal questions.length')
  }
  const body: CreateRoomBody = { config, questions }
  if (config.hostPlays) {
    if (o.host === undefined) fail('host profile required when hostPlays is true')
    body.host = parseProfile(o.host, 'host')
  }
  return body
}

export function parseClientMessage(raw: string): ClientMessage {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    fail('message is not valid JSON')
  }
  const o = obj(data, 'message')
  switch (o.t) {
    case 'join':
      return { t: 'join', ...parseProfile(o, 'join') }
    case 'start':
      return { t: 'start' }
    case 'answer':
      return { t: 'answer', qi: int(o.qi, 'qi'), idx: int(o.idx, 'idx') }
    case 'leave':
      return { t: 'leave' }
    case 'close':
      return { t: 'close' }
    default:
      return fail(`unknown message type: ${String(o.t)}`)
  }
}
