import { WhisperStatus } from "./constant.js"

export interface ClientOptions {
  login: {
    email: string
    password: string
  }
  chunkSize?: number
  whisperUrl?: string
}

export interface RequestError {
  message: string
  path: string
}

export interface UserInfo {
  id: number
  username: string | null
  email: string
  firstName: string
  lastName: string
  profileImageUrl: string | null
  subscriptionTier: "free" | "premium"
  stripeSubscriptionId: string | null
  stripeCustomerId: string | null
  trialStartDate: string | null
  trialEndDate: string | null
  hasUsedTrial: boolean
  monthlyUsageMinutes: number
  usageResetDate: string
  deletedMinutesThisCycle: number
  subscriptionStatus: "past_due" | "active"
  subscriptionEndDate: string | null
  cancellationOffered: boolean
  unsubscribed: boolean
  hearAboutUs: string | null
  industry:
    | "Healthcare & Medical"
    | "Legal & Compliance"
    | "Education & Research"
    | "Media & Entertainment"
    | "Technology & Software"
    | "Consulting & Professional Services"
    | "Financial Services (Banking, Insurance, Accounting)"
    | "Government & Nonprofit"
    | "Sales & Marketing / Advertising"
    | "Real Estate & Construction"
    | "Manufacturing & Engineering"
    | "Human Resources & Recruiting"
    | "Customer Support / Call Centers"
    | "Student"
    | string
  totalMinutes: number
  recordingsCount: number
  subscriptionPausedUntil: string | null
  subscriptionPauseStarts: string | null
  subscriptionOriginalTier: string | null
  discountCodeApplied: string | null
  retentionOfferShown: string | null
  billingFrequency: "monthly" | "weekly"
  hasSeenTutorial: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface UsageInfo {
  monthlyUsageMinutes: number
  subscriptionTier: "free" | "premium"
  limits: {
    monthlyMinutes: number
    dailyMinutes: number
    maxFileSize: number
  }
}

export interface InitMetaFile {
  filename: string
  durationSeconds: number
  title?: string
  mimeType?: string
  totalSize?: number
  language?: number
  enableSpeakerDetection?: boolean
  speakerCount?: "auto" | number
}

export interface InitChunkResponse {
  sessionId: string
  recordingId: number
}

export interface UploadChunkResponse {
  success: boolean
  chunkIndex: number
  uploadedChunks: number
  totalChunks: number
}

export interface FinalizeChunkResponse {
  id: number
  userId: number
  title: string
  originalFilename: string
  fileExtension: string
  mimeType: string
  audioUrl: string
  duration: number
  language: string
  status: WhisperStatus
  speakerDetectionEnabled: boolean
  speakerCount: number | null
  totalChunks: number
  metadata: Record<string, unknown> | null
  idempotencyKey: string | null
  uploadSessionId: string
  createdAt: string
  updatedAt: string
}

export interface TranscriptionResponse {
  id: number
  recordingId: number
  status: "queued" | "processing" | "completed" | "failed" | "canceled"
  createdAt: string
  updatedAt: string
}

export interface TranslateResponse {
  success: true
  message: string
  translation: {
    id: number
    transcriptionId: number
    targetLanguage: string
    content: string
    status: string
  }
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
  status: string
  speakerDetectionEnabled: boolean
  speakerCount: number | null
  totalChunks: number
  metadata: Record<string, unknown> | null
  idempotencyKey: string | null
  uploadSessionId: string
  accessToken: string
  accessTokenExpiry: string
  createdAt: string
  updatedAt: string
  transcription: {
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
    translations: Array<{
      id: number
      transcriptionId: number
      targetLanguage: string
      content: string
      status: string
      createdAt: string
    }>
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
}

export interface RecordingsQuery {
  page?: number
  limit?: number
}

export interface RecordingsResponse {
  data: RecordingResponse[]
  total: string
  page: number
  limit: number
  pages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface SubscriptionDetailsResponse {
  isPaidPlan: boolean
  isTrialActive: boolean
  nextBillingDate: string | null
  billingAmount: number | null
  subscriptionStatus: string
}
