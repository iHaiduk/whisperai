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

export class WhisperUploadError extends WhisperError {
  readonly code = "UPLOAD_ERROR"

  constructor(
    message: string,
    public readonly diagnosticId?: string,
    cause?: unknown
  ) {
    super(message)
    this.cause = cause
  }
}

export class WhisperTranscriptionError extends WhisperError {
  readonly code = "TRANSCRIPTION_ERROR"

  constructor(
    public readonly recordingId: number,
    public readonly status: string
  ) {
    super(`Transcription ${recordingId} finished with status ${status}`)
  }
}

export class WhisperTimeoutError extends WhisperError {
  readonly code = "TIMEOUT_ERROR"

  constructor(
    public readonly recordingId: number,
    public readonly timeoutMs: number
  ) {
    super(`Transcription ${recordingId} did not complete within ${timeoutMs}ms`)
  }
}
