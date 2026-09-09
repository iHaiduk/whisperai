import {
  DEFAULT_MAX_UPLOAD_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_UPLOAD_CHUNK_SIZE,
  MAX_DIAGNOSTIC_STRING_LENGTH,
  WhisperStatus
} from "./constant.js"
import {
  WhisperApiError,
  WhisperAuthError,
  WhisperError,
  WhisperNetworkError,
  WhisperTimeoutError,
  WhisperTranscriptionError,
  WhisperUploadError
} from "./errors.js"
import type {
  AudioInput,
  ClientOptions,
  CompletedRecordingResponse,
  DiagnosticEvent,
  FinalizeUploadResponse,
  InitMetaFile,
  OperationOptions,
  RecordingResponse,
  RecordingsQuery,
  RecordingsResponse,
  RecordingStatusResponse,
  SignedUploadResponse,
  SubscriptionDetailsResponse,
  SummaryResponse,
  TranscribeOptions,
  TranscriptionResponse,
  TranslateResponse,
  UsageInfo,
  UserInfo
} from "./types.js"

interface ResolvedClientOptions {
  login: ClientOptions["login"]
  whisperUrl: string
  chunkSize: number
  maxUploadAttempts: number
  initialRetryDelayMs: number
  maxRetryDelayMs: number
  diagnostics: boolean
  pollIntervalMs: number
  transcriptionTimeoutMs: number
  requestTimeoutMs: number
}

interface UploadContext {
  diagnosticId: string
  diagnostics: boolean
  signal?: AbortSignal
  onProgress?: (percentage: number) => void
}

interface RangeResult {
  complete: boolean
  nextOffset: number
  status: number
}

/**
 * Client for the WhisperAI service (v2).
 *
 * Provides end-to-end audio transcription using direct signed Google Cloud Storage resumable uploads,
 * automatic session recovery, status polling, and account management.
 *
 * @example
 * ```ts
 * import { WhisperClient } from "whisperai-sdk"
 * import { readFile } from "node:fs/promises"
 *
 * const client = new WhisperClient({
 *   login: {
 *     email: process.env.WHISPER_EMAIL!,
 *     password: process.env.WHISPER_PASSWORD!
 *   }
 * })
 *
 * const audio = new Uint8Array(await readFile("meeting.m4a"))
 * const result = await client.transcribe(audio, {
 *   filename: "meeting.m4a",
 *   durationSeconds: 120,
 *   mimeType: "audio/x-m4a"
 * })
 * console.log(result.transcription.content)
 * ```
 */
export class WhisperClient {
  private cookies?: string[]
  private readonly clientOptions: ResolvedClientOptions

  /**
   * Initializes a new WhisperClient instance.
   *
   * @param clientOptions Credentials and optional configuration overrides.
   */
  constructor(clientOptions: ClientOptions) {
    this.clientOptions = {
      whisperUrl: "https://whisperai.com",
      chunkSize: DEFAULT_UPLOAD_CHUNK_SIZE,
      maxUploadAttempts: DEFAULT_MAX_UPLOAD_ATTEMPTS,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 30_000,
      diagnostics: true,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      transcriptionTimeoutMs: DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      ...clientOptions
    }
  }

  private loginPromise?: Promise<UserInfo>

  /**
   * Authenticates with WhisperAI using configured email and password.
   * Concurrent calls are deduplicated into a single HTTP request.
   * Subsequent API requests authenticate automatically using session cookies.
   *
   * @param signal Optional AbortSignal to cancel waiting for login.
   * @returns User information for the authenticated account.
   * @throws {@link WhisperAuthError} If credentials are invalid.
   * @throws {@link WhisperNetworkError} If network connection fails.
   */
  async login(signal?: AbortSignal): Promise<UserInfo> {
    this.throwIfAborted(signal)
    if (!this.loginPromise) {
      const promise = this.post<UserInfo>(this.loginLink, this.clientOptions.login).finally(() => {
        if (this.loginPromise === promise) {
          this.loginPromise = undefined
        }
      })
      this.loginPromise = promise
    }
    return this.raceWithSignal(this.loginPromise, signal)
  }

  /**
   * Retrieves profile information for the authenticated user.
   *
   * @returns User profile details including ID, email, subscription status.
   */
  user() {
    return this.recall(() => this.get<UserInfo>(this.userLink))
  }

  /**
   * Retrieves current monthly transcription usage minutes and plan limits.
   *
   * @returns Usage statistics including consumed minutes and quota limits.
   */
  usage() {
    return this.recall(() => this.get<UsageInfo>(this.usageLink))
  }

  /**
   * Retrieves subscription billing details, plan status, and payment state.
   */
  subscriptionDetails() {
    return this.recall(() => this.get<SubscriptionDetailsResponse>(this.subscriptionDetailsLink))
  }

  /**
   * Initiates a transcription by requesting a signed GCS resumable upload URL,
   * uploading the audio chunks to Google Cloud Storage, and completing the upload.
   * Returns immediately once the file is uploaded without waiting for transcription processing.
   *
   * @param file Audio data as `Uint8Array` or `ReadableStream<Uint8Array>`.
   * @param meta Metadata describing the audio file (duration, filename, language, etc.).
   * @param options Upload options including abort signal, progress callback, and diagnostics.
   * @returns Response containing the recording ID and initial "processing" status.
   * @throws {@link WhisperUploadError} If the GCS session fails or upload is rejected.
   * @throws {@link WhisperApiError} If API signing or finalization returns an error.
   *
   * @example
   * ```ts
   * const started = await client.startTranscription(audioBuffer, {
   *   filename: "audio.m4a",
   *   durationSeconds: 60
   * })
   * console.log(`Uploaded recording ID: ${started.id}`)
   * ```
   */
  async startTranscription(
    file: AudioInput,
    meta: InitMetaFile,
    options: OperationOptions = {}
  ): Promise<FinalizeUploadResponse> {
    if (!(file instanceof Uint8Array) && meta.totalSize === undefined) {
      this.throwIfAborted(options.signal)
      const chunks: Uint8Array[] = []
      let totalLength = 0
      for await (const chunk of this.readChunks(file, this.clientOptions.chunkSize, options.signal)) {
        chunks.push(chunk)
        totalLength += chunk.byteLength
      }
      const buffer = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.byteLength
      }
      return this.startTranscription(buffer, { ...meta, totalSize: buffer.length }, options)
    }

    const totalSize = file instanceof Uint8Array ? file.byteLength : meta.totalSize!
    if (totalSize <= 0) throw new WhisperUploadError("Cannot upload an empty audio file")

    const context: UploadContext = {
      diagnosticId: (options.diagnosticId ?? this.createDiagnosticId()).slice(0, MAX_DIAGNOSTIC_STRING_LENGTH),
      diagnostics: options.diagnostics ?? this.clientOptions.diagnostics,
      signal: options.signal,
      onProgress: options.onProgress
    }
    const mimeType = meta.mimeType ?? "application/octet-stream"

    this.throwIfAborted(context.signal)
    this.sendDiagnostic(context, {
      phase: "file-selected",
      fileName: meta.filename,
      fileSize: totalSize,
      fileType: mimeType
    })
    this.sendDiagnostic(context, { phase: "init-requested" })

    let signed: SignedUploadResponse
    try {
      signed = await this.recall(
        () =>
          this.post<SignedUploadResponse>(
            this.signUploadLink,
            this.buildUploadMetadata(meta, totalSize, mimeType),
            { "X-Diagnostic-Id": context.diagnosticId },
            context.signal
          ),
        context.signal
      )
    } catch (error) {
      this.throwIfAborted(context.signal)
      const details = this.extractErrorDetails(error)
      this.sendDiagnostic(context, {
        phase: "init-failed",
        ...details
      })
      this.sendDiagnostic(context, {
        phase: "upload-given-up",
        ...details
      })
      throw this.withDiagnosticId(error, context.diagnosticId)
    }

    let sessionUrl: string
    try {
      sessionUrl = await this.startResumableSession(signed, context.signal)
      this.sendDiagnostic(context, { phase: "init-succeeded", recordingId: signed.recordingId })
    } catch (error) {
      await this.abandonUpload(signed.recordingId, "session-open-failed", context)
      const details = this.extractErrorDetails(error)
      this.sendDiagnostic(context, {
        phase: "init-failed",
        recordingId: signed.recordingId,
        ...details
      })
      this.sendDiagnostic(context, {
        phase: "upload-given-up",
        recordingId: signed.recordingId,
        ...details
      })
      this.throwIfAborted(context.signal)
      throw new WhisperUploadError("Failed to start resumable upload session", context.diagnosticId, error)
    }

    try {
      await this.uploadToGcs(file, totalSize, sessionUrl, signed.recordingId, context)
    } catch (error) {
      this.throwIfAborted(context.signal)
      if (error instanceof WhisperUploadError && error.diagnosticId) {
        throw error
      }
      await this.abandonUpload(signed.recordingId, "put-non-retriable", context)
      const details = this.extractErrorDetails(error)
      this.sendDiagnostic(context, {
        phase: "upload-given-up",
        recordingId: signed.recordingId,
        ...details
      })
      throw this.withDiagnosticId(error, context.diagnosticId)
    }
    this.sendDiagnostic(context, { phase: "chunk-finalize-attempted", recordingId: signed.recordingId })

    try {
      const result = await this.recall(
        () =>
          this.post<FinalizeUploadResponse>(
            this.completeUploadLink(signed.recordingId),
            {},
            { "X-Diagnostic-Id": context.diagnosticId },
            context.signal
          ),
        context.signal
      )
      this.sendDiagnostic(context, { phase: "chunk-finalize-succeeded", recordingId: signed.recordingId })
      this.sendDiagnostic(context, { phase: "upload-complete", recordingId: signed.recordingId })
      return result
    } catch (error) {
      this.throwIfAborted(context.signal)
      const details = this.extractErrorDetails(error)
      this.sendDiagnostic(context, {
        phase: "chunk-finalize-failed",
        recordingId: signed.recordingId,
        ...details
      })
      this.sendDiagnostic(context, {
        phase: "upload-given-up",
        recordingId: signed.recordingId,
        ...details
      })
      throw this.withDiagnosticId(error, context.diagnosticId)
    }
  }

  /**
   * Performs complete end-to-end transcription:
   * uploads the audio file to GCS, polls WhisperAI for processing completion,
   * and returns the final completed recording with transcription text.
   *
   * @param file Audio data as `Uint8Array` or `ReadableStream<Uint8Array>`.
   * @param meta Metadata describing the audio file (duration, filename, language, etc.).
   * @param options Transcribe options (poll interval, timeout, signal, progress callback).
   * @returns The completed recording containing `transcription.content`.
   * @throws {@link WhisperTimeoutError} If processing exceeds `timeoutMs` (default 30 min).
   * @throws {@link WhisperTranscriptionError} If transcription fails or is canceled.
   * @throws {@link WhisperUploadError} If audio upload fails.
   *
   * @example
   * ```ts
   * const recording = await client.transcribe(audio, {
   *   filename: "lecture.mp3",
   *   durationSeconds: 1800,
   *   language: "en",
   *   enableSpeakerDetection: true
   * }, {
   *   onProgress: (p) => console.log(`Upload progress: ${p}%`),
   *   timeoutMs: 20 * 60 * 1000
   * })
   * console.log(recording.transcription.content)
   * ```
   */
  async transcribe(
    file: AudioInput,
    meta: InitMetaFile,
    options: TranscribeOptions = {}
  ): Promise<CompletedRecordingResponse> {
    const started = await this.startTranscription(file, meta, options)
    return this.waitForTranscription(started.id, options)
  }

  /**
   * Requests transcription processing for an existing uploaded recording.
   * Normally not needed for new uploads as `startTranscription` automatically triggers processing.
   * Useful for retrying or re-processing previously uploaded recordings.
   *
   * @param recordingId The ID of the recording to transcribe.
   * @param signal Optional AbortSignal.
   * @returns Queued transcription response.
   */
  requestTranscription(recordingId: number, signal?: AbortSignal) {
    return this.recall(() => this.post<TranscriptionResponse>(this.transcriptionLink, { recordingId }, {}, signal), signal)
  }

  /**
   * Queries processing statuses for one or more recording IDs.
   *
   * @param recordingIds Array of recording IDs to query.
   * @param signal Optional AbortSignal.
   * @returns Array of status objects containing `recordingId` and `recordingStatus`.
   */
  recordingStatus(recordingIds: number[], signal?: AbortSignal) {
    if (recordingIds.length === 0) return Promise.resolve([] as RecordingStatusResponse[])
    const params = new URLSearchParams({ ids: recordingIds.join(",") })
    return this.recall(() => this.get<RecordingStatusResponse[]>(`${this.recordingStatusLink}?${params}`, signal), signal)
  }

  /**
   * Polls WhisperAI periodically until the recording finishes processing or fails.
   *
   * @param recordingId The ID of the recording to wait for.
   * @param options Polling configuration (`pollIntervalMs`, `timeoutMs`, `signal`).
   * @returns The completed recording with transcription content.
   * @throws {@link WhisperTimeoutError} If polling exceeds `timeoutMs`.
   * @throws {@link WhisperTranscriptionError} If the recording fails or is canceled.
   */
  async waitForTranscription(
    recordingId: number,
    options: Pick<TranscribeOptions, "pollIntervalMs" | "timeoutMs" | "signal"> = {}
  ): Promise<CompletedRecordingResponse> {
    const pollIntervalMs = options.pollIntervalMs ?? this.clientOptions.pollIntervalMs
    const timeoutMs = options.timeoutMs ?? this.clientOptions.transcriptionTimeoutMs

    if (timeoutMs <= 0) throw new WhisperTimeoutError(recordingId, timeoutMs)

    const safeTimeout = Math.min(timeoutMs, 2_147_483_647)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => {
      timeoutController.abort(new WhisperTimeoutError(recordingId, timeoutMs))
    }, safeTimeout)

    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal

    try {
      while (true) {
        this.throwIfAborted(options.signal)
        if (timeoutController.signal.aborted) throw new WhisperTimeoutError(recordingId, timeoutMs)

        const statuses = await this.recordingStatus([recordingId], combinedSignal)
        const status = statuses.find((item) => item.recordingId === recordingId)?.recordingStatus

        if (status === WhisperStatus.COMPLETED) {
          const recording = await this.recording(recordingId, combinedSignal)
          if (!recording.transcription)
            throw new WhisperTranscriptionError(recordingId, "completed_without_transcription")
          return recording as CompletedRecordingResponse
        }

        if (status === WhisperStatus.FAILED || status === WhisperStatus.CANCELLED || status === "canceled") {
          throw new WhisperTranscriptionError(recordingId, status)
        }

        if (timeoutController.signal.aborted) throw new WhisperTimeoutError(recordingId, timeoutMs)
        await this.sleep(pollIntervalMs, combinedSignal)
      }
    } catch (error) {
      this.throwIfAborted(options.signal)
      if (timeoutController.signal.aborted) throw new WhisperTimeoutError(recordingId, timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Translates a transcription into a target language.
   *
   * @param recordingId The ID of the recording whose transcription to translate.
   * @param language ISO language code (e.g. "es", "fr", "de", "ru").
   * @returns Translated text content.
   */
  translate(recordingId: number, language: string) {
    return this.recall(() =>
      this.post<TranslateResponse>(this.translateLink(recordingId), { targetLanguage: language })
    )
  }

  /**
   * Retrieves a recording by ID, including metadata and transcription if available.
   *
   * @param recordingId The recording ID to fetch.
   * @param signal Optional AbortSignal.
   * @returns Recording details.
   */
  recording(recordingId: number, signal?: AbortSignal) {
    return this.recall(() => this.get<RecordingResponse>(this.recordingLink(recordingId), signal), signal)
  }

  /**
   * Retrieves a paginated list of recordings.
   *
   * @param query Optional filtering and pagination parameters.
   * @returns Paginated recordings response.
   */
  recordings(query: RecordingsQuery = {}) {
    const params = new URLSearchParams()
    params.set("limit", String(query.limit ?? 20))
    if (query.page !== undefined) params.set("page", String(query.page))
    if (query.cursor) params.set("cursor", query.cursor)
    if (query.direction) params.set("direction", query.direction)
    if (query.search) params.set("q", query.search)
    if (query.status) params.set("status", query.status)
    if (query.sort) params.set("sort", query.sort)
    return this.recall(() => this.get<RecordingsResponse>(`${this.recordingsLink}?${params}`))
  }

  /**
   * Retrieves summary analytics for the user's account, including total minutes and streak.
   */
  summary() {
    return this.recall(() => this.get<SummaryResponse>(this.summaryLink))
  }

  private buildUploadMetadata(meta: InitMetaFile, totalSize: number, mimeType: string) {
    const title = meta.title ?? meta.filename.replace(/\.[^.]+$/, "")
    return {
      filename: meta.filename,
      mimeType,
      totalSize,
      title,
      language: meta.language ?? "auto",
      enableSpeakerDetection: meta.enableSpeakerDetection ?? false,
      speakerCount: meta.speakerCount ?? "auto",
      durationSeconds: meta.durationSeconds,
      transcriptionStyle: meta.transcriptionStyle ?? "standard",
      importantTerms: meta.importantTerms ?? "",
      customPrompt: meta.customPrompt ?? "",
      speakerIdentificationEnabled: meta.speakerIdentificationEnabled ?? false,
      speakerIdentificationMode: meta.speakerIdentificationMode ?? "role",
      speakerIdentificationValues: meta.speakerIdentificationValues ?? [],
      ...(meta.folderId === undefined ? {} : { folderId: meta.folderId })
    }
  }

  private createRequestSignal(signal?: AbortSignal | null) {
    const timeoutSignal = AbortSignal.timeout(this.clientOptions.requestTimeoutMs)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }

  private async startResumableSession(signed: SignedUploadResponse, signal?: AbortSignal) {
    const requestSignal = this.createRequestSignal(signal)
    let response: Response
    try {
      response = await fetch(signed.signedResumableInitUrl, {
        method: "POST",
        headers: signed.requiredHeaders,
        body: "",
        signal: requestSignal,
        redirect: "manual"
      })
    } catch (cause) {
      this.throwIfAborted(signal)
      throw new WhisperNetworkError(cause)
    }
    if (response.status !== 201) {
      const data = await this.responseData(response).catch(() => undefined)
      throw new WhisperApiError(response.status, data ?? `GCS session initialization failed (${response.status})`)
    }
    const location = response.headers.get("location")
    if (!location) throw new WhisperUploadError("GCS session response did not include a Location header")
    return location
  }

  private async uploadToGcs(
    input: AudioInput,
    totalSize: number,
    sessionUrl: string,
    recordingId: number,
    context: UploadContext
  ) {
    let offset = 0
    let chunkIndex = 0
    context.onProgress?.(0)

    let uploadComplete = false
    for await (const chunk of this.readChunks(input, this.clientOptions.chunkSize, context.signal)) {
      const chunkStart = offset
      const expectedEnd = chunkStart + chunk.byteLength
      if (expectedEnd > totalSize)
        throw new WhisperUploadError("Audio stream exceeded declared totalSize", context.diagnosticId)

      while (offset < expectedEnd) {
        if (offset < chunkStart) {
          throw new WhisperUploadError(
            "GCS requested data that is no longer available in the stream",
            context.diagnosticId
          )
        }
        const slice = chunk.subarray(offset - chunkStart)
        const result = await this.uploadRangeWithRetry(
          sessionUrl,
          slice,
          offset,
          totalSize,
          recordingId,
          chunkIndex,
          context
        )
        offset = result.nextOffset
        context.onProgress?.(Math.min(100, Math.round((offset / totalSize) * 100)))
        if (result.complete) {
          uploadComplete = true
          break
        }
      }
      chunkIndex++
      if (uploadComplete) break
    }

    if (offset !== totalSize) {
      throw new WhisperUploadError(
        `Audio stream size mismatch: expected ${totalSize}, uploaded ${offset}`,
        context.diagnosticId
      )
    }
  }

  private async uploadRangeWithRetry(
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    totalSize: number,
    recordingId: number,
    chunkIndex: number,
    context: UploadContext
  ): Promise<RangeResult> {
    let currentOffset = offset
    let currentChunk = chunk
    let lastError: unknown

    for (let attempt = 1; attempt <= this.clientOptions.maxUploadAttempts; attempt++) {
      this.throwIfAborted(context.signal)
      this.sendDiagnostic(context, { phase: "chunk-fetch-sent", recordingId, chunkIndex, attempt })
      try {
        const result = await this.putRange(sessionUrl, currentChunk, currentOffset, totalSize, context.signal)
        this.sendDiagnostic(context, {
          phase: "chunk-fetch-status",
          recordingId,
          chunkIndex,
          attempt,
          httpStatus: result.status
        })
        return result
      } catch (error) {
        this.throwIfAborted(context.signal)
        lastError = error
        const details = this.extractErrorDetails(error)
        this.sendDiagnostic(context, {
          phase: "chunk-fetch-error",
          recordingId,
          chunkIndex,
          attempt,
          ...details
        })
        if (attempt >= this.clientOptions.maxUploadAttempts || !this.isRetryable(error)) break
        await this.sleep(this.retryDelay(attempt), context.signal)
        try {
          const probe = await this.probeUpload(sessionUrl, totalSize, context.signal)
          if (probe.complete) return probe
          if (probe.nextOffset < offset || probe.nextOffset > offset + chunk.byteLength) {
            throw new WhisperUploadError(`Unexpected GCS resume offset ${probe.nextOffset}`)
          }
          if (probe.nextOffset === offset + chunk.byteLength) return probe
          currentOffset = probe.nextOffset
          currentChunk = chunk.subarray(currentOffset - offset)
        } catch (probeError) {
          this.throwIfAborted(context.signal)
          if (!this.isRetryable(probeError)) throw probeError
        }
      }
    }

    this.throwIfAborted(context.signal)
    const reason = !this.isRetryable(lastError) ? "put-non-retriable" : "put-retries-exhausted"
    await this.abandonUpload(recordingId, reason, context)
    const details = this.extractErrorDetails(lastError)
    this.sendDiagnostic(context, {
      phase: "upload-given-up",
      recordingId,
      chunkIndex,
      ...details
    })
    this.sendDiagnostic(context, {
      phase: "worker-fatal",
      recordingId,
      chunkIndex,
      ...details
    })
    throw new WhisperUploadError(
      "GCS resumable upload failed after all retry attempts",
      context.diagnosticId,
      lastError
    )
  }

  private async putRange(
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    totalSize: number,
    signal?: AbortSignal
  ): Promise<RangeResult> {
    const end = offset + chunk.byteLength
    const requestSignal = this.createRequestSignal(signal)
    let response: Response
    let data: unknown
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${totalSize}` },
        body: this.toArrayBuffer(chunk),
        signal: requestSignal,
        redirect: "manual"
      })
      if (response.status !== 200 && response.status !== 201 && response.status !== 308) {
        data = await this.responseData(response)
      }
    } catch (cause) {
      this.throwIfAborted(signal)
      throw new WhisperNetworkError(cause)
    }

    if (response.status === 200 || response.status === 201) {
      return { complete: true, nextOffset: totalSize, status: response.status }
    }
    if (response.status === 308) {
      return { complete: false, nextOffset: this.nextOffset(response.headers.get("range"), end), status: 308 }
    }
    throw new WhisperApiError(response.status, data)
  }

  private async probeUpload(sessionUrl: string, totalSize: number, signal?: AbortSignal): Promise<RangeResult> {
    const requestSignal = this.createRequestSignal(signal)
    let response: Response
    let data: unknown
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${totalSize}` },
        body: "",
        signal: requestSignal,
        redirect: "manual"
      })
      if (response.status !== 200 && response.status !== 201 && response.status !== 308) {
        data = await this.responseData(response)
      }
    } catch (cause) {
      this.throwIfAborted(signal)
      throw new WhisperNetworkError(cause)
    }
    if (response.status === 200 || response.status === 201) {
      return { complete: true, nextOffset: totalSize, status: response.status }
    }
    if (response.status === 308) {
      return { complete: false, nextOffset: this.nextOffset(response.headers.get("range"), 0), status: 308 }
    }
    throw new WhisperApiError(response.status, data)
  }

  private async *readChunks(
    input: AudioInput,
    chunkSize: number,
    signal?: AbortSignal
  ): AsyncGenerator<Uint8Array> {
    this.throwIfAborted(signal)
    if (input instanceof Uint8Array) {
      for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
        this.throwIfAborted(signal)
        yield input.subarray(offset, Math.min(offset + chunkSize, input.byteLength))
      }
      return
    }

    const reader = input.getReader()
    let buffer = new Uint8Array(0)
    try {
      while (true) {
        this.throwIfAborted(signal)
        const { done, value } = await this.readWithSignal(reader, signal)
        if (done) break
        if (!(value instanceof Uint8Array)) throw new TypeError("Audio stream chunks must be Uint8Array values")
        const merged = new Uint8Array(buffer.byteLength + value.byteLength)
        merged.set(buffer)
        merged.set(value, buffer.byteLength)
        buffer = merged
        while (buffer.byteLength >= chunkSize) {
          this.throwIfAborted(signal)
          yield buffer.slice(0, chunkSize)
          buffer = buffer.slice(chunkSize)
        }
      }
      if (buffer.byteLength > 0) {
        this.throwIfAborted(signal)
        yield buffer
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async readWithSignal<T>(
    reader: ReadableStreamDefaultReader<T>,
    signal?: AbortSignal
  ): Promise<{ done: boolean; value?: T }> {
    if (signal?.aborted) {
      await reader.cancel(signal.reason).catch(() => {})
      throw signal.reason ?? new DOMException("Aborted", "AbortError")
    }
    if (!signal) return reader.read()

    return new Promise<{ done: boolean; value?: T }>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        void reader.cancel(signal.reason).catch(() => {})
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener("abort", onAbort, { once: true })

      reader.read().then(
        (result) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          resolve(result)
        },
        (error) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          reject(error)
        }
      )
    })
  }

  private async recall<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.cookies) await this.login(signal)
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof WhisperAuthError)) throw error
      await this.login(signal)
      return call()
    }
  }

  private get<T>(url: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, { method: "GET", signal })
  }

  private post<T>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    return this.request<T>(url, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      extraHeaders: { "Content-Type": "application/json", ...headers }
    })
  }

  private async request<T>(url: string, init: RequestInit & { extraHeaders?: Record<string, string> }): Promise<T> {
    const { extraHeaders, ...fetchInit } = init
    const cookieHeader = this.cookies?.join("; ")
    const requestSignal = this.createRequestSignal(init.signal)
    let response: Response
    let data: unknown

    try {
      response = await fetch(url, {
        ...fetchInit,
        signal: requestSignal,
        headers: {
          "cache-control": "no-cache",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...extraHeaders
        }
      })
      if (response.status === 204) {
        data = undefined
      } else {
        data = await this.responseData(response)
      }
    } catch (cause) {
      this.throwIfAborted(init.signal)
      throw new WhisperNetworkError(cause)
    }

    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length > 0) this.mergeCookies(setCookies)

    if (!response.ok) {
      if (response.status === 401) throw new WhisperAuthError()
      throw new WhisperApiError(response.status, data)
    }

    return data as T
  }

  private async responseData(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  private async abandonUpload(recordingId: number, reason: string, context: UploadContext) {
    try {
      await this.post(
        this.abandonUploadLink(recordingId),
        { reason },
        { "X-Diagnostic-Id": context.diagnosticId }
      )
    } catch {
      // Best-effort notification; ignore failures
    }
  }

  private sendDiagnostic(context: UploadContext, event: Omit<DiagnosticEvent, "diagId" | "timestamp">) {
    if (!context.diagnostics) return
    const payload: DiagnosticEvent = {
      diagId: context.diagnosticId,
      ...event,
      timestamp: new Date().toISOString()
    }
    for (const key of ["diagId", "errorName", "errorMessage", "fileName", "fileType"] as const) {
      const value = payload[key]
      if (typeof value === "string") {
        payload[key] = value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)
      }
    }
    void this.request<void>(this.diagnosticsLink, {
      method: "POST",
      body: JSON.stringify({ events: [payload] }),
      extraHeaders: { "Content-Type": "application/json" }
    }).catch(() => undefined)
  }

  private isRetryable(error: unknown) {
    if (error instanceof WhisperNetworkError) return true
    return error instanceof WhisperApiError && (error.status === 408 || error.status === 429 || error.status >= 500)
  }

  private retryDelay(attempt: number) {
    const base = Math.min(
      this.clientOptions.maxRetryDelayMs,
      this.clientOptions.initialRetryDelayMs * 2 ** (attempt - 1)
    )
    return base + Math.random() * base * 0.25
  }

  private sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      const onAbort = () => {
        clearTimeout(timeout)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private throwIfAborted(signal?: AbortSignal | null) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
  }

  private raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener("abort", onAbort, { once: true })

      promise.then(
        (value) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          reject(error)
        }
      )
    })
  }

  private extractErrorDetails(error: unknown) {
    return {
      httpStatus: error instanceof WhisperApiError ? error.status : undefined,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: this.errorMessage(error)
    }
  }

  private nextOffset(range: string | null, fallback: number) {
    const match = range?.match(/bytes=0-(\d+)/i)
    return match ? Number(match[1]) + 1 : fallback
  }

  private toArrayBuffer(bytes: Uint8Array) {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return buffer
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error ?? "")
  }

  private withDiagnosticId(error: unknown, diagnosticId: string) {
    if (error instanceof WhisperError) {
      error.diagnosticId = diagnosticId
      return error
    }
    return new WhisperUploadError(this.errorMessage(error), diagnosticId, error)
  }

  private createDiagnosticId() {
    return (
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    )
      .replace(/-/g, "")
      .slice(0, 8)
  }

  private get loginLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/auth/login`
  }
  private get userLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/auth/user`
  }
  private get usageLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/account/usage`
  }
  private get subscriptionDetailsLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/payment/subscription-details`
  }
  private get signUploadLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/uploads/sign`
  }
  private completeUploadLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/uploads/${recordingId}/complete`
  }
  private abandonUploadLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/uploads/${recordingId}/abandon`
  }
  private get diagnosticsLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/diagnostics/upload-breadcrumb`
  }
  private get transcriptionLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/transcription`
  }
  private get recordingStatusLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/status`
  }
  private get summaryLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/analytics/summary`
  }
  private get recordingsLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/paginated`
  }
  private translateLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/v2/translation/${recordingId}/translate`
  }
  private recordingLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/${recordingId}`
  }

  private mergeCookies(incoming: string[]) {
    const map = new Map<string, string>()
    for (const cookie of [...(this.cookies ?? []), ...incoming]) {
      const pair = cookie.split(";")[0]?.trim()
      if (!pair) continue
      const name = pair.split("=")[0].trim()
      map.set(name, pair)
    }
    this.cookies = [...map.values()]
  }
}
