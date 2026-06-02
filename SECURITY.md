# Security Policy

## Supported versions

Only the latest code on `main` (the deployed Worker) is supported.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability**, or contact the maintainer via
[github.com/kadar77](https://github.com/kadar77). Include reproduction steps and
the impact you observed.

## Scope notes

This is a Cloudflare Worker + Durable Object backend that accepts **live game
input over WebSockets**. Reports about input validation, room/resource
exhaustion (e.g. `POST /rooms` abuse), authorization (host vs. player actions),
or data exposure are especially welcome. The server keeps only transient,
anonymous game state (nicknames, avatars, scores) that is auto-deleted by TTL.
