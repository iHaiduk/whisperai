import type {
  ClientOptions,
  FinalizeChunkResponse,
  InitChunkResponse,
  InitMetaFile,
  RecordingResponse,
  RecordingsQuery,
  RecordingsResponse,
  SummaryResponse,
  SubscriptionDetailsResponse,
  TranscriptionResponse,
  TranslateResponse,
  UploadChunkResponse,
  UsageInfo,
  UserInfo
} from "./types.js"
import { WhisperApiError, WhisperAuthError, WhisperNetworkError } from "./errors.js"

export class WhisperClient {
  private cookies?: string[]
  private readonly clientOptions: Required<ClientOptions>

  constructor(clientOptions: ClientOptions) {
    this.clientOptions = {
      whisperUrl: "https://whisperai.com",
      chunkSize: 8 * 1024 * 1024,
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

  async upload(file: Uint8Array | ReadableStream<Uint8Array>, meta: InitMetaFile): Promise<FinalizeChunkResponse> {
    if (file instanceof Uint8Array) {
      const totalChunks = this.getCountChunks(file.length)
      const { recordingId } = await this.recall(() => this.initChunkRequest(file.length, totalChunks, meta))
      await Promise.all(Array.from({ length: totalChunks }, (_, i) => this.uploadChunkSlice(file, recordingId, i)))
      return this.finalizeChunk(recordingId)
    }

    // ReadableStream: stream chunk-by-chunk without loading the full file into memory.
    // Requires meta.totalSize to compute totalChunks for the init request.
    // Falls back to buffering if totalSize is not provided.
    if (meta.totalSize === undefined) {
      const buffer = new Uint8Array(await new Response(file).arrayBuffer())
      return this.upload(buffer, { ...meta, totalSize: buffer.length })
    }

    const totalChunks = this.getCountChunks(meta.totalSize)
    const { recordingId } = await this.recall(() => this.initChunkRequest(meta.totalSize!, totalChunks, meta))
    await this.uploadFromStream(file, recordingId)
    return this.finalizeChunk(recordingId)
  }

  initChunk(fileBuffer: Uint8Array, meta: InitMetaFile) {
    const totalChunks = this.getCountChunks(fileBuffer.length)
    return this.recall(() => this.initChunkRequest(fileBuffer.length, totalChunks, meta))
  }

  uploadChunk(chunk: Uint8Array, recordingId: number, chunkIndex: number) {
    return this.recall(() => this.uploadChunkRequest(chunk, recordingId, chunkIndex))
  }

  finalizeChunk(recordingId: number) {
    return this.recall(() => this.post<FinalizeChunkResponse>(this.finalizeChunkLink, { recordingId }))
  }

  transcription(recordingId: number) {
    return this.recall(() => this.post<TranscriptionResponse>(this.transcriptionLink, { recordingId }))
  }

  translate(recordingId: number, language: string) {
    return this.recall(() =>
      this.post<TranslateResponse>(this.translateLink(recordingId), { targetLanguage: language })
    )
  }

  recording(recordingId: number) {
    return this.recall(() => this.get<RecordingResponse>(this.recordingLink(recordingId)))
  }

  recordings(query?: RecordingsQuery) {
    const params = new URLSearchParams({
      page: String(query?.page ?? 1),
      limit: String(query?.limit ?? 5)
    })
    return this.recall(() => this.get<RecordingsResponse>(`${this.recordingsLink}?${params}`))
  }

  summary() {
    return this.recall(() => this.get<SummaryResponse>(this.summaryLink))
  }

  private async uploadFromStream(stream: ReadableStream<Uint8Array>, recordingId: number) {
    const reader = stream.getReader()
    let buffer = new Uint8Array(0)
    let chunkIndex = 0

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          if (buffer.length > 0) {
            await this.uploadChunk(buffer, recordingId, chunkIndex)
          }
          break
        }

        const merged = new Uint8Array(buffer.length + value.length)
        merged.set(buffer)
        merged.set(value, buffer.length)
        buffer = merged

        while (buffer.length >= this.clientOptions.chunkSize) {
          await this.uploadChunk(buffer.subarray(0, this.clientOptions.chunkSize), recordingId, chunkIndex)
          buffer = buffer.slice(this.clientOptions.chunkSize)
          chunkIndex++
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private uploadChunkSlice(fileBuffer: Uint8Array, recordingId: number, chunkIndex: number) {
    const start = chunkIndex * this.clientOptions.chunkSize
    const end = Math.min(start + this.clientOptions.chunkSize, fileBuffer.length)
    return this.uploadChunk(fileBuffer.subarray(start, end), recordingId, chunkIndex)
  }

  private initChunkRequest(totalSize: number, totalChunks: number, meta: InitMetaFile) {
    return this.post<InitChunkResponse>(this.initChunkLink, {
      filename: meta.filename,
      durationSeconds: meta.durationSeconds,
      totalSize,
      mimeType: meta.mimeType ?? "",
      title: meta.title ?? meta.filename,
      enableSpeakerDetection: meta.enableSpeakerDetection ?? false,
      speakerCount: meta.speakerCount ?? "auto",
      language: meta.language ?? "",
      totalChunks
    })
  }

  private uploadChunkRequest(chunk: Uint8Array, recordingId: number, chunkIndex: number) {
    const buffer = new ArrayBuffer(chunk.byteLength)
    new Uint8Array(buffer).set(chunk)

    const formData = new FormData()
    formData.append("chunk", new Blob([buffer], { type: "application/octet-stream" }), `chunk_${chunkIndex}`)
    formData.append("recordingId", recordingId.toString())
    formData.append("chunkIndex", chunkIndex.toString())
    return this.postForm<UploadChunkResponse>(this.uploadChunkLink, formData)
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

  private get<T>(url: string): Promise<T> {
    return this.request<T>(url, { method: "GET" })
  }

  private post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>(url, {
      method: "POST",
      body: JSON.stringify(body),
      extraHeaders: { "Content-Type": "application/json" }
    })
  }

  private postForm<T>(url: string, body: FormData): Promise<T> {
    return this.request<T>(url, { method: "POST", body })
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
      const data = await response.json().catch(() => null)
      throw new WhisperApiError(response.status, data)
    }

    return response.json() as Promise<T>
  }

  private get loginLink() {
    return `${this.clientOptions.whisperUrl}/api/login`
  }
  private get userLink() {
    return `${this.clientOptions.whisperUrl}/api/user`
  }
  private get usageLink() {
    return `${this.clientOptions.whisperUrl}/api/usage`
  }
  private get subscriptionDetailsLink() {
    return `${this.clientOptions.whisperUrl}/api/subscription-details`
  }
  private get initChunkLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/init`
  }
  private get uploadChunkLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/upload`
  }
  private get finalizeChunkLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/finalize`
  }
  private get transcriptionLink() {
    return `${this.clientOptions.whisperUrl}/api/v2/transcription`
  }
  private get summaryLink() {
    return `${this.clientOptions.whisperUrl}/api/analytics/summary`
  }
  private get recordingsLink() {
    return `${this.clientOptions.whisperUrl}/api/recordings-paginated`
  }
  private translateLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/v2/translation/${recordingId}/translate`
  }
  private recordingLink(recordingId: number) {
    return `${this.clientOptions.whisperUrl}/api/recordings/${recordingId}`
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

  private getCountChunks(size: number) {
    return Math.ceil(size / this.clientOptions.chunkSize)
  }
}
