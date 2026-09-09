import { expect, it } from "bun:test"
import { basename } from "node:path"
import { WhisperClient, WhisperStatus } from "../src/index.js"

const email = Bun.env.WHISPER_EMAIL ?? process.env.WHISPER_EMAIL
const password = Bun.env.WHISPER_PASSWORD ?? process.env.WHISPER_PASSWORD
const audioPath = Bun.env.WHISPER_AUDIO_PATH ?? process.env.WHISPER_AUDIO_PATH
const durationSeconds = Number(Bun.env.WHISPER_AUDIO_DURATION_SECONDS ?? process.env.WHISPER_AUDIO_DURATION_SECONDS ?? 0)
const mimeType = Bun.env.WHISPER_AUDIO_MIME_TYPE ?? process.env.WHISPER_AUDIO_MIME_TYPE
const liveUploadEnabled = (Bun.env.WHISPER_LIVE_UPLOAD ?? process.env.WHISPER_LIVE_UPLOAD) === "1"

const shouldSkip = !liveUploadEnabled || !email || !password || !audioPath || durationSeconds <= 0

it.skipIf(shouldSkip)(
  "transcribes a real audio file with budget guard",
  async () => {
    const client = new WhisperClient({ login: { email: email!, password: password! } })

    const usageBefore = await client.usage()
    const remaining = usageBefore.limits.monthlyMinutes - usageBefore.monthlyUsageMinutes
    if (!Number.isFinite(remaining) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Cannot establish live-test budget")
    }
    // Консервативно резервируем не меньше целой минуты на один файл.
    if (remaining - Math.max(1, Math.ceil(durationSeconds / 60)) < 3) {
      throw new Error("Live test would consume the product testing reserve")
    }

    const bytes = await Bun.file(audioPath!).bytes()
    const result = await client.transcribe(bytes, {
      filename: basename(audioPath!),
      durationSeconds,
      mimeType,
      totalSize: bytes.byteLength,
      language: "auto",
      transcriptionStyle: "standard"
    })

    expect(result.status).toBe(WhisperStatus.COMPLETED)
    expect(result.transcription.content.length).toBeGreaterThan(0)

    const usageAfter = await client.usage()
    console.log(
      `[live-test] recordingId=${result.id}, status=${result.status}, usageBefore=${usageBefore.monthlyUsageMinutes}m, usageAfter=${usageAfter.monthlyUsageMinutes}m`
    )
  },
  35 * 60 * 1_000
)
