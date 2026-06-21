# whisperai-sdk

Unofficial TypeScript SDK for [WhisperAI](https://whisperai.com/). Version 2 uses WhisperAI's signed Google Cloud Storage resumable-upload flow and requires Node.js 22 or newer.

> This project is not affiliated with WhisperAI.

## Installation

```bash
npm install whisperai-sdk
```

## Transcribe a file

`transcribe()` performs the complete operation: authentication, upload, retries, finalization, status polling, and fetching the completed transcription.

```typescript
import { readFile } from "node:fs/promises"
import { WhisperClient } from "whisperai-sdk"

const client = new WhisperClient({
  login: {
    email: process.env.WHISPER_EMAIL!,
    password: process.env.WHISPER_PASSWORD!
  }
})

const audio = new Uint8Array(await readFile("./interview.m4a"))
const recording = await client.transcribe(audio, {
  filename: "interview.m4a",
  mimeType: "audio/x-m4a",
  durationSeconds: 120
})

console.log(recording.transcription.content)
```

The default processing timeout is 30 minutes and the default polling interval is 2 seconds.

```typescript
const controller = new AbortController()

const recording = await client.transcribe(audio, metadata, {
  timeoutMs: 45 * 60 * 1000,
  pollIntervalMs: 3000,
  signal: controller.signal,
  onProgress: percentage => console.log(`Upload: ${percentage}%`)
})
```

## Streams

For streaming uploads, provide `totalSize` so the SDK can upload without buffering the entire file. If it is omitted, the stream is buffered first to determine its size.

```typescript
const recording = await client.transcribe(stream, {
  filename: "meeting.webm",
  mimeType: "audio/webm",
  durationSeconds: 900,
  totalSize: contentLength
})
```

## Start without waiting

Queue workers can upload and return immediately, then check the recording later.

```typescript
const started = await client.startTranscription(audio, metadata)
console.log(started.id, started.status) // processing

const statuses = await client.recordingStatus([started.id])
const completed = await client.waitForTranscription(started.id)
```

`requestTranscription(recordingId)` is available for explicitly restarting or recovering an existing recording. A normal signed upload starts processing when the upload is completed, so it does not need this extra call.

## Upload metadata

The SDK accepts the current WhisperAI transcription settings:

```typescript
await client.transcribe(audio, {
  filename: "interview.m4a",
  durationSeconds: 120,
  language: "multi-auto",
  enableSpeakerDetection: true,
  speakerCount: "auto",
  transcriptionStyle: "clean_readable",
  importantTerms: "WhisperAI, Codex",
  customPrompt: "Technical product interview",
  speakerIdentificationEnabled: true,
  speakerIdentificationMode: "role",
  speakerIdentificationValues: ["Interviewer", "Guest"]
})
```

## Other methods

```typescript
await client.user()
await client.usage()
await client.subscriptionDetails()
await client.recording(recordingId)
await client.recordings({ limit: 20, sort: "newest" })
await client.summary()
await client.translate(recordingId, "es")
```

## Errors

```typescript
import {
  WhisperApiError,
  WhisperAuthError,
  WhisperNetworkError,
  WhisperTimeoutError,
  WhisperTranscriptionError,
  WhisperUploadError
} from "whisperai-sdk"
```

Upload diagnostics are enabled by default and sent best-effort to WhisperAI. Disable them globally with `diagnostics: false` in `ClientOptions`, or per operation with `{ diagnostics: false }`.

## Live smoke test

```bash
WHISPER_EMAIL=... \
WHISPER_PASSWORD=... \
WHISPER_AUDIO_PATH=./sample.m4a \
WHISPER_AUDIO_DURATION_SECONDS=10 \
bun test test/live.test.ts
```

## License

MIT
