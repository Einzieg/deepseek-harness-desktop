/** URL-spoofing checks for the Electron renderer boundary. */

import { describe, expect, it } from 'vitest'
import { isAppUrl, safeExternalUrl } from '../src/navigation.ts'

describe('Electron URL policy', () => {
  const origin = 'http://127.0.0.1:43123'

  it('accepts only the exact backend origin for in-window navigation', () => {
    expect(isAppUrl(`${origin}/sessions/1`, origin)).toBe(true)
    expect(isAppUrl('http://127.0.0.1:43124/', origin)).toBe(false)
    expect(isAppUrl('http://127.0.0.1:43123.evil.example/', origin)).toBe(false)
    expect(isAppUrl('http://user@127.0.0.1:43123/', origin)).toBe(false)
    expect(isAppUrl('https://127.0.0.1:43123/', origin)).toBe(false)
  })

  it('allows ordinary Web links externally but rejects executable and credential URLs', () => {
    expect(safeExternalUrl('https://example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
    expect(safeExternalUrl('http://example.com/')).toBe('http://example.com/')
    expect(safeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBeUndefined()
    expect(safeExternalUrl('https://user:secret@example.com/')).toBeUndefined()
    expect(safeExternalUrl('not a url')).toBeUndefined()
  })
})
