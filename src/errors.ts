export abstract class WhisperError extends Error {
  abstract readonly code: string

  protected constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class WhisperApiError extends WhisperError {
  readonly code = "API_ERROR"

  constructor(
    public readonly status: number,
    public readonly response: unknown
  ) {
    super(`Whisper API error (${status})`)
  }
}

export class WhisperAuthError extends WhisperError {
  readonly code = "AUTH_ERROR"

  constructor() {
    super("Authentication failed")
  }
}

export class WhisperNetworkError extends WhisperError {
  readonly code = "NETWORK_ERROR"

  constructor(cause?: unknown) {
    super("Network error")
    this.cause = cause
  }
}
