import { describe, expect, it } from 'vitest'
import { panelScale } from '../src/shared/types'

// Panels draw skin pixels at a whole number of device pixels each; anything
// else smears the bitmap fonts (it did, on a 1x 1440p display).
describe('panelScale', () => {
  it.each([1, 1.25, 1.5, 2, 2.5, 3])('lands on whole device pixels at %sx', (dpr) => {
    const devicePx = panelScale(dpr) * dpr
    expect(Number.isInteger(Math.round(devicePx * 1e6) / 1e6)).toBe(true)
  })

  it('is at least 2 device pixels per skin pixel, 3 on dense displays', () => {
    expect(panelScale(1) * 1).toBe(2)
    expect(panelScale(2) * 2).toBe(3)
  })
})
