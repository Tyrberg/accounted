import { describe, it, expect } from 'vitest'
import { matchesCandidate, sha256Hex } from '../lib/document'

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('document hash check', () => {
  it('hashes like bertil (hashlib.sha256().hexdigest())', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('opens only the file the candidate is about', async () => {
    const expected = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'
    expect(await matchesCandidate(bytes('abc'), expected)).toBe(true)
    expect(await matchesCandidate(bytes('abd'), expected)).toBe(false)
  })
})
