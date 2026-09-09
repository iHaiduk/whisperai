export enum WhisperStatus {
  PENDING = "pending",
  VALIDATING = "validating",
  UPLOADING = "uploading",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled"
}

export const DEFAULT_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024
export const DEFAULT_MAX_UPLOAD_ATTEMPTS = 8
export const DEFAULT_POLL_INTERVAL_MS = 2_000
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 30 * 60 * 1_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
export const MAX_DIAGNOSTIC_STRING_LENGTH = 256
