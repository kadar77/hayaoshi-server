// Wire protocol shared by the Worker, the Durable Object, and (mirrored on)
// the SPA client. Keep these shapes in sync with the frontend's
// src/lib/hayaoshi.ts when wiring the real client.

export interface RoomConfig {
  system: string
  level: string
  count: number
  /** Show the standings between questions. */
  showBoard: boolean
  /** Host is also a player (vs. "screen mode" — display only). */
  hostPlays: boolean
  /** Render Mongolian glosses under each answer tile. */
  showMn: boolean
  /** Show the prompt kanji's reading as a furigana hint. */
  showFurigana: boolean
}

/** A profile chosen by a player (or the host, when hostPlays). */
export interface Profile {
  name: string
  avatar: string
  color: string
}

export interface QuestionOption {
  /** Kanji id of the option (server-only; used to identify the correct one). */
  id: string
  /** English meaning shown on the tile. */
  m: string
  /** Mongolian gloss ('' when none). */
  mn: string
  /** Kana reading of this option's kanji (furigana hint); '' if none. */
  r: string
}

/** Full question as uploaded by the host at room creation (server-private). */
export interface Question {
  prompt: string
  opts: QuestionOption[]
  correctIdx: number
}

/** Option shape sent to clients — never includes which one is correct. */
export interface PublicOption {
  m: string
  mn: string
  /** Reading of the option's kanji (furigana hint); '' if none. */
  r: string
}

export type RoomStatus = 'lobby' | 'playing' | 'final'
export type RoundPhase = 'count' | 'q' | 'reveal' | 'board'

export interface PublicPlayer {
  id: string
  name: string
  avatar: string
  color: string
  score: number
  isHost: boolean
  connected: boolean
  lastGain?: number
  lastCorrect?: boolean
}

export interface RoomState {
  code: string
  status: RoomStatus
  config: RoomConfig
  players: PublicPlayer[]
  /** Number of questions in the deck. */
  total: number
  /** Server-enforced room capacity (read-only; not host-configurable). */
  maxPlayers: number
  round?: { qi: number; phase: RoundPhase; deadline?: number }
}

export interface RoomSummary {
  exists: boolean
  status: RoomStatus
  playerCount: number
}

// ─── Client → Server ──────────────────────────────────────────────────
export type ClientMessage =
  | { t: 'join'; name: string; avatar: string; color: string }
  | { t: 'start' }
  | { t: 'answer'; qi: number; idx: number }
  | { t: 'leave' }
  | { t: 'close' }

// ─── Server → Client ──────────────────────────────────────────────────
export type ServerMessage =
  | {
      t: 'welcome'
      you: { id: string; token: string; isHost: boolean }
      room: RoomState
    }
  | { t: 'snapshot'; room: RoomState }
  | { t: 'players'; players: PublicPlayer[] }
  | { t: 'countdown'; qi: number; total: number; n: number }
  | {
      t: 'question'
      qi: number
      total: number
      prompt: string
      opts: PublicOption[]
      deadline: number
      serverNow: number
    }
  | { t: 'answered'; qi: number; count: number }
  | {
      t: 'reveal'
      qi: number
      correctIdx: number
      gains: Record<string, number>
      players: PublicPlayer[]
    }
  | { t: 'leaderboard'; players: PublicPlayer[]; nextInMs: number }
  | { t: 'final'; players: PublicPlayer[] }
  | { t: 'closed' }
  | { t: 'error'; code: string; message: string }

/** Body of POST /rooms — config plus the client-built question deck. */
export interface CreateRoomBody {
  config: RoomConfig
  questions: Question[]
  /** Required when config.hostPlays is true. */
  host?: Profile
}
