import { expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { WhisperClient } from "../src/index.js"

const email = process.env.WHISPER_EMAIL
const password = process.env.WHISPER_PASSWORD
const audioPath = process.env.WHISPER_AUDIO_PATH
const durationSeconds = Number(process.env.WHISPER_AUDIO_DURATION_SECONDS ?? 0)

it.skipIf(!email || !password || !audioPath || durationSeconds <= 0)(
  "transcribes a real audio file",
  async () => {
    const bytes = new Uint8Array(await readFile(audioPath!))
    const client = new WhisperClient({ login: { email: email!, password: password! } })
    const result = await client.transcribe(bytes, {
      filename: basename(audioPath!),
      durationSeconds,
      totalSize: bytes.byteLength
    })
    expect(result.status).toBe("completed")
    expect(result.transcription.content.length).toBeGreaterThan(0)
  },
  35 * 60 * 1_000
)
