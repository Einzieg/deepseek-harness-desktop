/** Pure URL policy shared by Electron navigation and permission handlers. */

/** Whether a URL belongs to the one loopback origin announced by this backend. */
export function isAppUrl(candidate: string, appOrigin: string): boolean {
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && url.username === ''
      && url.password === ''
      && url.origin === appOrigin
  } catch {
    return false
  }
}

/**
 * Return a URL safe to hand to the operating system, or undefined for local,
 * credential-bearing, executable, and malformed schemes.
 */
export function safeExternalUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}
