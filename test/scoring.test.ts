import { describe, it, expect } from 'vitest'
import { points, QUESTION_TIME_MS } from '../src/scoring'

describe('points', () => {
  it('is zero for a wrong answer regardless of speed', () => {
    expect(points(false, 0)).toBe(0)
    expect(points(false, QUESTION_TIME_MS / 2)).toBe(0)
  })

  it('awards the max for an instant correct answer', () => {
    expect(points(true, 0)).toBe(1000)
  })

  it('awards only the base for a last-moment correct answer', () => {
    expect(points(true, QUESTION_TIME_MS)).toBe(600)
  })

  it('awards half the speed bonus at half time', () => {
    expect(points(true, QUESTION_TIME_MS / 2)).toBe(800)
  })

  it('never drops below the base even past the deadline', () => {
    expect(points(true, QUESTION_TIME_MS * 2)).toBe(600)
  })
})
