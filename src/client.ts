import {
  DEFAULT_MAX_UPLOAD_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_UPLOAD_CHUNK_SIZE,
  WhisperStatus
} from "./constant.js"
import {
  WhisperApiError,
  WhisperAuthError,
  WhisperNetworkError,
  WhisperTimeoutError,
  WhisperTranscriptionError,
  WhisperUploadError
} from "./errors.js"
import type {
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

type AudioInput = Uint8Array | ReadableStream<Uint8Array>

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

export class WhisperClient {
  private cookies?: string[]
  private readonly clientOptions: ResolvedClientOptions

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
      ...clientOptions
    }
  }

  login() {
    return this.post<UserInfo>(this.loginLink, this.clientOptions.login)
  }

  user() {
    return this.recall(() => this.get<UserInfo>(this.userLink))
  }

  usage() {
    return this.recall(() => this.get<UsageInfo>(this.usageLink))
  }

  subscriptionDetails() {
    return this.recall(() => this.get<SubscriptionDetailsResponse>(this.subscriptionDetailsLink))
  }

  async startTranscription(
    file: AudioInput,
    meta: InitMetaFile,
    options: OperationOptions = {}
  ): Promise<FinalizeUploadResponse> {
    if (!(file instanceof Uint8Array) && meta.totalSize === undefined) {
      const buffer = new Uint8Array(await new Response(file).arrayBuffer())
      return this.startTranscription(buffer, { ...meta, totalSize: buffer.length }, options)
    }

    const totalSize = file instanceof Uint8Array ? file.byteLength : meta.totalSize!
    if (totalSize <= 0) throw new WhisperUploadError("Cannot upload an empty audio file")

    const context: UploadContext = {
      diagnosticId: options.diagnosticId ?? this.createDiagnosticId(),
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
      signed = await this.recall(() =>
        this.post<SignedUploadResponse>(
          this.signUploadLink,
          this.buildUploadMetadata(meta, totalSize, mimeType),
          { "X-Diagnostic-Id": context.diagnosticId },
          context.signal
        )
      )
    } catch (error) {
      this.sendDiagnostic(context, { phase: "init-failed", errorMessage: this.errorMessage(error) })
      throw this.withDiagnosticId(error, context.diagnosticId)
    }

    let sessionUrl: string
    try {
      sessionUrl = await this.startResumableSession(signed, context.signal)
      this.sendDiagnostic(context, { phase: "init-succeeded", recordingId: signed.recordingId })
    } catch (error) {
      this.sendDiagnostic(context, {
        phase: "init-failed",
        recordingId: signed.recordingId,
        errorMessage: this.errorMessage(error)
      })
      throw new WhisperUploadError("Failed to start resumable upload session", context.diagnosticId, error)
    }

    await this.uploadToGcs(file, totalSize, sessionUrl, signed.recordingId, context)
    this.sendDiagnostic(context, { phase: "chunk-finalize-attempted", recordingId: signed.recordingId })

    try {
      const result = await this.recall(() =>
        this.post<FinalizeUploadResponse>(
          this.completeUploadLink(signed.recordingId),
          {},
          { "X-Diagnostic-Id": context.diagnosticId },
          context.signal
        )
      )
      this.sendDiagnostic(context, { phase: "chunk-finalize-succeeded", recordingId: signed.recordingId })
      this.sendDiagnostic(context, { phase: "upload-complete", recordingId: signed.recordingId })
      return result
    } catch (error) {
      this.sendDiagnostic(context, {
        phase: "chunk-finalize-failed",
        recordingId: signed.recordingId,
        errorMessage: this.errorMessage(error)
      })
      throw this.withDiagnosticId(error, context.diagnosticId)
    }
  }

  async transcribe(
    file: AudioInput,
    meta: InitMetaFile,
    options: TranscribeOptions = {}
  ): Promise<CompletedRecordingResponse> {
    const started = await this.startTranscription(file, meta, options)
    return this.waitForTranscription(started.id, options)
  }

  requestTranscription(recordingId: number, signal?: AbortSignal) {
    return this.recall(() => this.post<TranscriptionResponse>(this.transcriptionLink, { recordingId }, {}, signal))
  }

  recordingStatus(recordingIds: number[], signal?: AbortSignal) {
    if (recordingIds.length === 0) return Promise.resolve([] as RecordingStatusResponse[])
    const params = new URLSearchParams({ ids: recordingIds.join(",") })
    return this.recall(() => this.get<RecordingStatusResponse[]>(`${this.recordingStatusLink}?${params}`, signal))
  }

  async waitForTranscription(
    recordingId: number,
    options: Pick<TranscribeOptions, "pollIntervalMs" | "timeoutMs" | "signal"> = {}
  ): Promise<CompletedRecordingResponse> {
    const pollIntervalMs = options.pollIntervalMs ?? this.clientOptions.pollIntervalMs
    const timeoutMs = options.timeoutMs ?? this.clientOptions.transcriptionTimeoutMs
    const startedAt = Date.now()

    while (true) {
      this.throwIfAborted(options.signal)
      const statuses = await this.recordingStatus([recordingId], options.signal)
      const status = statuses.find(item => item.recordingId === recordingId)?.recordingStatus

      if (status === WhisperStatus.COMPLETED) {
        const recording = await this.recording(recordingId, options.signal)
        if (!recording.transcription) throw new WhisperTranscriptionError(recordingId, "completed_without_transcription")
        return recording as CompletedRecordingResponse
      }

      if (status === WhisperStatus.FAILED || status === WhisperStatus.CANCELLED || status === "canceled") {
        throw new WhisperTranscriptionError(recordingId, status)
      }

      if (Date.now() - startedAt >= timeoutMs) throw new WhisperTimeoutError(recordingId, timeoutMs)
      await this.sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))), options.signal)
    }
  }

  translate(recordingId: number, language: string) {
    return this.recall(() =>
      this.post<TranslateResponse>(this.translateLink(recordingId), { targetLanguage: language })
    )
  }

  recording(recordingId: number, signal?: AbortSignal) {
    return this.recall(() => this.get<RecordingResponse>(this.recordingLink(recordingId), signal))
  }

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
      language: meta.language ?? "multi-auto",
      enableSpeakerDetection: meta.enableSpeakerDetection ?? false,
      speakerCount: meta.speakerCount ?? "auto",
      durationSeconds: meta.durationSeconds,
      transcriptionStyle: meta.transcriptionStyle ?? "clean_readable",
      importantTerms: meta.importantTerms ?? "",
      customPrompt: meta.customPrompt ?? "",
      speakerIdentificationEnabled: meta.speakerIdentificationEnabled ?? false,
      speakerIdentificationMode: meta.speakerIdentificationMode ?? "role",
      speakerIdentificationValues: meta.speakerIdentificationValues ?? [],
      ...(meta.folderId === undefined ? {} : { folderId: meta.folderId })
    }
  }

  private async startResumableSession(signed: SignedUploadResponse, signal?: AbortSignal) {
    let response: Response
    try {
      response = await fetch(signed.signedResumableInitUrl, {
        method: "POST",
        headers: signed.requiredHeaders,
        body: "",
        signal,
        redirect: "manual"
      })
    } catch (cause) {
      throw new WhisperNetworkError(cause)
    }
    if (response.status !== 201) throw new WhisperUploadError(`GCS session initialization failed (${response.status})`)
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

    for await (const chunk of this.readChunks(input, this.clientOptions.chunkSize)) {
      const chunkStart = offset
      const expectedEnd = chunkStart + chunk.byteLength
      if (expectedEnd > totalSize) throw new WhisperUploadError("Audio stream exceeded declared totalSize", context.diagnosticId)

      while (offset < expectedEnd) {
        if (offset < chunkStart) {
          throw new WhisperUploadError("GCS requested data that is no longer available in the stream", context.diagnosticId)
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
        if (result.complete) break
      }
      chunkIndex++
    }

    if (offset !== totalSize) {
      throw new WhisperUploadError(`Audio stream size mismatch: expected ${totalSize}, uploaded ${offset}`, context.diagnosticId)
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
        lastError = error
        this.sendDiagnostic(context, {
          phase: "chunk-fetch-error",
          recordingId,
          chunkIndex,
          attempt,
          errorMessage: this.errorMessage(error)
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
          if (!this.isRetryable(probeError)) throw probeError
        }
      }
    }

    this.sendDiagnostic(context, {
      phase: "upload-given-up",
      recordingId,
      chunkIndex,
      errorMessage: this.errorMessage(lastError)
    })
    throw new WhisperUploadError("GCS resumable upload failed after all retry attempts", context.diagnosticId, lastError)
  }

  private async putRange(
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    totalSize: number,
    signal?: AbortSignal
  ): Promise<RangeResult> {
    const end = offset + chunk.byteLength
    let response: Response
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${totalSize}` },
        body: this.toArrayBuffer(chunk),
        signal,
        redirect: "manual"
      })
    } catch (cause) {
      throw new WhisperNetworkError(cause)
    }

    if (response.status === 200 || response.status === 201) {
      return { complete: true, nextOffset: totalSize, status: response.status }
    }
    if (response.status === 308) {
      return { complete: false, nextOffset: this.nextOffset(response.headers.get("range"), end), status: 308 }
    }
    throw new WhisperApiError(response.status, await this.responseData(response))
  }

  private async probeUpload(sessionUrl: string, totalSize: number, signal?: AbortSignal): Promise<RangeResult> {
    let response: Response
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${totalSize}` },
        body: "",
        signal,
        redirect: "manual"
      })
    } catch (cause) {
      throw new WhisperNetworkError(cause)
    }
    if (response.status === 200 || response.status === 201) {
      return { complete: true, nextOffset: totalSize, status: response.status }
    }
    if (response.status === 308) {
      return { complete: false, nextOffset: this.nextOffset(response.headers.get("range"), 0), status: 308 }
    }
    throw new WhisperApiError(response.status, await this.responseData(response))
  }

  private async *readChunks(input: AudioInput, chunkSize: number): AsyncGenerator<Uint8Array> {
    if (input instanceof Uint8Array) {
      for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
        yield input.subarray(offset, Math.min(offset + chunkSize, input.byteLength))
      }
      return
    }

    const reader = input.getReader()
    let buffer = new Uint8Array(0)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array)) throw new TypeError("Audio stream chunks must be Uint8Array values")
        const merged = new Uint8Array(buffer.byteLength + value.byteLength)
        merged.set(buffer)
        merged.set(value, buffer.byteLength)
        buffer = merged
        while (buffer.byteLength >= chunkSize) {
          yield buffer.slice(0, chunkSize)
          buffer = buffer.slice(chunkSize)
        }
      }
      if (buffer.byteLength > 0) yield buffer
    } finally {
      reader.releaseLock()
    }
  }

  private async recall<T>(call: () => Promise<T>): Promise<T> {
    try {
      if (!this.cookies) await this.login()
      return await call()
    } catch (error) {
      if (!(error instanceof WhisperAuthError)) throw error
      await this.login()
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
    let response: Response

    try {
      response = await fetch(url, {
        ...fetchInit,
        headers: {
          "cache-control": "no-cache",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...extraHeaders
        }
      })
    } catch (cause) {
      throw new WhisperNetworkError(cause)
    }

    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length > 0) this.mergeCookies(setCookies)

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new WhisperAuthError()
      throw new WhisperApiError(response.status, await this.responseData(response))
    }

    if (response.status === 204) return undefined as T
    return (await this.responseData(response)) as T
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

  private sendDiagnostic(context: UploadContext, event: Omit<DiagnosticEvent, "diagId" | "timestamp">) {
    if (!context.diagnostics) return
    const payload: DiagnosticEvent = {
      diagId: context.diagnosticId,
      ...event,
      timestamp: new Date().toISOString()
    }
    void this.request<void>(this.diagnosticsLink, {
      method: "POST",
      body: JSON.stringify({ events: [payload] }),
      extraHeaders: { "Content-Type": "application/json" },
      signal: context.signal
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

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
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
    if (error && typeof error === "object") {
      try {
        Object.assign(error, { diagnosticId })
      } catch {
        return new WhisperUploadError(this.errorMessage(error), diagnosticId, error)
      }
      return error
    }
    return new WhisperUploadError(this.errorMessage(error), diagnosticId, error)
  }

  private createDiagnosticId() {
    return (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
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
