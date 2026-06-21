import { afterEach, describe, expect, it } from "bun:test"
import {
  WhisperClient,
  WhisperTimeoutError,
  WhisperTranscriptionError,
  WhisperUploadError
} from "../src/index.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  })
}

function loginResponse() {
  return json({ id: 1 }, { headers: { "set-cookie": "connect.sid=test-session; Path=/; HttpOnly" } })
}

function signedResponse(totalSize: number) {
  return {
    recordingId: 570729,
    objectPath: "direct/audio/test.m4a",
    signedResumableInitUrl: "https://storage.test/init",
    requiredHeaders: { "x-goog-resumable": "start", "content-type": "audio/x-m4a" },
    ttlSec: 900,
    totalSize
  }
}

function finalized(status = "processing") {
  return {
    id: 570729,
    userId: 1,
    title: "audio",
    originalFilename: "audio.m4a",
    fileExtension: ".m4a",
    mimeType: "audio/x-m4a",
    audioUrl: "direct/audio/test.m4a",
    duration: 2,
    language: "multi-auto",
    status,
    speakerDetectionEnabled: false,
    speakerCount: null,
    totalChunks: null,
    metadata: null,
    idempotencyKey: null,
    uploadSessionId: "session",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    transcription: null
  }
}

function client(overrides: Record<string, unknown> = {}) {
  return new WhisperClient({
    login: { email: "test@example.com", password: "secret" },
    whisperUrl: "https://whisper.test",
    chunkSize: 4,
    initialRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    diagnostics: false,
    ...overrides
  })
}

describe("WhisperClient v2 upload", () => {
  it("signs, uploads ranges, and completes with the current v2 payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/api/v2/recordings/uploads/sign")) return json(signedResponse(6))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        const range = new Headers(init?.headers).get("content-range")
        if (range === "bytes 0-3/6") return new Response(null, { status: 308, headers: { range: "bytes=0-3" } })
        if (range === "bytes 4-5/6") return new Response(null, { status: 201 })
      }
      if (url.endsWith("/api/v2/recordings/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${init?.method} ${url}`)
    }) as typeof fetch

    const progress: number[] = []
    const result = await client().startTranscription(new Uint8Array([1, 2, 3, 4, 5, 6]), {
      filename: "audio.m4a",
      mimeType: "audio/x-m4a",
      durationSeconds: 1.5
    }, { onProgress: value => progress.push(value), diagnosticId: "bc0d4284" })

    expect(result.id).toBe(570729)
    expect(progress).toEqual([0, 67, 100])
    const sign = calls.find(call => call.url.endsWith("/uploads/sign"))!
    expect(new Headers(sign.init?.headers).get("x-diagnostic-id")).toBe("bc0d4284")
    expect(JSON.parse(String(sign.init?.body))).toEqual({
      filename: "audio.m4a",
      mimeType: "audio/x-m4a",
      totalSize: 6,
      title: "audio",
      language: "multi-auto",
      enableSpeakerDetection: false,
      speakerCount: "auto",
      durationSeconds: 1.5,
      transcriptionStyle: "clean_readable",
      importantTerms: "",
      customPrompt: "",
      speakerIdentificationEnabled: false,
      speakerIdentificationMode: "role",
      speakerIdentificationValues: []
    })
    expect(calls.filter(call => call.url === "https://storage.test/session")).toHaveLength(2)
  })

  it("probes the committed offset and resumes after a retryable failure", async () => {
    const ranges: string[] = []
    let uploadAttempts = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        const range = new Headers(init?.headers).get("content-range")!
        ranges.push(range)
        if (range === "bytes */4") return new Response(null, { status: 308, headers: { range: "bytes=0-1" } })
        uploadAttempts++
        if (uploadAttempts === 1) return new Response("temporary", { status: 500 })
        expect(range).toBe("bytes 2-3/4")
        return new Response(null, { status: 201 })
      }
      if (url.endsWith("/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await client().startTranscription(new Uint8Array([1, 2, 3, 4]), {
      filename: "audio.m4a",
      durationSeconds: 1,
      mimeType: "audio/x-m4a"
    })
    expect(ranges).toEqual(["bytes 0-3/4", "bytes */4", "bytes 2-3/4"])
  })

  it("does not resend a range when the probe shows the whole chunk was committed", async () => {
    const ranges: string[] = []
    let firstChunkAttempted = false
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(6))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        const range = new Headers(init?.headers).get("content-range")!
        ranges.push(range)
        if (range === "bytes 0-3/6" && !firstChunkAttempted) {
          firstChunkAttempted = true
          throw new TypeError("connection reset after commit")
        }
        if (range === "bytes */6") return new Response(null, { status: 308, headers: { range: "bytes=0-3" } })
        if (range === "bytes 4-5/6") return new Response(null, { status: 201 })
      }
      if (url.endsWith("/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await client().startTranscription(new Uint8Array([1, 2, 3, 4, 5, 6]), {
      filename: "audio.m4a",
      durationSeconds: 1
    })
    expect(ranges).toEqual(["bytes 0-3/6", "bytes */6", "bytes 4-5/6"])
  })

  it("buffers a stream when totalSize is omitted", async () => {
    let signedSize = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) {
        signedSize = JSON.parse(String(init?.body)).totalSize
        return json(signedResponse(signedSize))
      }
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") return new Response(null, { status: 201 })
      if (url.endsWith("/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      }
    })
    await client({ chunkSize: 8 }).startTranscription(stream, { filename: "audio.wav", durationSeconds: 1 })
    expect(signedSize).toBe(3)
  })

  it("sends best-effort diagnostics and accepts their 204 response", async () => {
    let diagnosticCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/diagnostics/upload-breadcrumb")) {
        diagnosticCalls++
        return new Response(null, { status: 204 })
      }
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(1))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") return new Response(null, { status: 201 })
      if (url.endsWith("/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await client({ diagnostics: true }).startTranscription(new Uint8Array([1]), {
      filename: "audio.wav",
      durationSeconds: 1
    })
    await Bun.sleep(0)
    expect(diagnosticCalls).toBeGreaterThan(0)
  })

  it("fails after upload retries are exhausted", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(1))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") return new Response("temporary", { status: 503 })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await expect(
      client({ maxUploadAttempts: 2 }).startTranscription(new Uint8Array([1]), {
        filename: "audio.wav",
        durationSeconds: 1
      })
    ).rejects.toBeInstanceOf(WhisperUploadError)
  })

  it("honors an already aborted signal before making a request", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("fetch should not be called")
    }) as typeof fetch
    const controller = new AbortController()
    controller.abort()
    await expect(
      client().startTranscription(
        new Uint8Array([1]),
        { filename: "audio.wav", durationSeconds: 1 },
        { signal: controller.signal }
      )
    ).rejects.toHaveProperty("name", "AbortError")
    expect(calls).toBe(0)
  })
})

describe("WhisperClient transcription polling", () => {
  it("waits for completion and returns a non-null transcription", async () => {
    let statusCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.includes("/api/v2/recordings/status")) {
        statusCalls++
        return json([{ recordingId: 570729, recordingStatus: statusCalls === 1 ? "processing" : "completed" }])
      }
      if (url.endsWith("/api/v2/recordings/570729")) {
        return json({ ...finalized("completed"), transcription: { id: 10, recordingId: 570729, content: "done" } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const result = await client({ pollIntervalMs: 0 }).waitForTranscription(570729)
    expect(result.transcription.content).toBe("done")
    expect(statusCalls).toBe(2)
  })

  it("times out while processing", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.includes("/recordings/status")) {
        return json([{ recordingId: 570729, recordingStatus: "processing" }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await expect(client().waitForTranscription(570729, { pollIntervalMs: 0, timeoutMs: 0 })).rejects.toBeInstanceOf(
      WhisperTimeoutError
    )
  })

  it("throws a typed error for terminal failure", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.includes("/recordings/status")) {
        return json([{ recordingId: 570729, recordingStatus: "failed" }])
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await expect(client().waitForTranscription(570729)).rejects.toBeInstanceOf(WhisperTranscriptionError)
  })
})

describe("WhisperClient v2 routes", () => {
  it("uses the current account, recording, analytics, and kickoff endpoints", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/api/v2/auth/user")) return json({ id: 1 })
      if (url.endsWith("/api/v2/account/usage")) return json({ monthlyUsageMinutes: 0 })
      if (url.endsWith("/api/v2/payment/subscription-details")) return json({ isPaidPlan: false })
      if (url.includes("/api/v2/recordings/paginated")) return json({ data: [] })
      if (url.endsWith("/api/v2/analytics/summary")) return json({ recordings: { total: 0 } })
      if (url.endsWith("/api/v2/transcription")) return json({ recordingId: 1, status: "queued" })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const api = client()
    await api.user()
    await api.usage()
    await api.subscriptionDetails()
    await api.recordings({ page: 2, limit: 10 })
    await api.summary()
    await api.requestTranscription(1)
    expect(urls).toContain("https://whisper.test/api/v2/auth/user")
    expect(urls).toContain("https://whisper.test/api/v2/account/usage")
    expect(urls).toContain("https://whisper.test/api/v2/payment/subscription-details")
    expect(urls).toContain("https://whisper.test/api/v2/analytics/summary")
    expect(urls).toContain("https://whisper.test/api/v2/transcription")
    const recordingsUrl = new URL(urls.find(url => url.includes("/api/v2/recordings/paginated"))!)
    expect(recordingsUrl.searchParams.get("page")).toBe("2")
    expect(recordingsUrl.searchParams.get("limit")).toBe("10")
  })
})
