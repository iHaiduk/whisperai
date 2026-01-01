import axios, { AxiosRequestConfig, AxiosResponse } from "axios"

import type {
  ClientOptions,
  UserInfo,
  UsageInfo,
  InitMetaFile,
  InitChunkResponse,
  UploadChunkResponse,
  FinalizeChunkResponse,
  TranscriptionResponse,
  TranslateResponse,
  SummaryResponse,
  RecordingResponse,
  RecordingsQuery,
  RecordingsResponse,
  SubscriptionDetailsResponse
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
    return this.handleRequest<UserInfo>(axios.post(this.loginLink, this.clientOptions.login))
  }

  user() {
    return this.recall(() => axios.get<UserInfo>(this.userLink, this.requestOptions))
  }

  usage() {
    return this.recall(() => axios.get<UsageInfo>(this.usageLink, this.requestOptions))
  }

  subscriptionDetails() {
    return this.recall(() => axios.get<SubscriptionDetailsResponse>(this.subscriptionDetailsLink, this.requestOptions))
  }

  upload(fileBuffer: Uint8Array, meta: InitMetaFile) {
    const totalChunks = this.getCountChunks(fileBuffer.length)

    return this.initChunk(fileBuffer, meta).then((response) =>
      Promise.all(
        Array.from({ length: totalChunks }, (_, i) => this.uploadChunk(fileBuffer, response.recordingId, i))
      ).then(() => this.finalizeChunk(response.recordingId))
    )
  }

  initChunk(fileBuffer: Uint8Array, meta: InitMetaFile) {
    return this.recall(() =>
      axios.post<InitChunkResponse>(
        this.initChunkLink,
        {
          filename: meta.filename,
          durationSeconds: meta.durationSeconds,
          totalSize: fileBuffer.length,
          mimeType: meta.mimeType ?? "",
          title: meta.title ?? meta.filename,
          enableSpeakerDetection: meta.enableSpeakerDetection ?? false,
          speakerCount: meta.speakerCount ?? "auto",
          language: meta.language ?? "",
          totalChunks: this.getCountChunks(fileBuffer.length)
        },
        this.requestOptions
      )
    )
  }

  uploadChunk(fileBuffer: Uint8Array, recordingId: number, chunkIndex: number) {
    const start = chunkIndex * this.clientOptions.chunkSize
    const end = Math.min(start + this.clientOptions.chunkSize, fileBuffer.length)
    const chunk = fileBuffer.slice(start, end)

    const blob = new Blob([chunk], { type: "application/octet-stream" })

    const formData = new FormData()
    formData.append("chunk", blob, `chunk_${chunkIndex}`)
    formData.append("recordingId", recordingId.toString())
    formData.append("chunkIndex", chunkIndex.toString())

    return this.recall(() => axios.post<UploadChunkResponse>(this.uploadChunkLink, formData, this.requestOptions))
  }

  finalizeChunk(recordingId: number) {
    return this.recall(() =>
      axios.post<FinalizeChunkResponse>(this.finalizeChunkLink, { recordingId }, this.requestOptions)
    )
  }

  transcription(recordingId: number) {
    return this.recall(() =>
      axios.post<TranscriptionResponse>(this.transcriptionLink, { recordingId }, this.requestOptions)
    )
  }

  translate(recordingId: number, language: string) {
    return this.recall(() =>
      axios.post<TranslateResponse>(this.translateLink(recordingId), { targetLanguage: language }, this.requestOptions)
    )
  }

  recording(recordingId: number) {
    return this.recall(() => axios.get<RecordingResponse>(this.recordingLink(recordingId), this.requestOptions))
  }

  recordings(query?: RecordingsQuery) {
    return this.recall(() =>
      axios.get<RecordingsResponse>(this.recordingsLink, {
        ...this.requestOptions,
        params: { page: 1, limit: 5, ...(query ?? {}) }
      })
    )
  }

  summary() {
    return this.recall(() => axios.get<SummaryResponse>(this.summaryLink, this.requestOptions))
  }

  private get loginLink(): string {
    return `${this.clientOptions.whisperUrl}/api/login`
  }

  private get userLink(): string {
    return `${this.clientOptions.whisperUrl}/api/user`
  }

  private get usageLink(): string {
    return `${this.clientOptions.whisperUrl}/api/usage`
  }

  private get subscriptionDetailsLink(): string {
    return `${this.clientOptions.whisperUrl}/api/subscription-details`
  }

  private get initChunkLink(): string {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/init`
  }

  private get uploadChunkLink(): string {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/upload`
  }

  private get finalizeChunkLink(): string {
    return `${this.clientOptions.whisperUrl}/api/v2/recordings/chunked/finalize`
  }

  private get transcriptionLink(): string {
    return `${this.clientOptions.whisperUrl}/api/v2/transcription`
  }

  private get summaryLink(): string {
    return `${this.clientOptions.whisperUrl}/api/analytics/summary`
  }

  private translateLink(recordingId: number): string {
    return `${this.clientOptions.whisperUrl}/api/v2/translation/${recordingId}/translate`
  }

  private recordingLink(recordingId: number): string {
    return `${this.clientOptions.whisperUrl}/api/recordings/${recordingId}`
  }
  private get recordingsLink(): string {
    return `${this.clientOptions.whisperUrl}/api/recordings-paginated`
  }

  private getCountChunks(size: number) {
    return Math.ceil(size / this.clientOptions.chunkSize)
  }

  private get requestOptions(): AxiosRequestConfig {
    return {
      headers: {
        "cache-control": "no-cache",
        Cookie: this.cookies,
      }
    }
  }

  private async recall<T>(call: () => Promise<AxiosResponse<T>>): Promise<T> {
    try {
      if (typeof this.cookies !== "string") await this.login()

      return await this.handleRequest(call())
    } catch (error: any) {
      if (error.code !== "AUTH_ERROR") throw error

      await this.login()
      return this.handleRequest(call())

    }
  }

  private async handleRequest<T = any, R extends Promise<AxiosResponse<T>> = Promise<AxiosResponse<T>>>(
    request: R
  ): Promise<T> {
    try {
      const response = await request

      this.cookies = response.headers["set-cookie"];
      return response.data
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (!err.response) {
          throw new WhisperNetworkError(err)
        }

        if (err.response.status === 401 || err.response.status === 403) {
          throw new WhisperAuthError()
        }

        throw new WhisperApiError(err.response.status, err.response.data)
      }

      throw err
    }
  }
}
