/**
 * Base class for all errors thrown by the WhisperAI SDK.
 */
export abstract class WhisperError extends Error {
  /** Error classification code (e.g. "AUTH_ERROR", "TIMEOUT_ERROR"). */
  abstract readonly code: string
  /** Correlation ID for tracing upload failures with WhisperAI support/diagnostics. */
  diagnosticId?: string

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * Thrown when the WhisperAI API returns a non-2xx HTTP response.
 */
export class WhisperApiError extends WhisperError {
  readonly code = "API_ERROR"

  constructor(
    /** HTTP status code (e.g. 400, 403, 500). */
    public readonly status: number,
    /** Response body returned by the API (JSON or text). */
    public readonly response: unknown
  ) {
    super(`Whisper API error (${status})`)
  }
}

/**
 * Thrown when authentication fails due to invalid email or password.
 */
export class WhisperAuthError extends WhisperError {
  readonly code = "AUTH_ERROR"

  constructor() {
    super("Authentication failed")
  }
}

/**
 * Thrown when a network request fails (DNS failure, connection reset, offline).
 */
export class WhisperNetworkError extends WhisperError {
  readonly code = "NETWORK_ERROR"

  constructor(cause?: unknown) {
    super("Network error", { cause })
    this.cause = cause
  }
}

/**
 * Thrown when an audio upload to Google Cloud Storage fails or is rejected.
 */
export class WhisperUploadError extends WhisperError {
  readonly code = "UPLOAD_ERROR"

  constructor(
    message: string,
    public readonly diagnosticId?: string,
    cause?: unknown
  ) {
    super(message, { cause })
    this.cause = cause
  }
}

/**
 * Thrown when a transcription reaches a terminal failed or canceled state in WhisperAI.
 */
export class WhisperTranscriptionError extends WhisperError {
  readonly code = "TRANSCRIPTION_ERROR"

  constructor(
    /** The ID of the failed recording. */
    public readonly recordingId: number,
    /** Final status reported by WhisperAI (e.g. "failed", "canceled"). */
    public readonly status: string
  ) {
    super(`Transcription ${recordingId} finished with status ${status}`)
  }
}

/**
 * Thrown when polling for transcription exceeds the configured timeout duration.
 */
export class WhisperTimeoutError extends WhisperError {
  readonly code = "TIMEOUT_ERROR"

  constructor(
    /** The ID of the recording that timed out. */
    public readonly recordingId: number,
    /** The configured timeout threshold in milliseconds. */
    public readonly timeoutMs: number
  ) {
    super(`Transcription ${recordingId} did not complete within ${timeoutMs}ms`)
  }
}
