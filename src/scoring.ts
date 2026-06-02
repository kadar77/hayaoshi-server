// Authoritative speed-bonus scoring. Mirrors the frontend's original formula
// (round(600 + speed*400)) but computed server-side from the answer timestamp
// the Durable Object records, so client clocks can't be cheated.
export const QUESTION_TIME_MS = 10_000
const BASE = 600
const SPEED_BONUS = 400

/**
 * @param correct   whether the chosen option was right
 * @param elapsedMs ms between the question going live and the answer arriving
 */
export function points(correct: boolean, elapsedMs: number): number {
  if (!correct) return 0
  const speed = Math.max(0, 1 - elapsedMs / QUESTION_TIME_MS)
  return Math.round(BASE + speed * SPEED_BONUS)
}
