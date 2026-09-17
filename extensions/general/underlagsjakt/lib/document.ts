/**
 * Viewing a candidate document.
 *
 * Contract 1.1 carries each candidate's filename, source and sha256, not the
 * file itself. The workspace therefore lets the user pick the file from their
 * own disk (bertil's Kvitton/ folder or the mail attachment) and opens it only
 * when its hash matches the candidate's, so what is shown is provably the
 * document bertil's evidence is about. The file never leaves the browser.
 */

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function matchesCandidate(data: ArrayBuffer, expectedSha256: string): Promise<boolean> {
  return (await sha256Hex(data)) === expectedSha256.toLowerCase()
}
