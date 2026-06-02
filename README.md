# hayaoshi-server

Backend for **Hayaoshi (早押し)** — the multiplayer kanji speed quiz from the
[kanji](../kanji) SPA. Built on **Cloudflare Workers + Durable Objects**.

The host's device builds the quiz deck client-side (it already has the kanji
data) and **uploads it when creating the room**, so this server never needs the
kanji dataset. The Durable Object is the single source of truth: it holds the
deck (keeping the correct answers private until reveal), runs the
**server-authoritative** game loop on storage alarms, and fans out to all
clients over hibernatable WebSockets. Auth is anonymous — players are identified
by an opaque per-session token.

## Architecture

```
Host SPA  ──POST /rooms (config + questions)──▶ Worker ──init──▶ ┐
Host SPA  ──WS /rooms/:code/ws?token=HOST───────▶ Worker ───────▶ │ GameRoom (DO)
Players   ──WS /rooms/:code/ws──────────────────▶ Worker ───────▶ ┘  • state + alarms
                       ◀──────── broadcast ──────────────────────    • authoritative scoring
```

- **Worker** (`src/index.ts`) — stateless router: allocates the room code,
  routes by code to `GAME_ROOM.idFromName(code)`, forwards WebSocket upgrades,
  applies CORS.
- **`GameRoom`** (`src/room.ts`) — one instance per room. State machine:
  `lobby → (start) → count(3·2·1) → q(10s) → reveal → [board] → … → final`.
  Timers are driven by `storage.setAlarm`; scoring uses the server-recorded
  answer timestamp (`src/scoring.ts`), so client clocks can't be cheated.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/rooms` | Create a room. Body `{ config, questions, host? }`. Returns `{ code, roomId, hostToken, joinUrl, wsUrl }`. `host` is required when `config.hostPlays`. |
| `GET` | `/rooms/:code` | `{ exists, status, playerCount }` for the join screen. |
| `GET` | `/rooms/:code/ws?token=…` | WebSocket upgrade. `token=hostToken` → host controller (and host player when `hostPlays`); a player's session token → reconnect; no/unknown token → new player (must send `join`). |
| `GET` | `/health` | Liveness. |

`config` = `{ system, level, count, showBoard, hostPlays, showMn, showFurigana }`.
`count` must equal `questions.length`. Room capacity is **server-enforced** via
the `MAX_PLAYERS` env var (default 15), not host-configurable. See
`src/protocol.ts` for exact shapes.

## WebSocket protocol

**Client → server:** `join {name, avatar, color}` · `start` (host) ·
`answer {qi, idx}` · `leave` · `close` (host — tears the room down now).

**Server → client:** `welcome {you, room}` · `snapshot {room}` · `players` ·
`countdown {n}` · `question {qi, prompt, opts, deadline, serverNow}` (options are
`{m, mn, r}` — meaning, Mongolian, reading; never the correct index) ·
`answered {count}` · `reveal {correctIdx, gains, players}` ·
`leaderboard {players, nextInMs}` · `final {players}` · `closed` · `error`.

Clients render the 3-2-1 and "next in N" countdowns from `deadline` / `nextInMs`.
The host can only `start` once at least one non-host player has joined (a game
provisions backend resources on demand — no solo start).

## Develop

```bash
npm install
npm run dev        # wrangler dev (local Worker + DO)
npm run typecheck
npm test           # vitest (scoring unit + full-flow integration)
```

## Deploy

```bash
npm run deploy     # wrangler deploy
```

Set `ALLOWED_ORIGIN` to your SPA origin and `JOIN_BASE_URL` to the SPA's join
route in `wrangler.toml` (or as deployment vars).

## SPA integration

The [kanji](https://github.com/kadar77/kanji) SPA is wired to this server:
`src/lib/hayaoshi-api.ts` (REST + `VITE_HAYAOSHI_API` base), the
`useHayaoshiRoom` hook (WebSocket-driven room state, reconnect via a per-session
`token` in `localStorage`), and `src/lib/hayaoshi-protocol.ts` (matching wire
types). The host builds the deck with `buildQuestions(...)` and uploads it at
room creation.

## Notes / future work

- Anonymous only; no accounts. Rooms self-clean (lobby idle TTL 2 h, post-final
  TTL 10 min).
- No server-side bots — production is real players. (The SPA's simulated bots
  were a front-end-only prototype device.)
- Possible follow-ups: per-IP rate limiting on `POST /rooms`, host-driven manual
  "next", spectator late-join, persisted match history.

## Data & privacy

The server stores only what a live game needs — players' chosen nicknames,
avatars/colors, and in-game scores — in the room's Durable Object. It is
**transient and anonymous**: no accounts, no analytics, and rooms (with all
their data) are automatically deleted by TTL alarms (idle lobby ~2 h, finished
game ~10 min). See the app's
[Privacy Policy](https://github.com/kadar77/kanji/blob/main/PRIVACY.md).

## License

MIT © [@kadar77](https://github.com/kadar77) — see [LICENSE](LICENSE). Part of
the [Kanji](https://github.com/kadar77/kanji) project.
