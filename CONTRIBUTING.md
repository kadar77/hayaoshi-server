# Contributing

Thanks for your interest! This is the backend for the
[Kanji](https://github.com/kadar77/kanji) app's multiplayer game.

## Getting started

```bash
npm install
npm run dev        # wrangler dev (local Worker + Durable Object)
npm run typecheck
npm test           # vitest (scoring unit + full-flow integration)
```

## Workflow

`dev` is the integration branch; `main` is production (auto-deployed).

1. Open an issue first for anything non-trivial.
2. Branch off `dev` and open your PR **against `dev`**. Keep PRs focused.
3. Make sure `npm run typecheck` and `npm test` pass before pushing.

### Releases (maintainer)

Promote `dev` → `main`: bump the version on `dev`
(`npm version <patch|minor|major> --no-git-tag-version`), open a `dev` → `main`
PR, and merge it. On merge, `main` deploys and CI tags `vX.Y.Z` + publishes a
GitHub Release with auto-generated notes.

## Conventions

- The Durable Object (`src/room.ts`) is the authoritative source of truth: game
  progression and scoring happen server-side (clients can't be trusted for
  timing). Keep correct answers private until reveal.
- The wire protocol lives in `src/protocol.ts` and is mirrored in the SPA
  (`src/lib/hayaoshi-protocol.ts`). **Changing it requires updating both sides**
  plus `src/validate.ts`.
- Validation is hand-rolled (no runtime deps) — keep it that way for a small
  Worker bundle.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
