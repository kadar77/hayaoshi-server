// Room codes use an ambiguity-free alphabet (no 0/O, 1/I, etc.) — the same set
// the frontend mock used, so codes read cleanly on a QR/lobby card.
const ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ23456789'

export function genCode(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
  return s
}

export function genToken(): string {
  return crypto.randomUUID()
}

export function genId(): string {
  return crypto.randomUUID().slice(0, 8)
}
