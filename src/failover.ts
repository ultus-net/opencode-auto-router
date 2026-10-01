/**
 * Automatic provider failover: Synthetic -> OpenRouter Auto Router.
 *
 * OpenCode cannot redirect an in-flight request from a plugin: on every
 * session hook (`context`, `retry`, …) the `model` field is readonly. What a
 * plugin *can* do is observe the failure and drive recovery through the
 * session API:
 *
 *   1. `session.retry.scheduled` carries the structured error (with its HTTP
 *      status) and fires per attempt. The `retry` hook lets us bound Synthetic
 *      retries so we reach a terminal failure quickly instead of waiting out
 *      OpenCode's long default backoff.
 *   2. `session.execution.failed` fires when the turn gives up, with the same
 *      structured error.
 *   3. We then `switchModel` to `openrouter/openrouter/auto` and re-send the
 *      last user message with `prompt`.
 *
 * Replay safety: re-sending a turn is only safe when nothing has happened yet.
 * A turn that already produced assistant content or ran a tool is not replayed,
 * because re-sending it would duplicate side effects. `replayCandidate` reports
 * whether the last turn is still safe to replay; the controller refuses to fail
 * over when it is not. The controller also refuses when the session is no longer
 * on Synthetic, so a failed fallback cannot loop.
 */

import { OPENROUTER_AUTO_MODEL_ID, OPENROUTER_PROVIDER_ID, SYNTHETIC_PROVIDER_ID } from "./constants.js"
import { log } from "./log.js"
import type { ResolvedConfig } from "./types.js"

export interface StructuredError {
  type?: string
  message?: string
  status?: number
}

export interface ModelRef {
  providerID: string
  id: string
}

/** A candidate turn to replay after a failover, with a safety verdict. */
export interface ReplayCandidate {
  /** The user-authored text of the last turn. */
  text: string
  /**
   * False when the failed turn already produced assistant output or ran tools.
   * Replaying such a turn would duplicate side effects, so the controller
   * refuses to fail over on an unsafe turn.
   */
  safe: boolean
}

/** A retry-hook decision, mutable so the hook can override it. */
export type RetryDecision = { retry: false } | { retry: true; delay: number }

/** The subset of the V2 `retry` hook event this controller reads. */
export interface RetryEvent {
  model: ModelRef
  error: StructuredError
  attempt: number
  decision: RetryDecision
}

/** Injected session operations, so the controller is unit-testable. */
export interface FailoverHost {
  getSessionModel(sessionID: string): Promise<ModelRef | undefined>
  /** Last user turn plus whether replaying it is safe. */
  replayCandidate(sessionID: string): Promise<ReplayCandidate | undefined>
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  prompt(sessionID: string, text: string): Promise<unknown>
}

/**
 * Decide whether a provider error is worth failing over on.
 * Matches configured HTTP statuses first, then message substrings for
 * providers that report rate limits without a status.
 */
export function isRetryable(
  error: StructuredError,
  config: ResolvedConfig,
): boolean {
  const { statuses, messageMatches } = config.failover
  if (typeof error.status === "number" && statuses.includes(error.status)) {
    return true
  }
  const haystack = `${error.type ?? ""} ${error.message ?? ""}`.toLowerCase()
  return messageMatches.some((needle) =>
    haystack.includes(needle.toLowerCase()),
  )
}

/** Per-session failover state. Kept minimal to avoid unbounded growth. */
interface SessionState {
  /** Successful cross-provider switches so far. */
  attempts: number
  /** A failover is currently being performed; suppresses reentry. */
  busy: boolean
}

export class FailoverController {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly config: ResolvedConfig,
    private readonly host: FailoverHost,
  ) {}

  /** Whether the plugin is configured to fail over at all. */
  get enabled(): boolean {
    return this.config.failover.enabled
  }

  /**
   * Retry-hook decision: cap Synthetic retries to a single short attempt so a
   * sustained rate limit reaches `session.execution.failed` promptly.
   * Returns true when it modified the decision.
   */
  boundRetry(event: RetryEvent): boolean {
    if (!this.enabled) return false
    if (event.model.providerID !== SYNTHETIC_PROVIDER_ID) return false
    if (!isRetryable(event.error, this.config)) return false

    if (event.attempt >= 2) {
      event.decision = { retry: false }
    } else {
      event.decision = { retry: true, delay: this.config.failover.retryDelayMs }
    }
    return true
  }

  /**
   * Handle a terminal turn failure: if the session was on Synthetic and the
   * error is retryable, switch to OpenRouter and re-send the last user message.
   */
  async onExecutionFailed(sessionID: string, error: StructuredError): Promise<void> {
    if (!this.enabled) return

    const state = this.state(sessionID)
    if (state.busy) return
    if (state.attempts >= this.config.failover.maxAttempts) {
      log.debug("failover budget exhausted for", sessionID)
      return
    }
    if (!isRetryable(error, this.config)) return

    state.busy = true
    try {
      const model = await this.host.getSessionModel(sessionID)
      if (model?.providerID !== SYNTHETIC_PROVIDER_ID) {
        // Not on Synthetic (already failed over, or user switched); do nothing.
        return
      }

      const candidate = await this.host.replayCandidate(sessionID)
      if (!candidate) {
        log.warn("no user message to replay; skipping failover for", sessionID)
        return
      }
      if (!candidate.safe) {
        log.warn(
          "failed turn already produced output or ran tools; not replaying (would duplicate side effects) for",
          sessionID,
        )
        return
      }

      log.info(
        `failing over ${sessionID} to ${OPENROUTER_PROVIDER_ID}/${OPENROUTER_AUTO_MODEL_ID}`,
      )
      await this.host.switchModel(sessionID, {
        providerID: OPENROUTER_PROVIDER_ID,
        id: OPENROUTER_AUTO_MODEL_ID,
      })
      state.attempts += 1
      await this.host.prompt(sessionID, candidate.text)
    } catch (failure) {
      log.warn("failover attempt failed", failure)
    } finally {
      state.busy = false
    }
  }

  /** Drop per-session state once a turn succeeds or the session is gone. */
  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  private state(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { attempts: 0, busy: false }
      this.sessions.set(sessionID, state)
    }
    return state
  }
}
