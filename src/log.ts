/**
 * Minimal namespaced logger.
 *
 * A plugin should never take down the host if it misbehaves, and should be
 * quiet by default. `OPENCODE_AUTO_ROUTER_DEBUG=1` enables verbose lines.
 */

const PREFIX = "[auto-router]"

function enabled(): boolean {
  const value = process.env.OPENCODE_AUTO_ROUTER_DEBUG
  return value === "1" || value === "true"
}

export const log = {
  debug(...args: unknown[]): void {
    if (enabled()) console.debug(PREFIX, ...args)
  },
  info(...args: unknown[]): void {
    if (enabled()) console.info(PREFIX, ...args)
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args)
  },
}
