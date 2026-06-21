import { WhisperStatus } from "./constant.js"

export interface ClientOptions {
  login: {
    email: string
    password: string
  }
  whisperUrl?: string
  chunkSize?: number
  maxUploadAttempts?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  diagnostics?: boolean
  pollIntervalMs?: number
  transcriptionTimeoutMs?: number
}

export interface OperationOptions {
  signal?: AbortSignal
  onProgress?: (percentage: number) => void
  diagnosticId?: string
  diagnostics?: boolean
}

export interface TranscribeOptions extends OperationOptions {
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface RequestError {
  message: string
  path?: string
  code?: string
}

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

export interface UsageInfo {
  monthlyUsageMinutes: number
  subscriptionTier: string
  limits: {
    monthlyMinutes: number
    dailyMinutes: number
    maxFileSize: number
  }
  maxFileSizeBytes: number
}

export type TranscriptionStyle = "standard" | "clean_readable" | (string & {})
export type SpeakerIdentificationMode = "role" | "name" | (string & {})

export interface InitMetaFile {
  filename: string
  durationSeconds: number
  title?: string
  mimeType?: string
  totalSize?: number
  language?: string
  enableSpeakerDetection?: boolean
  speakerCount?: "auto" | number
  transcriptionStyle?: TranscriptionStyle
  importantTerms?: string
  customPrompt?: string
  speakerIdentificationEnabled?: boolean
  speakerIdentificationMode?: SpeakerIdentificationMode
  speakerIdentificationValues?: string[]
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

export interface RecordingResponse {
  id: number
  userId: number
  title: string
  originalFilename: string
  fileExtension: string
  mimeType: string
  audioUrl: string
  duration: number
  language: string
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
  transcription: Transcription | null
}

export interface CompletedRecordingResponse extends RecordingResponse {
  status: WhisperStatus.COMPLETED
  transcription: Transcription
}

export type FinalizeUploadResponse = RecordingResponse

export interface TranslateResponse {
  success: true
  message: string
  translation: Translation
}

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

export interface RecordingsQuery {
  page?: number
  limit?: number
  cursor?: string
  direction?: "next" | "prev"
  search?: string
  status?: string
  sort?: "newest" | "oldest"
}

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
