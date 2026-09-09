import { WhisperStatus } from "./constant.js"

/**
 * Audio input supported by the SDK:
 * - `Uint8Array`: in-memory buffer containing the complete audio file.
 * - `ReadableStream<Uint8Array>`: Web ReadableStream yielding audio chunks.
 */
export type AudioInput = Uint8Array | ReadableStream<Uint8Array>

/**
 * Configuration options for initializing {@link WhisperClient}.
 */
export interface ClientOptions {
  /**
   * WhisperAI account credentials used for authentication.
   */
  login: {
    email: string
    password: string
  }
  /**
   * Base URL of the WhisperAI service.
   * @default "https://whisperai.com"
   */
  whisperUrl?: string
  /**
   * Chunk size in bytes for Google Cloud Storage resumable upload parts.
   * Must be a multiple of 256 KiB.
   * @default 8388608 (8 MiB)
   */
  chunkSize?: number
  /**
   * Maximum number of retry attempts per upload chunk on transient network or 5xx errors.
   * @default 8
   */
  maxUploadAttempts?: number
  /**
   * Initial backoff delay in milliseconds before retrying a failed upload chunk.
   * @default 1000 (1 second)
   */
  initialRetryDelayMs?: number
  /**
   * Maximum backoff delay in milliseconds between retry attempts.
   * @default 30000 (30 seconds)
   */
  maxRetryDelayMs?: number
  /**
   * Whether to send anonymous upload diagnostic breadcrumbs to WhisperAI.
   * @default true
   */
  diagnostics?: boolean
  /**
   * Interval in milliseconds between status polling queries in waitForTranscription.
   * @default 2000 (2 seconds)
   */
  pollIntervalMs?: number
  /**
   * Maximum duration in milliseconds to wait for transcription completion before timing out.
   * @default 1800000 (30 minutes)
   */
  transcriptionTimeoutMs?: number
  /**
   * Timeout in milliseconds for individual HTTP and GCS requests.
   * @default 120000 (2 minutes)
   */
  requestTimeoutMs?: number
}

/**
 * Options for audio upload operations.
 */
export interface OperationOptions {
  /**
   * AbortSignal to cancel the operation.
   */
  signal?: AbortSignal
  /**
   * Progress callback invoked with the upload percentage (0 to 100).
   */
  onProgress?: (percentage: number) => void
  /**
   * Optional correlation ID for upload diagnostics. If omitted, an 8-character ID is generated.
   */
  diagnosticId?: string
  /**
   * Override diagnostics sending for this specific operation.
   */
  diagnostics?: boolean
}

/**
 * Options for the one-shot `transcribe` and `waitForTranscription` methods.
 */
export interface TranscribeOptions extends OperationOptions {
  /**
   * Polling interval in milliseconds when checking for transcription completion.
   * @default 2000
   */
  pollIntervalMs?: number
  /**
   * Maximum time in milliseconds to wait for transcription processing before throwing WhisperTimeoutError.
   * @default 1800000 (30 minutes)
   */
  timeoutMs?: number
}

export interface RequestError {
  message: string
  path?: string
  code?: string
}

/**
 * Profile information for the authenticated user.
 */
export interface UserInfo {
  id: number
  username: string | null
  email: string
  firstName: string
  lastName: string
  profileImageUrl: string | null
  subscriptionTier: string
  stripeSubscriptionId: string | null
  stripeCustomerId: string | null
  trialStartDate: string | null
  trialEndDate: string | null
  hasUsedTrial: boolean
  monthlyUsageMinutes: number
  usageResetDate: string
  deletedMinutesThisCycle: number
  subscriptionStatus: string
  subscriptionEndDate: string | null
  cancellationOffered: boolean
  unsubscribed: boolean
  hearAboutUs: string | null
  industry: string
  totalMinutes: number
  recordingsCount: number
  subscriptionPausedUntil: string | null
  subscriptionPauseStarts: string | null
  subscriptionOriginalTier: string | null
  discountCodeApplied: string | null
  retentionOfferShown: string | null
  billingFrequency: string
  hasSeenTutorial: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Account usage information and plan limits.
 */
export interface UsageInfo {
  /** Minutes of audio transcribed in the current billing cycle. */
  monthlyUsageMinutes: number
  /** Current subscription tier name (e.g. "free", "starter", "pro"). */
  subscriptionTier: string
  /** Quota limits associated with the account tier. */
  limits: {
    monthlyMinutes: number
    dailyMinutes: number
    maxFileSize: number
  }
  /** Maximum audio file size in bytes permitted for uploads. */
  maxFileSizeBytes: number
}

export type TranscriptionStyle = "standard" | "clean_readable" | (string & {})
export type SpeakerIdentificationMode = "role" | "name" | (string & {})

/**
 * Metadata required when initiating an audio transcription upload.
 */
export interface InitMetaFile {
  /** Audio filename including extension (e.g. "interview.m4a", "meeting.wav"). */
  filename: string
  /** Duration of the audio file in seconds. Must be positive. */
  durationSeconds: number
  /** Human-readable title for the recording. Defaults to filename without extension. */
  title?: string
  /** MIME type of the audio file (e.g. "audio/x-m4a", "audio/wav", "audio/webm"). */
  mimeType?: string
  /**
   * Total size in bytes of the audio input.
   * Required when passing a ReadableStream to avoid buffering into memory.
   */
  totalSize?: number
  /**
   * Target audio language code (e.g. "auto", "en", "es", "multi-auto").
   * @default "auto"
   */
  language?: string
  /**
   * Enable diarization (detecting distinct speakers in the audio).
   * @default false
   */
  enableSpeakerDetection?: boolean
  /**
   * Expected number of distinct speakers ("auto" or numeric count).
   * @default "auto"
   */
  speakerCount?: "auto" | number
  /**
   * Formatting style of the generated transcript ("standard" or "clean_readable").
   * @default "standard"
   */
  transcriptionStyle?: TranscriptionStyle
  /** Domain-specific vocabulary, acronyms, or proper nouns to assist recognition. */
  importantTerms?: string
  /** Custom instructions or prompt guiding the transcription engine. */
  customPrompt?: string
  /** Whether speaker identification by label/name is enabled. @default false */
  speakerIdentificationEnabled?: boolean
  /** Speaker identification mode ("role" or "name"). @default "role" */
  speakerIdentificationMode?: SpeakerIdentificationMode
  /** Predefined speaker names or roles (e.g. `["Interviewer", "Candidate"]`). */
  speakerIdentificationValues?: string[]
  /** Optional folder ID in WhisperAI to organize the recording. */
  folderId?: number
}

export interface SignedUploadResponse {
  recordingId: number
  objectPath: string
  signedResumableInitUrl: string
  requiredHeaders: Record<string, string>
  ttlSec: number
}

export interface RecordingStatusResponse {
  recordingId: number
  recordingStatus: `${WhisperStatus}` | "canceled" | "retry_pending" | "retry_processing"
}

export interface TranscriptionResponse {
  id: number
  recordingId: number
  status: "queued" | "processing" | "completed" | "failed" | "canceled"
  createdAt: string
  updatedAt: string
}

export interface Translation {
  id: number
  transcriptionId: number
  targetLanguage: string
  content: string
  status: string
  createdAt: string
}

export interface Transcription {
  id: number
  userId: number
  recordingId: number
  content: string
  editedContent: string | null
  confidence: number
  segments: Array<{
    id: number
    start: number
    end: number
    text: string
  }>
  translations: Translation[]
  timestamps: {
    words: unknown[]
    duration: number
    language: string
    segments: Array<{
      id: number
      start: number
      end: number
      text: string
    }>
  }
  speakers: unknown | null
  speakerNames: Record<string, unknown>
  createdAt: string
  updatedAt: string
  summary: unknown | null
}

/**
 * Audio recording entity returned by WhisperAI.
 */
export interface RecordingResponse {
  /** Unique ID of the recording in WhisperAI. */
  id: number
  /** User ID of the owner. */
  userId: number
  /** Title of the recording. */
  title: string
  /** Original filename of the uploaded file. */
  originalFilename: string
  /** File extension (e.g. ".m4a"). */
  fileExtension: string
  /** MIME type of the uploaded audio. */
  mimeType: string
  /** URL to the stored audio file. */
  audioUrl: string
  /** Duration of the audio in seconds. */
  duration: number
  /** Detected or specified language. */
  language: string
  /** Processing status (e.g. "processing", "completed", "failed", "canceled"). */
  status: `${WhisperStatus}` | "canceled" | "retry_pending" | "retry_processing"
  speakerDetectionEnabled: boolean
  speakerCount: number | null
  totalChunks: number | null
  acceptedMaxFileSizeBytes?: number
  format?: string
  metadata: Record<string, unknown> | null
  idempotencyKey: string | null
  uploadSessionId: string
  source?: string
  sourceUrl?: string | null
  transcriptionStyle?: string
  importantTerms?: string[]
  customPrompt?: string
  speakerIdentificationEnabled?: boolean
  speakerIdentificationMode?: string
  speakerIdentificationValues?: string[]
  organizationId?: number | null
  folderId?: number | null
  accessToken?: string
  accessTokenExpiry?: string
  createdAt: string
  updatedAt: string
  /** Transcription object if processing is completed; null otherwise. */
  transcription: Transcription | null
}

/**
 * Recording guaranteed to have status "completed" and a non-null `transcription`.
 */
export interface CompletedRecordingResponse extends RecordingResponse {
  status: WhisperStatus.COMPLETED
  transcription: Transcription
}

/**
 * Response returned immediately after an audio upload finishes.
 * Status is typically "processing" until transcription finishes.
 */
export type FinalizeUploadResponse = RecordingResponse

/**
 * Result of translating a recording transcription.
 */
export interface TranslateResponse {
  success: true
  message: string
  translation: Translation
}

/**
 * Account-wide summary of transcription usage and recordings.
 */
export interface SummaryResponse {
  usage: {
    monthlyMinutes: number
    monthlyLimit: number
    percentage: number
  }
  recordings: {
    total: number
    thisMonth: number
    totalMinutes: number
    averageDuration: number
  }
  activity: {
    dailyCounts: Record<string, number>
    mostActiveDay: string
    currentStreak: number
  }
  insights: {
    shouldUpgrade: boolean
    suggestedTier: string
    upgradeReason: string
  }
}

/**
 * Query parameters for filtering and paginating recordings.
 */
export interface RecordingsQuery {
  /** Page number for offset-based pagination. */
  page?: number
  /** Maximum number of records to return (default 20). */
  limit?: number
  /** Cursor token for cursor-based pagination. */
  cursor?: string
  /** Direction when using cursor pagination ("next" or "prev"). */
  direction?: "next" | "prev"
  /** Search query matching recording title or transcript content. */
  search?: string
  /** Filter by recording status (e.g. "completed", "failed", "processing"). */
  status?: string
  /** Sort order ("newest" or "oldest"). */
  sort?: "newest" | "oldest"
}

/**
 * Paginated list of recordings.
 */
export interface RecordingsResponse {
  data: RecordingResponse[]
  sharedItems?: RecordingResponse[]
  total: number | string
  page?: number
  limit: number
  pages?: number
  hasNext: boolean
  hasPrev: boolean
  nextCursor?: string | null
  prevCursor?: string | null
  startIndex?: number
}

/**
 * Subscription status and next billing cycle details.
 */
export interface SubscriptionDetailsResponse {
  isPaidPlan: boolean
  isTrialActive: boolean
  nextBillingDate: string | null
  billingAmount: number | null
  subscriptionStatus: string
}

export interface DiagnosticEvent {
  diagId: string
  phase: string
  recordingId?: number
  chunkIndex?: number
  attempt?: number
  httpStatus?: number
  errorName?: string
  errorMessage?: string
  fileName?: string
  fileSize?: number
  fileType?: string
  timestamp: string
}
