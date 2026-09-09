import { afterEach, describe, expect, it } from "bun:test"
import {
  DEFAULT_MAX_UPLOAD_ATTEMPTS,
  DiagnosticEvent,
  InitMetaFile,
  WhisperApiError,
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
    const payload = JSON.parse(String(sign.init?.body))
    expect(payload).toEqual({
      filename: "audio.m4a",
      mimeType: "audio/x-m4a",
      totalSize: 6,
      title: "audio",
      language: "auto",
      enableSpeakerDetection: false,
      speakerCount: "auto",
      durationSeconds: 1.5,
      transcriptionStyle: "standard",
      importantTerms: "",
      customPrompt: "",
      speakerIdentificationEnabled: false,
      speakerIdentificationMode: "role",
      speakerIdentificationValues: []
    })
    expect(payload.language).toBe("auto")
    expect(payload.transcriptionStyle).toBe("standard")
    expect(DEFAULT_MAX_UPLOAD_ATTEMPTS).toBe(8)
    expect(calls.filter(call => call.url === "https://storage.test/session")).toHaveLength(2)
  })

  it("preserves explicit language and transcriptionStyle upload settings", async () => {
    const captured: { signBody?: InitMetaFile & Record<string, unknown> } = {}
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/api/v2/recordings/uploads/sign")) {
        captured.signBody = JSON.parse(String(init?.body))
        return json(signedResponse(4))
      }
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response(null, { status: 201 })
      }
      if (url.endsWith("/api/v2/recordings/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${init?.method} ${url}`)
    }) as typeof fetch

    await client().startTranscription(new Uint8Array([1, 2, 3, 4]), {
      filename: "audio.m4a",
      mimeType: "audio/x-m4a",
      durationSeconds: 1,
      language: "multi-auto",
      transcriptionStyle: "clean_readable"
    })

    expect(captured.signBody?.language).toBe("multi-auto")
    expect(captured.signBody?.transcriptionStyle).toBe("clean_readable")
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
    const capturedEvents: DiagnosticEvent[] = []
    let diagnosticCallCount = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/diagnostics/upload-breadcrumb")) {
        diagnosticCallCount++
        const body = JSON.parse(String(init?.body))
        capturedEvents.push(...body.events)
        // Alternating 204 and 400 should not affect upload outcome
        return diagnosticCallCount % 2 === 0 ? new Response("Bad Request", { status: 400 }) : new Response(null, { status: 204 })
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

    const longFilename = "a".repeat(300) + ".wav"
    const longDiagId = "x".repeat(300)
    const longMimeType = "audio/" + "m".repeat(300)

    const result = await client({ diagnostics: true }).startTranscription(
      new Uint8Array([1]),
      {
        filename: longFilename,
        mimeType: longMimeType,
        durationSeconds: 1
      },
      { diagnosticId: longDiagId }
    )

    expect(result.id).toBe(570729)
    await Bun.sleep(10)
    expect(capturedEvents.length).toBeGreaterThan(0)
    for (const event of capturedEvents) {
      if (event.fileName) expect(event.fileName.length).toBeLessThanOrEqual(256)
      if (event.fileType) expect(event.fileType.length).toBeLessThanOrEqual(256)
      if (event.errorMessage) expect(event.errorMessage.length).toBeLessThanOrEqual(256)
      expect(event.diagId.length).toBeLessThanOrEqual(256)
      expect(event.diagId).toBe("x".repeat(256))
    }
  })

  it("sends upload-given-up and worker-fatal diagnostics with httpStatus on terminal upload failure", async () => {
    const capturedEvents: DiagnosticEvent[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/diagnostics/upload-breadcrumb")) {
        const body = JSON.parse(String(init?.body))
        capturedEvents.push(...body.events)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response("Bad Request", { status: 400 })
      }
      if (url.includes("/abandon")) return json({ success: true })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client({ diagnostics: true }).startTranscription(new Uint8Array([1, 2, 3, 4]), {
        filename: "audio.m4a",
        durationSeconds: 1
      })
    ).rejects.toBeInstanceOf(WhisperUploadError)

    await Bun.sleep(10)
    const fatalEvent = capturedEvents.find(e => e.phase === "worker-fatal")
    expect(fatalEvent).toBeDefined()
    expect(fatalEvent?.httpStatus).toBe(400)
    const givenUpEvent = capturedEvents.find(e => e.phase === "upload-given-up")
    expect(givenUpEvent).toBeDefined()
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
      if (url.includes("/abandon")) return json({ success: true })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    await expect(
      client({ maxUploadAttempts: 2 }).startTranscription(new Uint8Array([1]), {
        filename: "audio.wav",
        durationSeconds: 1
      })
    ).rejects.toBeInstanceOf(WhisperUploadError)
  })

  it("calls abandon with session-open-failed when GCS init fails", async () => {
    let completeCalls = 0
    const abandonCalls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response("Internal Server Error", { status: 500 })
      }
      if (url.includes("/uploads/570729/abandon")) {
        abandonCalls.push({ url, init })
        return json({ success: true })
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client().startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { diagnosticId: "bc0d4284" }
      )
    ).rejects.toBeInstanceOf(WhisperUploadError)

    expect(abandonCalls).toHaveLength(1)
    const abandonCall = abandonCalls[0]
    expect(JSON.parse(String(abandonCall.init?.body))).toEqual({ reason: "session-open-failed" })
    expect(new Headers(abandonCall.init?.headers).get("x-diagnostic-id")).toBe("bc0d4284")
    expect(completeCalls).toBe(0)
  })

  it("calls abandon with put-non-retriable when GCS PUT returns non-retriable error", async () => {
    let completeCalls = 0
    const abandonCalls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response("Bad Request", { status: 400 })
      }
      if (url.includes("/uploads/570729/abandon")) {
        abandonCalls.push({ url, init })
        return json({ success: true })
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client().startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { diagnosticId: "bc0d4284" }
      )
    ).rejects.toBeInstanceOf(WhisperUploadError)

    expect(abandonCalls).toHaveLength(1)
    const abandonCall = abandonCalls[0]
    expect(JSON.parse(String(abandonCall.init?.body))).toEqual({ reason: "put-non-retriable" })
    expect(new Headers(abandonCall.init?.headers).get("x-diagnostic-id")).toBe("bc0d4284")
    expect(completeCalls).toBe(0)
  })

  it("calls abandon with put-retries-exhausted when GCS PUT retries are exhausted", async () => {
    let completeCalls = 0
    const abandonCalls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response("Service Unavailable", { status: 503 })
      }
      if (url.includes("/uploads/570729/abandon")) {
        abandonCalls.push({ url, init })
        return json({ success: true })
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client({ maxUploadAttempts: 2 }).startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { diagnosticId: "bc0d4284" }
      )
    ).rejects.toBeInstanceOf(WhisperUploadError)

    expect(abandonCalls).toHaveLength(1)
    const abandonCall = abandonCalls[0]
    expect(JSON.parse(String(abandonCall.init?.body))).toEqual({ reason: "put-retries-exhausted" })
    expect(new Headers(abandonCall.init?.headers).get("x-diagnostic-id")).toBe("bc0d4284")
    expect(completeCalls).toBe(0)
  })

  it("does not call abandon on complete failure, and abandon failure does not replace original error", async () => {
    const abandonCalls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response(null, { status: 201 })
      }
      if (url.includes("/abandon")) {
        abandonCalls.push({ url, init })
        return new Response("abandon failed", { status: 500 })
      }
      if (url.endsWith("/complete")) {
        return json({ code: "INTERNAL_ERROR", message: "Complete exploded" }, { status: 500 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let error: unknown
    try {
      await client().startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { diagnosticId: "bc0d4284" }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(WhisperApiError)
    expect((error as WhisperApiError).status).toBe(500)
    expect(abandonCalls).toHaveLength(0)
  })

  it("honors an already aborted signal before making a request", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch
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

  it("handles 403 on sign without retry or re-login, preserving status and body", async () => {
    let loginCalls = 0
    let signCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) {
        loginCalls++
        return loginResponse()
      }
      if (url.endsWith("/uploads/sign")) {
        signCalls++
        return json({ code: "FORBIDDEN", message: "Denied" }, { status: 403 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let error: unknown
    try {
      await client().startTranscription(new Uint8Array([1, 2, 3]), {
        filename: "audio.m4a",
        durationSeconds: 1
      })
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(WhisperApiError)
    expect((error as WhisperApiError).status).toBe(403)
    expect((error as WhisperApiError).response).toEqual({ code: "FORBIDDEN", message: "Denied" })
    expect(loginCalls).toBe(1)
    expect(signCalls).toBe(1)
  })

  it("recovers from 401 on sign by re-logging in and retrying sign", async () => {
    let loginCalls = 0
    let signCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) {
        loginCalls++
        return loginResponse()
      }
      if (url.endsWith("/uploads/sign")) {
        signCalls++
        if (signCalls === 1) return json({ code: "UNAUTHORIZED" }, { status: 401 })
        return json(signedResponse(2))
      }
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        return new Response(null, { status: 201 })
      }
      if (url.endsWith("/uploads/570729/complete")) return json(finalized())
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const res = await client().startTranscription(new Uint8Array([1, 2]), {
      filename: "audio.m4a",
      durationSeconds: 1
    })
    expect(res.id).toBe(570729)
    expect(loginCalls).toBe(2)
    expect(signCalls).toBe(2)
  })

  it("preserves abort during GCS resumable session init and does not complete", async () => {
    let completeCalls = 0
    const controller = new AbortController()
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        controller.abort()
        throw controller.signal.reason
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let error: unknown
    try {
      await client().startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { signal: controller.signal }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBe(controller.signal.reason)
    expect(completeCalls).toBe(0)
  })

  it("preserves abort during GCS PUT upload and does not complete", async () => {
    let completeCalls = 0
    let putCalls = 0
    const controller = new AbortController()
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        putCalls++
        controller.abort()
        throw controller.signal.reason
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let error: unknown
    try {
      await client().startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { signal: controller.signal }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBe(controller.signal.reason)
    expect(completeCalls).toBe(0)
    expect(putCalls).toBe(1)
  })
  it("aborts a hanging PUT via requestTimeoutMs and retries up to maxUploadAttempts", async () => {
    let putAttempts = 0
    let abandonCalls = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        const range = new Headers(init?.headers).get("content-range")
        if (range !== "bytes */4") putAttempts++
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }
      if (url.includes("/abandon")) {
        abandonCalls++
        return json({ success: true })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client({
        requestTimeoutMs: 10,
        maxUploadAttempts: 2,
        initialRetryDelayMs: 0,
        maxRetryDelayMs: 0
      }).startTranscription(new Uint8Array([1, 2, 3, 4]), {
        filename: "audio.m4a",
        durationSeconds: 1
      })
    ).rejects.toBeInstanceOf(WhisperUploadError)

    expect(putAttempts).toBe(2)
    expect(abandonCalls).toBe(1)
  })

  it("preserves external abort during hanging PUT without retrying", async () => {
    let putAttempts = 0
    let completeCalls = 0
    let abandonCalls = 0
    const controller = new AbortController()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(4))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        putAttempts++
        setTimeout(() => controller.abort(), 5)
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }
      if (url.includes("/abandon")) {
        abandonCalls++
        return json({ success: true })
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let error: unknown
    try {
      await client({
        requestTimeoutMs: 500,
        maxUploadAttempts: 3
      }).startTranscription(
        new Uint8Array([1, 2, 3, 4]),
        { filename: "audio.m4a", durationSeconds: 1 },
        { signal: controller.signal }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBe(controller.signal.reason)
    expect(putAttempts).toBe(1)
    expect(completeCalls).toBe(0)
    expect(abandonCalls).toBe(0)
  })

  it("cancels reader and releases lock when stream reading is aborted", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(10))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const controller = new AbortController()
    let readerCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        setTimeout(() => controller.abort(), 5)
        return new Promise(() => {})
      },
      cancel() {
        readerCancelled = true
      }
    })

    let error: unknown
    try {
      await client().startTranscription(
        stream,
        { filename: "audio.m4a", durationSeconds: 1, totalSize: 10 },
        { signal: controller.signal }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBe(controller.signal.reason)
    expect(readerCancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it("stops reading stream early when GCS returns complete: true without reading trailing chunks", async () => {
    let putCalls = 0
    let finalizeCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(16))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url === "https://storage.test/session") {
        putCalls++
        return new Response(null, { status: 201 })
      }
      if (url.endsWith("/complete")) {
        finalizeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    let chunksPushed = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPushed++
        if (chunksPushed <= 4) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]))
        } else {
          controller.close()
        }
      }
    })

    const result = await client({ chunkSize: 4 }).startTranscription(
      stream,
      { filename: "audio.m4a", durationSeconds: 1, totalSize: 16 }
    )

    expect(result.id).toBe(570729)
    expect(putCalls).toBe(1)
    expect(finalizeCalls).toBe(1)
    // Stream prefetches at most 1 chunk ahead (default highWaterMark: 1), so chunks 3 and 4 are never pulled
    expect(chunksPushed).toBe(2)
  })

  it("abandons upload and records diagnostics when audio stream fails during reading", async () => {
    let completeCalls = 0
    const abandonCalls: Array<{ url: string; init?: RequestInit }> = []
    const diagnosticsSent: DiagnosticEvent[] = []

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.endsWith("/uploads/sign")) return json(signedResponse(8))
      if (url === "https://storage.test/init") {
        return new Response(null, { status: 201, headers: { location: "https://storage.test/session" } })
      }
      if (url.includes("/abandon")) {
        abandonCalls.push({ url, init })
        return json({ success: true })
      }
      if (url.endsWith("/diagnostics/upload-breadcrumb")) {
        const body = JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }
        diagnosticsSent.push(...body.events)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith("/complete")) {
        completeCalls++
        return json(finalized())
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("Stream read error"))
      }
    })

    let error: unknown
    try {
      await client({ diagnostics: true }).startTranscription(
        stream,
        { filename: "audio.m4a", durationSeconds: 1, totalSize: 8 },
        { diagnosticId: "diag1234" }
      )
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(WhisperUploadError)
    expect((error as WhisperUploadError).diagnosticId).toBe("diag1234")
    expect((error as WhisperUploadError).message).toContain("Stream read error")
    expect(abandonCalls).toHaveLength(1)
    expect(JSON.parse(String(abandonCalls[0].init?.body))).toEqual({ reason: "put-non-retriable" })
    expect(completeCalls).toBe(0)
    expect(diagnosticsSent.some(e => e.phase === "upload-given-up")).toBe(true)
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

  it("aborts hanging status polling via timeoutMs and throws WhisperTimeoutError", async () => {
    let statusCalls = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.includes("/recordings/status")) {
        statusCalls++
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    await expect(
      client().waitForTranscription(570729, { pollIntervalMs: 0, timeoutMs: 15 })
    ).rejects.toBeInstanceOf(WhisperTimeoutError)

    expect(statusCalls).toBeGreaterThanOrEqual(1)
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

  it("does not overflow setTimeout for large timeoutMs", async () => {
    let statusCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) return loginResponse()
      if (url.includes("/recordings/status")) {
        statusCalls++
        return json([{ recordingId: 570729, recordingStatus: "completed" }])
      }
      if (url.endsWith("/api/v2/recordings/570729")) {
        return json({ ...finalized("completed"), transcription: { id: 10, recordingId: 570729, content: "done" } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    // 3_000_000_000 ms > 2^31 - 1, which overflows standard 32-bit int to 1ms
    const result = await client({ pollIntervalMs: 0 }).waitForTranscription(570729, {
      timeoutMs: 3_000_000_000
    })
    expect(result.transcription.content).toBe("done")
    expect(statusCalls).toBe(1)
  })
})

describe("WhisperClient authentication & concurrency", () => {
  it("deduplicates concurrent login calls to a single request", async () => {
    let loginCalls = 0
    let resolveLogin: (res: Response) => void
    const loginBarrier = new Promise<Response>((resolve) => {
      resolveLogin = resolve
    })

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) {
        loginCalls++
        return loginBarrier
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const api = client()
    const p1 = api.login()
    const p2 = api.login()

    expect(loginCalls).toBe(1)
    resolveLogin!(json({ id: 42, email: "test@example.com" }))

    const [u1, u2] = await Promise.all([p1, p2])
    expect(u1.id).toBe(42)
    expect(u2.id).toBe(42)
    expect(loginCalls).toBe(1)
  })

  it("handles per-caller abort without cancelling shared in-flight login", async () => {
    let loginCalls = 0
    let resolveLogin: (res: Response) => void
    const loginBarrier = new Promise<Response>((resolve) => {
      resolveLogin = resolve
    })

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v2/auth/login")) {
        loginCalls++
        return loginBarrier
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const api = client()
    const abortCtrl = new AbortController()

    const p1 = api.login()
    const p2 = api.login(abortCtrl.signal)

    expect(loginCalls).toBe(1)

    abortCtrl.abort(new DOMException("Caller cancelled", "AbortError"))

    await expect(p2).rejects.toThrow("Caller cancelled")
    expect(loginCalls).toBe(1)

    resolveLogin!(json({ id: 42 }))

    const u1 = await p1
    expect(u1.id).toBe(42)
  })

  it("rejects immediately if login signal is already aborted", async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return json({ id: 1 })
    }) as unknown as typeof fetch

    const api = client()
    const ctrl = new AbortController()
    ctrl.abort()

    await expect(api.login(ctrl.signal)).rejects.toThrow()
    expect(fetchCalls).toBe(0)
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

  it("verifies budget guard calculation logic", () => {
    function checkBudget(monthlyMinutes: number, monthlyUsageMinutes: number, durationSeconds: number) {
      const remaining = monthlyMinutes - monthlyUsageMinutes
      if (!Number.isFinite(remaining) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Cannot establish live-test budget")
      }
      if (remaining - Math.max(1, Math.ceil(durationSeconds / 60)) < 3) {
        throw new Error("Live test would consume the product testing reserve")
      }
      return true
    }

    expect(checkBudget(5, 1, 30)).toBe(true)
    expect(() => checkBudget(5, 2, 30)).toThrow("Live test would consume the product testing reserve")
    expect(() => checkBudget(NaN, 0, 30)).toThrow("Cannot establish live-test budget")
    expect(() => checkBudget(5, 0, 0)).toThrow("Cannot establish live-test budget")
  })
})
